import type { ConsolidationOutput, Severity } from "../tools/consolidate.js";
import type { RubricOutput } from "../tools/score-rubric.js";

/**
 * Verdict → `gh pr review` action mapping. The CLI passes the chosen action as
 * a flag; we compute it deterministically from verdict + score so the formatter
 * stays pure (no env reads, no auth).
 *
 *   REJECTED                                 -> request-changes (blocks merge)
 *   CHANGES_REQUIRED                         -> comment         (advisory, doesn't block)
 *   APPROVED + downgraded_by_score=true      -> comment         (downgraded, treat like CR)
 *   APPROVED + score < request_changes_below -> request-changes (project-policy gate)
 *   APPROVED otherwise                       -> approve
 *
 * `request_changes_below_score` is opt-in via .squad.yaml.pr_posting; without
 * it, APPROVED always maps to approve.
 */
export type GhReviewAction = "approve" | "comment" | "request-changes";

export interface FormatPrReviewOptions {
  /**
   * Below this weighted score, force `request-changes` even when verdict is
   * APPROVED. Lets a repo enforce a hard quality bar at PR review time.
   * Default: undefined (no override — APPROVED stays APPROVED).
   */
  requestChangesBelowScore?: number;
  /**
   * Optional repo identifier shown in the review header (e.g. "ggemba/squad-mcp").
   * Cosmetic — surface where the review came from when the PR aggregates many
   * sources.
   */
  repoLabel?: string;
  /**
   * A.3: severity budget. Caps how many findings get expanded inline in the
   * body before collapsing the surplus into a footnote. Drops happen
   * severity-aware: lowest severity first. Blockers are NEVER silently dropped
   * — if Blocker count alone exceeds `perPrMax` they all still render and the
   * footnote notes the overage.
   *
   * `perPrMax`: total expanded findings. Undefined = unlimited.
   * `dropBelow`: hard floor — anything strictly below this severity is dropped
   *   FIRST regardless of `perPrMax`.
   */
  severityBudget?: {
    perPrMax?: number;
    dropBelow?: "Suggestion" | "Minor" | "Major";
  };
}

export interface PrReviewPayload {
  /** Markdown body to pass to `gh pr review --body-file -`. */
  body: string;
  /** Which `gh pr review --<action>` flag to invoke. */
  action: GhReviewAction;
  /** Short one-line summary suitable for `gh pr review --body` if you want a fallback. */
  summary: string;
}

const SEVERITY_ORDER: Severity[] = ["Blocker", "Major", "Minor", "Suggestion"];

/**
 * Compute the `gh pr review` action for the given consolidation output and
 * options. Pure function; deterministic.
 *
 * Promotion never happens — a low-severity verdict cannot become approval.
 * Demotion (score-driven) only applies to APPROVED.
 */
export function chooseGhAction(
  consolidation: ConsolidationOutput,
  options: FormatPrReviewOptions,
): GhReviewAction {
  if (consolidation.verdict === "REJECTED") return "request-changes";
  if (consolidation.verdict === "CHANGES_REQUIRED") return "comment";

  // APPROVED. Check downgrade signals.
  if (consolidation.downgraded_by_score) return "comment";

  if (
    consolidation.rubric &&
    typeof options.requestChangesBelowScore === "number" &&
    consolidation.rubric.weighted_score < options.requestChangesBelowScore
  ) {
    return "request-changes";
  }
  return "approve";
}

function verdictHeader(consolidation: ConsolidationOutput): string {
  const r = consolidation.rubric;
  const v = consolidation.verdict;
  if (r) {
    const score = r.weighted_score.toFixed(1);
    if (v === "APPROVED" && r.passes_threshold && !consolidation.downgraded_by_score) {
      return `Squad Advisory: APPROVED (${score} / 100)`;
    }
    if (v === "APPROVED") {
      return `Squad Advisory: APPROVED with attention (${score} / 100)`;
    }
    return `Squad Advisory: ${v} (${score} / 100)`;
  }
  return `Squad Advisory: ${v}`;
}

function groupFindingsByAgent(
  consolidation: ConsolidationOutput,
): Map<string, { severity: Severity; title: string }[]> {
  // Consolidator output retains blocker/major lists with agent attribution; we
  // need the full set including Minor/Suggestion. The current ConsolidationOutput
  // shape only exposes blockers + majors_unjustified explicitly; severity_counts
  // is aggregate. To produce a per-agent listing of all findings, we'd need the
  // raw reports. The skill is responsible for passing that input — but post-review
  // CLI receives the consolidator output. We work with what's exposed here, which
  // is enough for the v1 PR comment: blockers + unjustified majors are the actionable
  // items. Minor/Suggestion counts go in the summary.
  const grouped = new Map<string, { severity: Severity; title: string }[]>();
  for (const b of consolidation.blockers) {
    const list = grouped.get(b.agent) ?? [];
    list.push({ severity: "Blocker", title: b.title });
    grouped.set(b.agent, list);
  }
  for (const m of consolidation.majors_unjustified) {
    const list = grouped.get(m.agent) ?? [];
    list.push({ severity: "Major", title: m.title });
    grouped.set(m.agent, list);
  }
  return grouped;
}

/**
 * Apply the A.3 severity budget. Operates on the per-agent grouped findings
 * (the actionable subset — Blockers + unjustified Majors only; Minor/Suggestion
 * counts already live as totals). Returns a possibly-pruned grouping plus a
 * tally of what was hidden so the caller can render a footnote.
 *
 * Drop order:
 *   1. Anything strictly below `dropBelow` (cap-independent).
 *   2. If still over `perPrMax`, drop from the lowest remaining severity until
 *      under cap. Blockers are exempt — if only Blockers remain and they exceed
 *      the cap, they all stay (and the footnote notes the budget was waived).
 */
export function applySeverityBudget(
  grouped: Map<string, { severity: Severity; title: string }[]>,
  budget: NonNullable<FormatPrReviewOptions["severityBudget"]> | undefined,
): {
  grouped: Map<string, { severity: Severity; title: string }[]>;
  hidden: Record<Severity, number>;
  budgetWaived: boolean;
} {
  const hidden: Record<Severity, number> = { Blocker: 0, Major: 0, Minor: 0, Suggestion: 0 };
  if (!budget) return { grouped, hidden, budgetWaived: false };

  // Flatten into one list with agent attribution so we can drop globally.
  type FlatItem = { agent: string; severity: Severity; title: string };
  let flat: FlatItem[] = [];
  for (const [agent, findings] of grouped.entries()) {
    for (const f of findings) flat.push({ agent, severity: f.severity, title: f.title });
  }

  // Step 1: drop strictly below `dropBelow`.
  if (budget.dropBelow) {
    const floorIdx = SEVERITY_ORDER.indexOf(budget.dropBelow as Severity);
    const next: FlatItem[] = [];
    for (const it of flat) {
      const itIdx = SEVERITY_ORDER.indexOf(it.severity);
      if (itIdx > floorIdx) {
        // strictly worse-than-floor index = lower severity in our ordering
        hidden[it.severity]++;
      } else {
        next.push(it);
      }
    }
    flat = next;
  }

  // Step 2: enforce per_pr_max if set.
  let budgetWaived = false;
  if (typeof budget.perPrMax === "number" && flat.length > budget.perPrMax) {
    // Drop from lowest severity upward until under cap, preserving Blockers.
    // Iterate severities in reverse-priority order: Suggestion → Minor → Major.
    const dropOrder: Severity[] = ["Suggestion", "Minor", "Major"];
    for (const sev of dropOrder) {
      while (flat.length > budget.perPrMax) {
        const idx = flat.findIndex((it) => it.severity === sev);
        if (idx === -1) break;
        hidden[sev]++;
        flat.splice(idx, 1);
      }
      if (flat.length <= budget.perPrMax) break;
    }
    // Blockers exempt — if still over cap after exhausting dropOrder, all remaining
    // items are Blockers. Surface the waiver so the footnote can explain.
    if (flat.length > budget.perPrMax) {
      budgetWaived = true;
    }
  }

  // Rebuild grouped from the surviving flat list.
  const next = new Map<string, { severity: Severity; title: string }[]>();
  for (const it of flat) {
    const list = next.get(it.agent) ?? [];
    list.push({ severity: it.severity, title: it.title });
    next.set(it.agent, list);
  }
  return { grouped: next, hidden, budgetWaived };
}

function formatFindingsSection(
  consolidation: ConsolidationOutput,
  budget: FormatPrReviewOptions["severityBudget"],
): string {
  const groupedRaw = groupFindingsByAgent(consolidation);
  const c = consolidation.severity_counts;
  const totalFindings = c.Blocker + c.Major + c.Minor + c.Suggestion;

  // Clean review with zero of every severity — skip the section entirely.
  if (totalFindings === 0) return "";

  const { grouped, hidden, budgetWaived } = applySeverityBudget(groupedRaw, budget);

  const totals = `**Severity totals:** ${c.Blocker} blocker / ${c.Major} major / ${c.Minor} minor / ${c.Suggestion} suggestion`;

  // Build the budget footnote (if anything was hidden).
  const hiddenTotal = hidden.Blocker + hidden.Major + hidden.Minor + hidden.Suggestion;
  const footnoteParts: string[] = [];
  if (hiddenTotal > 0) {
    const breakdown: string[] = [];
    for (const sev of SEVERITY_ORDER) {
      if (hidden[sev] > 0) breakdown.push(`${hidden[sev]} ${sev.toLowerCase()}`);
    }
    footnoteParts.push(
      `_Severity budget hid ${hiddenTotal} finding${hiddenTotal === 1 ? "" : "s"} (${breakdown.join(", ")}). Tune \`pr_posting.severity_budget\` in \`.squad.yaml\`._`,
    );
  }
  if (budgetWaived) {
    footnoteParts.push(
      `_Budget exceeded by Blocker count alone — Blockers are never silently dropped._`,
    );
  }

  // No actionable findings (no Blockers, no unjustified Majors) but Minor/Suggestion
  // counts exist. Emit just the totals — no per-agent expansion needed.
  if (grouped.size === 0) {
    const lines = ["### Findings", "", totals];
    if (footnoteParts.length > 0) lines.push("", ...footnoteParts);
    return lines.join("\n");
  }

  const sections: string[] = [];
  // Sort agents alphabetically for stable output (snapshot-friendly).
  const agentNames = Array.from(grouped.keys()).sort();
  for (const agent of agentNames) {
    const findings = grouped.get(agent) ?? [];
    findings.sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
    const lines = [`#### ${agent}`];
    for (const f of findings) {
      lines.push(`- **${f.severity}** — ${f.title}`);
    }
    sections.push(lines.join("\n"));
  }

  const out = ["### Findings", "", sections.join("\n\n"), "", totals];
  if (footnoteParts.length > 0) out.push("", ...footnoteParts);
  return out.join("\n");
}

function formatRubricBlock(rubric: RubricOutput | null): string {
  if (!rubric) return "";
  // Wrap the existing scorecard_text in a fenced block so the bars and ⚠ flags
  // render as monospace in the GitHub PR review body.
  return ["```", rubric.scorecard_text, "```"].join("\n");
}

function formatFooter(
  consolidation: ConsolidationOutput,
  action: GhReviewAction,
  options: FormatPrReviewOptions,
): string {
  const lines: string[] = [];
  lines.push("---");
  if (consolidation.downgraded_by_score) {
    lines.push(
      `_Verdict downgraded from APPROVED to CHANGES_REQUIRED because the weighted score is below the configured floor._`,
    );
  }
  if (action === "request-changes" && consolidation.verdict === "APPROVED") {
    lines.push(
      `_Posting as request-changes because score is below \`request_changes_below_score\` (${options.requestChangesBelowScore})._`,
    );
  }
  const suffix = options.repoLabel ? ` (\`${options.repoLabel}\`)` : "";
  lines.push(
    `_Generated by [@gempack/squad-mcp](https://github.com/ggemba/squad-mcp)${suffix}. Each agent reviewed only its sliced jurisdiction; the rubric is the weighted rollup. Tune \`.squad.yaml\` to override weights, threshold, or skip paths._`,
  );
  return lines.join("\n\n");
}

/**
 * Build the PR review payload from a consolidation output. Pure, deterministic.
 *
 * Output shape mirrors the squad's terminal report, repurposed as a markdown PR
 * review body:
 *   1. Header with verdict + weighted score
 *   2. Rubric scorecard (fenced code block — keeps the bars monospace)
 *   3. Findings grouped by agent (Blockers + unjustified Majors expanded;
 *      Minor/Suggestion totals only)
 *   4. Footer with attribution + override hint
 *
 * The action is chosen via `chooseGhAction` — caller passes it to
 * `gh pr review --<action>`.
 */
export function formatPrReview(
  consolidation: ConsolidationOutput,
  options: FormatPrReviewOptions = {},
): PrReviewPayload {
  const action = chooseGhAction(consolidation, options);

  const sections: string[] = [];
  sections.push(`## ${verdictHeader(consolidation)}`);

  const rubricBlock = formatRubricBlock(consolidation.rubric);
  if (rubricBlock) sections.push(rubricBlock);

  const findings = formatFindingsSection(consolidation, options.severityBudget);
  if (findings) sections.push(findings);

  sections.push(formatFooter(consolidation, action, options));

  const body = sections.join("\n\n") + "\n";

  // Single-line summary for fallbacks. Capped at ~200 chars — gh accepts more,
  // but PR review bodies that go in `--body` instead of `--body-file` get
  // shell-quoted and long lines invite escaping bugs.
  const c = consolidation.severity_counts;
  const scoreSegment = consolidation.rubric
    ? ` | score ${consolidation.rubric.weighted_score.toFixed(1)}/100`
    : "";
  const summary = `Squad: ${consolidation.verdict}${scoreSegment} | ${c.Blocker}B/${c.Major}M/${c.Minor}m/${c.Suggestion}s`;

  return { body, action, summary };
}
