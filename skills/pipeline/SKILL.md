---
name: pipeline
description: Chains the squad skills — brainstorm → grillme → tasks → next → implement → review — into one guided, human-gated sequence. The pipeline is a stateful advisor: each invocation figures out where you are, recommends the exact next command (it never auto-runs one), and explains the gate decision in front of you. State lives only in the conversation context — no file, no MCP tool, no telemetry of its own. Trigger when the user types /squad:pipeline, /pipeline, or asks to "run the full squad pipeline", "take this feature cradle-to-grave".
---

# Skill: Pipeline

## Objective

Take a feature from idea to verified change by chaining the six squad skills
into one sequence: **brainstorm → grillme → tasks → next → implement → review**.

The pipeline is a **stateful advisor**, not an executor. Each time it runs it
(1) reconstructs how far the feature has progressed from the conversation
context, (2) recommends the exact next command with arguments pre-filled, and
(3) explains the gate decision the user is about to make. The user fires every
command themselves — that hand-off IS the human gate.

Position in the workflow:

- The six skills run standalone when you want one step.
- **`/squad:pipeline`** runs them as a sequence for a feature going
  cradle-to-grave, so you never have to remember what comes next or how to
  wire one skill's output into the next skill's input.

## Inviolable Rules

1. **No telemetry of its own.** The pipeline is an orchestration skill. It MUST
   NOT call `record_run` and MUST NOT write any `.squad/` state. Every sub-skill
   it recommends already records its own run; a "pipeline run" is not a tracked
   entity. `/squad:stats` aggregates the sub-runs — that is the pipeline's
   telemetry, by composition.
2. **No auto-execution.** The pipeline only ever _recommends_ the next command.
   The user types it. Never invoke a sub-skill, Skill tool, or slash command on
   the user's behalf — auto-running would collapse the human gates that make the
   squad workflow safe.
3. **No persistence.** Pipeline state (which phases ran, their outputs) is
   reconstructed from the conversation context on every invocation. No state
   file, no `.squad/pipeline.json`, no MCP tool.
4. **No `git commit`, no `git push`.** Read-only git for context is fine. The
   sub-skills own their own writes; the user owns commits.
5. **Never edits source code.** The pipeline only prints text. The sub-skills
   it recommends do the building.
6. **No AI attribution** in anything the pipeline prints. Consistent with the
   squad-wide commit-authorship rule.

## Inputs

```
/squad:pipeline [--from <phase>] [--quick | --normal | --deep] <feature description>
```

| Flag             | Default      | Description                                                                       |
| ---------------- | ------------ | --------------------------------------------------------------------------------- |
| `--from <phase>` | `brainstorm` | Enter the pipeline at a specific phase. **Enumerated and validated** — see below. |
| `--quick`        | off          | Forwarded to every recommended sub-command. Smaller squads, tighter budgets.      |
| `--normal`       | default      | Forwarded as-is. Full pipeline at each step.                                      |
| `--deep`         | off          | Forwarded to every recommended sub-command. Larger squads, deeper research.       |

`--from` accepts ONLY this closed set:

```
brainstorm | grillme | tasks | next | implement | review
```

Any other value → **stop**, print `error: unknown phase '<value>'` followed by
the valid set, and do not guess. Default when omitted: `brainstorm`.

The free-form text after the flags is the feature description. **Capped at
16 KB**; truncate and surface `note: feature description truncated at 16 KB`.

## Phases

| #   | Phase        | Command recommended | Purpose                                | Skippable |
| --- | ------------ | ------------------- | -------------------------------------- | --------- |
| 1   | `brainstorm` | `/squad:brainstorm` | Explore _what_ to build (outward)      | yes       |
| 2   | `grillme`    | `/squad:grillme`    | Harden the plan vs MY codebase         | yes       |
| 3   | `tasks`      | `/squad:tasks`      | Decompose the plan into a task backlog | no        |
| 4   | `next`       | `/squad:next`       | Pick the next task from the backlog    | no        |
| 5   | `implement`  | `/squad:implement`  | Build it (full squad workflow)         | no        |
| 6   | `review`     | `/squad:review`     | Verify the change                      | yes       |

Phases 4–6 (`next → implement → review`) form an **inner loop** that repeats
once per task until the backlog is empty (see Phase 5 below).

## Phase 0 — Parse and validate

1. Parse `--from`. Validate against the closed set above. Invalid → stop with
   the error + valid set. No fuzzy matching.
2. Parse the depth flag (`--quick` / `--normal` / `--deep`); hold it to forward.
3. Capture the feature description; apply the 16 KB cap.

## Phase 1 — Reconstruct pipeline state

Read-only. Scan the conversation context for evidence of completed sub-skill
runs:

- a **brainstorm report** (`# Brainstorm — …` heading) → phase 1 done
- a **grill summary** (`# Grill summary — …`) → phase 2 done
- **tasks recorded** (a `record_tasks` result / task backlog) → phase 3 done
- an **implement verdict** (squad final verdict block) → phase 5 done for a task
- a **review verdict** → phase 6 done for a task

Set `current_phase`:

- if `--from` was passed → `current_phase = --from` (explicit override wins)
- else → the first phase with no completed output

If the conversation was compacted and prior outputs are gone, you cannot
reconstruct — see Edge Cases.

## Phase 2 — Present the pipeline map

Print all six phases with a status marker, e.g.:

```
Pipeline — {short feature name}    depth: normal
  [x] 1 brainstorm   done
  [x] 2 grillme      done
  [>] 3 tasks        current
  [ ] 4 next
  [ ] 5 implement
  [ ] 6 review
```

## Phase 3 — Recommend the next command

Emit the exact command for `current_phase`, with arguments pre-filled from the
feature description and the prior phase's output. Forward the depth flag.

Examples:

- entering `grillme` → `/squad:grillme --normal <chosen approach from the brainstorm matrix>`
- entering `tasks` → `/squad:tasks <hardened plan from the grill summary>`
- entering `implement` → `/squad:implement --normal <current task title + acceptance criteria>`

Print the command in a fenced block so it is copy-pasteable. Then **stop** —
the user runs it, then re-invokes `/squad:pipeline` to advance.

## Phase 4 — Gate semantics

When the user re-invokes `/squad:pipeline` after running a recommended command,
present the gate for the phase that just completed. Four decisions:

| Decision  | Meaning                        | Pipeline action                                                     |
| --------- | ------------------------------ | ------------------------------------------------------------------- |
| `proceed` | the phase output is good       | advance `current_phase` to the next phase; go to Phase 3            |
| `adjust`  | re-run this phase with changes | re-recommend the SAME phase, folding in the user's adjustment       |
| `skip`    | this phase is not needed       | advance without recording an output — **only `grillme` / `review`** |
| `exit`    | stop the pipeline here         | print the completion summary (Phase 6) and end                      |

`skip` is rejected for `tasks`, `next`, and `implement`: skipping `implement`
means nothing was built; skipping `tasks` / `next` means the inner loop has no
backlog to walk. Say so plainly and offer `proceed` or `exit` instead.

Call out at the gate which sub-skill mutated state: `brainstorm` and `grillme`
upstream are read-only-ish; `tasks` writes the backlog; `implement` writes code.

## Phase 5 — The inner loop (tasks → next → implement → review)

Once `tasks` has produced a backlog, phases `next → implement → review` repeat
once per task:

1. Recommend `/squad:next` → user picks/confirms a task.
2. Recommend `/squad:implement <task>` → user builds it.
3. Recommend `/squad:review` → user verifies it.
4. At the post-`review` gate: if tasks remain in the backlog → loop back to
   step 1; if the backlog is empty → go to Phase 6.

Track the remaining backlog from the conversation context. If it is unclear
how many tasks are left, recommend `/squad:next` again — it is the source of
truth and cheap to re-run.

## Phase 6 — Completion

When `review` passes on the last task (or the user chooses `exit`), print:

```
# Pipeline complete — {short feature name}

## Phases run
- brainstorm — {1-line outcome}
- grillme — {1-line outcome}
- tasks — N tasks
- implement / review — N tasks built and verified

## Skipped
- {phase} — {why, if the user skipped it}

## Next step
- `git diff` then commit when you are ready — the pipeline never commits.
```

## Edge Cases

- **No feature description and no `--from`** → ask one clarifying question:
  "what feature should the pipeline take cradle-to-grave?"
- **`--from implement` but no task backlog in context** → warn: "no backlog
  found — recommend `/squad:tasks` first, or pass a free-form task to
  `/squad:implement`."
- **User asks to skip `implement`** → reject (Phase 4); implement is the only
  phase whose whole point is the change.
- **Conversation compacted, prior outputs lost** → the pipeline cannot
  reconstruct state. Ask the user which phase they are on, or have them re-run
  with `--from <phase>`.
- **A sub-skill run failed** (e.g. `implement` halted at Gate 2 on a Blocker)
  → do not advance. Present `adjust` (re-run) or `exit`.
- **User runs a sub-skill directly without the pipeline** → fine; on the next
  `/squad:pipeline` invocation Phase 1 detects the output and advances anyway.

## Boundaries

- The pipeline never auto-runs a sub-skill — it only recommends.
- The pipeline never records telemetry and never writes `.squad/` state.
- The pipeline never persists its own state — context is the only store.
- The pipeline never edits source code or runs mutating git.
- The pipeline never carries AI attribution into anything it prints.

## Considerations

### Why model (b) — recommend-next-command

Auto-executing each sub-skill would collapse the human gates that make the
squad workflow safe (Gate 1 plan approval, Gate 2 Blocker halt). Recommend-next
keeps the user firing every command, so every phase boundary is a natural
checkpoint — at zero extra machinery.

### Why no telemetry of its own

A pipeline run is just N sub-skill runs, each already tracked by its own
`record_run`. A separate pipeline run id would double-count and need its own
store and schema. `/squad:stats` already aggregates the sub-runs.

### Discoverability

Registered as a command in `.claude-plugin/plugin.json`; carries a `CHANGELOG`
entry. The `brainstorm` and `implement` "Next step" lines may mention
`/squad:pipeline` as the cradle-to-grave alternative.
