import { describe, it, expect } from "vitest";
import { selectSquad } from "../src/tools/select-squad.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "squad-ext-"));
}

describe("selectSquad — extended", () => {
  it("returns deterministic agent ordering (sorted)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: [],
      read_content: false,
      force_agents: ["senior-dba", "senior-architect"],
    });
    const sorted = [...r.agents].sort();
    expect(r.agents).toEqual(sorted);
  });

  it("handles empty file list with only core agents", async () => {
    const r = await selectSquad({
      work_type: "Bug Fix",
      files: [],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toEqual(expect.arrayContaining(["senior-developer", "senior-qa"]));
    expect(r.evidence).toHaveLength(0);
    expect(r.low_confidence_files).toHaveLength(0);
  });

  it("honors ext_filter — useState match flagged for .tsx but not for .py", async () => {
    const dir = await tmpDir();
    const tsx = "comp.tsx";
    const py = "fake.py";
    await fs.writeFile(path.join(dir, tsx), 'import { useState } from "react"; useState(0);');
    await fs.writeFile(path.join(dir, py), "def useState(): pass\nuseState()");
    const r = await selectSquad({
      work_type: "Feature",
      files: [tsx, py],
      read_content: true,
      workspace_root: dir,
      force_agents: [],
    });
    const tsxEv = r.evidence.find((e) => e.file === tsx && e.signal === "React hook");
    const pyEv = r.evidence.find((e) => e.file === py && e.signal === "React hook");
    expect(tsxEv).toBeDefined();
    expect(pyEv).toBeUndefined();
  });

  it("detects FastAPI in Python via ext-gated signal", async () => {
    const dir = await tmpDir();
    const file = "app.py";
    await fs.writeFile(
      path.join(dir, file),
      'from fastapi import FastAPI\napp = FastAPI()\n@app.route("/")\ndef root(): return {}',
    );
    const r = await selectSquad({
      work_type: "Feature",
      files: [file],
      read_content: true,
      workspace_root: dir,
      force_agents: [],
    });
    expect(r.agents).toContain("senior-developer");
    expect(r.agents).toContain("senior-dev-security");
  });

  it("detects GORM in Go via ext-gated signal", async () => {
    const dir = await tmpDir();
    const file = "db.go";
    await fs.writeFile(
      path.join(dir, file),
      'package db\nimport "gorm.io/gorm"\nfunc Open() { gorm.Open(nil) }',
    );
    const r = await selectSquad({
      work_type: "Feature",
      files: [file],
      read_content: true,
      workspace_root: dir,
      force_agents: [],
    });
    expect(r.agents).toContain("senior-dba");
  });

  it("detects Go test files via path hint", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: ["internal/service/foo_test.go"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toContain("senior-qa");
  });
});
