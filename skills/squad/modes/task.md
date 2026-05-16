# Squad — task-mode phases

Phases 0.5 and 0.6 of the squad skill (`skills/squad/SKILL.md`). Loaded when the
entry command is `/squad:tasks`, `/squad:next`, or `/squad:task`. Task mode then
continues into the implement-mode phases (`modes/implement.md`) against the
task's scope. Phase numbers are global — they slot into the SKILL.md spine.

## Phase 0.5 — Decompose PRD into tasks (task-mode only)

Triggered by `/squad:tasks <prd-file>` (or `/squad:tasks` with the PRD pasted inline). Skipped entirely in plain `/squad:implement` and `/squad:review` flows.

### 1. Build the parse prompt

Read the PRD file (or accept inline text). Call `compose_prd_parse` with:

- `workspace_root` — repo root
- `prd_text` — the PRD contents
- `max_tasks` — soft cap (default 40)

The tool returns a `prompt`, an `output_schema`, the existing tasks (so the LLM doesn't duplicate), and `next_id_floor`.

### 2. Run the prompt through your own LLM

Feed the returned `prompt` to your model (you ARE the model — generate the JSON directly). Output MUST match `output_schema` — one JSON object, no prose. If you cannot produce valid JSON, abort and tell the user.

### 3. Show the user the parsed tasks BEFORE recording

Render the parsed tasks as a table (id placeholders starting at `next_id_floor + 1`, title, deps, priority, scope, agent_hints). Wait for the user to confirm before any write. Acceptable confirmations: "looks good", "record", "go", "yes". Anything else (silence, "wait", "let me edit") = abort or accept edits.

If the user wants to edit a task's title/deps/scope, apply the edit and re-show. Don't bulk-record half-edited output.

### 4. Call record_tasks

Once confirmed, call `record_tasks` with the validated array. Surface the resulting `ids` and `file` path to the user. Remind them to commit `.squad/tasks.json` if they want the decomposition to ship with the repo.

### 5. Inviolable rules for Phase 0.5

- **Never call record_tasks without explicit user confirmation.** Bulk-recording a hallucinated task list is a destructive write — the user must have seen it.
- **Never invent dependencies.** If two tasks aren't clearly ordered, leave deps empty rather than guess. Wrong deps will silently block `next_task` later.
- **Never alter ids the user reviewed.** If the user said "record", the ids the LLM showed are the ids that get written. `record_tasks` allocates from `next_id_floor + 1` in array order — same as the preview.

## Phase 0.6 — Pick a task to work on (task-mode only)

Triggered by `/squad:next` (default) or `/squad:task <id>` (explicit pick).

### `/squad:next`

Call `next_task` with `workspace_root` and any contextual filters (`agent` if the user is wearing one hat today, `changed_files` if they want a task that touches files they're already editing). The tool returns the next ready task, OR a `reason` (`no_candidates` / `all_blocked`) plus the blocked list.

If `task` is null:

- `no_candidates` → tell the user there are no pending tasks. Suggest `/squad:tasks` to add some.
- `all_blocked` → show the blocked list with their `missing_deps`. The user can either complete a dep manually, or call `/squad:task <id>` to override.

If `task` is set, surface its title + scope + agent_hints. Ask the user "work on this?" before flipping status to `in-progress`.

### `/squad:task <id>`

Explicit pick. Call `list_tasks` (filter to that id by listing all and finding the match) — id-by-id read isn't a separate primitive. Confirm the task is `pending` or `blocked` (not already done/cancelled). Show it to the user, ask for confirmation, then flip to `in-progress` via `update_task_status`.

### Then: run the squad on that task's scope

Call `slice_files_for_task` with `workspace_root`, the task's `id`, and the current changed_files list. The tool returns `matched` (files within scope) and `unmatched`.

Use `matched` as the file slice for `compose_advisory_bundle` — the squad now reviews ONLY the files that belong to this task. Phase 1 onward proceeds normally with the narrowed scope. This is the anti-bloat mechanism: each task drives a focused advisory pass instead of one giant context window.

If the task has `agent_hints`, pass them as `force_agents` to `compose_squad_workflow` so only the relevant specialists wake up.

When the implementation is done (Phase 8) and the consolidator approves (Phase 10), flip status to `done` via `update_task_status` before returning to the user.
