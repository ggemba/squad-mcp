import type { ConsolidationOutput, Severity } from "../tools/consolidate.js";
import { fingerprintFinding } from "../util/finding-fingerprint.js";

/**
 * SARIF 2.1.0 emitter for squad-mcp consolidation output.
 *
 * Goal: emit a CI-ingestible artefact alongside (or instead of) the markdown
 * PR comment. SARIF 2.1.0 is the OASIS standard consumed by GitHub Code
 * Scanning, GitLab SAST, Sonar, and most ingestion pipelines — picking it
 * means the existing CI fleet can gate on squad-mcp findings without bespoke
 * parsers.
 *
 * Scope of v1 (May 2026):
 *   - Each Blocker / unjustified Major in the consolidation becomes a SARIF
 *     `result`. Minor / Suggestion counts go to `properties.severity_counts`
 *     for downstream visibility but do not produce results — they're
 *     informational at this maturity level and would inflate every CI report.
 *   - `level` mapping: Blocker / Major → "error", Minor → "warning",
 *     Suggestion → "note". (Minor / Suggestion only appear if a future
 *     non-aggregated input is fed in; the v1 ConsolidationOutput exposes only
 *     Blockers + unjustified Majors as expanded items.)
 *   - `partialFingerprints.canonicalHash` carries the A.4 finding fingerprint
 *     so dedup-on-rerun (a future feature) and across-tool dedup (Sonar →
 *     squad-mcp) can match issues without relying on file paths or line numbers
 *     that drift across rebases.
 *   - `locations` is OMITTED. Today's ConsolidationOutput does not carry per-
 *     finding file/line metadata; SARIF allows results without locations
 *     (treated as "physical location unknown — issue applies repository-wide").
 *     Inline-comment work in a future task will populate this.
 *
 * What this is NOT:
 *   - Not a full SARIF 2.1.0 implementation. We emit the smallest valid shape
 *     that GitHub + Sonar accept: $schema, version, runs[].tool.driver +
 *     runs[].results[]. No taxonomies, no graphs, no logical locations.
 *   - Not a writer — pure formatter. The CLI (tools/post-review.mjs) decides
 *     where to put the bytes.
 */

export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA_URL =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json";

const DRIVER_NAME = "squad-mcp";
// Read at build time? No — keeping the formatter pure. The driver name +
// information URI are stable across versions; the version itself is
// uninteresting in SARIF and is left absent.
const DRIVER_INFO_URI = "https://github.com/ggemba/squad-mcp";

/** Per-severity SARIF level mapping. */
function severityToLevel(sev: Severity): "error" | "warning" | "note" {
  switch (sev) {
    case "Blocker":
    case "Major":
      return "error";
    case "Minor":
      return "warning";
    case "Suggestion":
      return "note";
  }
}

export interface FormatSarifOptions {
  /**
   * Optional repo identifier ("owner/name" for GitHub, "workspace/repo" for
   * Bitbucket) included in the run's `automationDetails.id`. Helps consumers
   * disambiguate squad-mcp results from multiple repos in a single dashboard.
   */
  repoLabel?: string;
}

export interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  partialFingerprints: { canonicalHash: string };
  properties: {
    severity: Severity;
    agent: string;
  };
}

export interface SarifLog {
  $schema: string;
  version: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        rules: Array<{ id: string; name: string }>;
      };
    };
    automationDetails?: { id: string };
    results: SarifResult[];
    properties: {
      verdict: string;
      weighted_score: number | null;
      passes_threshold: boolean | null;
      severity_counts: Record<Severity, number>;
      downgraded_by_score: boolean;
      summary: string;
    };
  }>;
}

/**
 * Build a SARIF 2.1.0 log from a ConsolidationOutput.
 * Pure, deterministic; no I/O.
 */
export function formatSarif(
  consolidation: ConsolidationOutput,
  options: FormatSarifOptions = {},
): SarifLog {
  const results: SarifResult[] = [];
  const ruleIds = new Set<string>();

  // Helper: build a stable rule id from the agent. Agents own rule namespaces
  // ("senior-developer:async-error-handling" for example) — but our
  // ConsolidationOutput doesn't carry per-finding rule ids today, so we use
  // the agent name as the rule id and let the message + fingerprint
  // disambiguate. Future inline work can extend this.
  function ruleIdFor(agent: string, severity: Severity): string {
    return `${agent}:${severity.toLowerCase()}`;
  }

  for (const b of consolidation.blockers) {
    const ruleId = ruleIdFor(b.agent, "Blocker");
    ruleIds.add(ruleId);
    results.push({
      ruleId,
      level: severityToLevel("Blocker"),
      message: { text: b.title },
      partialFingerprints: {
        canonicalHash: fingerprintFinding({
          agent: b.agent,
          severity: "Blocker",
          title: b.title,
        }),
      },
      properties: { severity: "Blocker", agent: b.agent },
    });
  }
  for (const m of consolidation.majors_unjustified) {
    const ruleId = ruleIdFor(m.agent, "Major");
    ruleIds.add(ruleId);
    results.push({
      ruleId,
      level: severityToLevel("Major"),
      message: { text: m.title },
      partialFingerprints: {
        canonicalHash: fingerprintFinding({
          agent: m.agent,
          severity: "Major",
          title: m.title,
        }),
      },
      properties: { severity: "Major", agent: m.agent },
    });
  }

  const rules = Array.from(ruleIds)
    .sort()
    .map((id) => ({ id, name: id }));

  const run: SarifLog["runs"][number] = {
    tool: {
      driver: {
        name: DRIVER_NAME,
        informationUri: DRIVER_INFO_URI,
        rules,
      },
    },
    results,
    properties: {
      verdict: consolidation.verdict,
      weighted_score: consolidation.rubric ? consolidation.rubric.weighted_score : null,
      passes_threshold: consolidation.rubric ? consolidation.rubric.passes_threshold : null,
      severity_counts: consolidation.severity_counts,
      downgraded_by_score: consolidation.downgraded_by_score,
      summary: consolidation.summary,
    },
  };

  if (options.repoLabel) {
    run.automationDetails = { id: options.repoLabel };
  }

  return {
    $schema: SARIF_SCHEMA_URL,
    version: SARIF_VERSION,
    runs: [run],
  };
}
