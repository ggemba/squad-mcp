import { describe, it, expect } from "vitest";
import { listTasks, nextTask } from "../src/tasks/select.js";
import type { Task } from "../src/tasks/store.js";

const t = (overrides: Partial<Task>): Task => ({
  id: 1,
  title: "t",
  status: "pending",
  dependencies: [],
  priority: "medium",
  subtasks: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("listTasks", () => {
  const tasks: Task[] = [
    t({ id: 1, status: "pending" }),
    t({ id: 2, status: "done" }),
    t({ id: 3, status: "in-progress" }),
    t({ id: 4, status: "blocked" }),
  ];

  it("returns all when no filters", () => {
    expect(listTasks(tasks)).toHaveLength(4);
  });

  it("filters by status set", () => {
    const r = listTasks(tasks, { status: ["pending", "in-progress"] });
    expect(r.map((x) => x.id)).toEqual([1, 3]);
  });

  it("agent filter passes tasks without agent_hints (repo-wide)", () => {
    const r = listTasks(
      [t({ id: 1 }), t({ id: 2, agent_hints: ["dba"] }), t({ id: 3, agent_hints: ["developer"] })],
      { agent: "dba" },
    );
    expect(r.map((x) => x.id)).toEqual([1, 2]);
  });

  it("scope filter against changed_files", () => {
    const r = listTasks(
      [t({ id: 1 }), t({ id: 2, scope: "src/auth/**" }), t({ id: 3, scope: "src/billing/**" })],
      { changed_files: ["src/auth/login.ts"] },
    );
    expect(r.map((x) => x.id)).toEqual([1, 2]);
  });

  it("respects limit AFTER filtering", () => {
    expect(listTasks(tasks, { status: ["pending"], limit: 1 })).toHaveLength(1);
  });
});

describe("nextTask", () => {
  it("returns no_candidates when nothing pending", () => {
    const r = nextTask([t({ status: "done" })]);
    expect(r.task).toBeNull();
    expect(r.reason).toBe("no_candidates");
  });

  it("returns the only ready task when no deps", () => {
    const r = nextTask([t({ id: 1 })]);
    expect(r.task?.id).toBe(1);
    expect(r.reason).toBe("ok");
  });

  it("skips tasks with unmet deps and reports them blocked", () => {
    const r = nextTask([
      t({ id: 1, status: "pending", dependencies: [2] }),
      t({ id: 2, status: "pending" }),
    ]);
    expect(r.task?.id).toBe(2);
    expect(r.blocked.map((b) => b.task.id)).toEqual([1]);
    expect(r.blocked[0]!.missing_deps).toEqual([2]);
  });

  it("returns all_blocked when every candidate has unmet deps", () => {
    const r = nextTask([
      t({ id: 1, status: "pending", dependencies: [99] }),
      t({ id: 2, status: "pending", dependencies: [99] }),
    ]);
    expect(r.task).toBeNull();
    expect(r.reason).toBe("all_blocked");
    expect(r.blocked).toHaveLength(2);
  });

  it("treats deps as ready when their status is in done_statuses", () => {
    const r = nextTask([
      t({ id: 1, status: "done" }),
      t({ id: 2, status: "pending", dependencies: [1] }),
    ]);
    expect(r.task?.id).toBe(2);
  });

  it("priority high beats medium beats low at tiebreak", () => {
    const r = nextTask([
      t({ id: 1, priority: "low" }),
      t({ id: 2, priority: "high" }),
      t({ id: 3, priority: "medium" }),
    ]);
    expect(r.task?.id).toBe(2);
  });

  it("falls back to id ascending when priority ties", () => {
    const r = nextTask([t({ id: 5, priority: "high" }), t({ id: 3, priority: "high" })]);
    expect(r.task?.id).toBe(3);
  });

  it("filters by agent (repo-wide tasks always pass)", () => {
    const r = nextTask(
      [t({ id: 1, agent_hints: ["developer"] }), t({ id: 2, agent_hints: ["dba"] }), t({ id: 3 })],
      { agent: "dba" },
    );
    expect([2, 3]).toContain(r.task!.id);
  });

  it("filters by changed_files (scope match)", () => {
    const r = nextTask(
      [t({ id: 1, scope: "src/auth/**" }), t({ id: 2, scope: "src/billing/**" })],
      { changed_files: ["src/billing/index.ts"] },
    );
    expect(r.task?.id).toBe(2);
  });

  it("custom candidate_statuses surfaces in-progress tasks", () => {
    const r = nextTask([t({ id: 1, status: "in-progress" })], {
      candidate_statuses: ["in-progress"],
    });
    expect(r.task?.id).toBe(1);
  });
});
