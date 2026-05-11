import { describe, it, expect } from "vitest";
// @ts-expect-error — JS module without typings (loose mjs CLI helper)
import { detectPlatformFromUrl } from "../tools/_pr-platform.mjs";

describe("detectPlatformFromUrl — github", () => {
  it("https with .git suffix", () => {
    expect(detectPlatformFromUrl("https://github.com/ggemba/squad-mcp.git")).toEqual({
      platform: "github",
      owner: "ggemba",
      repo: "squad-mcp",
    });
  });

  it("https without .git", () => {
    expect(detectPlatformFromUrl("https://github.com/ggemba/squad-mcp")).toEqual({
      platform: "github",
      owner: "ggemba",
      repo: "squad-mcp",
    });
  });

  it("scp-style ssh", () => {
    expect(detectPlatformFromUrl("git@github.com:ggemba/squad-mcp.git")).toEqual({
      platform: "github",
      owner: "ggemba",
      repo: "squad-mcp",
    });
  });

  it("ssh:// URL form", () => {
    expect(detectPlatformFromUrl("ssh://git@github.com/ggemba/squad-mcp.git")).toEqual({
      platform: "github",
      owner: "ggemba",
      repo: "squad-mcp",
    });
  });

  it("trailing slash tolerated", () => {
    expect(detectPlatformFromUrl("https://github.com/ggemba/squad-mcp/")).toEqual({
      platform: "github",
      owner: "ggemba",
      repo: "squad-mcp",
    });
  });

  it("www subdomain accepted", () => {
    expect(detectPlatformFromUrl("https://www.github.com/ggemba/squad-mcp")).toEqual({
      platform: "github",
      owner: "ggemba",
      repo: "squad-mcp",
    });
  });
});

describe("detectPlatformFromUrl — bitbucket cloud", () => {
  it("https with .git", () => {
    expect(
      detectPlatformFromUrl(
        "https://bitbucket.org/repos_acgsa/acg.vulcan.purchaseanddetails.lambda.git",
      ),
    ).toEqual({
      platform: "bitbucket-cloud",
      workspace: "repos_acgsa",
      repoSlug: "acg.vulcan.purchaseanddetails.lambda",
    });
  });

  it("https without .git", () => {
    expect(
      detectPlatformFromUrl(
        "https://bitbucket.org/repos_acgsa/acg.vulcan.purchaseanddetails.lambda",
      ),
    ).toEqual({
      platform: "bitbucket-cloud",
      workspace: "repos_acgsa",
      repoSlug: "acg.vulcan.purchaseanddetails.lambda",
    });
  });

  it("scp-style ssh", () => {
    expect(
      detectPlatformFromUrl(
        "git@bitbucket.org:repos_acgsa/acg.vulcan.purchaseanddetails.lambda.git",
      ),
    ).toEqual({
      platform: "bitbucket-cloud",
      workspace: "repos_acgsa",
      repoSlug: "acg.vulcan.purchaseanddetails.lambda",
    });
  });

  it("ssh:// URL form", () => {
    expect(
      detectPlatformFromUrl(
        "ssh://git@bitbucket.org/repos_acgsa/acg.vulcan.purchaseanddetails.lambda",
      ),
    ).toEqual({
      platform: "bitbucket-cloud",
      workspace: "repos_acgsa",
      repoSlug: "acg.vulcan.purchaseanddetails.lambda",
    });
  });
});

describe("detectPlatformFromUrl — unknown / errors", () => {
  it("empty string", () => {
    const r = detectPlatformFromUrl("");
    expect(r.platform).toBe("unknown");
    expect(r.reason).toMatch(/empty/i);
  });

  it("non-string input", () => {
    // @ts-expect-error intentional bad input
    const r = detectPlatformFromUrl(null);
    expect(r.platform).toBe("unknown");
  });

  it("self-hosted bitbucket server is rejected (different API)", () => {
    const r = detectPlatformFromUrl("https://bitbucket.acme.com/scm/team/repo.git");
    expect(r.platform).toBe("unknown");
    expect(r.reason).toMatch(/bitbucket\.acme\.com/);
  });

  it("gitlab is rejected (not implemented)", () => {
    const r = detectPlatformFromUrl("git@gitlab.com:owner/repo.git");
    expect(r.platform).toBe("unknown");
    expect(r.reason).toMatch(/gitlab\.com/);
  });

  it("missing path returns unknown", () => {
    const r = detectPlatformFromUrl("https://github.com/justowner");
    expect(r.platform).toBe("unknown");
    expect(r.reason).toMatch(/owner\/repo/);
  });

  it("garbage URL returns unknown", () => {
    const r = detectPlatformFromUrl("not even a url");
    expect(r.platform).toBe("unknown");
  });
});
