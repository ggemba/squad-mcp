import { describe, it, expect } from "vitest";
import { selectSquad, MIN_LOC_FOR_WEAK_PATH } from "../src/tools/select-squad.js";

/**
 * Coverage for the v1.7.3 promotion gate in select_squad. None of these
 * tests touch the filesystem — `read_content: false` disables the content-
 * snippet path, so the suite exercises path-based promotion + the new
 * status / magnitude gates in isolation. Content-signal interaction is
 * covered separately in tests that set up a tmpdir workspace.
 *
 * Work type is `Feature` throughout because Feature's `core` is
 * `[product-owner, developer, qa]` — none of which overlap with `dba` /
 * `architect` / `security`, so a promotion (or non-promotion) of the
 * latter is fully attributable to the path-hint path under test.
 */

const baseInput = {
  work_type: "Feature" as const,
  read_content: false,
  force_agents: [] as const,
  // workspace_root deliberately omitted — read_content=false bypasses fs.
};

describe("select_squad — v1.7.3 path-hint promotion gate", () => {
  it("does NOT promote dba on a WEAK path (Repository.cs) when status=modified and loc is absent", async () => {
    // Reproduces the PR #3 acg.noname.card.lambda case that motivated v1.7.3.
    const out = await selectSquad({
      ...baseInput,
      files: [{ path: "Data/NonameBulkRepository.cs", status: "modified" }],
    });
    expect(out.agents).not.toContain("dba");
    expect(out.low_confidence_files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "Data/NonameBulkRepository.cs",
          reason: expect.stringContaining("weak path signal"),
        }),
      ]),
    );
  });

  it("PROMOTES dba on a WEAK path when loc_changed >= MIN_LOC_FOR_WEAK_PATH", async () => {
    const out = await selectSquad({
      ...baseInput,
      files: [
        {
          path: "Data/NonameBulkRepository.cs",
          status: "modified",
          loc_added: MIN_LOC_FOR_WEAK_PATH,
          loc_deleted: 0,
        },
      ],
    });
    expect(out.agents).toContain("dba");
  });

  it("PROMOTES dba on a WEAK path when status=added (new file, default cautelar)", async () => {
    const out = await selectSquad({
      ...baseInput,
      files: [{ path: "Data/NewRepository.cs", status: "added" }],
    });
    expect(out.agents).toContain("dba");
  });

  it("does NOT promote dba on a WEAK path when status=deleted (SKIP-D)", async () => {
    // The exact bug from the v1.7.2 acg.noname.card.lambda PR review:
    // Data/NonameBulk*Repository.cs files were deleted and still triggered dba.
    const out = await selectSquad({
      ...baseInput,
      files: [
        { path: "Data/NonameBulkRepository.cs", status: "deleted" },
        { path: "Data/NonameBulkCardRepository.cs", status: "deleted" },
      ],
    });
    expect(out.agents).not.toContain("dba");
    // Each deleted file should produce a targeted SKIP-D reason in
    // low_confidence — not the generic "no signal matched" string.
    expect(out.low_confidence_files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "Data/NonameBulkRepository.cs",
          reason: expect.stringContaining("file is deleted"),
        }),
      ]),
    );
  });

  it("PROMOTES dba on a STRONG path (/Migrations/) regardless of magnitude", async () => {
    const out = await selectSquad({
      ...baseInput,
      files: [{ path: "src/Migrations/20260527_AddUserTable.cs", status: "modified" }],
    });
    expect(out.agents).toContain("dba");
  });

  it("does NOT promote dba on a STRONG path when status=deleted (SKIP-D universal)", async () => {
    const out = await selectSquad({
      ...baseInput,
      files: [{ path: "src/Migrations/20260527_AddUserTable.cs", status: "deleted" }],
    });
    expect(out.agents).not.toContain("dba");
  });

  it("treats legacy string[] input as status=modified (backward compat)", async () => {
    // Pre-v1.7.3 callers passed plain string paths. Without loc info, a WEAK
    // path treated as "modified" hits the gate and does NOT promote — that
    // is the intended behaviour change (the bug being fixed). Legacy callers
    // who relied on the old "always promote" behaviour now correctly get
    // squad-mcp's improved filtering. STRONG paths continue to promote.
    const outWeak = await selectSquad({
      ...baseInput,
      files: ["Data/NonameBulkRepository.cs"],
    });
    expect(outWeak.agents).not.toContain("dba");

    const outStrong = await selectSquad({
      ...baseInput,
      files: ["src/Migrations/Init.cs"],
    });
    expect(outStrong.agents).toContain("dba");
  });

  it("does NOT promote architect on WEAK DependencyInjection.cs without content or magnitude", async () => {
    // The other half of the PR #3 case: DependencyInjection.cs was modified
    // with only 6 LOC of cleanup (under the original threshold), and the
    // architect was still spawned. With the magnitude check, this depends on
    // the LOC field: loc < 5 does NOT promote; loc >= 5 does.
    const outUnderThreshold = await selectSquad({
      ...baseInput,
      files: [
        {
          path: "DependencyInjection.cs",
          status: "modified",
          loc_added: 1,
          loc_deleted: 3,
        },
      ],
    });
    expect(outUnderThreshold.agents).not.toContain("architect");

    const outAtThreshold = await selectSquad({
      ...baseInput,
      files: [
        {
          path: "DependencyInjection.cs",
          status: "modified",
          loc_added: 5,
          loc_deleted: 0,
        },
      ],
    });
    expect(outAtThreshold.agents).toContain("architect");
  });
});

describe("select_squad — v1.7.3 core agents preserved", () => {
  it("retains the Feature core (developer + qa) regardless of path-gate decisions", async () => {
    const out = await selectSquad({
      ...baseInput,
      files: [{ path: "Data/NonameBulkRepository.cs", status: "deleted" }],
    });
    // dba is gated out but core agents still come from the matrix.
    expect(out.agents).toContain("developer");
    expect(out.agents).toContain("qa");
    expect(out.agents).not.toContain("dba");
  });
});
