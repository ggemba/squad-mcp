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
// EXIT CODES
//   0 — Phase 0 list and the registry agree.
//   1 — drift detected (a two-sided diff is printed) or a runtime error.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverPath = path.resolve(root, "dist", "index.js");
const skillPath = path.resolve(root, "skills", "squad", "SKILL.md");

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

function main() {
  return getRegisteredToolNames().then((registered) => {
    const documented = getDocumentedToolNames();

    const regSet = new Set(registered);
    const docSet = new Set(documented);

    const missingFromDoc = registered.filter((n) => !docSet.has(n));
    const unknownInDoc = documented.filter((n) => !regSet.has(n));

    if (missingFromDoc.length === 0 && unknownInDoc.length === 0) {
      console.log(
        `skill-drift OK — SKILL.md Phase 0 lists all ${registered.length} registered tools.`,
      );
      process.exit(0);
    }

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
    console.error("  Fix: update skills/squad/SKILL.md Phase 0 to match the registry.");
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(`skill-drift ERROR — ${err.message}`);
  process.exit(1);
});
