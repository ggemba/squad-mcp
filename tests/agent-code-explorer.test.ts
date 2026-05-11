import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  AGENT_NAMES,
  AGENT_NAMES_TUPLE,
  CONTENT_SIGNALS,
  PATH_HINTS,
  SQUAD_BY_TYPE,
} from "../src/config/ownership-matrix.js";
import { selectSquad } from "../src/tools/select-squad.js";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";

describe("code-explorer agent — registration", () => {
  it("appears in AGENT_NAMES and AGENT_NAMES_TUPLE", () => {
    expect(AGENT_NAMES).toContain("code-explorer");
    expect(AGENT_NAMES_TUPLE).toContain("code-explorer");
  });

  it("has weight 0 and empty dimension (utility role, not advisor)", () => {
    const def = AGENTS["code-explorer"];
    expect(def).toBeDefined();
    expect(def.weight).toBe(0);
    expect(def.dimension).toBe("");
    expect(def.role).toMatch(/search|explorer|read-only/i);
  });

  it("agent markdown ships in the repo at agents/code-explorer.md", async () => {
    const abs = path.join(REPO_ROOT, "agents/code-explorer.md");
    const stat = await fs.stat(abs);
    expect(stat.isFile()).toBe(true);
    const content = await fs.readFile(abs, "utf8");
    // Front-matter: locked at Haiku for speed, name must match the registered key.
    expect(content).toMatch(/^---\s*\nname:\s*code-explorer\s*\n/);
    expect(content).toMatch(/\nmodel:\s*haiku\s*\n/);
  });
});

describe("code-explorer agent — NOT auto-selected by the matrix", () => {
  // Inviolable contract: code-explorer is a utility, not an advisor. It must
  // never be force-included on every Feature/Refactor/etc by the matrix — that
  // would dilute the rubric and inflate every run. Only force_agents and
  // explicit Task() dispatch put it in the squad.
  for (const workType of Object.keys(SQUAD_BY_TYPE) as (keyof typeof SQUAD_BY_TYPE)[]) {
    it(`is absent from SQUAD_BY_TYPE[${workType}].core and .conditional`, () => {
      const entry = SQUAD_BY_TYPE[workType];
      expect(entry.core).not.toContain("code-explorer");
      const conditionalAgents = entry.conditional.map((c) => c.agent);
      expect(conditionalAgents).not.toContain("code-explorer");
    });
  }

  it("is not the target of any PATH_HINT", () => {
    for (const hint of PATH_HINTS) {
      expect(hint.agent).not.toBe("code-explorer");
    }
  });

  it("is not the target of any CONTENT_SIGNAL", () => {
    for (const sig of CONTENT_SIGNALS) {
      expect(sig.agent).not.toBe("code-explorer");
    }
  });

  it("selectSquad never emits code-explorer on a vanilla Feature", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: ["src/api/foo.ts", "src/services/bar.ts"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).not.toContain("code-explorer");
  });
});

describe("code-explorer agent — explicit opt-in via force_agents", () => {
  it("is accepted by select_squad's force_agents Zod enum", async () => {
    // Smoke: if the new agent name is missing from AGENT_NAMES_TUPLE, this
    // throws an INVALID_INPUT zod error before reaching the handler.
    const r = await selectSquad({
      work_type: "Bug Fix",
      files: [],
      read_content: false,
      force_agents: ["code-explorer"],
    });
    expect(r.agents).toContain("code-explorer");
    const rationale = r.rationale.find((x) => x.agent === "code-explorer");
    expect(rationale).toBeDefined();
    expect(rationale?.reason).toMatch(/forced/i);
  });
});
