// Name-level drift lint for skills/squad/SKILL.md Phase 0.
//
// WHAT THIS IS
//   A lightweight check that the bulleted MCP-tool list in SKILL.md Phase 0
//   stays in sync, BY NAME, with the tools the server actually registers.
//
// WHAT IT CATCHES
//   - A tool added to the registry but not documented in Phase 0.
//   - A tool removed/renamed in the registry but still listed in Phase 0.
//   - A tool count mismatch between the two.
//
// WHAT IT DOES NOT CATCH
//   - Parameter / input-schema drift. This is a NAME-level check only; a
//     tool whose name is unchanged but whose arguments changed will pass.
//   - Description-text drift. The one-line prose after each name is not
//     compared — only the `name` token inside the backticks.
//
// HOW IT GETS THE AUTHORITATIVE NAMES
//   It spawns the built server (dist/index.js) over stdio and calls the MCP
//   `tools/list` method — the same proven technique tests/smoke.mjs uses.
//   This exercises the real registry wiring (not a static source grep, which
//   is fragile against re-exports and conditional registration). The built
//   dist/index.js must exist; run `npm run build` first (CI does this).
//
// MODEL-DRIFT CHECK (second, independent gate)
//   Beyond the name-level tool diff above, this script also guards against the
//   model-drift bug: prose in SKILL.md claiming an agent runs on a given model
//   (opus/sonnet/haiku) that CONTRADICTS that agent's `agents/<name>.md`
//   frontmatter `model:` pin. The frontmatter is the single source of truth;
//   SKILL.md only narrates it, so any disagreement is a documentation bug.
//
//   HOW IT DETECTS A MISMATCH
//     - Build agent→model truth by reading every `agents/*.md` frontmatter.
//     - Scan SKILL.md line by line for ADJACENT agent-name + model-word
//       assertions (parenthetical `name (model)`, `<Model>-class` next to a
//       name, `name ... pins/pin <model>`, and `<model> for name`). Adjacency
//       (a small word window), not mere same-line co-occurrence, is required
//       so a list of agent names that ends in one shared model claim does not
//       produce false positives.
//     - For each (agent, claimedModel) pair, compare against the truth; any
//       contradiction is reported as file:line with expected-vs-claimed.
//
// EXIT CODES
//   0 — Phase 0 list and the registry agree AND no model claim contradicts
//       the agent frontmatter.
//   1 — tool-name drift OR model-claim drift detected (details printed), or a
//       runtime error.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.resolve(root, "dist", "index.js");
const skillPath = path.resolve(root, "skills", "squad", "SKILL.md");
const agentsDir = path.resolve(root, "agents");

/**
 * Spawn the built server, perform the MCP handshake, and return the sorted
 * set of registered tool names from `tools/list`.
 */
function getRegisteredToolNames() {
  return new Promise((resolve, reject) => {
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
            // non-JSON log line — ignore
          }
        }
      }
    });
    child.on("error", reject);

    const send = (req) => child.stdin.write(JSON.stringify(req) + "\n");

    // Tracked at function scope so the `finally` block can clear a poll
    // interval still pending on the rejection path (e.g. a handshake error
    // thrown before the matching `waitFor` resolves).
    let activeInterval = null;

    const waitFor = (id, timeoutMs = 5000) =>
      new Promise((res, rej) => {
        const start = Date.now();
        const interval = setInterval(() => {
          const m = messages.find((x) => x.id === id);
          if (m) {
            clearInterval(interval);
            activeInterval = null;
            res(m);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(interval);
            activeInterval = null;
            rej(new Error(`timeout waiting for response id ${id}`));
          }
        }, 20);
        activeInterval = interval;
      });

    (async () => {
      try {
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "check-skill-drift", version: "0.0" },
          },
        });
        await waitFor(1);

        // Spec-conformant handshake: the client MUST send the
        // `notifications/initialized` notification after the `initialize`
        // response before issuing further requests. (A notification has no
        // `id` and gets no response.)
        send({ jsonrpc: "2.0", method: "notifications/initialized" });

        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        const res = await waitFor(2);
        const names = res.result.tools.map((t) => t.name).sort();
        resolve(names);
      } catch (err) {
        reject(err);
      } finally {
        // Clear any still-pending poll interval and tear down the stdout
        // accumulator so neither dangles after the child is killed.
        if (activeInterval) clearInterval(activeInterval);
        child.kill();
        child.stdout.destroy();
      }
    })();
  });
}

/**
 * Parse the tool names from SKILL.md Phase 0's bulleted list.
 *
 * Phase 0's list lives between the "Available tools:" line and the next
 * blank line that precedes the "Available named subagents" paragraph. Each
 * entry has the form `- \`tool_name\` — description`. We anchor on that
 * exact shape so prose containing backticked identifiers elsewhere in the
 * file is not mistaken for a tool entry.
 */
function getDocumentedToolNames() {
  const body = readFileSync(skillPath, "utf8");
  const lines = body.split(/\r?\n/);

  const startIdx = lines.findIndex((l) => /Available tools:/.test(l));
  if (startIdx === -1) {
    throw new Error("could not find the 'Available tools:' marker in SKILL.md");
  }

  const names = [];
  // NOTE: the separator after the backticked name is a literal U+2014 EM DASH
  // (—), not an ASCII hyphen-minus — entries written with `-` will not match.
  const entryRe = /^- `([a-z_]+)` —/;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(entryRe);
    if (m) {
      names.push(m[1]);
      continue;
    }
    // First non-blank, non-entry line after the list ends the block.
    if (line.trim() !== "" && names.length > 0) break;
  }

  if (names.length === 0) {
    throw new Error("parsed zero tool entries from SKILL.md Phase 0 list");
  }
  return names.sort();
}

// ---------------------------------------------------------------------------
// Model-drift check
// ---------------------------------------------------------------------------

const MODEL_WORDS = ["opus", "sonnet", "haiku"];

/**
 * Read every `agents/*.md` frontmatter `model:` line and return the truth map
 * { "<agent-name>": "<model>" }. The frontmatter `name:` is the canonical key.
 */
function getAgentModelTruth() {
  const truth = {};
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const text = readFileSync(path.join(agentsDir, f), "utf8");
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(\S+)\s*$/m);
    const modelMatch = fm.match(/^model:\s*(\S+)\s*$/m);
    if (!nameMatch || !modelMatch) continue;
    const name = nameMatch[1].trim();
    const model = modelMatch[1].trim().toLowerCase();
    if (MODEL_WORDS.includes(model)) truth[name] = model;
  }
  if (Object.keys(truth).length === 0) {
    throw new Error("parsed zero agent model pins from agents/*.md frontmatter");
  }
  return truth;
}

/**
 * Resolve a (possibly nicknamed) agent token used in SKILL.md prose to its
 * canonical frontmatter name. SKILL.md routinely abbreviates the tech-lead
 * roles ("planner", "consolidator"); fold those onto their canonical names so
 * a claim about "planner" is checked against `tech-lead-planner`'s pin.
 */
function canonicalAgent(token, truth) {
  const t = token.toLowerCase().replace(/`/g, "");
  if (truth[t]) return t;
  const nicknames = {
    planner: "tech-lead-planner",
    consolidator: "tech-lead-consolidator",
  };
  if (nicknames[t] && truth[nicknames[t]]) return nicknames[t];
  return null;
}

/**
 * Scan SKILL.md for model assertions tied to a specific agent and return the
 * list of contradictions: { line, lineNo, agent, expected, claimed, snippet }.
 *
 * Only ADJACENT agent-name + model-word pairs are treated as assertions, so a
 * sentence that merely lists several agents and then states one shared model
 * is matched on that one model word, not on every name on the line. Patterns:
 *   1. `name (model)`            e.g. `code-explorer (haiku)`, `implementer (opus)`
 *   2. `Model-class` after name  e.g. `code-explorer (... Haiku-class ...)`
 *   3. `name ... pin[s] model`   e.g. `... product-owner all pin sonnet`
 *   4. `model for name`          e.g. `opus for implementer`
 */
function findModelClaimDrift(truth) {
  const body = readFileSync(skillPath, "utf8");
  const lines = body.split(/\r?\n/);
  // Alternation of every agent name AND known nickname, longest first so
  // `tech-lead-consolidator` wins over a bare `consolidator` substring.
  const agentTokens = [
    ...Object.keys(truth),
    "tech-lead-planner",
    "tech-lead-consolidator",
    "planner",
    "consolidator",
  ];
  const uniqTokens = [...new Set(agentTokens)].sort((a, b) => b.length - a.length);
  const agentAlt = uniqTokens.map((t) => t.replace(/[-]/g, "\\-")).join("|");
  const modelAlt = MODEL_WORDS.join("|");

  // Each pattern captures one (agent, model) pair via named-ordered groups.
  // For each, group order is documented inline as [agentGroup, modelGroup].
  const patterns = [
    // 1. `name (model)` — agent immediately before a parenthetical model.
    { re: new RegExp(`\\b(${agentAlt})\\b[^()]{0,40}?\\((${modelAlt})\\b`, "gi"), a: 1, m: 2 },
    // 2. `Model-class` immediately after an agent name (within a short window).
    { re: new RegExp(`\\b(${agentAlt})\\b[^.]{0,60}?\\b(${modelAlt})-class\\b`, "gi"), a: 1, m: 2 },
    // 3. `name ... pin[s] model` — agent then a pin verb then the model.
    {
      re: new RegExp(`\\b(${agentAlt})\\b[^.]{0,40}?\\bpins?\\s+(${modelAlt})\\b`, "gi"),
      a: 1,
      m: 2,
    },
    // 4. `model for name` — model then "for" then the agent (e.g. "opus for implementer").
    { re: new RegExp(`\\b(${modelAlt})\\s+for\\s+\`?(${agentAlt})\\b`, "gi"), a: 2, m: 1 },
  ];

  const drift = [];
  const seen = new Set(); // dedupe (lineNo|agent|claimed) across overlapping patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, a, m } of patterns) {
      re.lastIndex = 0;
      let mm;
      while ((mm = re.exec(line)) !== null) {
        const rawAgent = mm[a];
        const claimed = mm[m].toLowerCase();
        const agent = canonicalAgent(rawAgent, truth);
        if (!agent) continue;
        const expected = truth[agent];
        if (expected !== claimed) {
          const key = `${i + 1}|${agent}|${claimed}`;
          if (seen.has(key)) continue;
          seen.add(key);
          drift.push({
            lineNo: i + 1,
            agent,
            expected,
            claimed,
            snippet: line.trim().slice(0, 140),
          });
        }
        // Avoid zero-width infinite loops on empty matches.
        if (mm.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return drift;
}

function main() {
  return getRegisteredToolNames().then((registered) => {
    const documented = getDocumentedToolNames();

    const regSet = new Set(registered);
    const docSet = new Set(documented);

    const missingFromDoc = registered.filter((n) => !docSet.has(n));
    const unknownInDoc = documented.filter((n) => !regSet.has(n));
    const toolDrift = missingFromDoc.length > 0 || unknownInDoc.length > 0;

    // Second, independent gate: model-claim drift against agent frontmatter.
    const truth = getAgentModelTruth();
    const modelDrift = findModelClaimDrift(truth);

    if (!toolDrift && modelDrift.length === 0) {
      console.log(
        `skill-drift OK — SKILL.md Phase 0 lists all ${registered.length} registered tools; ` +
          `all model claims match agent frontmatter (${Object.keys(truth).length} agents checked).`,
      );
      process.exit(0);
    }

    if (toolDrift) {
      console.error("skill-drift FAILED — SKILL.md Phase 0 is out of sync with the registry.\n");
      if (missingFromDoc.length > 0) {
        console.error("  Registered but MISSING from SKILL.md Phase 0:");
        for (const n of missingFromDoc) console.error(`    + ${n}`);
        console.error("");
      }
      if (unknownInDoc.length > 0) {
        console.error("  Listed in SKILL.md Phase 0 but NOT registered:");
        for (const n of unknownInDoc) console.error(`    - ${n}`);
        console.error("");
      }
      console.error(`  registry: ${registered.length} tools | doc: ${documented.length} entries`);
      console.error("  Fix: update skills/squad/SKILL.md Phase 0 to match the registry.\n");
    }

    if (modelDrift.length > 0) {
      console.error(
        "skill-drift FAILED — SKILL.md makes model claims that contradict agent frontmatter.\n",
      );
      const skillRel = path.relative(root, skillPath);
      for (const d of modelDrift) {
        console.error(
          `  ${skillRel}:${d.lineNo} — ${d.agent}: expected '${d.expected}' (frontmatter), ` +
            `but SKILL.md claims '${d.claimed}'`,
        );
        console.error(`      > ${d.snippet}`);
      }
      console.error("");
      console.error(
        "  Fix: agents/<name>.md frontmatter is the source of truth — correct the SKILL.md prose.",
      );
      process.exit(1);
    }

    // Reached only when there was tool-name drift but no model-claim drift
    // (the model-drift branch exits 1 above on its own).
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(`skill-drift ERROR — ${err.message}`);
  process.exit(1);
});
