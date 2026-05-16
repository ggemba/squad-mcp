import { describe, it, expect } from "vitest";
import { readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readAgentLanguageSupplement,
  readAgentLanguageSupplements,
  readAgentFrameworkSupplement,
  readAgentFrameworkSupplements,
} from "../src/resources/agent-loader.js";
import { LANGUAGE_AWARE_AGENTS } from "../src/tools/compose-advisory-bundle.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS_DIR = join(REPO_ROOT, "agents");

describe("readAgentLanguageSupplement — single language", () => {
  it("returns the typescript supplement for reviewer", async () => {
    const body = await readAgentLanguageSupplement("reviewer", "typescript");
    expect(body).not.toBeNull();
    // Body is a markdown checklist, not a JSON envelope — sanity-grep one
    // checklist item to confirm it loaded the right file.
    expect(body!.toLowerCase()).toContain("typescript");
  });

  it("returns null for an agent that has no .langs/ directory", async () => {
    // architect is intentionally NOT in LANGUAGE_AWARE_AGENTS and has
    // no .langs/ directory; the loader returns null without touching fs
    // (well, it touches fs and gets ENOENT, then returns null).
    const body = await readAgentLanguageSupplement("architect", "typescript");
    expect(body).toBeNull();
  });

  it("returns null for a language that has no supplement on disk", async () => {
    // We ship typescript/python/csharp initially; ruby is a valid Language
    // but has no .md yet — should silently return null.
    const body = await readAgentLanguageSupplement("reviewer", "ruby");
    expect(body).toBeNull();
  });

  it("rejects path-traversal-shaped language identifiers", async () => {
    // Defense in depth: the regex gate on language id stops `../something`
    // before any fs call.
    const traversal = await readAgentLanguageSupplement("reviewer", "../typescript");
    expect(traversal).toBeNull();
  });

  it("rejects language identifiers with uppercase / spaces", async () => {
    expect(await readAgentLanguageSupplement("reviewer", "TypeScript")).toBeNull();
    expect(await readAgentLanguageSupplement("reviewer", "type script")).toBeNull();
  });
});

describe("readAgentLanguageSupplements — bulk", () => {
  it("returns only the languages that exist on disk", async () => {
    const map = await readAgentLanguageSupplements("reviewer", [
      "typescript",
      "python",
      "csharp",
      "ruby", // not yet shipped
      "swift", // not yet shipped
    ]);
    expect(Object.keys(map).sort()).toEqual(["csharp", "python", "typescript"]);
    expect(map.typescript).toBeDefined();
    expect(map.python).toBeDefined();
    expect(map.csharp).toBeDefined();
    expect(map.ruby).toBeUndefined();
    expect(map.swift).toBeUndefined();
  });

  it("returns empty record for an agent without .langs/", async () => {
    const map = await readAgentLanguageSupplements("architect", ["typescript", "python"]);
    expect(map).toEqual({});
  });

  it("returns empty record when languages list is empty", async () => {
    const map = await readAgentLanguageSupplements("reviewer", []);
    expect(map).toEqual({});
  });

  it("each of the 4 LANGUAGE_AWARE_AGENTS has supplements for the initial 3 languages", async () => {
    const agents = ["developer", "reviewer", "qa", "implementer"] as const;
    for (const a of agents) {
      const map = await readAgentLanguageSupplements(a, ["typescript", "python", "csharp"]);
      expect(Object.keys(map).sort(), `agent=${a}`).toEqual(["csharp", "python", "typescript"]);
    }
  });
});

describe("LANGUAGE_AWARE_AGENTS contract — const matches on-disk .langs/ directories", () => {
  // Resolves the architect Major from the v0.13 squad review (round 1):
  // dual SoT between the const in compose-advisory-bundle.ts and the on-disk
  // `agents/<name>.langs/` directories. This test fails loudly the moment the
  // two drift, forcing the maintainer to update both together.
  it("every directory `agents/<name>.langs/` is enumerated in LANGUAGE_AWARE_AGENTS", async () => {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    const onDiskAgents = entries
      .filter((e) => e.isDirectory() && e.name.endsWith(".langs"))
      .map((e) => e.name.replace(/\.langs$/, ""))
      .sort();

    const constSorted = [...LANGUAGE_AWARE_AGENTS].sort();
    expect(onDiskAgents, "on-disk .langs/ directories must match LANGUAGE_AWARE_AGENTS").toEqual(
      constSorted,
    );
  });

  it("every agent in LANGUAGE_AWARE_AGENTS has a `.langs/` directory on disk", async () => {
    for (const agent of LANGUAGE_AWARE_AGENTS) {
      const dir = join(AGENTS_DIR, `${agent}.langs`);
      const s = await stat(dir);
      expect(s.isDirectory(), `expected directory at ${dir}`).toBe(true);
    }
  });

  it("every agent in LANGUAGE_AWARE_AGENTS has a corresponding agents/<name>.md file", async () => {
    // The `.langs/` directory is meaningless without the parent agent file.
    for (const agent of LANGUAGE_AWARE_AGENTS) {
      const file = join(AGENTS_DIR, `${agent}.md`);
      const s = await stat(file);
      expect(s.isFile(), `expected agent definition at ${file}`).toBe(true);
    }
  });
});

describe("readAgentFrameworkSupplement — framework supplements", () => {
  it("returns the react supplement for reviewer", async () => {
    const body = await readAgentFrameworkSupplement("reviewer", "react");
    expect(body).not.toBeNull();
    expect(body!.toLowerCase()).toContain("react");
  });

  it("returns null for an agent with no .frameworks/ directory", async () => {
    expect(await readAgentFrameworkSupplement("architect", "react")).toBeNull();
  });

  it("returns null for a framework with no supplement on disk", async () => {
    expect(await readAgentFrameworkSupplement("reviewer", "solid")).toBeNull();
  });

  it("rejects path-traversal-shaped framework identifiers", async () => {
    expect(await readAgentFrameworkSupplement("reviewer", "../react")).toBeNull();
  });

  it("bulk variant returns only frameworks that exist on disk", async () => {
    const map = await readAgentFrameworkSupplements("reviewer", [
      "react",
      "vue",
      "angular",
      "svelte",
      "solid", // not shipped
    ]);
    expect(Object.keys(map).sort()).toEqual(["angular", "react", "svelte", "vue"]);
    expect(map.solid).toBeUndefined();
  });

  it("every framework-aware agent ships all four framework supplements", async () => {
    for (const agent of LANGUAGE_AWARE_AGENTS) {
      for (const fw of ["react", "vue", "angular", "svelte"]) {
        const file = join(AGENTS_DIR, `${agent}.frameworks`, `${fw}.md`);
        const s = await stat(file);
        expect(s.isFile(), `expected agents/${agent}.frameworks/${fw}.md`).toBe(true);
      }
    }
  });

  it("every `.frameworks/` directory belongs to a LANGUAGE_AWARE_AGENT", async () => {
    // Framework supplements are looked up over the same agent set as `.langs/`
    // (the `compose_advisory_bundle` loop iterates LANGUAGE_AWARE_AGENTS). A
    // `.frameworks/` directory on any other agent would be dead weight.
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    const onDisk = entries
      .filter((e) => e.isDirectory() && e.name.endsWith(".frameworks"))
      .map((e) => e.name.replace(/\.frameworks$/, ""))
      .sort();
    expect(onDisk).toEqual([...LANGUAGE_AWARE_AGENTS].sort());
  });
});
