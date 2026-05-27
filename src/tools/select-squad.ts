import { z } from "zod";
import type { ToolDef } from "./registry.js";
import {
  AGENTS,
  AGENT_NAMES_TUPLE,
  CONTENT_SIGNALS,
  PATH_HINTS,
  signalApplies,
  SQUAD_BY_TYPE,
  type AgentName,
  type WorkType,
} from "../config/ownership-matrix.js";
import {
  createSafePathContext,
  MAX_BYTES,
  readSnippet,
  resolveSafePath,
} from "../util/path-safety.js";
import { isSquadError } from "../errors.js";
import { SafeString as safeString } from "./_shared/schemas.js";

/**
 * Minimum lines-changed in a single file required for a WEAK path hint
 * (`requires_content: true` in `ownership-matrix.ts`) to promote its agent
 * when no content signal for that agent was found. v1.7.3+.
 *
 * Rationale: a one-line edit to `DependencyInjection.cs` that only renames
 * a config-key string should not spawn the architect — the file's name is
 * suggestive, but the actual change is trivial. A file with ≥5 changed lines
 * is a heavier hint that something meaningful is happening, even if no content
 * signal regex matched (regex coverage is incomplete by design).
 *
 * Pre-existing behaviour ignored magnitude entirely: any path match promoted
 * the agent regardless of diff size.
 */
export const MIN_LOC_FOR_WEAK_PATH = 5;

/**
 * File-input shape accepted by `select_squad`. The legacy form (plain string
 * path) is treated as `{ path, status: "modified" }` for backward compatibility
 * with v1.7.2 and earlier callers — including external scripts and the
 * `select_squad` MCP tool surface. Internal callers (`compose-core.ts`,
 * `compose-advisory-bundle.ts`) construct the rich form with status + per-file
 * loc so the v1.7.3+ weak-path-hint gate has the signals it needs.
 */
const fileInputSchema = z.union([
  safeString(4096),
  z.object({
    path: safeString(4096),
    // ChangeStatus values from src/tools/detect-changed-files.ts. Default
    // "modified" matches the legacy string-form coercion.
    status: z
      .enum(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unknown"])
      .optional()
      .default("modified"),
    loc_added: z.number().int().min(0).optional(),
    loc_deleted: z.number().int().min(0).optional(),
  }),
]);

const schema = z.object({
  work_type: z.enum(["Feature", "Bug Fix", "Refactor", "Performance", "Security", "Business Rule"]),
  files: z.array(fileInputSchema).max(10_000).default([]),
  read_content: z.boolean().optional().default(true),
  force_agents: z.array(z.enum(AGENT_NAMES_TUPLE)).optional().default([]),
  workspace_root: safeString(4096).optional(),
});

/**
 * Normalised internal file shape — legacy strings get coerced into this. All
 * downstream logic in `selectSquad` reads through this type, so adding new
 * gating signals (e.g. binary detection) is a single-site change.
 */
interface NormalisedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "unknown";
  loc_added?: number;
  loc_deleted?: number;
}

function normaliseFiles(raw: z.infer<typeof schema>["files"]): NormalisedFile[] {
  const out: NormalisedFile[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push({ path: entry, status: "modified" });
    } else {
      const f: NormalisedFile = { path: entry.path, status: entry.status };
      if (entry.loc_added !== undefined) f.loc_added = entry.loc_added;
      if (entry.loc_deleted !== undefined) f.loc_deleted = entry.loc_deleted;
      out.push(f);
    }
  }
  return out;
}

/**
 * User-facing surface detection (v0.12+, C2). Matched against the changed-file
 * list to decide whether `product-owner` belongs in the squad for a `Feature`
 * change. The PO's value is reasoning about UX, copy, accessibility, and
 * conversion flows — none of which apply to a purely internal API refactor
 * that happens to be classified as Feature.
 *
 * Heuristic shape (single combined regex for speed; `i` flag for cross-OS
 * path-case tolerance):
 *
 *   - Front-end view-component directories: components / pages / ui / views /
 *     screens / routes (Next / Remix / Nuxt / SvelteKit / etc.) anywhere in
 *     the path. Hyphenated variants like `view-models` deliberately excluded
 *     — `view-models` is server-internal, not user-facing.
 *   - JSX-family file extensions: .tsx, .jsx, .vue, .svelte, .razor, .cshtml
 *   - Web presentation: .html, .htm, .css, .scss, .sass, .less, .styl
 *   - .NET / Java MVC view-class suffixes: *Component.cs, *Page.cs, *View.cs,
 *     *Razor.cs (server-rendered presentation that is still user-facing).
 *   - Translation / copy: i18n / locales / l10n / translations directories,
 *     .po / .pot files.
 *
 * NOT user-facing (deliberately excluded to keep the PO out of pure
 * back-end / infra Features):
 *
 *   - Controllers, services, repositories, models, DTOs, schemas, migrations,
 *     workers, queues, cron jobs, CLI tools, build configs.
 *   - Tests of any kind (they're verification, not user surface).
 *
 * Conservatively wide: a false positive (PO included on an internal feature
 * that happens to touch `components/` for a tooling reason) only costs one
 * extra Haiku/Sonnet dispatch. A false negative (PO excluded from a real UX
 * change) is louder — the user pays in either a missed UX finding or a
 * manual `--force-agents product-owner` invocation. Bias toward inclusion.
 */
const USER_FACING_PATTERN = new RegExp(
  [
    // Front-end view directories (no hyphenated suffixes — view-models is NOT user-facing)
    String.raw`[\\/](components|pages|ui|views|screens|routes|app(?:[\\/]|$))(?:[\\/]|$)`,
    // JSX-family + presentation file extensions
    String.raw`\.(tsx|jsx|vue|svelte|razor|cshtml|html?|css|scss|sass|less|styl)$`,
    // .NET / Java MVC view-class suffixes (case-insensitive — accommodates *page.cs / *Page.cs)
    String.raw`(Component|Page|View|Razor)\.cs$`,
    // i18n / l10n / translations dirs + translation file extensions.
    // NOTE: `.properties` is NOT included — Java apps use it for both i18n
    // bundles and ordinary backend config (`application.properties`, `log4j.properties`).
    // The directory-based check above (`[\\/]i18n[\\/]`, `[\\/]locales[\\/]`, etc.)
    // catches Java i18n correctly without dragging in Spring configs.
    String.raw`[\\/](i18n|locales?|l10n|translations?|lang)[\\/]`,
    String.raw`\.(po|pot|xlf)$`,
  ].join("|"),
  "i",
);

/**
 * Path-prefix check for `node_modules/`. A third-party package file at
 * `node_modules/some-ui-lib/components/Button.tsx` would trip the regex
 * but is NOT a user-facing change — the diff that touches it is operating
 * on the dependency tree, not on the user's own UI surface. Exclude
 * unconditionally.
 *
 * Defensive against both POSIX (`node_modules/...`) and Windows
 * (`node_modules\...`) separators, anywhere in the path (handles nested
 * `apps/web/node_modules/foo/...` in monorepos).
 */
function isUnderNodeModules(file: string): boolean {
  return /(?:^|[\\/])node_modules[\\/]/.test(file);
}

function hasUserFacingFile(files: readonly string[]): boolean {
  for (const f of files) {
    if (isUnderNodeModules(f)) continue;
    if (USER_FACING_PATTERN.test(f)) return true;
  }
  return false;
}

type Input = z.infer<typeof schema>;

export interface Evidence {
  file: string;
  agent: AgentName;
  signal: string;
  source: "content" | "path";
  confidence: "high" | "medium" | "low";
  truncated?: boolean;
}

export interface SelectSquadOutput {
  agents: AgentName[];
  rationale: { agent: AgentName; reason: string }[];
  evidence: Evidence[];
  low_confidence_files: { file: string; reason: string }[];
}

export async function selectSquad(input: Input): Promise<SelectSquadOutput> {
  const matrixEntry = SQUAD_BY_TYPE[input.work_type as WorkType];

  // v0.12+ C2: drop `product-owner` from `Feature` core when the diff has
  // no user-facing surface. PO reviews UX/copy/accessibility — adding it
  // to a purely internal API feature is a wasted Sonnet dispatch and a
  // dilution of the rubric. The matrix declares PO as Feature.core; this
  // is the only place that overrides that declaration, and it does so
  // ONLY when both conditions hold: work_type === "Feature" AND no path
  // in the changed-file list trips USER_FACING_PATTERN.
  //
  // Business Rule keeps PO unconditionally — that work type's whole
  // reason for existing is to surface PO. `force_agents` still wins
  // below: a caller passing `force_agents: ["product-owner"]` re-adds
  // the agent regardless of this drop.
  // v1.7.3: normalise file inputs once up-front. Legacy string entries become
  // { path, status: "modified" }; structured entries are passed through. All
  // downstream logic — including `hasUserFacingFile` below and the matching
  // loop further on — reads through this normalised shape.
  const files = normaliseFiles(input.files);
  const filePathsForDetection = files.map((f) => f.path);

  const skipProductOwner =
    input.work_type === "Feature" &&
    matrixEntry.core.includes("product-owner") &&
    !hasUserFacingFile(filePathsForDetection);

  const coreAgents = skipProductOwner
    ? matrixEntry.core.filter((a) => a !== "product-owner")
    : matrixEntry.core;

  const selected = new Set<AgentName>(coreAgents);
  const rationale: { agent: AgentName; reason: string }[] = coreAgents.map((a) => ({
    agent: a,
    reason: `core agent for ${input.work_type}`,
  }));
  if (skipProductOwner) {
    rationale.push({
      agent: "product-owner",
      reason:
        "demoted from core: Feature has no user-facing files (components / pages / ui / views / *.tsx / *.vue / view-class suffixes / i18n). Pass force_agents=[product-owner] to re-include.",
    });
  }

  const evidence: Evidence[] = [];
  const lowConfidence: { file: string; reason: string }[] = [];

  const ctx = createSafePathContext();
  const canReadContent = input.read_content && input.workspace_root !== undefined;

  for (const f of files) {
    // Collect both path and content matches without promoting yet — promotion
    // is gated below per-match against the file's status and magnitude.
    const pathMatches: { agent: AgentName; signal: string; requires_content: boolean }[] = [];
    const contentMatches: {
      agent: AgentName;
      signal: string;
      source: "content";
      truncated?: boolean;
    }[] = [];

    for (const hint of PATH_HINTS) {
      if (hint.pattern.test(f.path)) {
        pathMatches.push({
          agent: hint.agent,
          signal: hint.description,
          requires_content: hint.requires_content === true,
        });
      }
    }

    let snippetTruncated = false;
    if (canReadContent) {
      try {
        const abs = await resolveSafePath(input.workspace_root, f.path, ctx);
        const snippet = await readSnippet(abs);
        if (snippet) {
          snippetTruncated = snippet.truncated;
          for (const sig of CONTENT_SIGNALS) {
            if (!signalApplies(sig, f.path)) continue;
            if (sig.pattern.test(snippet.content)) {
              contentMatches.push({
                agent: sig.agent,
                signal: sig.description,
                source: "content",
                truncated: snippet.truncated,
              });
            }
          }
        }
      } catch (err) {
        if (isSquadError(err)) {
          lowConfidence.push({ file: f.path, reason: `path rejected: ${err.code}` });
          continue;
        }
        throw err;
      }
    }

    // v1.7.3 promotion gate. SKIP-D universal: deleted files never promote via
    // path (there is no post-deletion content for the agent to review). WEAK
    // path hints (PathHint.requires_content === true) require ALSO a content
    // signal for the same agent OR file new (status=added) OR file has
    // sufficient magnitude (loc_added + loc_deleted >= MIN_LOC_FOR_WEAK_PATH).
    const isDeleted = f.status === "deleted";
    const isAdded = f.status === "added";
    const fileLoc = (f.loc_added ?? 0) + (f.loc_deleted ?? 0);
    const meetsLocThreshold = fileLoc >= MIN_LOC_FOR_WEAK_PATH;
    const contentAgents = new Set<AgentName>(contentMatches.map((m) => m.agent));

    const matched: {
      agent: AgentName;
      signal: string;
      source: "content" | "path";
      truncated?: boolean;
    }[] = [];

    for (const pm of pathMatches) {
      if (isDeleted) {
        lowConfidence.push({
          file: f.path,
          reason: `path signal "${pm.signal}" (${pm.agent}) skipped: file is deleted`,
        });
        continue;
      }
      if (pm.requires_content) {
        const hasContentForSameAgent = contentAgents.has(pm.agent);
        if (!hasContentForSameAgent && !isAdded && !meetsLocThreshold) {
          lowConfidence.push({
            file: f.path,
            reason: `weak path signal "${pm.signal}" (${pm.agent}) without content confirmation, file is not new, and loc_changed ${fileLoc} < ${MIN_LOC_FOR_WEAK_PATH}`,
          });
          continue;
        }
      }
      matched.push({ agent: pm.agent, signal: pm.signal, source: "path" });
    }

    // Content matches always promote (they are evidence of actual change),
    // regardless of file status. Deleted files can still produce content
    // matches when `read_content` is true and the snippet was captured from
    // the pre-deletion blob (rare path; usually the file is gone from disk).
    for (const cm of contentMatches) {
      matched.push({
        agent: cm.agent,
        signal: cm.signal,
        source: "content",
        ...(cm.truncated !== undefined ? { truncated: cm.truncated } : {}),
      });
    }

    if (matched.length === 0) {
      // Only record the generic "no signal matched" reason when nothing —
      // neither path nor content — fired. The targeted "deleted" / "weak"
      // skip reasons recorded above already explain those cases.
      if (pathMatches.length === 0) {
        lowConfidence.push({ file: f.path, reason: "no path or content signal matched" });
      }
      continue;
    }

    const contentMatched = contentMatches.length > 0;
    const seen = new Set<string>();
    for (const m of matched) {
      const key = `${m.agent}|${m.signal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const confidence: Evidence["confidence"] =
        m.source === "content" ? "high" : contentMatched ? "medium" : "medium";
      const ev: Evidence = {
        file: f.path,
        agent: m.agent,
        signal: m.signal,
        source: m.source,
        confidence,
      };
      if (m.truncated || (m.source === "content" && snippetTruncated)) ev.truncated = true;
      evidence.push(ev);
      if (!selected.has(m.agent)) {
        selected.add(m.agent);
        rationale.push({
          agent: m.agent,
          reason: `${m.source} signal in ${f.path}: ${m.signal}`,
        });
      }
    }
  }

  for (const forced of input.force_agents) {
    if (!selected.has(forced)) {
      selected.add(forced);
      rationale.push({ agent: forced, reason: "forced by caller" });
    }
  }

  // Preserve insertion order: core agents from the matrix come first, then
  // content/path signals, then user force_agents last. This is the "ranked"
  // order downstream consumers (notably `shapeSquadForMode` in
  // compose-squad-workflow.ts when mode === "quick") rely on. Prior versions
  // sorted alphabetically and silently shipped a top-2 that didn't match
  // the docstring contract.
  const rankedAgents = Array.from(selected);
  return {
    agents: rankedAgents,
    rationale,
    evidence,
    low_confidence_files: lowConfidence,
  };
}

export const selectSquadTool: ToolDef<typeof schema> = {
  name: "select_squad",
  description:
    `Select agents for a work type given changed files. Combines core matrix with content sniff and path hints. ` +
    `Reads up to ${MAX_BYTES} bytes per file when workspace_root is set; signals can be ext-gated to avoid cross-stack false positives.`,
  schema,
  handler: selectSquad,
};

void AGENTS;
