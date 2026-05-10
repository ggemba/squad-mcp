import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readSquadYaml,
  applySkipPaths,
  applyDisableAgents,
  matchesGlob,
  __resetSquadYamlCacheForTests,
} from "../src/config/squad-yaml.js";
import { isSquadError } from "../src/errors.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "squad-yaml-test-"));
  __resetSquadYamlCacheForTests();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  __resetSquadYamlCacheForTests();
});

describe("readSquadYaml — file presence", () => {
  it("returns defaults when no .squad.yaml exists", async () => {
    const config = await readSquadYaml(workspace);
    expect(config.source).toBeNull();
    expect(config.threshold).toBe(75);
    expect(config.min_score).toBeUndefined();
    expect(config.skip_paths).toEqual([]);
    expect(config.disable_agents).toEqual([]);
    // Default weights present and sum to 100
    const sum = Object.values(config.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("reads .squad.yaml when present", async () => {
    await fs.writeFile(
      path.join(workspace, ".squad.yaml"),
      "threshold: 80\nmin_score: 70\n",
    );
    const config = await readSquadYaml(workspace);
    expect(config.source).toContain(".squad.yaml");
    expect(config.threshold).toBe(80);
    expect(config.min_score).toBe(70);
  });

  it("reads .squad.yml as a fallback", async () => {
    await fs.writeFile(path.join(workspace, ".squad.yml"), "threshold: 90\n");
    const config = await readSquadYaml(workspace);
    expect(config.source).toContain(".squad.yml");
    expect(config.threshold).toBe(90);
  });

  it("prefers .squad.yaml over .squad.yml when both exist", async () => {
    await fs.writeFile(path.join(workspace, ".squad.yaml"), "threshold: 80\n");
    await fs.writeFile(path.join(workspace, ".squad.yml"), "threshold: 90\n");
    const config = await readSquadYaml(workspace);
    expect(config.source).toContain(".squad.yaml");
    expect(config.threshold).toBe(80);
  });

  it("handles empty .squad.yaml as defaults", async () => {
    await fs.writeFile(path.join(workspace, ".squad.yaml"), "");
    const config = await readSquadYaml(workspace);
    expect(config.threshold).toBe(75);
  });
});

describe("readSquadYaml — weights override", () => {
  it("accepts weights that sum to 100 and zeroes out the rest", async () => {
    await fs.writeFile(
      path.join(workspace, ".squad.yaml"),
      `weights:
  senior-architect: 50
  senior-dev-security: 50
`,
    );
    const config = await readSquadYaml(workspace);
    expect(config.weights["senior-architect"]).toBe(50);
    expect(config.weights["senior-dev-security"]).toBe(50);
    // Agents NOT in the override list zero out (override = explicit choice).
    expect(config.weights["senior-developer"]).toBe(0);
    expect(config.weights["product-owner"]).toBe(0);
  });

  it("rejects weights that do not sum to 100", async () => {
    await fs.writeFile(
      path.join(workspace, ".squad.yaml"),
      `weights:
  senior-architect: 60
  senior-dev-security: 30
`,
    );
    let caught: unknown;
    try {
      await readSquadYaml(workspace);
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
    if (isSquadError(caught)) {
      expect(caught.code).toBe("INVALID_INPUT");
      expect(caught.message).toMatch(/sum to 100/);
    }
  });

  it("rejects unknown agent names in weights", async () => {
    await fs.writeFile(
      path.join(workspace, ".squad.yaml"),
      `weights:
  not-an-agent: 100
`,
    );
    let caught: unknown;
    try {
      await readSquadYaml(workspace);
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
    if (isSquadError(caught)) {
      expect(caught.code).toBe("INVALID_INPUT");
    }
  });
});

describe("readSquadYaml — skip_paths and disable_agents", () => {
  it("parses skip_paths", async () => {
    await fs.writeFile(
      path.join(workspace, ".squad.yaml"),
      `skip_paths:
  - "docs/**"
  - "**/*.md"
`,
    );
    const config = await readSquadYaml(workspace);
    expect(config.skip_paths).toEqual(["docs/**", "**/*.md"]);
  });

  it("parses disable_agents", async () => {
    await fs.writeFile(
      path.join(workspace, ".squad.yaml"),
      `disable_agents:
  - product-owner
  - senior-dba
`,
    );
    const config = await readSquadYaml(workspace);
    expect(config.disable_agents).toEqual(["product-owner", "senior-dba"]);
  });

  it("rejects unknown agents in disable_agents", async () => {
    await fs.writeFile(
      path.join(workspace, ".squad.yaml"),
      `disable_agents:
  - bogus-agent
`,
    );
    let caught: unknown;
    try {
      await readSquadYaml(workspace);
    } catch (e) {
      caught = e;
    }
    expect(isSquadError(caught)).toBe(true);
  });
});

describe("readSquadYaml — caching", () => {
  it("caches the result by mtimeMs", async () => {
    const filePath = path.join(workspace, ".squad.yaml");
    await fs.writeFile(filePath, "threshold: 80\n");
    const a = await readSquadYaml(workspace);
    const b = await readSquadYaml(workspace);
    expect(a).toBe(b); // same object reference — cache hit
  });

  it("invalidates cache when file mtime changes", async () => {
    const filePath = path.join(workspace, ".squad.yaml");
    await fs.writeFile(filePath, "threshold: 80\n");
    const a = await readSquadYaml(workspace);
    expect(a.threshold).toBe(80);

    // Modify with a future mtime to guarantee the cache key changes.
    await fs.writeFile(filePath, "threshold: 90\n");
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(filePath, future, future);

    const b = await readSquadYaml(workspace);
    expect(b.threshold).toBe(90);
    expect(b).not.toBe(a);
  });
});

describe("matchesGlob", () => {
  it("matches double-star segments (zero or more)", () => {
    expect(matchesGlob("docs/**", "docs/intro.md")).toBe(true);
    expect(matchesGlob("docs/**", "docs/sub/a.md")).toBe(true);
    expect(matchesGlob("docs/**", "src/foo.ts")).toBe(false);
  });

  it("matches **/X form (any depth, file at end)", () => {
    expect(matchesGlob("**/*.md", "README.md")).toBe(true);
    expect(matchesGlob("**/*.md", "docs/intro.md")).toBe(true);
    expect(matchesGlob("**/*.md", "a/b/c.md")).toBe(true);
    expect(matchesGlob("**/*.md", "src/foo.ts")).toBe(false);
  });

  it("single star does NOT cross directory separators", () => {
    expect(matchesGlob("src/*.ts", "src/foo.ts")).toBe(true);
    expect(matchesGlob("src/*.ts", "src/sub/foo.ts")).toBe(false);
  });

  it("exact strings", () => {
    expect(matchesGlob("package.json", "package.json")).toBe(true);
    expect(matchesGlob("package.json", "package-lock.json")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    expect(matchesGlob("foo.bar", "fooXbar")).toBe(false);
    expect(matchesGlob("foo.bar", "foo.bar")).toBe(true);
  });
});

describe("applySkipPaths", () => {
  it("returns input untouched when no patterns", () => {
    const r = applySkipPaths(["a.ts", "b.ts"], []);
    expect(r.kept).toEqual(["a.ts", "b.ts"]);
    expect(r.skipped).toEqual([]);
  });

  it("partitions files by pattern match", () => {
    const r = applySkipPaths(
      ["src/foo.ts", "docs/intro.md", "README.md", "src/bar.ts"],
      ["docs/**", "**/*.md"],
    );
    expect(r.kept).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(r.skipped).toEqual(["docs/intro.md", "README.md"]);
  });
});

describe("applyDisableAgents", () => {
  it("returns input untouched when nothing disabled", () => {
    const r = applyDisableAgents(["senior-architect", "senior-developer"], []);
    expect(r).toEqual(["senior-architect", "senior-developer"]);
  });

  it("removes the disabled agents", () => {
    const r = applyDisableAgents(
      ["senior-architect", "senior-developer", "product-owner"],
      ["product-owner"],
    );
    expect(r).toEqual(["senior-architect", "senior-developer"]);
  });
});
