import { z } from "zod";
import type { ToolDef } from "./registry.js";
import { EXEC_MODES } from "./compose-squad-workflow.js";
import {
  composeWorkflowCore,
  type ComposeCoreInput,
  type ComposeWorkflowOutput,
} from "./_shared/compose-core.js";
import { sliceFilesForAgent, type SliceOutput } from "./slice-files.js";
import { validatePlanText, type ValidatePlanOutput } from "./validate-plan-text.js";
import { extractFileHunks, type FileHunk } from "../exec/diff-hunks.js";
import {
  detectLanguages,
  detectFrameworks,
  type LanguageDetection,
} from "../exec/detect-languages.js";
import {
  readAgentLanguageSupplements,
  readAgentFrameworkSupplements,
} from "../resources/agent-loader.js";
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
  "developer",
  "reviewer",
  "qa",
  "implementer",
] as const;

/**
 * Build the ready-to-emit single-pass review prompt for `mode: "micro"`
 * (v1.7+). Concatenates all changed-file hunks, the user's stated criteria
 * (or defaults), and a scorecard template. The orchestrator pastes the
 * result into its own response — no subagent dispatch is involved.
 *
 * Why a separate helper: the existing per-agent slice + per-agent hunks path
 * is wired for N parallel dispatches, and threading micro through it would
 * leak the "no dispatch" branch into every per-agent loop. Separating keeps
 * the existing path untouched for quick/normal/deep callers.
 *
 * Fail-soft on hunk extraction: matches the bundle's existing policy. If git
 * diff fails mid-call, the prompt is still emitted with a "[diff extraction
 * failed: <code>]" placeholder so the orchestrator surfaces something
 * actionable instead of erroring.
 */
async function buildMicroPrompt(args: {
  workflow: ComposeWorkflowOutput;
  filePaths: string[];
  workspaceRoot: string;
  baseRef?: string;
  stagedOnly: boolean;
  maxHunkBytes: number;
  userPrompt: string;
}): Promise<{
  prompt: string;
  hunks_status: AdvisoryBundleOutput["hunks_status"];
  hunks_error?: { code: string; message: string };
  detected_languages?: LanguageDetection;
}> {
  const { workflow, filePaths } = args;
  const detected = filePaths.length > 0 ? detectLanguages(filePaths) : undefined;

  let diffText = "[no changed files]";
  let hunks_status: AdvisoryBundleOutput["hunks_status"] = "skipped";
  let hunks_error: { code: string; message: string } | undefined;

  if (filePaths.length > 0) {
    try {
      const ctx = createSafePathContext();
      const safeCwd = await resolveSafePath(args.workspaceRoot, ".", ctx);
      const hunksInput: Parameters<typeof extractFileHunks>[0] = {
        cwd: safeCwd,
        files: filePaths,
        staged_only: args.stagedOnly,
        max_bytes_per_file: args.maxHunkBytes,
      };
      if (args.baseRef !== undefined) hunksInput.base_ref = args.baseRef;
      const allHunks = await extractFileHunks(hunksInput);
      const parts: string[] = [];
      for (const p of filePaths) {
        const h = allHunks[p];
        if (h === undefined) continue;
        parts.push(`### ${p}${h.truncated ? "  (truncated)" : ""}`);
        parts.push("```diff");
        parts.push(h.diff);
        parts.push("```");
      }
      diffText = parts.length > 0 ? parts.join("\n") : "[diff produced no hunks]";
      hunks_status = "ok";
    } catch (err) {
      const code = isSquadError(err) ? err.code : "UNKNOWN";
      const message = err instanceof Error ? err.message : String(err);
      hunks_status = "extraction_failed";
      hunks_error = { code, message };
      diffText = `[diff extraction failed: ${code}: ${message}]`;
      logger.warn("micro_prompt: hunks extraction failed", {
        details: { code, message, files_count: filePaths.length },
      });
    }
  }

  const triggerLabel = workflow.mode_source === "user" ? "user-forced" : "auto-detected";
  const locShown = workflow.inferred_risk_signals.loc_changed ?? "n/a";
  const stack = detected && detected.all.length > 0 ? detected.all.join(", ") : "unrecognised";

  const userCriteria = args.userPrompt.trim();
  const criteriaSection =
    userCriteria.length > 0
      ? `O solicitante pediu foco em:\n\n> ${userCriteria.replace(/\n/g, "\n> ")}\n\nAplique esses critérios ao analisar o diff abaixo.`
      : `Nenhum critério específico informado. Análise geral cobrindo:\n` +
        `- Qualidade e legibilidade\n` +
        `- Possíveis bugs / edge cases\n` +
        `- Boas práticas e padrões idiomáticos do stack\n` +
        `- Segurança visível no diff\n` +
        `- Performance visível no diff`;

  const prompt =
    `# Code Review — micro mode\n\n` +
    `- **Modo:** micro (${triggerLabel}: ${workflow.inferred_risk_signals.files_count} files, ${locShown} LOC, risk=${workflow.risk.level})\n` +
    `- **Stack detectado:** ${stack}\n` +
    `- **Work type:** ${workflow.work_type}\n\n` +
    `## Critérios\n\n${criteriaSection}\n\n` +
    `## Diff\n\n${diffText}\n\n` +
    `## Instruções\n\n` +
    `Analise o diff acima. Aponte problemas, sugestões e elogios. Cite file:line. Seja específico e construtivo.\n\n` +
    `Ao final emita o scorecard EXATAMENTE neste formato:\n\n` +
    `### Scorecard\n\n` +
    `| Critério                | Nota (0-10) | Observação                |\n` +
    `|-------------------------|-------------|---------------------------|\n` +
    `| Segurança               | X           | ...                       |\n` +
    `| Legibilidade            | X           | ...                       |\n` +
    `| Manutenibilidade        | X           | ...                       |\n` +
    `| Performance             | X           | ...                       |\n` +
    `| Boas Práticas / Padrões | X           | ...                       |\n` +
    `| Tratamento de Erros     | X           | ...                       |\n` +
    `| **Nota Geral**          | **X**       | Média ponderada ou parecer|\n\n` +
    `Regras: 0-3 crítico, 4-6 aceitável, 7-8 bom, 9-10 excelente.\n\n` +
    `### Verdict\n\n` +
    `Após o scorecard, declare o verdict em uma linha:\n` +
    `- \`APPROVED\` quando a Nota Geral é ≥ 7.5 e não há finding com severidade Blocker.\n` +
    `- \`CHANGES_REQUIRED\` quando 5.0 ≤ Nota Geral < 7.5 OU há pelo menos 1 Blocker.\n` +
    `- \`REJECTED\` quando Nota Geral < 5.0 ou o diff demonstra defeito estrutural.\n`;

  const result: {
    prompt: string;
    hunks_status: AdvisoryBundleOutput["hunks_status"];
    hunks_error?: { code: string; message: string };
    detected_languages?: LanguageDetection;
  } = { prompt, hunks_status };
  if (hunks_error) result.hunks_error = hunks_error;
  if (detected) result.detected_languages = detected;
  return result;
}

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
  /**
   * Ready-to-emit single-pass review prompt (v1.7+). Present iff
   * `workflow.mode === "micro"`. The orchestrator pastes this string into its
   * own response — no subagent dispatch happens. When this field is present,
   * `slices_by_agent` is `{}` and `hunks_by_agent` / `language_supplements_by_agent`
   * are absent (micro mode bypasses per-agent fan-out entirely).
   *
   * Includes the full diff inline (concatenation of all per-file hunks),
   * detected stack, work type, user criteria (or defaults), and a scorecard +
   * verdict template. Sized for the orchestrator's prompt budget — files are
   * still capped at `max_hunk_bytes_per_file`, and micro mode only triggers
   * on diffs of <30 LOC by default so truncation is rare.
   */
  micro_prompt?: string;
}

export async function composeAdvisoryBundle(input: Input): Promise<AdvisoryBundleOutput> {
  // Sanitize at the prompt boundary — strips invisibles, role tokens, normalises NFKC.
  // See src/util/prompt-sanitize.ts. Apply once at the top of the handler; downstream
  // calls (composeWorkflowCore, validatePlanText) receive the sanitized values.
  const safeUserPrompt = sanitizeForPrompt(input.user_prompt);
  const safePlan = sanitizeForPrompt(input.plan);

  // Run the shared compose pipeline. `compose_advisory_bundle` and
  // `compose_squad_workflow` both delegate the detect -> classify -> score ->
  // select -> mode-resolution work to `composeWorkflowCore` (see
  // `_shared/compose-core.ts`); this tool then layers slices / hunks /
  // plan_validation / language supplements on top of the result.
  const workflowInput: ComposeCoreInput = {
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

  const workflow = await composeWorkflowCore(workflowInput);

  // Use the FILTERED list (skip_paths already applied by composeWorkflowCore).
  // Slicing has to operate on the same set of files the squad was selected over,
  // otherwise an agent would receive paths the composer just hid.
  const allChanged = workflow.changed_files.files.map((f) => f.path);
  const skippedSet = new Set(workflow.skipped_paths);
  const filePaths = allChanged.filter((p) => !skippedSet.has(p));

  // v1.7+ micro mode: short-circuit the per-agent fan-out entirely. Build the
  // single-pass `micro_prompt` and return early. `slices_by_agent` is empty
  // (shapeSquadForMode already returned `agents: []` so there's nothing to
  // slice anyway); hunks / language supplements are absent because micro
  // bundles the full diff inline in the prompt instead of fanning it out.
  // plan_validation still runs (it's cheap and the empty plan path produces
  // an empty validation, which the orchestrator ignores in review mode).
  if (workflow.mode === "micro") {
    const micro = await buildMicroPrompt({
      workflow,
      filePaths,
      workspaceRoot: input.workspace_root,
      ...(input.base_ref !== undefined ? { baseRef: input.base_ref } : {}),
      stagedOnly: input.staged_only,
      maxHunkBytes: input.max_hunk_bytes_per_file ?? 8192,
      userPrompt: safeUserPrompt,
    });
    const plan_validation = validatePlanText({ plan: safePlan });
    const out: AdvisoryBundleOutput = {
      workflow,
      slices_by_agent: {},
      plan_validation,
      hunks_status: micro.hunks_status,
      micro_prompt: micro.prompt,
    };
    if (micro.hunks_error) out.hunks_error = micro.hunks_error;
    if (micro.detected_languages) out.detected_languages = micro.detected_languages;
    return out;
  }

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
    const frameworks = detectFrameworks(filePaths);

    // Per-agent supplement maps, merged from the language pass and the
    // framework pass. Both feed the same `language_supplements_by_agent`
    // field — the host injects every entry the same way.
    const byAgent: Partial<Record<AgentName, Record<string, string>>> = {};
    const mergeInto = (pairs: ReadonlyArray<readonly [AgentName, Record<string, string>]>) => {
      for (const [agent, map] of pairs) {
        if (Object.keys(map).length === 0) continue;
        byAgent[agent] = { ...(byAgent[agent] ?? {}), ...map };
      }
    };

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
      mergeInto(
        await Promise.all(
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
        ),
      );
    }

    // Framework supplements run independently of language detection — a pure
    // `.vue` / `.svelte` PR has no recognised Language but still has a
    // framework. Today only `reviewer` ships a `.frameworks/` directory; the
    // other agents return empty maps and are skipped.
    if (frameworks.length > 0) {
      mergeInto(
        await Promise.all(
          LANGUAGE_AWARE_AGENTS.map(async (agent) => {
            try {
              const map = await readAgentFrameworkSupplements(agent, frameworks);
              return [agent, map] as const;
            } catch (err) {
              logger.warn("framework supplement lookup failed; continuing without", {
                details: {
                  agent,
                  frameworks,
                  message: err instanceof Error ? err.message : String(err),
                },
              });
              return [agent, {} as Record<string, string>] as const;
            }
          }),
        ),
      );
    }

    // Don't surface an empty record — keep the field absent if no agent
    // produced any supplement (clean output).
    if (Object.keys(byAgent).length > 0) {
      language_supplements_by_agent = byAgent;
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
