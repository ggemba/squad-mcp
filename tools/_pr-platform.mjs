// Detect the PR-hosting platform from a git remote URL.
//
// Two layers exported from this module:
//   - `detectPlatformFromUrl(url)` — PURE parser. No I/O, no subprocess.
//     Tests that want determinism import only this.
//   - `getRemoteUrl(remote, cwd)` and `detectPlatform(remote, cwd)` — thin
//     wrappers around `git remote get-url`. THESE DO spawn a subprocess.
//     The CLI uses these when --platform=auto.
//
// Supported shapes:
//   GitHub
//     https://github.com/<owner>/<repo>(.git)?
//     git@github.com:<owner>/<repo>(.git)?
//     ssh://git@github.com/<owner>/<repo>(.git)?
//   Bitbucket Cloud
//     https://bitbucket.org/<workspace>/<repo>(.git)?
//     git@bitbucket.org:<workspace>/<repo>(.git)?
//     ssh://git@bitbucket.org/<workspace>/<repo>(.git)?
//
// Bitbucket Server / Data Center is intentionally NOT supported — it has a
// different REST API (1.0 vs Cloud's 2.0) and requires a separate adapter.
// Detection returns { platform: "unknown" } for those URLs so the CLI can
// surface a clear error instead of silently misrouting.

import { spawnSync } from "node:child_process";

/**
 * Parse a git remote URL.
 *
 * @param {string} url
 * @returns {
 *   | { platform: "github", owner: string, repo: string }
 *   | { platform: "bitbucket-cloud", workspace: string, repoSlug: string }
 *   | { platform: "unknown", reason: string }
 * }
 */
export function detectPlatformFromUrl(url) {
  if (typeof url !== "string" || url.trim() === "") {
    return { platform: "unknown", reason: "empty remote URL" };
  }
  const trimmed = url.trim();

  // Strip a trailing ".git" once before slug extraction.
  const stripGit = (s) => (s.endsWith(".git") ? s.slice(0, -4) : s);

  // 1) scp-like SSH: git@host:owner/repo(.git)?
  //    Bitbucket and GitHub both speak this. The host is everything between
  //    the first '@' and the first ':'.
  const scpMatch = /^([^@\s]+)@([^:\s]+):([^\s]+)$/.exec(trimmed);
  if (scpMatch) {
    const host = scpMatch[2].toLowerCase();
    const path = stripGit(scpMatch[3]).replace(/^\/+/, "").replace(/\/+$/, "");
    return classifyHostAndPath(host, path);
  }

  // 2) URL-shaped: ssh://, https://, http://, git://
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { platform: "unknown", reason: `unparseable remote URL: ${trimmed}` };
  }
  const host = parsed.hostname.toLowerCase();
  const path = stripGit(parsed.pathname).replace(/^\/+/, "").replace(/\/+$/, "");
  return classifyHostAndPath(host, path);
}

function classifyHostAndPath(host, pathSegment) {
  const segments = pathSegment.split("/").filter((s) => s.length > 0);

  if (host === "github.com" || host === "www.github.com") {
    if (segments.length < 2) {
      return { platform: "unknown", reason: `github URL missing owner/repo: ${pathSegment}` };
    }
    return { platform: "github", owner: segments[0], repo: segments[1] };
  }

  if (host === "bitbucket.org" || host === "www.bitbucket.org") {
    if (segments.length < 2) {
      return {
        platform: "unknown",
        reason: `bitbucket URL missing workspace/repo: ${pathSegment}`,
      };
    }
    return { platform: "bitbucket-cloud", workspace: segments[0], repoSlug: segments[1] };
  }

  return {
    platform: "unknown",
    reason: `unrecognised host "${host}" — only github.com and bitbucket.org are supported`,
  };
}

/**
 * Resolve the remote URL for the current repo via `git remote get-url <name>`.
 * Returns the trimmed URL string, or null if git fails (not a repo, no such
 * remote, git not on PATH).
 *
 * @param {string} remoteName  defaults to "origin"
 * @param {string} cwd         defaults to process.cwd()
 * @returns {string | null}
 */
export function getRemoteUrl(remoteName = "origin", cwd = process.cwd()) {
  const r = spawnSync("git", ["remote", "get-url", remoteName], {
    cwd,
    encoding: "utf8",
  });
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout || "").trim();
  return out === "" ? null : out;
}

/**
 * One-shot helper: read the remote URL from git and classify it.
 * Returns the same shape as detectPlatformFromUrl, plus a "no-remote"
 * variant when git can't resolve the URL.
 *
 * @param {string} remoteName
 * @param {string} cwd
 */
export function detectPlatform(remoteName = "origin", cwd = process.cwd()) {
  const url = getRemoteUrl(remoteName, cwd);
  if (url === null) {
    return {
      platform: "unknown",
      reason: `git remote "${remoteName}" not resolvable in ${cwd}`,
    };
  }
  return detectPlatformFromUrl(url);
}
