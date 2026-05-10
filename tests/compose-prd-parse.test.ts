import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { composePrdParseTool } from "../src/tools/compose-prd-parse.js";
import { recordTasks } from "../src/tasks/store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-prd-test-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("composePrdParseTool", () => {
  it("emits a prompt and a JSON schema", async () => {
    const out = await composePrdParseTool({
      workspace_root: workspace,
      prd_text: "Build a thing.",
      max_tasks: 40,
      include_existing: true,
    });
    expect(typeof out.prompt).toBe("string");
    expect(out.prompt.length).toBeGreaterThan(200);
    expect(out.output_schema).toBeDefined();
    expect(out.next_action).toBe("call_record_tasks_with_user_confirmation");
    expect(out.next_id_floor).toBe(0);
    expect(out.existing).toEqual([]);
  });

  it("embeds the PRD text verbatim in the prompt", async () => {
    const prd = "## A header\nDo X then Y.";
    const out = await composePrdParseTool({
      workspace_root: workspace,
      prd_text: prd,
      max_tasks: 40,
      include_existing: true,
    });
    expect(out.prompt).toContain(prd);
  });

  it("respects max_tasks in the prompt", async () => {
    const out = await composePrdParseTool({
      workspace_root: workspace,
      prd_text: "test",
      max_tasks: 7,
      include_existing: true,
    });
    expect(out.prompt).toContain("Cap at 7 tasks");
  });

  it("surfaces existing tasks and the next_id_floor", async () => {
    await recordTasks(workspace, [{ title: "first" }, { title: "second" }]);
    const out = await composePrdParseTool({
      workspace_root: workspace,
      prd_text: "extend",
      max_tasks: 40,
      include_existing: true,
    });
    expect(out.next_id_floor).toBe(2);
    expect(out.existing.map((t) => t.title)).toEqual(["first", "second"]);
    expect(out.prompt).toContain("The next available task ID will be 3");
    expect(out.prompt).toContain("1. [pending] first");
    expect(out.prompt).toContain("2. [pending] second");
  });

  it("skips existing-tasks section when include_existing is false", async () => {
    await recordTasks(workspace, [{ title: "hidden" }]);
    const out = await composePrdParseTool({
      workspace_root: workspace,
      prd_text: "x",
      max_tasks: 40,
      include_existing: false,
    });
    // existing is also skipped in the returned shape (caller asked us not to read)
    expect(out.existing).toEqual([]);
    expect(out.prompt).not.toContain("hidden");
    expect(out.prompt).toContain("`include_existing: false`");
  });

  it("output_schema declares tasks as an array of objects with required title", () => {
    // Pure schema-shape check — guards against accidental contract changes.
    const out = composePrdParseTool({
      workspace_root: workspace,
      prd_text: "x",
      max_tasks: 40,
      include_existing: true,
    });
    expect(out).resolves.toMatchObject({
      output_schema: {
        type: "object",
        properties: expect.objectContaining({
          tasks: expect.objectContaining({
            type: "array",
            items: expect.objectContaining({
              required: ["title"],
            }),
          }),
        }),
        required: ["tasks"],
      },
    });
  });
});
