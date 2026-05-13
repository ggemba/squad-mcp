import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DetectChangedFilesOutput } from "../src/tools/detect-changed-files.js";

vi.mock("../src/tools/detect-changed-files.js", () => ({
  detectChangedFiles: vi.fn(),
}));

import { detectChangedFiles } from "../src/tools/detect-changed-files.js";
import { composeSquadWorkflow } from "../src/tools/compose-squad-workflow.js";

const detectChangedFilesMock = detectChangedFiles as unknown as ReturnType<typeof vi.fn>;

const baseChanged: DetectChangedFilesOutput = {
  files: [
    { path: "src/auth/jwt-validator.ts", status: "modified", raw_status: "M" },
    { path: "src/services/payment-processor.ts", status: "added", raw_status: "A" },
    { path: "src/repositories/order-repository.ts", status: "modified", raw_status: "M" },
  ],
  base_ref: "HEAD~1",
  staged_only: false,
  invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
};

beforeEach(() => {
  detectChangedFilesMock.mockReset();
});

describe("composeSquadWorkflow", () => {
  it("runs full pipeline and returns aggregated output", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: "C:/fake/workspace",
      user_prompt: "fix authentication bug in JWT validator",
      base_ref: "main",
      staged_only: false,
      read_content: false,
      force_agents: [],
    });

    expect(out.changed_files).toBe(baseChanged);
    expect(out.classification.work_type).toBe("Bug Fix");
    expect(out.work_type).toBe(out.classification.work_type);
    expect(out.risk).toBeDefined();
    expect(out.squad).toBeDefined();
    expect(out.squad.agents).toEqual(expect.arrayContaining(["developer", "qa"]));
  });

  it("infers risk signals from changed file paths", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: "C:/fake/workspace",
      user_prompt: "add payment flow",
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(out.inferred_risk_signals.touches_auth).toBe(true);
    expect(out.inferred_risk_signals.touches_money).toBe(true);
    expect(out.inferred_risk_signals.new_module).toBe(true);
    expect(out.inferred_risk_signals.files_count).toBe(3);
    expect(out.risk.score).toBeGreaterThanOrEqual(3);
  });

  it("honors force_work_type override", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: "C:/fake/workspace",
      user_prompt: "fix authentication bug",
      force_work_type: "Refactor",
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(out.work_type).toBe("Refactor");
  });

  it("honors explicit risk_signals override", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: "C:/fake/workspace",
      user_prompt: "minor refactor",
      risk_signals: { touches_auth: false, touches_money: false, touches_migration: false },
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(out.inferred_risk_signals.touches_auth).toBe(false);
    expect(out.inferred_risk_signals.touches_money).toBe(false);
  });

  it("honors force_agents passthrough", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    const out = await composeSquadWorkflow({
      workspace_root: "C:/fake/workspace",
      user_prompt: "add feature",
      force_agents: ["qa"],
      read_content: false,
      staged_only: false,
    });

    expect(out.squad.agents).toContain("qa");
  });

  it("detects migrations folder as touches_migration", async () => {
    detectChangedFilesMock.mockResolvedValue({
      files: [{ path: "src/Migrations/20260101_add_users.cs", status: "added", raw_status: "A" }],
      base_ref: null,
      staged_only: true,
      invocation: "git diff --name-status --no-renames --cached",
    });

    const out = await composeSquadWorkflow({
      workspace_root: "C:/fake/workspace",
      user_prompt: "add user table migration",
      staged_only: true,
      read_content: false,
      force_agents: [],
    });

    expect(out.inferred_risk_signals.touches_migration).toBe(true);
  });

  describe("mode resolution (quick / normal / deep)", () => {
    const lowRiskOneFile: DetectChangedFilesOutput = {
      files: [{ path: "src/utils/format.ts", status: "modified", raw_status: "M" }],
      base_ref: "HEAD~1",
      staged_only: false,
      invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
    };

    const highRiskAuth: DetectChangedFilesOutput = {
      files: [{ path: "src/auth/jwt-validator.ts", status: "modified", raw_status: "M" }],
      base_ref: "HEAD~1",
      staged_only: false,
      invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
    };

    it("auto-detects quick on a Low-risk single-file Feature", async () => {
      detectChangedFilesMock.mockResolvedValue(lowRiskOneFile);

      const out = await composeSquadWorkflow({
        workspace_root: "/tmp/x",
        user_prompt: "add a formatter helper",
        staged_only: false,
        read_content: false,
        force_agents: [],
      });

      expect(out.mode).toBe("quick");
      expect(out.mode_source).toBe("auto");
      expect(out.mode_warning).toBeUndefined();
      expect(out.squad.agents.length).toBeLessThanOrEqual(2);
      expect(out.squad.agents).toContain("developer");
    });

    it("auto-detects deep on a High-risk auth change", async () => {
      detectChangedFilesMock.mockResolvedValue(highRiskAuth);

      const out = await composeSquadWorkflow({
        workspace_root: "/tmp/x",
        user_prompt: "fix JWT validation bug",
        staged_only: false,
        read_content: false,
        force_agents: [],
      });

      expect(out.mode).toBe("deep");
      expect(out.mode_source).toBe("auto");
      expect(out.squad.agents).toContain("architect");
      expect(out.squad.agents).toContain("security");
    });

    it("user-forced deep on a trivial diff wins over auto-detect", async () => {
      detectChangedFilesMock.mockResolvedValue(lowRiskOneFile);

      const out = await composeSquadWorkflow({
        workspace_root: "/tmp/x",
        user_prompt: "add helper",
        mode: "deep",
        staged_only: false,
        read_content: false,
        force_agents: [],
      });

      expect(out.mode).toBe("deep");
      expect(out.mode_source).toBe("user");
      expect(out.squad.agents).toContain("architect");
      expect(out.squad.agents).toContain("security");
    });

    it("user-forced quick on high-risk emits mode_warning and force-includes security", async () => {
      detectChangedFilesMock.mockResolvedValue(highRiskAuth);

      const out = await composeSquadWorkflow({
        workspace_root: "/tmp/x",
        user_prompt: "fix JWT validator",
        mode: "quick",
        staged_only: false,
        read_content: false,
        force_agents: [],
      });

      expect(out.mode).toBe("quick");
      expect(out.mode_source).toBe("user");
      expect(out.mode_warning).toBeDefined();
      expect(out.mode_warning?.code).toBe("forced_quick_on_high_risk");
      expect(out.mode_warning?.message).toMatch(/security force-included/);
      // Lock the exact wording — CI integrations may regex this, so a silent
      // re-phrasing should fail loudly. Bump the snapshot deliberately if the
      // copy is intentionally updated.
      expect(out.mode_warning?.message).toMatchInlineSnapshot(
        `"user forced --quick on a high-risk diff; security force-included in the 2-agent cap as a safety override"`,
      );
      expect(out.squad.agents).toHaveLength(2);
      expect(out.squad.agents).toContain("security");
    });

    it("quick-mode cap drops force_agents beyond 2 and emits force_agents_truncated", async () => {
      // Low-risk single-file Feature → auto-quick. User force-pushes 3 agents;
      // the cap-to-2 must drop one and emit a structured truncation warning.
      detectChangedFilesMock.mockResolvedValue(lowRiskOneFile);

      const out = await composeSquadWorkflow({
        workspace_root: "/tmp/x",
        user_prompt: "tweak the formatter",
        mode: "quick",
        staged_only: false,
        read_content: false,
        force_agents: ["dba", "architect", "security"],
      });

      expect(out.mode).toBe("quick");
      expect(out.squad.agents).toHaveLength(2);
      expect(out.mode_warning).toBeDefined();
      expect(out.mode_warning?.code).toBe("force_agents_truncated");
      expect(out.mode_warning?.message).toMatch(/quick mode caps the squad at 2/);
      // Earlier force_agents win the two slots; the last gets dropped.
      expect(out.squad.agents).toEqual(["dba", "architect"]);
    });

    it("rollback contract: omitting mode still selects normal for a Medium-risk diff", async () => {
      // The implicit default — pre-v0.8.0 behaviour. We need a diff that
      // exceeds QUICK_AUTO_MAX_FILES (8 since 2026-05) AND carries no
      // high-risk signal, so neither auto-quick nor auto-deep fires.
      const nineFiles: DetectChangedFilesOutput = {
        files: [
          { path: "src/a.ts", status: "modified", raw_status: "M" },
          { path: "src/b.ts", status: "modified", raw_status: "M" },
          { path: "src/c.ts", status: "modified", raw_status: "M" },
          { path: "src/d.ts", status: "modified", raw_status: "M" },
          { path: "src/e.ts", status: "modified", raw_status: "M" },
          { path: "src/f.ts", status: "modified", raw_status: "M" },
          { path: "src/g.ts", status: "modified", raw_status: "M" },
          { path: "src/h.ts", status: "modified", raw_status: "M" },
          { path: "src/i.ts", status: "modified", raw_status: "M" },
        ],
        base_ref: "HEAD~1",
        staged_only: false,
        invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
      };
      detectChangedFilesMock.mockResolvedValue(nineFiles);

      const out = await composeSquadWorkflow({
        workspace_root: "/tmp/x",
        user_prompt: "refactor several modules",
        staged_only: false,
        read_content: false,
        force_agents: [],
      });

      // 9 files > QUICK_AUTO_MAX_FILES (8), so auto-quick declines. No
      // high-risk signal so deep also declines. Result: normal.
      expect(out.mode).toBe("normal");
      expect(out.mode_source).toBe("auto");
      expect(out.mode_warning).toBeUndefined();
    });

    it("auto-detects quick on the new 8-file boundary (post-2026-05 bump)", async () => {
      // Pins the threshold bump from 5 → 8. Eight Low-risk files with no
      // auth/money/migration signal should now resolve to quick (previously
      // fell through to normal).
      const eightFiles: DetectChangedFilesOutput = {
        files: [
          { path: "src/a.ts", status: "modified", raw_status: "M" },
          { path: "src/b.ts", status: "modified", raw_status: "M" },
          { path: "src/c.ts", status: "modified", raw_status: "M" },
          { path: "src/d.ts", status: "modified", raw_status: "M" },
          { path: "src/e.ts", status: "modified", raw_status: "M" },
          { path: "src/f.ts", status: "modified", raw_status: "M" },
          { path: "src/g.ts", status: "modified", raw_status: "M" },
          { path: "src/h.ts", status: "modified", raw_status: "M" },
        ],
        base_ref: "HEAD~1",
        staged_only: false,
        invocation: "git diff --name-status --no-renames HEAD~1..HEAD",
      };
      detectChangedFilesMock.mockResolvedValue(eightFiles);

      const out = await composeSquadWorkflow({
        workspace_root: "/tmp/x",
        user_prompt: "small Low-risk refactor across eight files",
        staged_only: false,
        read_content: false,
        force_agents: [],
      });

      expect(out.mode).toBe("quick");
      expect(out.mode_source).toBe("auto");
    });
  });

  it("passes base_ref through to detectChangedFiles", async () => {
    detectChangedFilesMock.mockResolvedValue(baseChanged);

    await composeSquadWorkflow({
      workspace_root: "C:/fake/workspace",
      user_prompt: "small change",
      base_ref: "release/1.2",
      read_content: false,
      staged_only: false,
      force_agents: [],
    });

    expect(detectChangedFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ base_ref: "release/1.2", workspace_root: "C:/fake/workspace" }),
    );
  });
});
