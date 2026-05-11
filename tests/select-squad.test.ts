import { describe, it, expect } from "vitest";
import { selectSquad } from "../src/tools/select-squad.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "squad-mcp-"));
}

describe("selectSquad", () => {
  it("Feature with NO files drops product-owner (no user-facing signal — C2)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: [],
      read_content: false,
      force_agents: [],
    });
    // v0.12 C2 behaviour: PO demoted when no user-facing signal.
    // senior-developer + senior-qa still in core.
    expect(r.agents).toEqual(expect.arrayContaining(["senior-developer", "senior-qa"]));
    expect(r.agents).not.toContain("product-owner");
    // Rationale explicitly explains the demotion.
    expect(r.rationale.some((e) => e.agent === "product-owner" && /demoted/i.test(e.reason))).toBe(
      true,
    );
  });

  it("Feature WITH user-facing file (.tsx) keeps product-owner in core (C2)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: ["src/components/Button.tsx"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toEqual(
      expect.arrayContaining(["product-owner", "senior-developer", "senior-qa"]),
    );
  });

  it("Feature with pages/ dir triggers PO inclusion (C2)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: ["src/pages/login.ts"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toContain("product-owner");
  });

  it("Feature with .NET *Page.cs view-class keeps PO (C2)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: ["Pages/LoginPage.cs"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toContain("product-owner");
  });

  it("Feature with i18n directory keeps PO (translation = user-facing — C2)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: ["src/i18n/pt-br.json"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toContain("product-owner");
  });

  it("Feature with pure backend files demotes PO (C2)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: [
        "src/api/UserController.cs",
        "src/repositories/UserRepository.cs",
        "src/services/AuthService.cs",
      ],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).not.toContain("product-owner");
  });

  it("force_agents=[product-owner] re-adds PO even on backend-only Feature (C2 + override)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: ["src/api/UserController.cs"],
      read_content: false,
      force_agents: ["product-owner"],
    });
    expect(r.agents).toContain("product-owner");
  });

  it("Business Rule keeps PO regardless of file shape (C2 boundary)", async () => {
    const r = await selectSquad({
      work_type: "Business Rule",
      files: ["src/services/PricingEngine.cs"], // pure backend
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toContain("product-owner");
  });

  it("Bug Fix without PO in matrix core is unaffected by C2", async () => {
    const r = await selectSquad({
      work_type: "Bug Fix",
      files: ["src/services/AuthService.cs"],
      read_content: false,
      force_agents: [],
    });
    // PO was never in Bug Fix core anyway — sanity check no regression.
    expect(r.agents).not.toContain("product-owner");
  });

  it("`application.properties` (Java backend config) does NOT trigger PO inclusion (C2 round-2 fix)", async () => {
    // `.properties` was originally in USER_FACING_PATTERN as Java i18n bundles;
    // round-2 review surfaced that Spring `application.properties` /
    // `log4j.properties` are pure backend config. Removed from regex; the
    // directory-based check (`[\\/]i18n[\\/]`) still catches real Java i18n.
    const r = await selectSquad({
      work_type: "Feature",
      files: ["src/main/resources/application.properties"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).not.toContain("product-owner");
  });

  it("Java i18n via directory (`messages_en.properties` in i18n/) still triggers PO (C2)", async () => {
    // i18n directory match catches Java bundles without the .properties ext.
    const r = await selectSquad({
      work_type: "Feature",
      files: ["src/main/resources/i18n/messages_en.properties"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toContain("product-owner");
  });

  it("`node_modules/<pkg>/components/...` does NOT trigger PO inclusion (C2 round-2 fix)", async () => {
    // Third-party package files were tripping USER_FACING_PATTERN; explicit
    // exclusion now strips them before the regex check.
    const r = await selectSquad({
      work_type: "Feature",
      files: ["node_modules/some-ui-lib/components/Button.tsx"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).not.toContain("product-owner");
  });

  it("nested `apps/web/node_modules/<pkg>/...` (monorepo) also excluded (C2 round-2 fix)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: ["apps/web/node_modules/some-pkg/pages/index.tsx"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).not.toContain("product-owner");
  });

  it("user-facing file + node_modules file together → PO included (only legit signal counts)", async () => {
    const r = await selectSquad({
      work_type: "Feature",
      files: [
        "node_modules/some-pkg/components/Foo.tsx", // ignored
        "src/components/Login.tsx", // counts
      ],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toContain("product-owner");
  });

  it("detects DBA via path hint (Repository.cs)", async () => {
    const r = await selectSquad({
      work_type: "Bug Fix",
      files: ["src/Data/UserRepository.cs"],
      read_content: false,
      force_agents: [],
    });
    expect(r.agents).toContain("senior-dba");
  });

  it("detects DBA via content sniff when name does not match", async () => {
    const dir = await tmpDir();
    const file = "Services/MyDataAccess.cs";
    const abs = path.join(dir, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "public class MyDataAccess : DbContext { }");
    const r = await selectSquad({
      work_type: "Bug Fix",
      files: [file],
      read_content: true,
      workspace_root: dir,
      force_agents: [],
    });
    expect(r.agents).toContain("senior-dba");
    const ev = r.evidence.find((e) => e.agent === "senior-dba");
    expect(ev?.source).toBe("content");
  });

  it("honors force_agents", async () => {
    const r = await selectSquad({
      work_type: "Bug Fix",
      files: [],
      read_content: false,
      force_agents: ["senior-dev-security"],
    });
    expect(r.agents).toContain("senior-dev-security");
  });

  it("records low_confidence when nothing matches", async () => {
    const r = await selectSquad({
      work_type: "Bug Fix",
      files: ["Helpers/Util.cs"],
      read_content: false,
      force_agents: [],
    });
    expect(r.low_confidence_files.map((f) => f.file)).toContain("Helpers/Util.cs");
  });
});
