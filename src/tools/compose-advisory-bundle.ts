import { z } from "zod";
import type { ToolDef } from "./registry.js";
import {
  composeSquadWorkflow,
  EXEC_MODES,
  type ComposeWorkflowOutput,
} from "./compose-squad-workflow.js";
import { sliceFilesForAgent, type SliceOutput } from "./slice-files.js";
import { validatePlanText, type ValidatePlanOutput } from "./validate-plan-text.js";
import { extractFileHunks, type FileHunk } from "../exec/diff-hunks.js";
import { detectLanguages, type LanguageDetection } from "../exec/detect-languages.js";
import { readAgentLanguageSupplements } from "../resources/agent-loader.js";
import { AGENT_NAMES_TUPLE, type AgentName } from "../config/ownership-matrix.js";
import { isSquadError } from "../errors.js";
import { SafeString as safeString } from "./_shared/schemas.js";
import { createSafePathContext, resolveSafePath } from "../util/path-safety.js";
import { sanitizeForPrompt } from "../util/prompt-sanitize.js";
import { logger } from "../observability/logger.js";

/**
 * Agents whose `agents/<name>.langs/<lang>.md` supplement files are LOOKED
 * UP when language-aware bundling is enabled. Agents not in this list never
 * receive supplements regardless of detection — most are language-agnostic
 * (architect, dba, security, planner, consolidator, PO) and adding the
 * lookup overhead for them would yield no payoff.
 *
 * Maintenance contract: when adding `.langs/` content for a new agent, also
 * add the name here so `compose_advisory_bundle` includes it. The reverse
 * also holds — adding a name here without shipping the directory makes the
 * bundle attempt empty reads on every dispatch. Both directions are enforced
 * by the `LANGUAGE_AWARE_AGENTS contract` block in
 * `tests/agent-language-supplements.test.ts`, which fails CI on any drift.
 */
export const LANGUAGE_AWARE_AGENTS: readonly AgentName[] = [
  "senior-developer",
  "senior-dev-reviewer",
  "senior-qa",
  "senior-implementer",
] as const;

const schema = z.object({
  workspace_root: safeString(4096),
  /** User prompt. Sanitized for prompt-injection codepoints before interpolation. */
  user_prompt: safeString(8192),
  /** Plan text. Sanitized for prompt-injection codepoints before interpolation. */
  plan: safeString(65_536),
  base_ref: safeString(200).optional(),
  staged_only: z.boolean().optional().default(false),
  read_content: z.boolean().optional().default(true),
  /**
   * Execution depth. Omit to let `selectMode` auto-detect from
   * classify+risk signals. Pass explicitly to override the auto-detect.
   * See compose-squad-workflow.ts for the resolution rules.
   */
  mode: z.enum(EXEC_MODES).optional(),
  force_work_type: z
    .enum(["Feature", "Bug Fix", "Refactor", "Performance", "Security", "Business Rule"])
    .optional(),
  force_agents: z.array(z.enum(AGENT_NAMES_TUPLE)).optional().default([]),
  risk_signals: z
    .object({
      touches_auth: z.boolean().optional(),
      touches_money: z.boolean().optional(),
      touches_migration: z.boolean().optional(),
      new_module: z.boolean().optional(),
      api_contract_change: z.boolean().optional(),
    })
    .optional(),
  /**
   * Include unified-diff hunks per agent so the host LLM can render the agent
   * prompt with the changed regions inline instead of (or alongside) full file
   * content. Default true — the squad-mcp v0.12 perf series default. Set
   * false to fall back to the pre-v0.12 "full-file-only" behaviour (used by
   * agents that explicitly need cross-line architecture context).
   *
   * When `read_content: false`, hunks are still returned regardless of this
   * flag — the host has nothing else to feed agents.
   */
  include_hunks: z.boolean().optional().default(true),
  /**
   * Per-file byte cap on the returned hunk diff. 8 KB default protects the
   * Sonnet/Haiku prompt budget; truncated hunks carry an explicit marker so
   * the agent knows to `Read` the file for full context when needed.
   */
  max_hunk_bytes_per_file: z.number().int().positive().max(65_536).optional().default(8192),
  /**
   * Detect languages from the changed-file list and look up per-agent
   * `.langs/<lang>.md` supplements (v0.13+). Default true. When enabled,
   * the bundle includes `detected_languages` and `language_supplements_by_agent`
   * so the orchestrator can inject focused, stack-relevant guidance into each
   * agent prompt (instead of every agent reading a 700-line multi-stack
   * checklist of which 80% is irrelevant).
   *
   * Set false in flows that intentionally want the language-agnostic core
   * prompt only (rare — used by tests and any caller that has its own
   * language-context discipline).
   */
  include_language_supplements: z.boolean().optional().default(true),
  /**
   * Threshold for SECONDARY languages: a non-primary detected language must
   * have at least this many files in the change to receive a supplement.
   * The PRIMARY language is always supplemented regardless of file count
   * (the dominant stack of the change is never marginal).
   *
   * Default 2 — protects the prompt budget from "PR with 1 .ts touched +
   * 1 unrelated .py infra script" scenarios where the secondary language
   * is incidental noise. Set to 1 to disable the threshold (pre-v0.13.x
   * behaviour: every detected language gets a supplement). Set higher to
   * be more aggressive about pruning marginal stacks.
   *
   * Note: this filters what gets INJECTED, not what gets DETECTED. The
   * `detected_languages` output stays full-fidelity; the prune is visible
   * by comparing its `all` field with `language_supplements_by_agent[agent]`'s
   * keys.
   */
  min_files_per_secondary_language: z.number().int().min(1).max(100).optional().default(2),
});

type Input = z.infer<typeof schema>;

export interface AdvisoryBundleOutput {
  workflow: ComposeWorkflowOutput;
  slices_by_agent: Record<string, SliceOutput>;
  /**
   * Per-agent diff hunks for the files in `slices_by_agent[agent].matched`.
   * Keyed by post-change path. Absent when `include_hunks: false` was passed,
   * when the workflow has no detected changed files, or when hunk extraction
   * failed (consult `hunks_status` to disambiguate).
   *
   * Files marked `full_file_changed: true` (added/deleted whole) carry a
   * diff that includes the `new file mode` / `deleted file mode` git header
   * — agents should treat this as the canonical signal for "use Read for
   * full content if you need it" rather than relying on the partial diff.
   *
   * Outer key is `AgentName` (the same finite enum used everywhere else).
   * `Partial<Record<AgentName, ...>>` because agents not in the selected
   * squad have no entry.
   */
  hunks_by_agent?: Partial<Record<AgentName, Record<string, FileHunk>>>;
  /**
   * Status of the hunk extraction step (v0.12+). Lets callers distinguish
   * "no hunks because empty diff or include_hunks: false" from "no hunks
   * because extraction failed mid-run". Always present.
   *
   *   "ok"               — extraction succeeded (hunks_by_agent populated)
   *   "skipped"          — include_hunks: false OR filePaths empty
   *   "extraction_failed" — git/path resolution failed; check `hunks_error` for code
   */
  hunks_status: "ok" | "skipped" | "extraction_failed";
  /**
   * Error metadata when `hunks_status === "extraction_failed"`. Absent
   * otherwise. `code` is a SquadError code when available, else `"UNKNOWN"`.
   */
  hunks_error?: { code: string; message: string };
  /**
   * Language detection result from the changed-file list (v0.13+). Absent
   * when `include_language_supplements: false` was passed or when no files
   * changed. `confidence: "none"` means nothing recognised — callers should
   * fall back to the language-agnostic core prompt.
   */
  detected_languages?: LanguageDetection;
  /**
   * Per-agent language supplements: `{agent: {language: file_content}}`.
   * Only populated for agents in `LANGUAGE_AWARE_AGENTS` (today: developer,
   * dev-reviewer, qa, implementer) AND only when the agent has the matching
   * `agents/<agent>.langs/<lang>.md` file on disk. Languages without an
   * on-disk supplement are silently absent from the inner record — same
   * envelope as `hunks_by_agent` (presence implies "ready to inject").
   *
   * The orchestrator (skill) iterates this and prepends each supplement to
   * the agent's Phase 5 dispatch prompt under a `## Language-specific
   * guidance` heading. Agents not in the map (architect, dba, security, PO,
   * tech-lead-*) get the core prompt only — they are deliberately
   * language-agnostic.
   */
  language_supplements_by_agent?: Partial<Record<AgentName, Record<string, string>>>;
  plan_validation: ValidatePlanOutput;
}

export async function composeAdvisoryBundle(input: Input): Promise<AdvisoryBundleOutput> {
  // Sanitize at the prompt boundary — strips invisibles, role tokens, normalises NFKC.
  // See src/util/prompt-sanitize.ts. Apply once at the top of the handler; downstream
  // calls (composeSquadWorkflow, validatePlanText) receive the sanitized values.
  const safeUserPrompt = sanitizeForPrompt(input.user_prompt);
  const safePlan = sanitizeForPrompt(input.plan);

  const workflowInput: Parameters<typeof composeSquadWorkflow>[0] = {
    workspace_root: input.workspace_root,
    user_prompt: safeUserPrompt,
    staged_only: input.staged_only,
    read_content: input.read_content,
    force_agents: input.force_agents,
  };
  if (input.base_ref !== undefined) workflowInput.base_ref = input.base_ref;
  if (input.force_work_type !== undefined) workflowInput.force_work_type = input.force_work_type;
  if (input.risk_signals !== undefined) workflowInput.risk_signals = input.risk_signals;
  if (input.mode !== undefined) workflowInput.mode = input.mode;

  const workflow = await composeSquadWorkflow(workflowInput);

  // Use the FILTERED list (skip_paths already applied by composeSquadWorkflow).
  // Slicing has to operate on the same set of files the squad was selected over,
  // otherwise an agent would receive paths the composer just hid.
  const allChanged = workflow.changed_files.files.map((f) => f.path);
  const skippedSet = new Set(workflow.skipped_paths);
  const filePaths = allChanged.filter((p) => !skippedSet.has(p));

  const slices_by_agent: Record<string, SliceOutput> = {};
  for (const agent of workflow.squad.agents) {
    const slice = await sliceFilesForAgent({
      agent,
      files: filePaths,
      read_content: input.read_content,
      workspace_root: input.workspace_root,
    });
    slices_by_agent[agent] = slice;
  }

  // Hunks: one git diff call on the full surviving file set, then per-agent
  // filter. Cheaper than N calls and the byte cost is bounded by the per-file
  // truncation. Skip the call entirely when there's nothing to diff or the
  // caller asked us not to (some flows want pure-file-content prompts).
  //
  // Note: zod's `.default(true)` for include_hunks only fires when callers go
  // through the dispatcher (which calls schema.parse). Direct in-process
  // callers (tests, other tools) get `undefined`. Treat undefined as the
  // "default-on" case explicitly — only `false` opts out.
  const includeHunks = input.include_hunks !== false;
  const maxHunkBytes = input.max_hunk_bytes_per_file ?? 8192;
  let hunks_by_agent: Partial<Record<AgentName, Record<string, FileHunk>>> | undefined;
  let hunks_status: AdvisoryBundleOutput["hunks_status"] = "skipped";
  let hunks_error: { code: string; message: string } | undefined;
  if (includeHunks && filePaths.length > 0) {
    try {
      const ctx = createSafePathContext();
      const safeCwd = await resolveSafePath(input.workspace_root, ".", ctx);
      const hunksInput: Parameters<typeof extractFileHunks>[0] = {
        cwd: safeCwd,
        files: filePaths,
        staged_only: input.staged_only,
        max_bytes_per_file: maxHunkBytes,
      };
      if (input.base_ref !== undefined) hunksInput.base_ref = input.base_ref;
      const allHunks = await extractFileHunks(hunksInput);
      hunks_by_agent = {};
      for (const agent of workflow.squad.agents) {
        const slice = slices_by_agent[agent];
        const matched = new Set((slice?.matched ?? []).map((m) => m.file));
        const agentHunks: Record<string, FileHunk> = {};
        for (const [p, h] of Object.entries(allHunks)) {
          if (matched.has(p)) agentHunks[p] = h;
        }
        hunks_by_agent[agent as AgentName] = agentHunks;
      }
      hunks_status = "ok";
    } catch (err) {
      // Hunks are an OPTIMISATION — failure to extract must not break the
      // bundle. Surface structured signal via `hunks_status` + `hunks_error`
      // so the orchestrator can warn the user once instead of silently
      // shipping reduced-context agents.
      //
      // Log level: SquadError with a known code = warn (expected operational
      // failures like PATH_TRAVERSAL_DENIED, GIT_NOT_A_REPO). Anything else
      // = error (likely a regression in the parser or unexpected exception
      // from the runtime).
      const code = isSquadError(err) ? err.code : "UNKNOWN";
      const message = err instanceof Error ? err.message : String(err);
      const knownOperationalCode = isSquadError(err); // any SquadError is "known"
      hunks_status = "extraction_failed";
      hunks_error = { code, message };
      const details = {
        code,
        message,
        stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
        files_count: filePaths.length,
        staged_only: input.staged_only,
        base_ref: input.base_ref,
        agent_count: workflow.squad.agents.length,
      };
      if (knownOperationalCode) {
        logger.warn("hunks extraction failed (operational); bundle omits hunks_by_agent", {
          details,
        });
      } else {
        logger.error("hunks extraction failed (unexpected); bundle omits hunks_by_agent", {
          details,
        });
      }
    }
  }

  // Language detection + per-agent supplements (v0.13+ language-aware
  // bundling). Pure: detection is extension-based, no I/O. Supplements are fs
  // reads but capped — only LANGUAGE_AWARE_AGENTS × detected_languages.all,
  // with the agent-loader returning null for missing files (silently skipped).
  // Same fail-soft envelope as hunks: any error logs and proceeds with empty.
  const includeLanguageSupplements = input.include_language_supplements !== false;
  let detected_languages: LanguageDetection | undefined;
  let language_supplements_by_agent: Partial<Record<AgentName, Record<string, string>>> | undefined;

  if (includeLanguageSupplements && filePaths.length > 0) {
    detected_languages = detectLanguages(filePaths);
    if (detected_languages.all.length > 0) {
      // Apply the secondary-language file-count threshold. PRIMARY always
      // passes regardless of count (the dominant language is never marginal).
      // SECONDARIES must clear `min_files_per_secondary_language` (default 2).
      // This filters what is INJECTED — `detected_languages` stays full so
      // telemetry can still distinguish "language present but pruned" from
      // "language absent". Caller can opt out by passing `1`.
      const minSecondary = input.min_files_per_secondary_language ?? 2;
      const langsToInject = detected_languages.all.filter((lang) => {
        if (lang === detected_languages!.primary) return true;
        const count = detected_languages!.files_by_language[lang]?.length ?? 0;
        return count >= minSecondary;
      });
      // Look up supplements for the agents that have language-aware addenda.
      // Concurrent — each agent's supplement read is independent.
      const supplements = await Promise.all(
        LANGUAGE_AWARE_AGENTS.map(async (agent) => {
          try {
            const map = await readAgentLanguageSupplements(agent, langsToInject);
            return [agent, map] as const;
          } catch (err) {
            // Read failure is fail-soft — just no supplement for this agent.
            logger.warn("language supplement lookup failed; continuing without", {
              details: {
                agent,
                languages: langsToInject,
                message: err instanceof Error ? err.message : String(err),
              },
            });
            return [agent, {} as Record<string, string>] as const;
          }
        }),
      );
      language_supplements_by_agent = {};
      for (const [agent, map] of supplements) {
        if (Object.keys(map).length > 0) {
          language_supplements_by_agent[agent] = map;
        }
      }
      // Don't surface an empty record — keep the field absent if no agent
      // produced any supplement (clean output).
      if (Object.keys(language_supplements_by_agent).length === 0) {
        language_supplements_by_agent = undefined;
      }
    }
  }

  const plan_validation = validatePlanText({ plan: safePlan });

  const out: AdvisoryBundleOutput = {
    workflow,
    slices_by_agent,
    plan_validation,
    hunks_status,
  };
  if (hunks_by_agent) out.hunks_by_agent = hunks_by_agent;
  if (hunks_error) out.hunks_error = hunks_error;
  if (detected_languages) out.detected_languages = detected_languages;
  if (language_supplements_by_agent)
    out.language_supplements_by_agent = language_supplements_by_agent;
  return out;
}

export const composeAdvisoryBundleTool: ToolDef<typeof schema> = {
  name: "compose_advisory_bundle",
  description:
    "End-to-end advisory dispatch bundle. Runs compose_squad_workflow, then slice_files_for_agent for each " +
    "selected agent, then validate_plan_text on the supplied plan. Returns the union output ready for the " +
    "host to dispatch parallel advisory reviews.",
  schema,
  handler: composeAdvisoryBundle,
};
