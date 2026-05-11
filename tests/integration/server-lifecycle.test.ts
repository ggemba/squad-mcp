import { describe, it, expect, afterEach } from "vitest";
import { spawnServer, initialize, type ServerHandle } from "./stdio-helpers.js";

let handle: ServerHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe("server lifecycle", () => {
  it("initializes, lists tools, calls a tool, closes cleanly", async () => {
    handle = await spawnServer();
    const initRes = await initialize(handle, 1);
    expect(initRes.id).toBe(1);
    expect((initRes.result as { protocolVersion?: string }).protocolVersion).toBeTruthy();

    handle.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const toolsRes = await handle.recv(2);
    const tools = (toolsRes.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "apply_consolidation_rules",
      "classify_work_type",
      "compose_advisory_bundle",
      "compose_prd_parse",
      "compose_squad_workflow",
      "detect_changed_files",
      "expand_task",
      "get_agent_definition",
      "init_local_config",
      "list_agents",
      "list_runs",
      "list_tasks",
      "next_task",
      "prune_learnings",
      "read_learnings",
      "read_squad_config",
      "record_learning",
      "record_run",
      "record_tasks",
      "score_risk",
      "score_rubric",
      "select_squad",
      "slice_files_for_agent",
      "slice_files_for_task",
      "update_task_status",
      "validate_plan_text",
    ]);

    handle.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "score_risk",
        arguments: {
          touches_auth: true,
          touches_money: true,
          touches_migration: true,
          files_count: 10,
          new_module: false,
          api_contract_change: false,
        },
      },
    });
    const callRes = await handle.recv(3);
    const text = (callRes.result as { content: { text: string }[] }).content[0]!.text;
    const parsed = JSON.parse(text) as { level: string };
    expect(parsed.level).toBe("High");
  }, 15_000);

  it("lists resources and prompts", async () => {
    handle = await spawnServer();
    await initialize(handle, 1);

    handle.send({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    const resRes = await handle.recv(2);
    const resources = (resRes.result as { resources: unknown[] }).resources;
    expect(resources.length).toBeGreaterThanOrEqual(9);

    handle.send({ jsonrpc: "2.0", id: 3, method: "prompts/list" });
    const promptsRes = await handle.recv(3);
    const prompts = (promptsRes.result as { prompts: { name: string }[] }).prompts;
    const promptNames = prompts.map((p) => p.name).sort();
    expect(promptNames).toEqual(["agent_advisory", "consolidator", "squad_orchestration"]);
  }, 15_000);

  it("select_squad with cross-stack fixtures emits expected agents", async () => {
    handle = await spawnServer();
    await initialize(handle, 1);

    handle.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "select_squad",
        arguments: {
          work_type: "Feature",
          files: [
            "tests/fixtures/express.ts",
            "tests/fixtures/fastapi.py",
            "tests/fixtures/gin.go",
          ],
          read_content: true,
          workspace_root: process.cwd(),
        },
      },
    });
    const callRes = await handle.recv(2);
    const text = (callRes.result as { content: { text: string }[] }).content[0]!.text;
    const parsed = JSON.parse(text) as { agents: string[] };
    expect(parsed.agents).toContain("senior-dev-security");
    expect(parsed.agents).toContain("senior-dba");
    expect(parsed.agents).toContain("senior-developer");
  }, 15_000);
});
