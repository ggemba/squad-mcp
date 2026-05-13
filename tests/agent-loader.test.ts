import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveAgentFile,
  __resetAgentLoaderForTests,
  initLocalConfig,
  getLocalDir,
} from "../src/resources/agent-loader.js";
import { isSquadError } from "../src/errors.js";

let fakeHome: string;
let originalCwd: string;

async function insideHome(label: string): Promise<string> {
  return await fs.mkdtemp(path.join(fakeHome, label));
}

async function outsideAllowlist(label: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), label));
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  delete process.env.SQUAD_AGENTS_DIR;
  delete process.env.SQUAD_AGENTS_ALLOW_UNSAFE;
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "squad-fake-home-"));
  vi.stubEnv("HOME", fakeHome);
  vi.stubEnv("USERPROFILE", fakeHome);
  vi.stubEnv("APPDATA", path.join(fakeHome, "AppData", "Roaming"));
  vi.stubEnv("LOCALAPPDATA", path.join(fakeHome, "AppData", "Local"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(fakeHome, ".config"));
  originalCwd = process.cwd();
  process.chdir(fakeHome);
  __resetAgentLoaderForTests();
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  __resetAgentLoaderForTests();
  await fs.rm(fakeHome, { recursive: true, force: true });
});

describe("agent-loader — env unset", () => {
  it("falls back to embedded when no override dir exists (fresh install)", async () => {
    const result = await resolveAgentFile("product-owner");
    expect(result).toMatch(/agents[\\/]product-owner\.md$/);
  });
});

describe("agent-loader — env set to allowlisted dir", () => {
  it("serves override file when it exists", async () => {
    const dir = await insideHome("serve-");
    const overridePo = path.join(dir, "product-owner.md");
    await fs.writeFile(overridePo, "# overridden");
    vi.stubEnv("SQUAD_AGENTS_DIR", dir);
    __resetAgentLoaderForTests();
    const result = await resolveAgentFile("product-owner");
    const real = await fs.realpath(overridePo);
    expect(result).toBe(real);
  });

  it("falls back to embedded for that file when override does not contain it", async () => {
    const dir = await insideHome("partial-");
    await fs.writeFile(path.join(dir, "product-owner.md"), "# overridden");
    vi.stubEnv("SQUAD_AGENTS_DIR", dir);
    __resetAgentLoaderForTests();
    const archResult = await resolveAgentFile("architect");
    expect(archResult).toMatch(/agents[\\/]architect\.md$/);
  });

  it("resolves debugger from the embedded agents directory (v0.10.0)", async () => {
    __resetAgentLoaderForTests();
    const result = await resolveAgentFile("debugger");
    expect(result).toMatch(/agents[\\/]debugger\.md$/);
  });
});

describe("agent-loader — env set to non-allowlisted dir", () => {
  it("throws OVERRIDE_REJECTED when env points outside allowlist", async () => {
    const dir = await outsideAllowlist("reject-");
    vi.stubEnv("SQUAD_AGENTS_DIR", dir);
    __resetAgentLoaderForTests();
    try {
      let caught: unknown;
      try {
        await resolveAgentFile("product-owner");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isSquadError(caught)).toBe(true);
      if (isSquadError(caught)) {
        expect(caught.code).toBe("OVERRIDE_REJECTED");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("SQUAD_AGENTS_ALLOW_UNSAFE=1 bypasses the rejection", async () => {
    const dir = await outsideAllowlist("reject-unsafe-");
    await fs.writeFile(path.join(dir, "product-owner.md"), "# unsafe-override");
    vi.stubEnv("SQUAD_AGENTS_DIR", dir);
    vi.stubEnv("SQUAD_AGENTS_ALLOW_UNSAFE", "1");
    __resetAgentLoaderForTests();
    try {
      const result = await resolveAgentFile("product-owner");
      const real = await fs.realpath(path.join(dir, "product-owner.md"));
      expect(result).toBe(real);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("agent-loader — env set to non-existent dir", () => {
  it("warn-and-fallback when env points at a path that does not exist", async () => {
    const ghost = path.join(fakeHome, `ghost-${Date.now()}`);
    vi.stubEnv("SQUAD_AGENTS_DIR", ghost);
    __resetAgentLoaderForTests();
    const result = await resolveAgentFile("product-owner");
    expect(result).toMatch(/agents[\\/]product-owner\.md$/);
  });
});

describe("agent-loader — agent name traversal guard", () => {
  it("rejects unknown agent names with UNKNOWN_AGENT", async () => {
    const dir = await insideHome("trav-");
    vi.stubEnv("SQUAD_AGENTS_DIR", dir);
    __resetAgentLoaderForTests();
    let caught: unknown;
    try {
      // @ts-expect-error — testing runtime guard against type system bypass
      await resolveAgentFile("../../../etc/passwd");
    } catch (err) {
      caught = err;
    }
    expect(isSquadError(caught)).toBe(true);
    if (isSquadError(caught)) expect(caught.code).toBe("UNKNOWN_AGENT");
  });
});

describe("agent-loader — getLocalDir reflects env state", () => {
  it("returns explicit=true when SQUAD_AGENTS_DIR is set", () => {
    vi.stubEnv("SQUAD_AGENTS_DIR", "/some/path");
    const { rawDir, explicit } = getLocalDir();
    expect(explicit).toBe(true);
    expect(rawDir).toBe("/some/path");
  });

  it("returns explicit=false and the platform default when env is unset", () => {
    const { explicit } = getLocalDir();
    expect(explicit).toBe(false);
  });

  it("treats empty-string env as unset", () => {
    vi.stubEnv("SQUAD_AGENTS_DIR", "");
    const { explicit } = getLocalDir();
    expect(explicit).toBe(false);
  });
});

describe("agent-loader — initLocalConfig idempotency", () => {
  it("creates files on first run and skips on second run", async () => {
    const dir = await insideHome("init-");
    vi.stubEnv("SQUAD_AGENTS_DIR", dir);
    __resetAgentLoaderForTests();
    const first = await initLocalConfig();
    expect(first.created.length).toBeGreaterThan(0);
    expect(first.skipped.length).toBe(0);

    const second = await initLocalConfig();
    expect(second.created.length).toBe(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });
});

describe("agent-loader — filesystem permissions (Unix-only)", () => {
  it.runIf(process.platform !== "win32")(
    "initLocalConfig creates the override dir with mode 0o700",
    async () => {
      const parent = await insideHome("perms-dir-");
      const dir = path.join(parent, "agents");
      vi.stubEnv("SQUAD_AGENTS_DIR", dir);
      __resetAgentLoaderForTests();
      await initLocalConfig();
      const stat = await fs.stat(dir);
      expect(stat.mode & 0o777).toBe(0o700);
    },
  );

  it.runIf(process.platform !== "win32")(
    "initLocalConfig creates files with mode 0o600",
    async () => {
      const dir = await insideHome("perms-file-");
      vi.stubEnv("SQUAD_AGENTS_DIR", dir);
      __resetAgentLoaderForTests();
      await initLocalConfig();
      const stat = await fs.stat(path.join(dir, "product-owner.md"));
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== "win32")(
    "world-writable existing override dir triggers a warn-once log",
    async () => {
      const dir = await insideHome("perms-warn-");
      // Create a file so the override dir actually serves something
      await fs.writeFile(path.join(dir, "product-owner.md"), "# overridden");
      // Make the directory world-writable
      await fs.chmod(dir, 0o757);
      vi.stubEnv("SQUAD_AGENTS_DIR", dir);
      __resetAgentLoaderForTests();
      const { logger } = await import("../src/observability/logger.js");
      const warnSpy = vi.spyOn(logger, "warn");
      try {
        await resolveAgentFile("product-owner");
        // Trigger again — must NOT re-warn (warn-once)
        await resolveAgentFile("architect");
        const permWarnings = warnSpy.mock.calls.filter(
          (c) => typeof c[0] === "string" && c[0].includes("world-writable"),
        );
        expect(permWarnings.length).toBe(1);
      } finally {
        warnSpy.mockRestore();
        // Restore perms so the rm in afterEach can succeed
        await fs.chmod(dir, 0o700).catch(() => {});
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "group-writable (but not world-writable) does NOT trigger the warn",
    async () => {
      const dir = await insideHome("perms-group-");
      await fs.writeFile(path.join(dir, "product-owner.md"), "# overridden");
      await fs.chmod(dir, 0o770); // group-write, no other-write
      vi.stubEnv("SQUAD_AGENTS_DIR", dir);
      __resetAgentLoaderForTests();
      const { logger } = await import("../src/observability/logger.js");
      const warnSpy = vi.spyOn(logger, "warn");
      try {
        await resolveAgentFile("product-owner");
        const permWarnings = warnSpy.mock.calls.filter(
          (c) => typeof c[0] === "string" && c[0].includes("world-writable"),
        );
        expect(permWarnings.length).toBe(0);
      } finally {
        warnSpy.mockRestore();
        await fs.chmod(dir, 0o700).catch(() => {});
      }
    },
  );
});
