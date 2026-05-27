# Squad — implement-mode phases

Phases 2, 4, 8, 9, and 11 of the squad skill (`skills/squad/SKILL.md`) — the
implement-mode-only phases. Loaded when the entry command is `/squad:implement`
(or task mode, which runs implement-mode against a task scope). Execute each at
its numbered slot in the SKILL.md spine; phase numbers are global. Shared phases
(1, 3, 5, 6, 7, 10, 12) stay in SKILL.md.

## Execution order (v1.5+, implement mode only)

```
Phase 1   detect + classify + score + select
Phase 2   tech-lead-planner stress-tests the plan        (skipped when --quick)
Phase 3   optional Codex review of plan                  (--codex / explicit High-risk only)
Phase 4   Gate 1: user approval of plan
Phase 8   implementer subagent executes against the plan
Phase 5   advisory squad scores the IMPLEMENTED DIFF     (was: pre-impl on plan)
Phase 6   Gate 2: Blocker halt (now on diff findings, not plan findings)
Phase 7   optional escalation round on cross-domain findings
Phase 10  apply_consolidation_rules + (optional) consolidator persona
Phase 11  reject-loop: REJECTED → re-dispatch implementer with prior-iteration findings
Phase 12  wrap
```

**Why advisory runs AFTER implementation.** Before v1.5, advisors stress-tested the plan draft (pre-impl). When the planner then revised the plan in response (plan v1 → plan v2), advisor scores became stale immediately — the rubric reflected plan v1 issues the new plan had already fixed. The fix: advisors review the actual diff produced by the implementer. Trade-off accepted: implementer runs without advisor guardrails on the first pass; the safety net is Phase 11 reject-loop on REJECTED. In practice the planner phase (Phase 2) already catches most plan-level mistakes, and post-impl advisory catches code-level issues the plan couldn't anticipate. Plan-stage advisory was redundant with the planner.

**Review mode order is unchanged.** Review runs Phase 5 / 6 / 10 / 12 against an existing diff — no implementation step exists, so no inversion applies.

## Phase 2 — Build plan + tech-lead-planner (implement mode only, skipped in quick)

Construct an implementation plan from the user prompt and the file context. Simultaneously dispatch the `tech-lead-planner` subagent on the plan draft via `Task(subagent_type="tech-lead-planner", description="Plan review", prompt=<plan + workspace context>)`. The `model` parameter is OMITTED in every mode (v1.5+); the agent's frontmatter governs. Absorb planner feedback before showing the plan to the user.

**Optional context-gathering via `code-explorer`.** When the diff is large, the file list is unfamiliar, or the planner explicitly asks for grounded context, the planner persona may dispatch the `code-explorer` subagent before drafting the plan: `Task(subagent_type="code-explorer", prompt="<targeted question>. breadth: medium")`. It is read-only, Haiku-class by frontmatter pin, and returns `file:line`-cited excerpts — designed to give the planner orientation without blowing the orchestrator's context window on full-file reads. Use one or two targeted dispatches, not five. The `model` parameter is OMITTED in every mode (v1.5+) — the haiku pin stays put.

**Skipped when `mode === "quick"`.** In quick mode, jump straight from Phase 1 to Phase 4 (Gate 1) with the plan you have, and trust the 2-agent advisory in Phase 5 to catch issues. Skipped entirely in review mode regardless of `mode`.

## Phase 4 — Gate 1: user approval (implement mode only)

Show the final plan. Wait for explicit "approved" / "go" / equivalent. Without that, stop.

Skip this gate entirely in review mode.

## Phase 8 — Implementation (implement mode only)

Implementation is dispatched to the dedicated `implementer` subagent (`agents/implementer.md`, pinned `model: opus`). The orchestrator does NOT edit files directly. Default: **single** `Task` dispatch per implementation step. Opt-in: **parallel** dispatch when the plan marks non-overlapping sub-tasks (see "Parallel sub-task dispatch" below).

### Dispatch contract (v1.5+ — slim prompt + no inline gates)

The dispatch prompt is intentionally short: paths only, no inlined file content. The implementer uses `Read` on-demand for the files it needs to touch. The orchestrator (NOT the implementer) runs `npm test` / `npm run lint` (or the polyglot equivalent) AFTER the dispatch returns. Pre-v1.5 the implementer embedded full hunks and ran tests inline; both behaviours added latency without proportionate quality gain. The implementer's job is now: read → edit → report. Gates are run once, externally.

```
Task(
  subagent_type: "implementer",
  description: "Execute approved plan",
  prompt: <
    ## Workspace
    workspace_root: <absolute path to repo root, same value passed to compose_squad_workflow>

    ## Approved plan
    {the plan from Phase 4, verbatim, including any clarifications the user made at Gate 1}

    ## Acceptance criteria
    {Bullet list of what the implementation must satisfy. Source priority (v1.5+ inverted order):
       1. First-pass dispatch — extract from the plan body's "Acceptance criteria" / "Definition of done"
          section if present; otherwise build from the plan's explicit success conditions (behaviour
          change matches the user request, no scope creep, files in scope only).
       2. Reject-loop dispatches (Phase 11) — see Prior-iteration findings below.
     Format: "- <criterion text>" — no agent prefix on first dispatch because advisors haven't run yet.
     Agent-prefixed criteria reappear in Phase 11 reject-loop dispatches when post-impl advisors raised
     findings the implementation must close.}

    ## Files in scope
    {Comma-or-newline-separated workspace-relative paths the agent is permitted to Edit/Write.
     Source: union of `slices_by_agent[a].matched.map(m => m.file)` for every advisor in `workflow.squad.agents` IF advisors ran (Phase 11 reject-loop).
     First-pass dispatch (v1.5+ inverted order): no advisor slices exist yet — source is the file list the plan explicitly names, or `workflow.changed_files.files.map(f => f.path)` filtered by `workflow.skipped_paths`.
     `implementer` is INTENTIONALLY not in any SQUAD_BY_TYPE entry — it is never auto-selected for slicing — so the orchestrator MUST compute the list here, not call `slice_files_for_agent({agent: "implementer"})`.

     NOTE (v1.5+): file CONTENT is NOT pasted into the prompt. The implementer uses `Read` on-demand on the paths above. This keeps the dispatch prompt small (~5-10× smaller on multi-file plans), reduces transmission latency, and lets the implementer choose what to read based on which files it actually needs to edit. The implementer is forbidden from Edit/Write on any path outside this list.}

    ## Past team decisions (omit section entirely if learnings.rendered is empty)
    {learnings.rendered — promoted entries first, then recent. Treat ⭐ PROMOTED as binding constraints.}

    ## Prior-iteration findings (Phase 11 reject-loop only — omit on first dispatch)
    {Structured list, one bullet per finding, exact format:
       - <severity>: <agent-name> — <finding title> — <one-line "what to fix" guidance derived from
         the consolidator's response or the post-impl reviewer's report>
     Severities are Blocker | Major (Minor / Suggestion are NOT re-fed — they are advisory-only).
     Source priority: (1) post-impl consolidator output from prior round, (2) any new advisor finding
     since the prior implementer report. Do NOT re-feed the prior implementer's own Section 6 Blockers
     verbatim — those were halts, not fixable findings, and they should have triggered Gate-1 re-entry
     instead of Phase 11.}
  >
  // model: "opus" is INHERITED from implementer.md frontmatter pin in every
  // mode (v1.5+). The skill never overrides at dispatch time; the pin is the
  // single source of truth for high-stakes steps.
)
```

### Post-dispatch gates (orchestrator runs, NOT the implementer)

After the implementer dispatch returns the Implementation Report, the orchestrator runs the project's test + lint commands ONCE via Bash. Detection priority:

1. `package.json` `scripts.test` + `scripts.lint` → `npm test` and `npm run lint`.
2. `pyproject.toml` `[tool.pytest.ini_options]` or `[tool.ruff]` → `pytest` + `ruff check`.
3. `Cargo.toml` → `cargo test` + `cargo clippy`.
4. `*.csproj` / `*.sln` → `dotnet test` + `dotnet format --verify-no-changes`.
5. None of the above → skip post-dispatch gates and surface `gates: "not_runnable"` in the wrap.

Capture the exit code + last ~50 lines of stdout/stderr. Wall-clock cap: 5 min per command (`timeout` flag on Bash). On timeout: surface as Blocker, enter Phase 11.

Outcomes:

- Both green → proceed to Phase 5 (advisory squad on the diff).
- Either failed → enter Phase 11 reject-loop with the failure as a synthetic Blocker finding (`agent: "implementer"`, `title: "post-impl gate failure"`, `detail: <stderr tail>`). Skip Phase 5 on this iteration — there is nothing to review until gates pass.

The implementer SHOULD NOT have run gates internally. If the report's Section 3 ("Tests run") is non-empty, treat it as informational only — the orchestrator's gate run is the authoritative result.

### Parallel sub-task dispatch (v1.5+, opt-in via plan markers)

When the approved plan declares independent sub-tasks with NON-OVERLAPPING file scope, the orchestrator MAY dispatch them in parallel — multiple `Task(subagent_type: "implementer", ...)` calls in a SINGLE assistant message, same parallelism contract as Phase 5 advisors. Each parallel implementer gets its own slice (paths only). All reports merge into a composite Section 2 / 6 for the orchestrator's downstream Phase 5 (advisory on the combined diff) and Phase 10.

#### Trigger

The orchestrator activates parallel dispatch ONLY when the plan body explicitly marks groups. Two supported syntaxes:

1. **Section-suffix marker**: `### F1 — <title> (parallel-group: 1)` — sub-tasks sharing the same group number run in parallel; groups run sequentially (group 1 → group 2 → ...).
2. **Top-of-plan declaration**: a fenced block tagged `parallel-groups` containing a JSON array of arrays of sub-task ids: `[["F1","F2"], ["F3"], ["F4","F5"]]` — same group semantics.

If neither marker is present, run the implementer sequentially (single dispatch, default behaviour). The orchestrator does NOT infer parallelism from heuristics — only from explicit markers — because the cost of a wrong inference (two implementers editing the same file) is unbounded.

#### Slice computation per sub-task

For each parallel sub-task, the file scope MUST be the union of paths that sub-task names + paths the planner explicitly attributes to it. The orchestrator verifies pairwise non-overlap before dispatching: if any path appears in two sub-tasks of the SAME parallel group, abort the parallel optimisation and fall back to sequential dispatch (surface a `mode_warning` to the user). Path overlap is a plan defect; the orchestrator does not silently serialise around it.

#### Worst-case cost vs wall-clock

| Plan shape                | Sequential cost (Opus dispatches) | Sequential wall-clock | Parallel cost (Opus dispatches) | Parallel wall-clock           |
| ------------------------- | --------------------------------- | --------------------- | ------------------------------- | ----------------------------- |
| 5 findings, all parallel  | 1                                 | ~700 s (whole batch)  | 5                               | ~150-300 s (longest sub-task) |
| 5 findings, 2 + 3 grouped | 1                                 | ~700 s                | 5 (2 + 3 across two groups)     | ~300 + 200 s = 500 s          |
| 5 findings, sequential    | 1                                 | ~700 s                | 1                               | ~700 s                        |

Parallel dispatch BURNS more Opus calls in exchange for wall-clock. The user explicitly opted in by writing parallel markers in the plan; the orchestrator does not auto-parallelise to avoid surprising cost spikes.

#### Reject-loop semantics with parallel groups

If post-dispatch gates fail OR Phase 5 raises a Blocker that traces to a specific sub-task, Phase 11 re-dispatches ONLY that sub-task (or the affected group), not the whole implementation. Other sub-tasks' work is preserved. Reject-loop cap (1 / 2 / 3 per mode) applies per sub-task, not per group.

#### Failure mode protection

If ANY parallel implementer dispatch returns Section 6 Blocker (could-not-complete), halt the whole flow immediately and surface to user — do NOT proceed to Phase 5 with a partial implementation. Mixed-state diffs are harder to review than serial failures.

### Handling the Implementation Report

The agent returns a 6-section Implementation Report. The orchestrator MUST inspect it before proceeding to Phase 9 / Phase 10:

| Section                         | Orchestrator action                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Plan summary                 | Verify the agent's restatement matches the plan you passed. If materially divergent (agent misread scope), halt and surface to user — do NOT proceed to Phase 9/10 with a wrong-scope implementation.                                                                                                                                                                                                                                                                    |
| 2. Changes made                 | Surface to user verbatim under "Implementation: changes made".                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3. Tests run                    | Pre-v1.5 source. v1.5+: the implementer SHOULD NOT have run tests; this section is informational only. The AUTHORITATIVE test/lint result comes from the orchestrator's post-dispatch gate run (see "Post-dispatch gates" above). If the implementer ran tests anyway, surface its output verbatim but DO NOT skip the orchestrator's external run on its basis.                                                                                                         |
| 4. Acceptance criteria coverage | Verify all criteria are ✅ or have justified ⚠️/❌. ANY ❌ → halt and surface to user (the implementation does not meet what the squad approved).                                                                                                                                                                                                                                                                                                                        |
| 5. Out of scope                 | Surface to user as advisory only. NOT a blocker.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6. Blockers                     | **If non-empty, HALT.** Do NOT proceed to Phase 9 (Codex review), Phase 10 (consolidator), or Phase 11 (reject-loop). The agent could not complete the plan; the right path is to surface the Section 6 content to the user, present them with options (re-enter Gate 1 with revised plan / abandon / manually intervene), and STOP. Treating Section 6 Blockers as a normal Phase-11 input would loop the agent against an obstacle it already declared insurmountable. |

### Worst-case cost

`--deep` mode caps Phase 11 at 3 reject-loop cycles. With Phase 8 itself being 1 dispatch, the worst case is **4 Opus implementer dispatches per `/squad:implement --deep`** (1 first-pass + 3 reject-loop iterations). Budget accordingly. `--normal` caps at 2 (3 total Opus dispatches). `--quick` caps at 1 (2 total).

### Why a subagent and not the orchestrator

1. **Model guarantee.** Pre-v0.13, the orchestrator's editing inherited the user's session model (often Sonnet for cost). The frontmatter pin on `implementer` ensures implementation always runs at Opus regardless of the session default.
2. **Context isolation.** The implementer prompt carries only the approved plan + acceptance criteria + files. It is not contaminated by the conversation backlog (other branches the user explored before the plan crystallised). Behaviour is deterministic for a given plan.

**Inviolable rules preserved.** The agent's frontmatter and prose forbid `git commit`, `git push`, AI attribution, and scope creep beyond the plan. The agent halts and reports if it cannot complete a step — does NOT leave TODO comments or silently extend scope.

**Reject-loop continuity.** Phase 11 re-dispatches the same `subagent_type` — Claude Code spawns a fresh subagent each time, with zero memory of prior iterations. `prior_iteration_findings` is the ONLY continuity channel between iterations; its schema is defined above and the orchestrator MUST follow it precisely.

Skip this phase entirely in review mode.

## Phase 9 — Optional Codex implementation review (implement mode only)

Delta only. Same consent rules as Phase 3.

## Phase 11 — Gate 3: reject loop (implement mode only)

`REJECTED` → apply fixes, re-run affected agents on the delta, re-consolidate. Iteration cap depends on `mode`:

- `mode === "normal"` (default): 2 cycles.
- `mode === "deep"`: 3 cycles — deep mode opted into thoroughness, accept the extra round.
- `mode === "quick"`: 1 cycle — quick mode optimises for speed; if the first re-pass still rejects, escalate to user immediately rather than spending more wall time.

Escalate to user if the cap is hit while still rejected. Skip this gate in review mode — the verdict is the output.
