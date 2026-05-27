---
name: pipeline
description: Cradle-to-grave executor for the full squad workflow: brainstorm → grillme → tasks → next → implement → review. Auto-invokes each sub-skill in sequence and halts only at explicit user-decision gates. The user fires ONE command at the start and answers inline gate questions thereafter — no re-typing slash commands between phases. Triggers: "run the full squad pipeline", "take this feature cradle-to-grave", "walk me through from idea to merge", "whole feature flow", "guide me end-to-end", "/squad:pipeline". Pass --from <phase> to enter mid-sequence. Example: "/squad:pipeline new notifications system".
---

# Skill: Pipeline

## Objective

Take a feature from idea to verified change by chaining the six squad skills
into one auto-executed sequence: **brainstorm → grillme → tasks → next →
implement → review**.

The pipeline is an **executor with explicit gates** (v1.5+). It (1)
reconstructs how far the feature has progressed from the conversation
context, (2) auto-invokes the next sub-skill via the `Skill` tool, and
(3) halts at each phase boundary to ask the user whether to proceed.
The user fires ONE entry command and answers inline gate questions; no
re-typing slash commands between phases.

Position in the workflow:

- The six skills run standalone when you want one step.
- **`/squad:pipeline`** runs them as an executed sequence for a feature
  going cradle-to-grave, so the user never has to copy-paste a slash
  command between phases.

## Inviolable Rules

1. **No telemetry of its own.** The pipeline is an orchestration skill. It
   MUST NOT call `record_run`. Every sub-skill it invokes already records
   its own run; a "pipeline run" is not a tracked entity. `/squad:stats`
   aggregates the sub-runs — that is the pipeline's telemetry, by
   composition. (The thin `.squad/pipeline-state.json` resume cache from
   Rule 3 is NOT telemetry — it is per-feature state for resume only and
   never feeds `/squad:stats`.)
2. **Auto-execution between explicit gates.** Pre-v1.5 the pipeline only
   recommended commands and the user typed them. From v1.5 the pipeline
   invokes sub-skills directly via the `Skill` tool, but ONLY between
   explicit user-decision gates. Every phase boundary is a halt with an
   `AskUserQuestion` (`proceed` / `adjust` / `skip` / `exit`); sub-skills'
   own internal gates (e.g. `/squad:implement` Gate 1 plan approval, Gate 2
   Blocker halt) keep firing as before. The pipeline never silently
   advances past a gate. The reserved interruption commands (see "Reserved
   commands" below) let the user break out at any point.
3. **State persistence is a thin resume cache, not a journal.** From
   v1.5+ the pipeline writes a minimal `.squad/pipeline-state.json` so
   the user can resume across context compaction or a closed session.
   The file carries phase status + 1-line outcomes only — NO full
   sub-skill outputs, NO secrets, NO conversation transcripts. File mode
   `0o600`, single-writer (only the pipeline writes), gitignored. On
   every `/squad:pipeline` invocation the pipeline reads this file
   FIRST, then falls back to scanning conversation context for anything
   the file does not cover. See "State persistence" section below for
   schema + lifecycle.
4. **No `git commit`, no `git push`.** Read-only git for context is fine.
   Sub-skills own their own writes; the user owns commits.
5. **Never edits source code directly.** The pipeline only invokes
   sub-skills and prints inter-phase gate text. The sub-skills it invokes
   do the building.
6. **No AI attribution** in anything the pipeline prints. Consistent with
   the squad-wide commit-authorship rule.

## Inputs

```
/squad:pipeline [--from <phase>] [--quick | --normal | --deep] <feature description>
```

| Flag             | Default      | Description                                                                       |
| ---------------- | ------------ | --------------------------------------------------------------------------------- |
| `--from <phase>` | `brainstorm` | Enter the pipeline at a specific phase. **Enumerated and validated** — see below. |
| `--quick`        | off          | Forwarded to every invoked sub-skill. Smaller squads, tighter budgets.            |
| `--normal`       | default      | Forwarded as-is. Full pipeline at each step.                                      |
| `--deep`         | off          | Forwarded to every invoked sub-skill. Larger squads, deeper research.             |

`--from` accepts ONLY this closed set:

```
brainstorm | grillme | tasks | next | implement | review
```

Any other value → **stop**, print `error: unknown phase '<value>'` followed
by the valid set, and do not guess. Default when omitted: `brainstorm`.

The free-form text after the flags is the feature description. **Capped at
16 KB**; truncate and surface `note: feature description truncated at 16 KB`.

## Phases

| #   | Phase        | Sub-skill invoked  | Purpose                                | Skippable |
| --- | ------------ | ------------------ | -------------------------------------- | --------- |
| 1   | `brainstorm` | `squad:brainstorm` | Explore _what_ to build (outward)      | yes       |
| 2   | `grillme`    | `squad:grillme`    | Harden the plan vs MY codebase         | yes       |
| 3   | `tasks`      | `squad:tasks`      | Decompose the plan into a task backlog | no        |
| 4   | `next`       | `squad:next`       | Pick the next task from the backlog    | no        |
| 5   | `implement`  | `squad:implement`  | Build it (full squad workflow)         | no        |
| 6   | `review`     | `squad:review`     | Verify the change                      | yes       |

Phases 4–6 (`next → implement → review`) form an **inner loop** that
repeats once per task until the backlog is empty (see Phase 5 below).

## Phase 0 — Parse and validate

1. Parse `--from`. Validate against the closed set above. Invalid → stop
   with the error + valid set. No fuzzy matching.
2. Parse the depth flag (`--quick` / `--normal` / `--deep`); hold it to
   forward.
3. Capture the feature description; apply the 16 KB cap.

## Phase 1 — Reconstruct pipeline state

Source priority (v1.5+):

1. **Read `.squad/pipeline-state.json`** if it exists AND it carries an
   in-progress run (`status` ∈ {`in_progress`}). This is the
   authoritative source — it survives context compaction and closed
   sessions. Validate the file against the schema in "State persistence"
   below; on parse error fall back to step 2 and log a one-line warning.
2. **Fall back to scanning the conversation context** for evidence of
   completed sub-skill runs:
   - a **brainstorm report** (`# Brainstorm — …` heading) → phase 1 done
   - a **grill summary** (`# Grill summary — …`) → phase 2 done
   - **tasks recorded** (a `record_tasks` result / task backlog) → phase 3 done
   - an **implement verdict** (squad final verdict block) → phase 5 done for a task
   - a **review verdict** → phase 6 done for a task

Set `current_phase`:

- if `--from` was passed → `current_phase = --from` (explicit override wins,
  also overrides any value loaded from the state file)
- else if `.squad/pipeline-state.json` carried a valid `current_phase` →
  use it
- else → the first phase with no completed output found in context

If the state file is missing AND the conversation was compacted (prior
outputs gone), the pipeline cannot reconstruct — see Edge Cases.

### Cross-feature collision

If the state file exists with a feature whose name does NOT match the new
invocation's feature description (Levenshtein ratio < 0.6 against the
short feature name), HALT before resuming and ask the user:

```
in-progress pipeline found for: "{stored feature name}"
new invocation: "{new feature name}"

(A) resume the stored pipeline
(B) abandon the stored pipeline and start fresh on the new feature
(C) exit without changes
```

Never silently overwrite an in-progress state file with a different
feature — that would orphan the user's prior work.

## Phase 2 — Present the pipeline map

Print all six phases with a status marker, e.g.:

```
Pipeline — {short feature name}    depth: normal
  [x] 1 brainstorm   done
  [x] 2 grillme      done
  [>] 3 tasks        current — about to invoke
  [ ] 4 next
  [ ] 5 implement
  [ ] 6 review
```

## Phase 3 — Auto-invoke the current phase

Invoke the sub-skill for `current_phase` via the `Skill` tool. Forward the
depth flag and the relevant input (feature description, prior phase output,
selected task, etc.). Examples:

- `current_phase = brainstorm` → `Skill({ skill: "squad:brainstorm", args: "--normal <feature description>" })`
- `current_phase = grillme` → `Skill({ skill: "squad:grillme", args: "--normal <chosen approach from the brainstorm matrix>" })`
- `current_phase = tasks` → `Skill({ skill: "squad:tasks", args: "<hardened plan from the grill summary>" })`
- `current_phase = next` → `Skill({ skill: "squad:next" })`
- `current_phase = implement` → `Skill({ skill: "squad:implement", args: "--normal <current task title + acceptance criteria>" })`
- `current_phase = review` → `Skill({ skill: "squad:review" })`

The invoked sub-skill executes its full body — including its own internal
gates (e.g. `/squad:implement` will fire its Gate 1 plan approval and Gate
2 Blocker halt; `/squad:brainstorm` will ask its clarifying question if
the topic is ambiguous). The pipeline does NOT intercept those — the user
answers them as they fire. When the sub-skill completes, control returns
to the pipeline.

## Phase 4 — Inter-phase gate

After the sub-skill returns, surface its key output (verdict / option /
backlog) in 1-3 lines, then fire an `AskUserQuestion` with the four
decisions:

| Decision  | Meaning                        | Pipeline action                                                     |
| --------- | ------------------------------ | ------------------------------------------------------------------- |
| `proceed` | the phase output is good       | advance `current_phase` to the next phase; loop back to Phase 3     |
| `adjust`  | re-run this phase with changes | re-invoke the SAME sub-skill, folding in the user's adjustment text |
| `skip`    | this phase is not needed       | advance without recording an output — **only `grillme` / `review`** |
| `exit`    | stop the pipeline here         | print the completion summary (Phase 6) and end                      |

`skip` is rejected for `tasks`, `next`, and `implement`: skipping
`implement` means nothing was built; skipping `tasks` / `next` means the
inner loop has no backlog to walk. Say so plainly and offer `proceed` or
`exit` instead.

Call out at the gate which sub-skill mutated state: `brainstorm` and
`grillme` upstream are read-only-ish; `tasks` writes the backlog;
`implement` writes code.

## Phase 5 — The inner loop (tasks → next → implement → review)

Once `tasks` has produced a backlog, phases `next → implement → review`
repeat once per task. The pipeline auto-loops:

1. Invoke `Skill({ skill: "squad:next" })` → user picks/confirms a task at
   `/squad:next`'s own confirmation prompt.
2. Invoke `Skill({ skill: "squad:implement", args: "<task>" })` → user
   answers Gate 1 (plan approval) inside `/squad:implement`. Pipeline
   waits for the implementer + advisory + verdict to complete.
3. Invoke `Skill({ skill: "squad:review" })` → user gets the review
   verdict.
4. Inter-phase gate (Phase 4 above) fires: `proceed` (next task) /
   `adjust` (re-run last task's review with notes) / `skip` (skip review
   on this task) / `exit`.
5. If `proceed` AND backlog has more tasks → loop back to step 1.
6. If backlog empty → go to Phase 6.

Track the remaining backlog from the conversation context. If it is
unclear how many tasks are left, re-invoke `Skill({ skill: "squad:next" })`
— it is the source of truth and cheap to re-run.

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

## State persistence

The pipeline writes a single JSON file at
`.squad/pipeline-state.json` (mode `0o600`, gitignored) carrying the
minimal state needed to resume across context compaction or a closed
session. The file is overwritten atomically (write to `.tmp`, rename
into place) on every phase transition. There is exactly one state file
per workspace — multi-feature concurrent pipelines are NOT supported in
v1.5.

### Schema

```json
{
  "schema_version": 1,
  "feature_short_name": "notifications-system",
  "feature_description": "<verbatim user input, truncated at 16 KB>",
  "depth": "normal",
  "started_at": "2026-05-26T20:00:00Z",
  "updated_at": "2026-05-26T22:15:00Z",
  "status": "in_progress",
  "current_phase": "implement",
  "phases": {
    "brainstorm": {
      "status": "done",
      "completed_at": "2026-05-26T20:30:00Z",
      "outcome": "Picked option B (job queue)"
    },
    "grillme": { "status": "skipped" },
    "tasks": { "status": "done", "completed_at": "2026-05-26T21:00:00Z", "task_count": 5 },
    "next": {
      "status": "done",
      "completed_at": "2026-05-26T21:10:00Z",
      "current_task_id": "task-abc-123",
      "task_index": 2,
      "task_total": 5
    },
    "implement": { "status": "in_progress" },
    "review": { "status": "pending" }
  }
}
```

Per-phase `status` ∈ {`pending`, `in_progress`, `done`, `skipped`}.
Top-level `status` ∈ {`in_progress`, `completed`, `exited`, `failed`}.

**What the file MUST NOT carry:**

- Full sub-skill outputs (brainstorm reports, grill summaries, plans, diffs)
- Conversation transcripts
- Secrets, tokens, API keys, paths to credentials
- File contents from the working tree
- Anything beyond the 1-line `outcome` per phase

The state file is a **resume cache**, not a journal. The authoritative
sub-skill outputs live in the conversation and in each sub-skill's own
records (`.squad/runs.jsonl`, `.squad/tasks.json`, etc.). If the
conversation is compacted, the user can re-invoke `/squad:pipeline` and
the state file tells the pipeline where to pick up — the sub-skills'
own state handles the rest.

### Write points

The pipeline writes (atomically) at these moments:

1. **On pipeline start** — after Phase 0 parse + Phase 1 reconstruction,
   set `status: "in_progress"`, write the initial file (or update an
   existing one if resuming).
2. **After each Phase 4 gate decision** — record the just-completed
   phase's `status: "done"` (or `"skipped"`) + 1-line outcome, set
   `current_phase` to the next phase.
3. **On Phase 6 completion** — set top-level `status: "completed"`,
   `updated_at` to now.
4. **On `exit` or `pipeline stop`** — set top-level `status: "exited"`,
   `updated_at` to now.
5. **On unrecoverable failure** — set top-level `status: "failed"`,
   include a one-line `failure_reason` field.

### Lifecycle

- A `status: "in_progress"` file is the resume target — Phase 1 reads it
  and continues.
- A `status: "completed"` / `"exited"` / `"failed"` file is treated as
  history. The next `/squad:pipeline` invocation OVERWRITES it (after a
  one-line confirmation when the new feature description differs from
  the stored one — see Cross-feature collision in Phase 1).
- The file is NEVER deleted by the pipeline. Users who want to clear it
  manually: `rm .squad/pipeline-state.json`.
- The atomic-rewrite pattern uses a `.prev` sibling (same convention as
  the rest of squad-mcp's JSONL writers). The `safeReadFile` helper in
  `src/util/safe-read.ts` handles the mid-rename ENOENT fallback (v1.5+).

### Failure modes

- **Disk full / IO error on write** → log a one-line warning, continue
  the pipeline. State persistence is best-effort; a failed write does
  not halt the run.
- **Parse error on read** → log a one-line warning, fall back to
  context-based reconstruction (Phase 1 step 2). Do NOT prompt the user.
- **Schema-version mismatch** (future v2 reading a v1 file, or vice
  versa) → log + fall back to context reconstruction. Migration is the
  next-revision's concern.

## Reserved commands (interruption)

At ANY inter-phase gate (Phase 4) or sub-skill internal gate, the user
may type one of the reserved commands to break the auto-flow:

| Command         | Effect                                                                               |
| --------------- | ------------------------------------------------------------------------------------ |
| `pipeline stop` | Halt the pipeline immediately. Print the partial completion summary (Phase 6 shape). |
| `pipeline skip` | Skip the current phase if `skip` is allowed for it; else reject + re-ask the gate.   |
| `pipeline redo` | Re-invoke the current sub-skill from scratch, ignoring its prior output.             |
| `pipeline back` | Go back one phase. Re-invoke the previous sub-skill with the same input.             |

These commands are case-insensitive. If the user types something
ambiguous (e.g. just "stop"), interpret as `pipeline stop` ONLY when
spoken at a clear gate prompt; otherwise re-ask the gate with the four
options.

## Edge Cases

- **No feature description and no `--from`** → ask one clarifying
  question: "what feature should the pipeline take cradle-to-grave?"
- **`--from implement` but no task backlog in context** → warn: "no
  backlog found — recommend `/squad:tasks` first, or pass a free-form
  task." Offer to invoke `/squad:tasks` automatically or exit.
- **User asks to skip `implement`** → reject (Phase 4); implement is the
  only phase whose whole point is the change.
- **Conversation compacted, prior outputs lost** → check
  `.squad/pipeline-state.json` (v1.5+) FIRST — if it carries an
  in-progress run, resume from `current_phase`. Sub-skill outputs that
  the state file doesn't carry (full reports, plans) live in each
  sub-skill's own store (`.squad/runs.jsonl`, `.squad/tasks.json`, etc.)
  and the next sub-skill dispatch can re-read what it needs. Only when
  BOTH the state file is missing AND the conversation is compacted: ask
  the user which phase they are on, or have them re-run with
  `--from <phase>`.
- **A sub-skill run failed** (e.g. `implement` halted at Gate 2 on a
  Blocker; the user said `exit` inside the sub-skill) → the pipeline
  does NOT auto-advance. Surface the failure context and fire Phase 4
  gate with `adjust` (re-run) / `exit` as the realistic options.
- **User runs a sub-skill directly without the pipeline** → fine; on the
  next `/squad:pipeline` invocation Phase 1 detects the output and the
  pipeline advances to the next phase.
- **Sub-skill invocation fails to start** (Skill tool rejects, skill
  name unknown) → surface the error verbatim, halt; do NOT silently fall
  back to the pre-v1.5 "recommend the command" behavior.

## Boundaries

- The pipeline auto-invokes sub-skills via `Skill` between gates; it
  never bypasses a sub-skill's own internal gate.
- The pipeline never records telemetry and never writes `.squad/` state.
- The pipeline writes `.squad/pipeline-state.json` as a thin resume
  cache (v1.5+, phase status + 1-line outcomes only, mode `0o600`,
  gitignored). Sub-skill outputs are NEVER copied into it — those live
  in each sub-skill's own store.
- The pipeline never edits source code directly or runs mutating git.
- The pipeline never carries AI attribution into anything it prints.
