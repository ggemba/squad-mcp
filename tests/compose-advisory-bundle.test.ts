import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DetectChangedFilesOutput } from "../src/tools/detect-changed-files.js";

vi.mock("../src/tools/detect-changed-files.js", () => ({
  detectChangedFiles: vi.fn(),
}));

import { detectChangedFiles } from "../src/tools/detect-changed-files.js";
import { composeAdvisoryBundle } from "../src/tools/compose-advisory-bundle.js";

const detectChangedFilesMock = detectChangedFiles as unknown as ReturnType<typeof vi.fn>;

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
});
