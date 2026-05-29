import { z } from "zod";

/**
 * Centralised Zod primitives for tool input schemas. Tools historically
 * each redeclared `safeString` with a NUL-byte refine; the redeclarations
 * drifted (one checked space instead of NUL — see PR fixing the
 * compose_advisory_bundle bug). Import from here instead so the contract
 * lives in one place and a future schema bug surfaces in every consumer
 * at once.
 *
 * Conventions:
 *   - `SafeString(max)` — bounded UTF-8 string, no embedded NUL.
 *   - `WorkspaceRoot` — absolute or relative workspace path; bounded to 4096.
 *   - `Ref` — git ref (branch / tag / commit); bounded to 200.
 *   - `Prompt` — user-supplied free text; bounded to 8192.
 */

/**
 * Bounded UTF-8 string that must not contain a NUL byte. NUL bytes
 * terminate C strings and are common in path-confusion attacks; refusing
 * them at the schema edge is cheap insurance.
 */
export const SafeString = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.indexOf("\0") === -1, "must not contain NUL byte");

/**
 * One phase entry in the typed, deterministic `execution_plan` that
 * `compose_squad_workflow` emits ([O1], v1.7+).
 *
 * The plan is a machine-readable projection of the SKILL.md mode/skip rules:
 * given the already-resolved `mode`, risk signals, and selected agents, every
 * phase the orchestrator might run or skip is encoded as data so the skill
 * spine no longer has to re-derive the conditions in prose. It is purely
 * ADDITIVE — it does not replace any existing output field; consumers that
 * don't know about it simply ignore it.
 *
 * Fields:
 *   - `phase`        — stable SKILL.md phase number (4 Gate 1, 2 planner,
 *                      5 advisory, 10 consolidator).
 *   - `run`          — true if the phase executes in this run, false if skipped.
 *   - `skip_reason`  — present only when `run === false`; the mode/condition
 *                      that caused the skip ("quick", "micro", "review-mode").
 *   - `agents`       — advisors dispatched in this phase (Phase 5 only). Empty
 *                      / absent for phases that don't dispatch advisors.
 *   - `model_source` — always "frontmatter": each agent's own `model` pin wins
 *                      in EVERY mode (SKILL.md "Model strategy by mode").
 *   - `dispatch`     — "parallel" (≥1 advisor, concurrent Task calls),
 *                      "inline" (micro single-pass, no Task dispatch), or
 *                      "none" (phase doesn't dispatch advisors / is skipped).
 *   - `gate`         — "user" when the phase blocks on user approval (Gate 1,
 *                      Phase 4, implement mode only), else null.
 */
export const ExecutionStepSchema = z.object({
  phase: z.number().int(),
  run: z.boolean(),
  skip_reason: z.string().optional(),
  agents: z.array(z.string()).optional(),
  model_source: z.literal("frontmatter"),
  dispatch: z.enum(["parallel", "inline", "none"]),
  gate: z.enum(["user"]).nullable().optional(),
});

export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;
