import { createHash } from "node:crypto";
import { normalizeFindingTitle } from "../learning/normalize.js";

// This module lives in src/util/ (not src/format/) because the fingerprint
// is a general primitive consumed by SARIF emission today AND designed to be
// reused for future dedup-on-rerun + learnings dedup. Its semantic anchor is
// `normalizeFindingTitle` (the learnings normalisation function), so a change
// to that normaliser flows through here and any SARIF consumer depending on
// fingerprint stability needs to know.

/**
 * Stable canonical hash for a finding. Used as `partialFingerprints.canonicalHash`
 * in the SARIF writer (A.2) and — once dedup-on-rerun lands — by the PR-posting
 * adapter to skip findings already on the PR.
 *
 * Inputs are intentionally narrow: agent + severity + normalised title. We do
 * NOT include `detail`, `score`, `forwarded_to`, or scoring metadata because
 * those drift between runs ("there are 3 occurrences" → "there are 4 occurrences")
 * while the underlying issue is the same. Including them would explode the
 * fingerprint surface and defeat the dedup goal.
 *
 * `file` is accepted optionally — when the upstream finding gains a per-line
 * anchor (future inline-comment work), passing it tightens the hash so two
 * different files raising the same canonical title don't collapse. Until then,
 * pass undefined and the fingerprint stays file-agnostic.
 *
 * The hash is sha256, hex-encoded, truncated to 16 chars. 16 hex chars = 64 bits
 * of namespace which is overwhelmingly enough for the ≤500 findings any single
 * /squad:review can carry (collision probability < 1e-12 per run). Truncating
 * keeps the SARIF rows small.
 */
export interface FingerprintInput {
  agent: string;
  severity: "Blocker" | "Major" | "Minor" | "Suggestion";
  title: string;
  /**
   * Optional file path. When supplied, becomes part of the hash so per-file
   * variants of the same canonical issue dedup separately.
   */
  file?: string;
}

export const FINGERPRINT_HEX_LENGTH = 16;

export function fingerprintFinding(input: FingerprintInput): string {
  const agent = String(input.agent ?? "")
    .trim()
    .toLowerCase();
  const severity = String(input.severity ?? "").trim();
  const titleCanonical = normalizeFindingTitle(String(input.title ?? ""));
  const file = input.file !== undefined ? String(input.file).trim() : "";

  // Field separator is `` (US — unit separator). Picked because it can't
  // appear in any of the inputs (control chars are stripped at our boundaries
  // and aren't valid in agent / severity / file paths). Keeps "agent='a', file='b'"
  // distinct from "agent='a|b', file=''" without resorting to JSON.stringify.
  const canonical = [agent, severity, titleCanonical, file].join("");

  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_HEX_LENGTH);
}
