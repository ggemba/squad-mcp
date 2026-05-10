import { matchesGlob } from "../config/squad-yaml.js";
import type { AgentName } from "../config/ownership-matrix.js";
import type { Task, TaskStatus } from "./store.js";

/**
 * Pure selection helpers over the in-memory tasks list. Stateless. Used by
 * the next_task and list_tasks MCP tools.
 */

export interface ListTasksOptions {
  /** Filter to one or more statuses. */
  status?: TaskStatus[];
  /**
   * When set, return only tasks whose `agent_hints` includes ANY of these
   * agents. Tasks without agent_hints are repo-wide and always pass.
   */
  agent?: AgentName;
  /**
   * When set, return only tasks whose `scope` glob matches at least one of
   * these paths. Tasks without scope are repo-wide and always pass.
   */
  changed_files?: string[];
  /** Cap result count. Default unlimited. */
  limit?: number;
}

export function listTasks(tasks: Task[], opts: ListTasksOptions = {}): Task[] {
  let out = tasks;

  if (opts.status && opts.status.length > 0) {
    const set = new Set(opts.status);
    out = out.filter((t) => set.has(t.status));
  }

  if (opts.agent !== undefined) {
    const wantedAgent = opts.agent;
    out = out.filter((t) => {
      if (!t.agent_hints || t.agent_hints.length === 0) return true;
      return t.agent_hints.includes(wantedAgent);
    });
  }

  if (opts.changed_files && opts.changed_files.length > 0) {
    const files = opts.changed_files;
    out = out.filter((t) => {
      if (!t.scope) return true;
      return files.some((f) => matchesGlob(t.scope!, f));
    });
  }

  if (opts.limit !== undefined && opts.limit > 0) {
    out = out.slice(0, opts.limit);
  }
  return out;
}

const PRIORITY_RANK: Record<Task["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface NextTaskOptions {
  /**
   * Treat these statuses as "complete" for dependency checks. Defaults to
   * just `done`. A task whose deps are all `done` is considered ready.
   */
  done_statuses?: TaskStatus[];
  /**
   * Statuses considered eligible for selection. Defaults to `pending`.
   * Use `["pending", "blocked"]` to also surface blocked tasks (with a hint
   * the caller can show the user — handled outside this function).
   */
  candidate_statuses?: TaskStatus[];
  agent?: AgentName;
  changed_files?: string[];
}

export interface NextTaskResult {
  task: Task | null;
  /** Reason "task is null": no candidates, or all blocked by deps. */
  reason: "no_candidates" | "all_blocked" | "ok";
  /**
   * Tasks that match candidate filters but have unmet dependencies. Useful
   * for the caller to show "X is next when Y completes".
   */
  blocked: Array<{ task: Task; missing_deps: number[] }>;
}

/**
 * Pick the next ready task. A task is ready when:
 *  - its status is in `candidate_statuses` (default `["pending"]`)
 *  - every id in its `dependencies` refers to a task whose status is in
 *    `done_statuses` (default `["done"]`)
 *  - it passes the agent / changed_files filters
 *
 * Tiebreakers (in order): priority (high < medium < low), then id ascending.
 *
 * Returns the task plus a structured result so the caller can distinguish
 * "no candidates" from "all blocked by deps" (different UX).
 */
export function nextTask(
  tasks: Task[],
  opts: NextTaskOptions = {},
): NextTaskResult {
  const doneSet = new Set<TaskStatus>(opts.done_statuses ?? ["done"]);
  const candidateStatuses = opts.candidate_statuses ?? ["pending"];

  // Build done-id index over the FULL task list — deps may point at any task,
  // not just ones passing the filters.
  const doneIds = new Set(
    tasks.filter((t) => doneSet.has(t.status)).map((t) => t.id),
  );

  // Filter to candidates (status + agent + scope).
  const filterOpts: ListTasksOptions = { status: candidateStatuses };
  if (opts.agent !== undefined) filterOpts.agent = opts.agent;
  if (opts.changed_files !== undefined)
    filterOpts.changed_files = opts.changed_files;
  const candidates = listTasks(tasks, filterOpts);

  if (candidates.length === 0) {
    return { task: null, reason: "no_candidates", blocked: [] };
  }

  const ready: Task[] = [];
  const blocked: NextTaskResult["blocked"] = [];

  for (const t of candidates) {
    const missing = t.dependencies.filter((d) => !doneIds.has(d));
    if (missing.length === 0) {
      ready.push(t);
    } else {
      blocked.push({ task: t, missing_deps: missing });
    }
  }

  if (ready.length === 0) {
    return { task: null, reason: "all_blocked", blocked };
  }

  ready.sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    return a.id - b.id;
  });

  return { task: ready[0]!, reason: "ok", blocked };
}
