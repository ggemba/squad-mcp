import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "dist", "index.js");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const messages = [];
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  }
});

function send(req) {
  child.stdin.write(JSON.stringify(req) + "\n");
}

function waitFor(id, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const m = messages.find((x) => x.id === id);
      if (m) {
        clearInterval(interval);
        resolve(m);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`timeout for id ${id}`));
      }
    }, 20);
  });
}

let exitCode = 0;
try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0" },
    },
  });
  await waitFor(1);

  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const toolsRes = await waitFor(2);
  const toolNames = toolsRes.result.tools.map((t) => t.name).sort();
  console.log("tools:", toolNames.join(", "));
  const expected = [
    "apply_consolidation_rules",
    "classify_work_type",
    "compose_advisory_bundle",
    "compose_squad_workflow",
    "detect_changed_files",
    "get_agent_definition",
    "init_local_config",
    "list_agents",
    "score_risk",
    "score_rubric",
    "select_squad",
    "slice_files_for_agent",
    "validate_plan_text",
  ];
  for (const e of expected) {
    if (!toolNames.includes(e)) throw new Error(`missing tool: ${e}`);
  }
  if (toolNames.length !== expected.length) {
    throw new Error(
      `tool count mismatch: ${toolNames.length} vs ${expected.length}`,
    );
  }

  send({
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
      },
    },
  });
  const callRes = await waitFor(3);
  const text = callRes.result.content[0].text;
  const parsed = JSON.parse(text);
  if (parsed.level !== "High")
    throw new Error(`expected High, got ${parsed.level}`);
  console.log("score_risk High ok, score=", parsed.score);

  send({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  const resRes = await waitFor(4);
  console.log("resources count:", resRes.result.resources.length);
  if (resRes.result.resources.length < 9)
    throw new Error("expected at least 9 agent resources");

  send({ jsonrpc: "2.0", id: 5, method: "prompts/list" });
  const promptsRes = await waitFor(5);
  const promptNames = promptsRes.result.prompts.map((p) => p.name).sort();
  console.log("prompts:", promptNames.join(", "));
  for (const p of ["agent_advisory", "consolidator", "squad_orchestration"]) {
    if (!promptNames.includes(p)) throw new Error(`missing prompt: ${p}`);
  }

  console.log("SMOKE OK");
} catch (err) {
  console.error("SMOKE FAILED:", err.message);
  exitCode = 1;
} finally {
  child.kill();
  process.exit(exitCode);
}
