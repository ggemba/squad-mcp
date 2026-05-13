import { describe, it, expect, beforeAll } from "vitest";
import { registerTools, dispatchTool } from "../src/tools/registry.js";

beforeAll(() => {
  registerTools();
});

describe("dispatchTool error mapping", () => {
  it("returns UNKNOWN_TOOL for unregistered name", async () => {
    const r = (await dispatchTool("nope", {})) as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe("UNKNOWN_TOOL");
  });

  it("returns INVALID_INPUT when zod validation fails", async () => {
    const r = (await dispatchTool("select_squad", {
      work_type: "Invalid",
    })) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when agent enum rejects unknown name", async () => {
    const r = (await dispatchTool("slice_files_for_agent", {
      agent: "made-up-agent",
      files: [],
    })) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("returns success shape on a valid call", async () => {
    const r = (await dispatchTool("score_risk", {
      touches_auth: true,
      touches_money: false,
      touches_migration: false,
      files_count: 0,
      new_module: false,
      api_contract_change: false,
    })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0]!.text);
    expect(body.level).toBe("Low");
  });

  it("compose_advisory_bundle accepts user_prompt with spaces (regression: refine must check NUL byte, not space)", async () => {
    const r = (await dispatchTool("compose_advisory_bundle", {
      workspace_root: process.cwd(),
      user_prompt: "Review the changes in this diff",
      plan: "",
    })) as { content: { text: string }[]; isError?: boolean };
    // The point of this test is the Zod refine: a prompt with spaces must NOT
    // be rejected as "NUL byte". The git step may still fail downstream when
    // the runner is a shallow clone (no HEAD~1) — we only assert the schema
    // accepted the input, not that git produced a useful diff.
    if (r.isError) {
      const body = JSON.parse(r.content[0]!.text);
      expect(body.error.code).not.toBe("INVALID_INPUT");
      expect(body.error.message).not.toContain("NUL byte");
    }
  });

  it("compose_advisory_bundle rejects user_prompt containing a NUL byte", async () => {
    const r = (await dispatchTool("compose_advisory_bundle", {
      workspace_root: process.cwd(),
      user_prompt: "has " + String.fromCharCode(0) + " nul byte",
      plan: "",
    })) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toContain("NUL byte");
  });

  it("compose_squad_workflow accepts a `mode` flag and roundtrips it on the output", async () => {
    // Round-trip: the new `mode` field must survive the dispatcher/Zod boundary
    // and surface back on the structured output. Uses `force_work_type` so the
    // test is not coupled to classifier heuristics.
    const r = (await dispatchTool("compose_squad_workflow", {
      workspace_root: process.cwd(),
      user_prompt: "tiny tweak",
      mode: "deep",
      force_work_type: "Refactor",
      read_content: false,
      staged_only: false,
    })) as { content: { text: string }[]; isError?: boolean };
    // `detectChangedFiles` may yield zero files on a shallow CI clone; we are
    // only asserting the mode field survives — not that the diff matters.
    if (r.isError) {
      const body = JSON.parse(r.content[0]!.text);
      expect(body.error.code).not.toBe("INVALID_INPUT");
      return;
    }
    const body = JSON.parse(r.content[0]!.text);
    expect(body.mode).toBe("deep");
    expect(body.mode_source).toBe("user");
    expect(["normal", "quick", "deep"]).toContain(body.mode);
  });

  it("compose_squad_workflow rejects an unknown mode value", async () => {
    const r = (await dispatchTool("compose_squad_workflow", {
      workspace_root: process.cwd(),
      user_prompt: "tiny tweak",
      mode: "thinking",
      read_content: false,
      staged_only: false,
    })) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("record_learning rejects finding containing a NUL byte (SafeString boundary)", async () => {
    const r = (await dispatchTool("record_learning", {
      workspace_root: process.cwd(),
      agent: "dba",
      finding: "csrf " + String.fromCharCode(0) + " token missing",
      decision: "accept",
    })) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toContain("NUL byte");
  });

  it("record_learning rejects reason containing a NUL byte (SafeString boundary)", async () => {
    const r = (await dispatchTool("record_learning", {
      workspace_root: process.cwd(),
      agent: "dba",
      finding: "csrf token missing",
      decision: "accept",
      reason: "we shipped " + String.fromCharCode(0) + " it already",
    })) as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toContain("NUL byte");
  });

  it("prune_learnings is registered and accepts a default-args call", async () => {
    const r = (await dispatchTool("prune_learnings", {
      workspace_root: process.cwd(),
    })) as { content: { text: string }[]; isError?: boolean };
    // The tool may error if the workspace has no .squad.yaml, but the
    // critical assertion is that it's NOT UNKNOWN_TOOL — i.e. registered.
    if (r.isError) {
      const body = JSON.parse(r.content[0]!.text);
      expect(body.error.code).not.toBe("UNKNOWN_TOOL");
    } else {
      const body = JSON.parse(r.content[0]!.text);
      expect(body.ok).toBe(true);
      // Defaults: max_age_days=0 (disabled) → no archival on no-op.
      expect(body.archived_count).toBe(0);
    }
  });

  it("PATH_TRAVERSAL_DENIED surfaces in select_squad low_confidence_files (does not abort batch)", async () => {
    const r = (await dispatchTool("select_squad", {
      work_type: "Bug Fix",
      files: ["../etc/passwd", "src/legit.ts"],
      read_content: true,
      workspace_root: process.cwd(),
    })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0]!.text);
    const denied = body.low_confidence_files.find((f: { reason: string }) =>
      f.reason.includes("PATH_TRAVERSAL_DENIED"),
    );
    expect(denied).toBeDefined();
  });
});
