---
description: Multi-agent advisory squad workflow for implementing changes — classification, risk scoring, agent selection, advisory review, consolidation.
argument-hint: "<task description>"
---

You are running the squad-dev workflow for the user's request:

$ARGUMENTS

Follow this orchestration exactly. Inviolable rules:

1. **No implementation before approval.** Stop at Gate 1 (plan approval) and Gate 2 (Blocker halt). Wait for explicit user confirmation before writing any code.
2. **Codex requires consent.** Never invoke Codex without `--codex` in the user prompt or explicit confirmation when High risk.
3. **TechLead-Consolidator owns the final verdict.** No merge without it.
4. **Advisory agents do not implement.** They report only.
5. **No `git commit` or `git push` from this workflow.** Commits and pushes are the user's call.

## Phase 0 — Setup

Use the squad MCP server (`squad`) for all orchestration. Required tools:

- `detect_changed_files` — find changed files in workspace
- `classify_work_type` — heuristic WorkType
- `score_risk` — compute risk level
- `select_squad` — pick advisory agents
- `slice_files_for_agent` — filter file list per agent
- `compose_squad_workflow` — pipeline of the four above (preferred — single call)
- `compose_advisory_bundle` — full bundle including plan validation
- `validate_plan_text` — check plan for inviolable-rule violations
- `get_agent_definition` — read an agent's full markdown
- `apply_consolidation_rules` — final verdict

## Phase 1 — Detect + classify + score + select

Run `compose_squad_workflow` with `workspace_root`, `user_prompt`, and `base_ref` (default `HEAD~1`). Surface `work_type`, `confidence`, `risk.level`, `squad.agents`, and any `low_confidence_files` to the user.

If the user wants to override, accept `force_work_type` or `force_agents`.

## Phase 2 — Build plan + tech-lead-planner in parallel

Construct an implementation plan from the user prompt and the file context. Simultaneously dispatch the `tech-lead-planner` agent (read its definition via `get_agent_definition`) on the plan draft. Absorb planner feedback before showing the plan.

## Phase 3 — Optional Codex plan review

If `--codex` flag present, or risk is High and the user opts in, dispatch Codex on the plan. **Do not auto-invoke without consent.**

## Phase 4 — Gate 1: user approval

Show the final plan. Wait for explicit "approved" / "go" / equivalent. Without that, stop.

## Phase 5 — Advisory squad (parallel, sliced)

For each agent in `squad.agents`, call `slice_files_for_agent` to get the file slice, then dispatch the agent with the prompt template from MCP prompt `agent_advisory` (arguments: `agent`, `plan`, `slice`). Run all dispatches in parallel.

## Phase 6 — Gate 2: Blocker halt

Aggregate findings. If any agent raised a Blocker, halt and ask the user before proceeding.

## Phase 7 — Optional escalation round

For Blocker/Major items in domains owned by agents not originally selected, spawn those agents only for the affected items.

## Phase 8 — Implementation

Implement the plan. Honor advisory acceptance criteria. Do not commit or push.

## Phase 9 — Optional Codex implementation review

Delta only. Same consent rules as Phase 3.

## Phase 10 — TechLead-Consolidator

Read `tech-lead-consolidator` definition. Pass it all reports plus the rules output from `apply_consolidation_rules`. It emits final verdict (`APPROVED` / `CHANGES_REQUIRED` / `REJECTED`) + rollback plan.

## Phase 11 — Gate 3: reject loop (max 2 iterations)

`REJECTED` → apply fixes, re-run affected agents on the delta, re-consolidate. Cap at 2 cycles; escalate to user if still rejected.

## Phase 12 — Wrap

Summarize what changed, where, advisory verdict, residual risks. Stop.
