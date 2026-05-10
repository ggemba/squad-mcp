import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validateOverrideDir,
  validateOverrideFile,
  rejectionToError,
  __resetOverrideAllowlistCache,
} from "../src/util/override-allowlist.js";

let fakeHome: string;
let originalCwd: string;

async function insideHome(label = "oa-"): Promise<string> {
  return await fs.mkdtemp(path.join(fakeHome, label));
}

async function outsideAllowlist(label = "oa-out-"): Promise<string> {
  // Real os.tmpdir() is unaffected by HOME/APPDATA stubs and lives outside fakeHome.
  return await fs.mkdtemp(path.join(os.tmpdir(), label));
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  __resetOverrideAllowlistCache();
  delete process.env.SQUAD_AGENTS_DIR;
  delete process.env.SQUAD_AGENTS_ALLOW_UNSAFE;
  // Build an isolated fake home in real os.tmpdir() and route every allowlist
  // env source there so the allowlist does not cover the real user's HOME.
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "squad-fake-home-"));
  vi.stubEnv("HOME", fakeHome);
  vi.stubEnv("USERPROFILE", fakeHome);
  vi.stubEnv("APPDATA", path.join(fakeHome, "AppData", "Roaming"));
  vi.stubEnv("LOCALAPPDATA", path.join(fakeHome, "AppData", "Local"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(fakeHome, ".config"));
  originalCwd = process.cwd();
  process.chdir(fakeHome);
  __resetOverrideAllowlistCache();
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  __resetOverrideAllowlistCache();
  await fs.rm(fakeHome, { recursive: true, force: true });
});

describe("validateOverrideDir — accept paths under stubbed HOME", () => {
  it("accepts a directory directly under stubbed HOME", async () => {
    const dir = await insideHome();
    const result = await validateOverrideDir(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(["home", "cwd"]).toContain(result.allowlistMatch);
      expect(result.unsafeOverride).toBe(false);
    }
  });

  it("accepts deep child of HOME", async () => {
    const top = await insideHome();
    const deep = path.join(top, "a", "b", "c");
    await fs.mkdir(deep, { recursive: true });
    const result = await validateOverrideDir(deep);
    expect(result.ok).toBe(true);
  });
});

describe("validateOverrideDir — reject paths outside allowlist", () => {
  it("rejects a path under real os.tmpdir() outside fakeHome", async () => {
    const dir = await outsideAllowlist();
    try {
      const result = await validateOverrideDir(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("outside_allowlist");
        expect(result.rejectedPath).toBe(dir);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects /etc on Unix", async () => {
    if (process.platform === "win32") return;
    const result = await validateOverrideDir("/etc");
    expect(result.ok).toBe(false);
  });

  it("rejects substring-prefix of HOME (regression: no startsWith bug)", async () => {
    const evil = fakeHome + "-evil";
    const result = await validateOverrideDir(evil);
    expect(result.ok).toBe(false);
  });
});

describe("validateOverrideDir — malformed input rejection", () => {
  it("rejects relative paths", async () => {
    const result = await validateOverrideDir("./relative/path");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_absolute");
  });

  it("rejects empty string", async () => {
    const result = await validateOverrideDir("");
    expect(result.ok).toBe(false);
  });

  it("rejects tilde-prefixed paths (no shell expansion)", async () => {
    const result = await validateOverrideDir("~/something");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});

describe("validateOverrideDir — UNC/device-namespace rejection (Windows)", () => {
  it.runIf(process.platform === "win32")("rejects UNC \\\\server\\share", async () => {
    const result = await validateOverrideDir("\\\\server\\share\\agents");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unc_or_device_namespace");
  });

  it.runIf(process.platform === "win32")(
    "rejects long-path UNC \\\\?\\UNC\\server\\share",
    async () => {
      const result = await validateOverrideDir("\\\\?\\UNC\\server\\share\\agents");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unc_or_device_namespace");
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects device namespace \\\\.\\PhysicalDrive0",
    async () => {
      const result = await validateOverrideDir("\\\\.\\PhysicalDrive0");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unc_or_device_namespace");
    },
  );
});

describe("validateOverrideDir — escape hatch SQUAD_AGENTS_ALLOW_UNSAFE", () => {
  it("only the literal string '1' bypasses the allowlist", async () => {
    const dir = await outsideAllowlist("reject-unsafe-");
    try {
      vi.stubEnv("SQUAD_AGENTS_ALLOW_UNSAFE", "true");
      __resetOverrideAllowlistCache();
      let result = await validateOverrideDir(dir);
      expect(result.ok).toBe(false);

      vi.stubEnv("SQUAD_AGENTS_ALLOW_UNSAFE", "1");
      __resetOverrideAllowlistCache();
      result = await validateOverrideDir(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.unsafeOverride).toBe(true);
        expect(result.allowlistMatch).toBe("unsafe_override");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("escape hatch does NOT bypass malformed input rejection", async () => {
    vi.stubEnv("SQUAD_AGENTS_ALLOW_UNSAFE", "1");
    __resetOverrideAllowlistCache();
    const result = await validateOverrideDir("~/danger");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});

describe("validateOverrideDir — symlink escape", () => {
  it.runIf(process.platform !== "win32")(
    "rejects override dir that is a symlink to outside allowlist",
    async () => {
      const target = await outsideAllowlist("symlink-target-");
      const link = path.join(fakeHome, `link-${Date.now()}`);
      await fs.symlink(target, link, "dir");
      try {
        const result = await validateOverrideDir(link);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("symlink_escape");
      } finally {
        await fs.unlink(link).catch(() => {});
        await fs.rm(target, { recursive: true, force: true });
      }
    },
  );
});

describe("rejectionToError", () => {
  it("produces a SquadError with code OVERRIDE_REJECTED and details fields", () => {
    const err = rejectionToError(
      { ok: false, reason: "outside_allowlist", rejectedPath: "/etc" },
      5,
    );
    expect(err.code).toBe("OVERRIDE_REJECTED");
    expect(err.details).toMatchObject({
      reason: "outside_allowlist",
      path: "/etc",
      allowlist_size: 5,
    });
  });
});

describe("validateOverrideFile", () => {
  it("accepts a file inside the validated dir", async () => {
    const dir = await insideHome("vof-");
    const file = path.join(dir, "product-owner.md");
    await fs.writeFile(file, "content");
    const real = await fs.realpath(dir);
    const result = await validateOverrideFile(real, "product-owner.md");
    expect(result).not.toBeNull();
  });

  it("returns null for non-existent file", async () => {
    const dir = await insideHome("vof-miss-");
    const real = await fs.realpath(dir);
    const result = await validateOverrideFile(real, "missing.md");
    expect(result).toBeNull();
  });

  it("rejects file name with traversal segments", async () => {
    const dir = await insideHome("vof-trav-");
    const real = await fs.realpath(dir);
    const result = await validateOverrideFile(real, "../etc/passwd");
    expect(result).toBeNull();
  });

  it("rejects absolute file name", async () => {
    const dir = await insideHome("vof-abs-");
    const real = await fs.realpath(dir);
    const target =
      process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/passwd";
    const result = await validateOverrideFile(real, target);
    expect(result).toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "rejects file whose realpath escapes the validated dir (symlink to outside)",
    async () => {
      const dir = await insideHome("vof-sym-");
      const target = path.join(os.tmpdir(), `oa-target-${Date.now()}.md`);
      await fs.writeFile(target, "evil");
      const link = path.join(dir, "product-owner.md");
      await fs.symlink(target, link);
      try {
        const real = await fs.realpath(dir);
        const result = await validateOverrideFile(real, "product-owner.md");
        expect(result).toBeNull();
      } finally {
        await fs.unlink(link).catch(() => {});
        await fs.unlink(target).catch(() => {});
      }
    },
  );
});
