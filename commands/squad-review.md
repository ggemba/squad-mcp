---
description: Multi-agent advisory review of an existing branch, PR, or set of changes — same agents and severity model as /squad, but review-only (no implementation).
argument-hint: "<branch | PR# | path | nothing for current diff>"
---

You are running the squad-review workflow for the user's request:

$ARGUMENTS

Review-only. **Never implement, commit, or push.** Output is advisory only.

## Inviolable rules

1. No code changes. No commits. No pushes.
2. Codex (`--codex`) requires consent.
3. TechLead-Consolidator owns the final verdict.
4. Each agent receives only its sliced view of the changes.

## Phase 0 — Resolve target

If the argument is empty: review the current uncommitted diff (`base_ref` = `HEAD`, `staged_only=false`).
If a branch: review `<branch>..HEAD` or `main..<branch>` per user intent.
If a PR number: fetch the diff and treat as a branch range.
If a path: review the working-tree changes under that path.

## Phase 1 — Detect changes + select agents

Use the squad MCP server. Run `compose_advisory_bundle` with:

- `workspace_root` = repo root
- `base_ref` = resolved from Phase 0
- `user_prompt` = "review the changes in this diff" (or richer if user gave context)
- `plan` = "" (no plan to validate in review-only mode; pass empty or a stub)

The bundle returns: `workflow.changed_files`, `workflow.classification`, `workflow.risk`, `workflow.squad.agents`, `slices_by_agent`, `plan_validation` (skip in review).

Surface to the user: file count, work type, risk level, selected agents.

## Phase 2 — Optional Codex pre-review

If `--codex` present, dispatch Codex on the diff for an independent read. Same consent rules as `/squad`.

## Phase 3 — Advisory squad (parallel, sliced)

For each agent in `squad.agents`, dispatch with the `agent_advisory` MCP prompt. Each agent gets only its `slices_by_agent[<agent>]` view.

Each agent emits findings tagged Blocker / Major / Minor / Suggestion per `_Severity-and-Ownership.md`.

## Phase 4 — Optional escalation

If a Blocker/Major touches a domain whose owner was not selected, spawn that agent for the affected slice only.

## Phase 5 — TechLead-Consolidator

Read `tech-lead-consolidator` definition. Pass all reports + the `apply_consolidation_rules` output. It emits the merge verdict.

## Phase 6 — Output

Single consolidated report:

- Diff summary: files, work_type, risk
- Per-agent findings (severity tagged)
- Cross-cutting concerns
- Final verdict: `APPROVED` / `CHANGES_REQUIRED` / `REJECTED`
- Rollback / mitigation guidance
- Suggested follow-ups (optional, not required for merge)

Stop. Do not implement, commit, or push.
