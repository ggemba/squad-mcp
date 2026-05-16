# Squad — implement-mode phases

Phases 2, 4, 8, 9, and 11 of the squad skill (`skills/squad/SKILL.md`) — the
implement-mode-only phases. Loaded when the entry command is `/squad:implement`
(or task mode, which runs implement-mode against a task scope). Execute each at
its numbered slot in the SKILL.md spine; phase numbers are global. Shared phases
(1, 3, 5, 6, 7, 10, 12) stay in SKILL.md.

## Phase 2 — Build plan + tech-lead-planner (implement mode only, skipped in quick)

Construct an implementation plan from the user prompt and the file context. Simultaneously dispatch the `tech-lead-planner` subagent on the plan draft via `Task(subagent_type="tech-lead-planner", description="Plan review", prompt=<plan + workspace context>{, model: "opus" when mode === "deep"})`. Absorb planner feedback before showing the plan to the user.

**Optional context-gathering via `code-explorer`.** When the diff is large, the file list is unfamiliar, or the planner explicitly asks for grounded context, the planner persona may dispatch the `code-explorer` subagent before drafting the plan: `Task(subagent_type="code-explorer", prompt="<targeted question>. breadth: medium"{, model: "opus" when mode === "deep"})`. It is read-only, Haiku-class by default, and returns `file:line`-cited excerpts — designed to give the planner orientation without blowing the orchestrator's context window on full-file reads. Use one or two targeted dispatches, not five. **In `deep` mode the explorer also upgrades to opus per the global override** — slower than its haiku default but consistent with the depth-over-speed contract of `--deep`.

**Skipped when `mode === "quick"`.** In quick mode, jump straight from Phase 1 to Phase 4 (Gate 1) with the plan you have, and trust the 2-agent advisory in Phase 5 to catch issues. Skipped entirely in review mode regardless of `mode`.

## Phase 4 — Gate 1: user approval (implement mode only)

Show the final plan. Wait for explicit "approved" / "go" / equivalent. Without that, stop.

Skip this gate entirely in review mode.

## Phase 8 — Implementation (implement mode only)

Implementation is dispatched to the dedicated `implementer` subagent (`agents/implementer.md`, pinned `model: opus`). The orchestrator does NOT edit files directly anymore. Single `Task` dispatch, not parallel — there is exactly one implementer per implementation step.

### Dispatch contract

````
Task(
  subagent_type: "implementer",
  description: "Execute approved plan",
  prompt: <
    ## Workspace
    workspace_root: <absolute path to repo root, same value passed to compose_squad_workflow>
    test_command_hint: <one-line hint inferred from package.json `test` script,
                        OR `pyproject.toml` / `Cargo.toml` / `*.csproj`,
                        OR "unknown — agent should detect and report">
    lint_command_hint: <same shape>

    ## Approved plan
    {the plan from Phase 4, verbatim, including any clarifications the user made at Gate 1}

    ## Advisory acceptance criteria
    {bullet list per advisory agent — what the implementation must satisfy to pass each one's review.
     Format: "- [<agent-name>] <criterion text>" so the agent can map back to ✅/⚠️/❌ in Section 4.}

    ## Files in scope
    {Comma-or-newline-separated workspace-relative paths the agent is permitted to Edit/Write.
     Source: union of `slices_by_agent[a].matched.map(m => m.file)` for every advisor in `workflow.squad.agents`.
     Falls back to `workflow.changed_files.files.map(f => f.path)` filtered by `workflow.skipped_paths` when no advisor selected the file (rare, but possible for cross-cutting changes).
     `implementer` is INTENTIONALLY not in any SQUAD_BY_TYPE entry — it is never auto-selected for slicing — so the orchestrator MUST compute the union here, not call `slice_files_for_agent({agent: "implementer"})`.}

    ## Files in scope — diffs (when hunks_by_agent populated)
    {Per-file hunks (UNION across all advisor slices), pasted as fenced ```diff blocks. Truncated hunks
     carry the standard `[... diff truncated by squad-mcp ...]` marker — the agent uses Read to fetch
     full context for those.}

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
  // model: "opus" is INHERITED from implementer.md frontmatter pin in
  // --quick and --normal modes. In --deep mode the skill-level Opus override
  // (line ~230) also applies and is a no-op since the pin already gave Opus.
)
````

### Handling the Implementation Report

The agent returns a 6-section Implementation Report. The orchestrator MUST inspect it before proceeding to Phase 9 / Phase 10:

| Section                         | Orchestrator action                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Plan summary                 | Verify the agent's restatement matches the plan you passed. If materially divergent (agent misread scope), halt and surface to user — do NOT proceed to Phase 9/10 with a wrong-scope implementation.                                                                                                                                                                                                                                                                    |
| 2. Changes made                 | Surface to user verbatim under "Implementation: changes made".                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3. Tests run                    | Surface to user verbatim under "Implementation: test run". If a test newly failed, halt and re-enter Phase 11 reject-loop with the failure as a Blocker finding.                                                                                                                                                                                                                                                                                                         |
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
