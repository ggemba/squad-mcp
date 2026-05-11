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

const schema = z.object({
  work_type: z.enum(["Feature", "Bug Fix", "Refactor", "Performance", "Security", "Business Rule"]),
  files: z.array(safeString(4096)).max(10_000).default([]),
  read_content: z.boolean().optional().default(true),
  force_agents: z.array(z.enum(AGENT_NAMES_TUPLE)).optional().default([]),
  workspace_root: safeString(4096).optional(),
});

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
  const skipProductOwner =
    input.work_type === "Feature" &&
    matrixEntry.core.includes("product-owner") &&
    !hasUserFacingFile(input.files);

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

  for (const file of input.files) {
    const matched: {
      agent: AgentName;
      signal: string;
      source: "content" | "path";
      truncated?: boolean;
    }[] = [];

    for (const hint of PATH_HINTS) {
      if (hint.pattern.test(file)) {
        matched.push({
          agent: hint.agent,
          signal: hint.description,
          source: "path",
        });
      }
    }

    let contentMatched = false;
    let snippetTruncated = false;
    if (canReadContent) {
      try {
        const abs = await resolveSafePath(input.workspace_root, file, ctx);
        const snippet = await readSnippet(abs);
        if (snippet) {
          snippetTruncated = snippet.truncated;
          for (const sig of CONTENT_SIGNALS) {
            if (!signalApplies(sig, file)) continue;
            if (sig.pattern.test(snippet.content)) {
              matched.push({
                agent: sig.agent,
                signal: sig.description,
                source: "content",
                truncated: snippet.truncated,
              });
              contentMatched = true;
            }
          }
        }
      } catch (err) {
        if (isSquadError(err)) {
          lowConfidence.push({ file, reason: `path rejected: ${err.code}` });
          continue;
        }
        throw err;
      }
    }

    if (matched.length === 0) {
      lowConfidence.push({ file, reason: "no path or content signal matched" });
      continue;
    }

    const seen = new Set<string>();
    for (const m of matched) {
      const key = `${m.agent}|${m.signal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const confidence: Evidence["confidence"] =
        m.source === "content" ? "high" : contentMatched ? "medium" : "medium";
      const ev: Evidence = {
        file,
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
          reason: `${m.source} signal in ${file}: ${m.signal}`,
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
