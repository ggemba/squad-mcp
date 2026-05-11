import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DetectChangedFilesOutput } from "../src/tools/detect-changed-files.js";

vi.mock("../src/tools/detect-changed-files.js", () => ({
  detectChangedFiles: vi.fn(),
}));

// extractFileHunks is mocked because it shells out to git diff via runGit —
// unit tests cannot rely on the test workspace's git state. The mock lets us
// assert the bundle's per-agent hunk filtering and back-compat behaviour.
vi.mock("../src/exec/diff-hunks.js", () => ({
  extractFileHunks: vi.fn(),
}));

import { detectChangedFiles } from "../src/tools/detect-changed-files.js";
import { extractFileHunks, type FileHunk } from "../src/exec/diff-hunks.js";
import {
  composeAdvisoryBundle,
  LANGUAGE_AWARE_AGENTS,
} from "../src/tools/compose-advisory-bundle.js";
import { logger } from "../src/observability/logger.js";
import * as agentLoader from "../src/resources/agent-loader.js";

const detectChangedFilesMock = detectChangedFiles as unknown as ReturnType<typeof vi.fn>;
const extractFileHunksMock = extractFileHunks as unknown as ReturnType<typeof vi.fn>;

function fakeHunk(diffSnippet: string, opts: Partial<FileHunk> = {}): FileHunk {
  return {
    diff: diffSnippet,
    truncated: false,
    full_file_changed: false,
    is_binary: false,
    byte_size: Buffer.byteLength(diffSnippet, "utf8"),
    ...opts,
  };
}

const baseChanged: DetectChangedFilesOutput = {
  files: [
    { path: "src/AuthController.cs", status: "modified", raw_status: "M" },
    { path: "src/Repositories/UserRepository.cs", status: "modified", raw_status: "M" },
    { path: "tests/AuthTests.cs", status: "added", raw_status: "A" },
  ],
  base_ref: "HEAD~1",
  staged_only: false,
  invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
};

beforeEach(() => {
  detectChangedFilesMock.mockReset();
  extractFileHunksMock.mockReset();
  // Default mock: empty hunks (preserves back-compat for existing tests that
  // don't care about hunk content). Tests asserting on hunks_by_agent override.
  extractFileHunksMock.mockResolvedValue({});
});

describe("composeAdvisoryBundle", () => {
  it("returns workflow + slices_by_agent + plan_validation", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeAdvisoryBundle({
      workspace_root: "C:/fake/workspace",
      user_prompt: "add new authentication endpoint",
      plan: "Step 1: design endpoint. Step 2: add validation. Step 3: write tests.",
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(out.workflow).toBeDefined();
    expect(out.workflow.squad.agents.length).toBeGreaterThan(0);
    expect(out.slices_by_agent).toBeDefined();
    expect(out.plan_validation).toBeDefined();
    expect(out.plan_validation.advisory).toBe(true);
  });

  it("produces a slice entry for every selected agent", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeAdvisoryBundle({
      workspace_root: "C:/fake/workspace",
      user_prompt: "add new feature for users",
      plan: "plan body",
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    for (const agent of out.workflow.squad.agents) {
      expect(out.slices_by_agent[agent]).toBeDefined();
      expect(out.slices_by_agent[agent]!.agent).toBe(agent);
    }
  });

  it("flags GIT_COMMIT_FENCE in plan via plan_validation", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeAdvisoryBundle({
      workspace_root: "C:/fake/workspace",
      user_prompt: "feature work",
      plan: 'Step 1: code.\n\n```sh\ngit commit -m "wip"\n```\n',
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(out.plan_validation.findings.some((f) => f.rule === "GIT_COMMIT_FENCE")).toBe(true);
  });

  it("returns empty findings on a clean plan", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeAdvisoryBundle({
      workspace_root: "C:/fake/workspace",
      user_prompt: "feature",
      plan: "Awaiting plan approved sign-off before proceeding to implementation.",
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(out.plan_validation.findings).toEqual([]);
  });

  it("passes force_agents through to underlying squad", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeAdvisoryBundle({
      workspace_root: "C:/fake/workspace",
      user_prompt: "feature",
      plan: "plan",
      force_agents: ["senior-dba", "senior-dev-security"],
      read_content: false,
      staged_only: false,
    });

    expect(out.workflow.squad.agents).toEqual(
      expect.arrayContaining(["senior-dba", "senior-dev-security"]),
    );
    expect(out.slices_by_agent["senior-dba"]).toBeDefined();
    expect(out.slices_by_agent["senior-dev-security"]).toBeDefined();
  });

  describe("v0.12 perf path — hunks_by_agent", () => {
    it("emits hunks_by_agent by default (include_hunks defaults to true)", async () => {
      detectChangedFilesMock.mockResolvedValue(baseChanged);
      extractFileHunksMock.mockResolvedValue({
        "src/AuthController.cs": fakeHunk("@@ -1,3 +1,3 @@\n-old\n+new\n"),
        "src/Repositories/UserRepository.cs": fakeHunk("@@ -10,2 +10,2 @@\n-a\n+b\n"),
        "tests/AuthTests.cs": fakeHunk("@@ -0,0 +1,5 @@\n+new test\n", { full_file_changed: true }),
      });

      const out = await composeAdvisoryBundle({
        workspace_root: process.cwd(),
        user_prompt: "add auth endpoint",
        plan: "step 1: implement; step 2: tests",
        read_content: false,
        staged_only: false,
        force_agents: [],
      });

      expect(out.hunks_by_agent).toBeDefined();
      expect(extractFileHunksMock).toHaveBeenCalledTimes(1);
      // Every selected agent gets a (possibly empty) per-agent hunk map.
      for (const agent of out.workflow.squad.agents) {
        expect(out.hunks_by_agent![agent]).toBeDefined();
      }
    });

    it("omits hunks_by_agent when include_hunks is false", async () => {
      detectChangedFilesMock.mockResolvedValue(baseChanged);

      const out = await composeAdvisoryBundle({
        workspace_root: "C:/fake/workspace",
        user_prompt: "add auth endpoint",
        plan: "plan",
        read_content: false,
        staged_only: false,
        force_agents: [],
        include_hunks: false,
      });

      expect(out.hunks_by_agent).toBeUndefined();
      expect(extractFileHunksMock).not.toHaveBeenCalled();
    });

    it("filters hunks per agent against their matched files", async () => {
      detectChangedFilesMock.mockResolvedValue(baseChanged);
      extractFileHunksMock.mockResolvedValue({
        "src/AuthController.cs": fakeHunk("controller diff"),
        "src/Repositories/UserRepository.cs": fakeHunk("repo diff"),
        "tests/AuthTests.cs": fakeHunk("test diff"),
      });

      const out = await composeAdvisoryBundle({
        workspace_root: process.cwd(),
        user_prompt: "auth feature",
        plan: "plan",
        force_agents: ["senior-dba", "senior-dev-reviewer"],
        read_content: false,
        staged_only: false,
      });

      // Each agent's hunks are the intersection of allHunks and the agent's
      // matched files. Hunks for paths NOT in the agent's slice must NOT
      // appear on that agent.
      for (const agent of out.workflow.squad.agents) {
        const matched = new Set((out.slices_by_agent[agent]?.matched ?? []).map((m) => m.file));
        const agentHunks = out.hunks_by_agent![agent] ?? {};
        for (const p of Object.keys(agentHunks)) {
          expect(matched.has(p)).toBe(true);
        }
      }
    });

    it("survives extractFileHunks failure by warning + omitting hunks", async () => {
      // Spy on the unexpected-error log path to verify the catch actually
      // surfaces a structured error signal, not just silent absence.
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      detectChangedFilesMock.mockResolvedValue(baseChanged);
      extractFileHunksMock.mockRejectedValue(new Error("git diff exit 128: not a repo"));

      const out = await composeAdvisoryBundle({
        workspace_root: process.cwd(),
        user_prompt: "x",
        plan: "plan",
        read_content: false,
        staged_only: false,
        force_agents: [],
      });

      // Bundle still produced; hunks gracefully absent.
      expect(out.workflow).toBeDefined();
      expect(out.slices_by_agent).toBeDefined();
      expect(out.hunks_by_agent).toBeUndefined();
      // Structured signal so the orchestrator can warn the user.
      expect(out.hunks_status).toBe("extraction_failed");
      expect(out.hunks_error).toMatchObject({
        code: "UNKNOWN", // generic Error → not a SquadError → "UNKNOWN"
        message: expect.stringContaining("not a repo"),
      });
      // Unexpected (non-SquadError) failure → logged at error level with
      // structured details, never at warn.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain("hunks extraction failed");
      errorSpy.mockRestore();
    });

    it("happy path sets hunks_status='ok' and omits hunks_error", async () => {
      detectChangedFilesMock.mockResolvedValue(baseChanged);
      extractFileHunksMock.mockResolvedValue({
        "src/AuthController.cs": fakeHunk("diff"),
      });
      const out = await composeAdvisoryBundle({
        workspace_root: process.cwd(),
        user_prompt: "x",
        plan: "plan",
        read_content: false,
        staged_only: false,
        force_agents: [],
      });
      expect(out.hunks_status).toBe("ok");
      expect(out.hunks_error).toBeUndefined();
    });

    it("include_hunks=false sets hunks_status='skipped'", async () => {
      detectChangedFilesMock.mockResolvedValue(baseChanged);
      const out = await composeAdvisoryBundle({
        workspace_root: "C:/fake/workspace",
        user_prompt: "x",
        plan: "plan",
        read_content: false,
        staged_only: false,
        force_agents: [],
        include_hunks: false,
      });
      expect(out.hunks_status).toBe("skipped");
      expect(out.hunks_error).toBeUndefined();
    });

    it("skips the hunk extraction call when filePaths is empty", async () => {
      detectChangedFilesMock.mockResolvedValue({
        ...baseChanged,
        files: [],
      });

      const out = await composeAdvisoryBundle({
        workspace_root: "C:/fake/workspace",
        user_prompt: "no changes yet",
        plan: "plan",
        read_content: false,
        staged_only: false,
        force_agents: [],
      });

      expect(extractFileHunksMock).not.toHaveBeenCalled();
      expect(out.hunks_by_agent).toBeUndefined();
    });
  });

  // v0.13 — language-aware bundling. Resolves the QA Major from the round-1
  // squad review on language segmentation: the new fields had ZERO bundle
  // integration coverage. These tests exercise the full
  // detect → look-up → emit pipeline through composeAdvisoryBundle.
  describe("language-aware supplements (v0.13)", () => {
    // POSIX-only paths so this fixture's behaviour is identical on
    // Linux/macOS CI and Windows local. The Windows-backslash path is
    // covered by a dedicated test below — keeping it out of the shared
    // fixture avoids triggering Linux-side path-normalisation warns that
    // distort the fail-soft warn-cardinality assertion.
    const tsChanged: DetectChangedFilesOutput = {
      files: [
        { path: "src/auth/jwt-validator.ts", status: "modified", raw_status: "M" },
        { path: "src/auth/session.ts", status: "modified", raw_status: "M" },
        { path: "src/auth/types.ts", status: "added", raw_status: "A" },
        { path: "tests/jwt.test.ts", status: "added", raw_status: "A" },
      ],
      base_ref: "HEAD~1",
      staged_only: false,
      invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
    };

    const mixedChanged: DetectChangedFilesOutput = {
      files: [
        { path: "src/auth/jwt-validator.ts", status: "modified", raw_status: "M" },
        { path: "src/auth/session.ts", status: "modified", raw_status: "M" },
        { path: "scripts/generate-keys.py", status: "added", raw_status: "A" },
        { path: "scripts/rotate-secrets.py", status: "added", raw_status: "A" },
      ],
      base_ref: "HEAD~1",
      staged_only: false,
      invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
    };

    it("populates detected_languages with the right primary + confidence for a TS-only change", async () => {
      detectChangedFilesMock.mockResolvedValue(tsChanged);

      const out = await composeAdvisoryBundle({
        workspace_root: "C:/fake/workspace",
        user_prompt: "harden jwt validation path",
        plan: "Step 1: tighten audience claim. Step 2: tests.",
        read_content: false,
        staged_only: false,
        force_agents: [],
      });

      expect(out.detected_languages).toBeDefined();
      expect(out.detected_languages!.primary).toBe("typescript");
      expect(out.detected_languages!.all).toEqual(["typescript"]);
      expect(out.detected_languages!.confidence).toBe("high");
    });

    it("populates language_supplements_by_agent for every LANGUAGE_AWARE_AGENT on a TS change", async () => {
      detectChangedFilesMock.mockResolvedValue(tsChanged);

      const out = await composeAdvisoryBundle({
        workspace_root: "C:/fake/workspace",
        user_prompt: "harden jwt validation path",
        plan: "Step 1: tighten audience claim. Step 2: tests.",
        read_content: false,
        staged_only: false,
        force_agents: [],
      });

      expect(out.language_supplements_by_agent).toBeDefined();
      // The bundle looks up supplements for ALL language-aware agents,
      // independent of which agents the squad selected — the orchestrator
      // decides at dispatch time which to apply.
      for (const agent of LANGUAGE_AWARE_AGENTS) {
        const map = out.language_supplements_by_agent![agent];
        expect(map, `agent=${agent}`).toBeDefined();
        expect(typeof map!.typescript, `agent=${agent} typescript body`).toBe("string");
        expect(map!.typescript!.length).toBeGreaterThan(0);
        // Cheap content sanity-grep: prove the body matches the requested
        // language and we didn't (e.g.) hand back the python supplement under
        // the typescript key.
        expect(map!.typescript!.toLowerCase(), `agent=${agent} typescript body content`).toContain(
          "typescript",
        );
      }
    });

    it("supports the include_language_supplements: false opt-out (both fields absent)", async () => {
      detectChangedFilesMock.mockResolvedValue(tsChanged);

      const out = await composeAdvisoryBundle({
        workspace_root: "C:/fake/workspace",
        user_prompt: "harden jwt validation path",
        plan: "Step 1: tighten audience claim. Step 2: tests.",
        read_content: false,
        staged_only: false,
        force_agents: [],
        include_language_supplements: false,
      });

      expect(out.detected_languages).toBeUndefined();
      expect(out.language_supplements_by_agent).toBeUndefined();
    });

    it("emits supplements for both languages on a multi-language (TS + Python) change", async () => {
      detectChangedFilesMock.mockResolvedValue(mixedChanged);

      const out = await composeAdvisoryBundle({
        workspace_root: "C:/fake/workspace",
        user_prompt: "rotate signing keys end to end",
        plan: "Step 1: write rotation script. Step 2: wire ts code to new env.",
        read_content: false,
        staged_only: false,
        force_agents: [],
      });

      expect(out.detected_languages).toBeDefined();
      expect(out.detected_languages!.all.sort()).toEqual(["python", "typescript"]);
      // Either TS or Python could win primary depending on counts, but both
      // must appear in supplements for every LANGUAGE_AWARE_AGENT.
      expect(out.language_supplements_by_agent).toBeDefined();
      for (const agent of LANGUAGE_AWARE_AGENTS) {
        const map = out.language_supplements_by_agent![agent];
        expect(map, `agent=${agent}`).toBeDefined();
        expect(typeof map!.typescript, `agent=${agent} typescript body`).toBe("string");
        expect(typeof map!.python, `agent=${agent} python body`).toBe("string");
      }
    });

    it("is fail-soft when readAgentLanguageSupplements throws — bundle still resolves", async () => {
      detectChangedFilesMock.mockResolvedValue(tsChanged);
      const supplementsSpy = vi
        .spyOn(agentLoader, "readAgentLanguageSupplements")
        .mockRejectedValue(new Error("disk on fire"));
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      try {
        const out = await composeAdvisoryBundle({
          workspace_root: "C:/fake/workspace",
          user_prompt: "harden jwt validation path",
          plan: "Step 1: tighten audience claim. Step 2: tests.",
          read_content: false,
          staged_only: false,
          force_agents: [],
        });

        // Detection still succeeded — only the disk read failed.
        expect(out.detected_languages).toBeDefined();
        expect(out.detected_languages!.primary).toBe("typescript");
        // No agent produced any supplement, so the bundle prunes the field.
        expect(out.language_supplements_by_agent).toBeUndefined();
        // Each failure was logged once per language-aware agent — assert
        // the cardinality, not just "fired at least once", so the contract
        // ("one warn per failed agent") is locked in.
        expect(warnSpy).toHaveBeenCalledTimes(LANGUAGE_AWARE_AGENTS.length);
        expect(supplementsSpy).toHaveBeenCalledTimes(LANGUAGE_AWARE_AGENTS.length);
      } finally {
        supplementsSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("detects languages from Windows-style backslash paths (cross-platform sanity)", async () => {
      // QA round-2 polish: prove the language pipeline doesn't drop files
      // whose paths arrive with backslash separators (Windows callers,
      // git output on some configurations). Kept isolated from the shared
      // tsChanged fixture so Linux-side path-normalisation logging cannot
      // distort the fail-soft test's warn cardinality assertion.
      const winPaths: DetectChangedFilesOutput = {
        files: [
          { path: "src\\auth\\jwt-validator.ts", status: "modified", raw_status: "M" },
          { path: "src\\auth\\session.ts", status: "modified", raw_status: "M" },
          { path: "src\\auth\\types.ts", status: "added", raw_status: "A" },
        ],
        base_ref: "HEAD~1",
        staged_only: false,
        invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
      };
      detectChangedFilesMock.mockResolvedValue(winPaths);

      const out = await composeAdvisoryBundle({
        workspace_root: "C:/fake/workspace",
        user_prompt: "harden jwt validation path",
        plan: "Step 1: tighten audience claim. Step 2: tests.",
        read_content: false,
        staged_only: false,
        force_agents: [],
      });

      // Detection treats backslashes as separators (see classifyByExtension)
      // so all three .ts files contribute to the typescript bucket.
      expect(out.detected_languages).toBeDefined();
      expect(out.detected_languages!.primary).toBe("typescript");
      expect(out.detected_languages!.confidence).toBe("high");
    });

    // v0.13.x — secondary-language file-count threshold. Prevents a single
    // off-stack file from inflating every agent's prompt with an irrelevant
    // checklist.
    describe("min_files_per_secondary_language threshold", () => {
      // 4 TS files (primary) + 1 single Python script (incidental).
      const tsPlusOnePyChanged: DetectChangedFilesOutput = {
        files: [
          { path: "src/auth/jwt-validator.ts", status: "modified", raw_status: "M" },
          { path: "src/auth/session.ts", status: "modified", raw_status: "M" },
          { path: "src/auth/types.ts", status: "added", raw_status: "A" },
          { path: "src/auth/index.ts", status: "modified", raw_status: "M" },
          { path: "scripts/one-off.py", status: "added", raw_status: "A" },
        ],
        base_ref: "HEAD~1",
        staged_only: false,
        invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
      };

      it("prunes a secondary language with fewer than the threshold (default 2)", async () => {
        detectChangedFilesMock.mockResolvedValue(tsPlusOnePyChanged);

        const out = await composeAdvisoryBundle({
          workspace_root: "C:/fake/workspace",
          user_prompt: "harden jwt validation path",
          plan: "Step 1: tighten audience claim. Step 2: tests.",
          read_content: false,
          staged_only: false,
          force_agents: [],
        });

        // Detection result still carries Python (truth, full fidelity)…
        expect(out.detected_languages).toBeDefined();
        expect(out.detected_languages!.primary).toBe("typescript");
        expect(out.detected_languages!.all.sort()).toEqual(["python", "typescript"]);

        // …but the INJECTED supplements drop Python (1 file < threshold of 2).
        // TS is still injected (it's primary, exempt regardless).
        expect(out.language_supplements_by_agent).toBeDefined();
        for (const agent of LANGUAGE_AWARE_AGENTS) {
          const map = out.language_supplements_by_agent![agent];
          expect(map, `agent=${agent}`).toBeDefined();
          expect(map!.typescript, `agent=${agent} TS body`).toBeDefined();
          expect(map!.python, `agent=${agent} python pruned`).toBeUndefined();
        }
      });

      it("preserves both languages when the secondary clears the threshold", async () => {
        // Mixed PR with 2 Python files — meets threshold.
        const tsPlusTwoPyChanged: DetectChangedFilesOutput = {
          files: [
            { path: "src/auth/jwt-validator.ts", status: "modified", raw_status: "M" },
            { path: "src/auth/session.ts", status: "modified", raw_status: "M" },
            { path: "scripts/migrate.py", status: "added", raw_status: "A" },
            { path: "scripts/seed.py", status: "added", raw_status: "A" },
          ],
          base_ref: "HEAD~1",
          staged_only: false,
          invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
        };
        detectChangedFilesMock.mockResolvedValue(tsPlusTwoPyChanged);

        const out = await composeAdvisoryBundle({
          workspace_root: "C:/fake/workspace",
          user_prompt: "rotate signing keys end to end",
          plan: "Step 1: rotation script. Step 2: wire ts to new env.",
          read_content: false,
          staged_only: false,
          force_agents: [],
        });

        expect(out.language_supplements_by_agent).toBeDefined();
        for (const agent of LANGUAGE_AWARE_AGENTS) {
          const map = out.language_supplements_by_agent![agent];
          expect(map!.typescript, `agent=${agent} TS body`).toBeDefined();
          expect(map!.python, `agent=${agent} python body`).toBeDefined();
        }
      });

      it("disables the threshold when min_files_per_secondary_language: 1 (pre-v0.13.x behaviour)", async () => {
        detectChangedFilesMock.mockResolvedValue(tsPlusOnePyChanged);

        const out = await composeAdvisoryBundle({
          workspace_root: "C:/fake/workspace",
          user_prompt: "harden jwt validation path",
          plan: "Step 1: tighten audience claim. Step 2: tests.",
          read_content: false,
          staged_only: false,
          force_agents: [],
          min_files_per_secondary_language: 1,
        });

        // With threshold=1, even the lone .py file gets supplemented.
        expect(out.language_supplements_by_agent).toBeDefined();
        for (const agent of LANGUAGE_AWARE_AGENTS) {
          const map = out.language_supplements_by_agent![agent];
          expect(map!.typescript, `agent=${agent} TS body`).toBeDefined();
          expect(map!.python, `agent=${agent} python body (no threshold)`).toBeDefined();
        }
      });
    });
  });
});
