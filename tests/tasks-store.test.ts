import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readTasks,
  recordTasks,
  updateTaskStatus,
  expandTask,
  DEFAULT_TASKS_PATH,
  __resetTasksStoreCacheForTests,
} from "../src/tasks/store.js";
import { isSquadError } from "../src/errors.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-tasks-test-"));
  __resetTasksStoreCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  __resetTasksStoreCacheForTests();
});

describe("readTasks — empty", () => {
  it("rejects configuredPath that escapes workspaceRoot via .. (CWE-22)", async () => {
    await expect(readTasks(workspace, { configuredPath: "../escape.json" })).rejects.toThrow(
      /PATH_TRAVERSAL_DENIED|escapes workspace_root/,
    );
  });

  it("rejects absolute configuredPath (CWE-22)", async () => {
    await expect(readTasks(workspace, { configuredPath: "/etc/passwd" })).rejects.toThrow(
      /PATH_TRAVERSAL_DENIED|must be a workspace-relative/,
    );
  });

  it("returns empty file when no tasks.json exists", async () => {
    const f = await readTasks(workspace);
    expect(f.tasks).toEqual([]);
    expect(f.version).toBe(1);
  });

  it("returns empty when path is a directory", async () => {
    await fs.mkdir(path.join(workspace, ".squad", "tasks.json"), {
      recursive: true,
    });
    const f = await readTasks(workspace);
    expect(f.tasks).toEqual([]);
  });
});

describe("recordTasks — concurrency", () => {
  it("serialises concurrent writes via file lock: 20 parallel recordTasks produce unique ids", async () => {
    const writers = Array.from({ length: 20 }, (_, i) =>
      recordTasks(workspace, [{ title: `parallel-${i}` }]),
    );
    const results = await Promise.all(writers);
    const allIds = results.flatMap((r) => r.ids);
    const unique = new Set(allIds);
    expect(unique.size).toBe(20);
    const final = await readTasks(workspace);
    expect(final.tasks).toHaveLength(20);
  });

  it("keeps a .prev snapshot of the prior generation after write", async () => {
    await recordTasks(workspace, [{ title: "first" }]);
    await recordTasks(workspace, [{ title: "second" }]);
    const file = path.join(workspace, DEFAULT_TASKS_PATH);
    const prevExists = await fs
      .access(`${file}.prev`)
      .then(() => true)
      .catch(() => false);
    expect(prevExists).toBe(true);
    const prevBody = await fs.readFile(`${file}.prev`, "utf8");
    expect(prevBody).toContain("first");
    expect(prevBody).not.toContain("second");
  });
});

describe("recordTasks", () => {
  it("creates the file and allocates ids when omitted", async () => {
    const r = await recordTasks(workspace, [{ title: "first" }, { title: "second" }]);
    expect(r.ids).toEqual([1, 2]);
    const f = await readTasks(workspace);
    expect(f.tasks).toHaveLength(2);
    expect(f.tasks[0]!.id).toBe(1);
    expect(f.tasks[1]!.title).toBe("second");
  });

  it("accepts explicit ids when unique", async () => {
    const r = await recordTasks(workspace, [
      { id: 10, title: "a" },
      { id: 20, title: "b" },
    ]);
    expect(r.ids).toEqual([10, 20]);
    const f = await readTasks(workspace);
    expect(f.tasks.map((t) => t.id)).toEqual([10, 20]);
  });

  it("allocates from max(existing) + 1 on subsequent calls", async () => {
    await recordTasks(workspace, [{ id: 5, title: "five" }]);
    const r = await recordTasks(workspace, [{ title: "next" }]);
    expect(r.ids).toEqual([6]);
  });

  it("rejects duplicate ids", async () => {
    await recordTasks(workspace, [{ id: 1, title: "first" }]);
    let caught: unknown;
    try {
      await recordTasks(workspace, [{ id: 1, title: "dup" }]);
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
  });

  it("validates dependencies resolve (forward refs in batch ok)", async () => {
    const r = await recordTasks(workspace, [
      { title: "first" },
      { title: "second", dependencies: [1] },
    ]);
    expect(r.ids).toEqual([1, 2]);
  });

  it("rejects unresolved dependency ids", async () => {
    let caught: unknown;
    try {
      await recordTasks(workspace, [{ title: "first", dependencies: [99] }]);
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
  });

  it("rejects self-dependencies", async () => {
    let caught: unknown;
    try {
      await recordTasks(workspace, [{ id: 1, title: "self", dependencies: [1] }]);
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
  });

  it("stores scope and agent_hints", async () => {
    await recordTasks(workspace, [
      {
        title: "auth",
        scope: "src/auth/**",
        agent_hints: ["senior-dev-security", "senior-developer"],
      },
    ]);
    const f = await readTasks(workspace);
    expect(f.tasks[0]!.scope).toBe("src/auth/**");
    expect(f.tasks[0]!.agent_hints).toEqual(["senior-dev-security", "senior-developer"]);
  });

  it("rejects empty input", async () => {
    let caught: unknown;
    try {
      await recordTasks(workspace, []);
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
  });
});

describe("updateTaskStatus", () => {
  it("flips a task's status and updated_at", async () => {
    await recordTasks(workspace, [{ title: "a" }]);
    const r = await updateTaskStatus(workspace, 1, "in-progress");
    expect(r.task.status).toBe("in-progress");
    expect(r.task.updated_at).not.toBe(r.task.created_at);
  });

  it("flips a subtask's status", async () => {
    await recordTasks(workspace, [{ title: "parent" }]);
    await expandTask(workspace, 1, [{ title: "child" }]);
    const r = await updateTaskStatus(workspace, 1, "done", { subtaskId: 1 });
    expect(r.task.subtasks[0]!.status).toBe("done");
    expect(r.task.status).toBe("pending");
  });

  it("throws on unknown task", async () => {
    let caught: unknown;
    try {
      await updateTaskStatus(workspace, 99, "done");
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
  });

  it("throws on unknown subtask", async () => {
    await recordTasks(workspace, [{ title: "a" }]);
    let caught: unknown;
    try {
      await updateTaskStatus(workspace, 1, "done", { subtaskId: 99 });
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
  });
});

describe("expandTask", () => {
  it("appends subtasks with sequential ids", async () => {
    await recordTasks(workspace, [{ title: "parent" }]);
    const r = await expandTask(workspace, 1, [{ title: "a" }, { title: "b" }]);
    expect(r.task.subtasks).toHaveLength(2);
    expect(r.task.subtasks[0]!.id).toBe(1);
    expect(r.task.subtasks[1]!.id).toBe(2);
  });

  it("appends to existing subtasks (id continues from max)", async () => {
    await recordTasks(workspace, [{ title: "parent" }]);
    await expandTask(workspace, 1, [{ title: "first" }]);
    const r = await expandTask(workspace, 1, [{ title: "second" }]);
    expect(r.task.subtasks.map((s) => s.id)).toEqual([1, 2]);
  });

  it("validates sibling dependency references", async () => {
    await recordTasks(workspace, [{ title: "parent" }]);
    let caught: unknown;
    try {
      await expandTask(workspace, 1, [{ title: "x", dependencies: [99] }]);
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
  });

  it("accepts forward refs in same batch (id assigned in order)", async () => {
    await recordTasks(workspace, [{ title: "parent" }]);
    const r = await expandTask(workspace, 1, [
      { title: "first" },
      { title: "second", dependencies: [1] },
    ]);
    expect(r.task.subtasks[1]!.dependencies).toEqual([1]);
  });
});

describe("readTasks — caching", () => {
  it("caches reads with same mtime", async () => {
    await recordTasks(workspace, [{ title: "a" }]);
    const a = await readTasks(workspace);
    const b = await readTasks(workspace);
    expect(a).toBe(b);
  });

  it("invalidates cache after write", async () => {
    await recordTasks(workspace, [{ title: "a" }]);
    const a = await readTasks(workspace);
    expect(a.tasks).toHaveLength(1);

    await recordTasks(workspace, [{ title: "b" }]);
    const b = await readTasks(workspace);
    expect(b.tasks).toHaveLength(2);
    expect(b).not.toBe(a);
  });
});

describe("v0.14.x D1 hygiene — file mode + cache size key", () => {
  it.skipIf(process.platform === "win32")(
    "writes tasks.json with mode 0o600 (user-only)",
    async () => {
      // Pin the create-time mode on the swapped-in file. The atomic-rewrite
      // path now writes the tmp with mode 0o600 and defensively chmods the
      // final file after rename — both paths converge on 0o600.
      await recordTasks(workspace, [{ title: "a" }]);
      const file = path.join(workspace, DEFAULT_TASKS_PATH);
      const st = await fs.stat(file);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "writes tasks.json.prev with mode 0o600 after a second write",
    async () => {
      // POSIX rename preserves source mode, which on a pre-existing 0o644
      // file would carry 0o644 forward into .prev. The defensive fs.chmod
      // after the rename re-stamps 0o600.
      await recordTasks(workspace, [{ title: "first" }]);
      await recordTasks(workspace, [{ title: "second" }]);
      const file = path.join(workspace, DEFAULT_TASKS_PATH);
      const stPrev = await fs.stat(`${file}.prev`);
      expect(stPrev.mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "re-stamps 0o600 on .prev even when the prior generation was 0o644 (legacy)",
    async () => {
      // Simulate an upgrade scenario: an older squad-mcp left the tasks
      // file at 0o644. The next write moves source → .prev (rename inherits
      // 0o644) and then we must defensively re-stamp .prev to 0o600.
      const file = path.join(workspace, DEFAULT_TASKS_PATH);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const legacyBody = JSON.stringify({ version: 1, tasks: [] }) + "\n";
      await fs.writeFile(file, legacyBody, { mode: 0o644 });
      let st = await fs.stat(file);
      expect(st.mode & 0o777).toBe(0o644);

      await recordTasks(workspace, [{ title: "after-upgrade" }]);
      const stPrev = await fs.stat(`${file}.prev`);
      expect(stPrev.mode & 0o777).toBe(0o600);
      st = await fs.stat(file);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );

  it("race regression: stale cache (same mtime, different size) re-reads under lock", async () => {
    // This exercises the LOGIC of the new (mtime, size) cache key — same
    // mtime + different size used to falsely return the cached data. With
    // size in the cache key, the read re-stats and reloads.
    //
    // Strategy: do a first recordTasks() to populate cache, then mutate the
    // file on disk WITHOUT bumping mtime (utimes pin), and call readTasks
    // again — it should re-read and surface the new entry.
    await recordTasks(workspace, [{ title: "first" }]);
    const file = path.join(workspace, DEFAULT_TASKS_PATH);
    const first = await readTasks(workspace);
    expect(first.tasks).toHaveLength(1);

    // Build a new on-disk shape with two tasks, pinned to the previous mtime.
    const originalStat = await fs.stat(file);
    const newBody =
      JSON.stringify(
        {
          version: 1,
          tasks: [
            {
              id: 1,
              title: "first",
              status: "pending",
              dependencies: [],
              priority: "medium",
              subtasks: [],
              created_at: "2026-05-11T10:00:00Z",
              updated_at: "2026-05-11T10:00:00Z",
            },
            {
              id: 2,
              title: "second",
              status: "pending",
              dependencies: [],
              priority: "medium",
              subtasks: [],
              created_at: "2026-05-11T10:00:00Z",
              updated_at: "2026-05-11T10:00:00Z",
            },
          ],
        },
        null,
        2,
      ) + "\n";
    await fs.writeFile(file, newBody);
    // Pin mtime back to original — simulates the same-millisecond race.
    await fs.utimes(file, originalStat.atime, originalStat.mtime);

    const second = await readTasks(workspace);
    expect(second.tasks).toHaveLength(2);
    expect(second.tasks[1]!.title).toBe("second");
  });
});

describe("on-disk format", () => {
  it("writes pretty-printed JSON sorted by id", async () => {
    await recordTasks(workspace, [
      { id: 3, title: "third" },
      { id: 1, title: "first" },
      { id: 2, title: "second" },
    ]);
    const raw = await fs.readFile(path.join(workspace, DEFAULT_TASKS_PATH), "utf8");
    const idx1 = raw.indexOf('"id": 1');
    const idx2 = raw.indexOf('"id": 2');
    const idx3 = raw.indexOf('"id": 3');
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("ends with a trailing newline", async () => {
    await recordTasks(workspace, [{ title: "a" }]);
    const raw = await fs.readFile(path.join(workspace, DEFAULT_TASKS_PATH), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
