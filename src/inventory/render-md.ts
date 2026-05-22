/**
 * Deterministic JSON → Markdown renderer for the inventory skill.
 *
 * Same JSON input → byte-identical MD output. This is the property the skill
 * relies on for re-run stability — the renderer never reads the LLM, never
 * varies output by env, never depends on time-of-day. Time only enters via
 * the `generated_at` field of the input report (already an ISO string the
 * caller controls).
 *
 * Sort order is fixed in two places:
 *  - The caller MUST pass findings pre-sorted by `(file, line_start, id)`.
 *  - Within this module, category buckets and cross-ref targets are sorted
 *    by name to break ties stably.
 *
 * The renderer never throws on missing optional fields — coverage gaps degrade
 * to "—" or empty sections, not errors. The renderer DOES throw on schema
 * mismatches (`InventoryReportSchema.parse`) so a malformed intermediate is
 * caught at the boundary, not when a user reads the MD.
 */

import { InventoryReportSchema, type InventoryReport, type InventoryFinding } from "./types.js";

/**
 * Render an inventory report to Markdown. Pure function. The input is parsed
 * through the Zod schema first; downstream callers can pass JSON.parse'd
 * data without a separate validation step.
 */
export function renderInventoryMd(report: InventoryReport | unknown): string {
  const r = InventoryReportSchema.parse(report);
  const sections: string[] = [];

  sections.push(renderFrontmatter(r));
  sections.push(renderTitle(r));
  sections.push(renderCoverage(r));

  if (r.cross_ref_index && Object.keys(r.cross_ref_index).length > 0) {
    const xrefBlock = renderCrossRefSections(r);
    // Skip the section if every kind had an empty entries array (the
    // outer guard above only checks key presence; the inner loop may
    // still emit zero blocks).
    if (xrefBlock !== "") sections.push(xrefBlock);
  }

  sections.push(renderFindingsByFile(r));
  sections.push(renderSources(r));

  return sections.join("\n\n") + "\n";
}

function renderFrontmatter(r: InventoryReport): string {
  const cats = Object.keys(r.findings_by_category)
    .sort()
    .map((k) => `${k}: ${r.findings_by_category[k]}`)
    .join(", ");
  return [
    "---",
    `recipe: ${yamlString(r.recipe)}`,
    `recipe_version: ${r.recipe_version}`,
    `project: ${yamlString(r.project)}`,
    `generated_at: ${r.generated_at}`,
    `depth: ${r.depth}`,
    `findings_total: ${r.findings.length}`,
    `findings_by_category: { ${cats} }`,
    `files_scanned: ${r.coverage.files_scanned}`,
    `files_skipped: ${r.coverage.files_skipped.length}`,
    `duration_ms: ${r.coverage.duration_ms}`,
    `tokens_used_estimate: ${r.coverage.tokens_used_estimate}`,
    `cache_hits: ${r.coverage.cache_hits}`,
    "---",
  ].join("\n");
}

function renderTitle(r: InventoryReport): string {
  return `# Inventory: ${r.recipe} — ${r.project}`;
}

function renderCoverage(r: InventoryReport): string {
  const lines: string[] = ["## Coverage"];
  lines.push(`- Files scanned: ${r.coverage.files_scanned}`);
  if (r.coverage.files_skipped.length > 0) {
    lines.push(`- Files skipped: ${r.coverage.files_skipped.length}`);
    for (const s of [...r.coverage.files_skipped].sort((a, b) =>
      a.path.localeCompare(b.path, "en-US"),
    )) {
      lines.push(`  - \`${s.path}\` — ${s.reason}`);
    }
  } else {
    lines.push(`- Files skipped: 0`);
  }
  lines.push(`- Duration: ${formatMs(r.coverage.duration_ms)}`);
  lines.push(
    `- Tokens used (estimate): ${r.coverage.tokens_used_estimate.toLocaleString("en-US")}`,
  );
  if (r.coverage.cache_hits + r.coverage.cache_misses > 0) {
    const total = r.coverage.cache_hits + r.coverage.cache_misses;
    const pct = Math.round((r.coverage.cache_hits / total) * 100);
    lines.push(`- Cache: ${r.coverage.cache_hits}/${total} hits (${pct}%)`);
  }
  return lines.join("\n");
}

function renderCrossRefSections(r: InventoryReport): string {
  const blocks: string[] = [];
  const xref = r.cross_ref_index ?? {};
  const findingMap = new Map<string, InventoryFinding>();
  for (const f of r.findings) findingMap.set(f.id, f);

  for (const kind of Object.keys(xref).sort()) {
    const source = xref[kind] ?? [];
    const entries = [...source].sort((a, b) => a.target.localeCompare(b.target, "en-US"));
    if (entries.length === 0) continue;
    blocks.push(`## Findings by ${humanizeKind(kind)}`);
    for (const entry of entries) {
      blocks.push(`### \`${entry.target}\``);
      const ids = [...entry.finding_ids].sort();
      for (const id of ids) {
        const f = findingMap.get(id);
        if (!f) continue;
        blocks.push(renderFindingBlock(f, /*compact*/ true));
      }
    }
  }
  return blocks.join("\n\n");
}

function renderFindingsByFile(r: InventoryReport): string {
  const lines: string[] = ["## Findings by file"];
  const byFile = new Map<string, InventoryFinding[]>();
  for (const f of r.findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const files = [...byFile.keys()].sort();
  for (const file of files) {
    const findings = (byFile.get(file) ?? []).slice().sort((a, b) => a.line_start - b.line_start);
    lines.push(`### \`${file}\``);
    for (const f of findings) {
      lines.push(renderFindingBlock(f, /*compact*/ false));
    }
  }
  return lines.join("\n\n");
}

function renderFindingBlock(f: InventoryFinding, compact: boolean): string {
  const lines: string[] = [];
  const range = f.line_start === f.line_end ? `${f.line_start}` : `${f.line_start}-${f.line_end}`;
  lines.push(`#### [${f.id}] \`${f.file}:${range}\` — ${f.category} (${f.severity})`);
  if (f.summary) lines.push(`**Summary:** ${f.summary}`);
  lines.push("```");
  lines.push(f.excerpt.trimEnd());
  lines.push("```");
  if (!compact) {
    lines.push(`- Rule: \`${f.rule_id}\``);
    if (f.confidence != null) {
      lines.push(`- Confidence: ${f.confidence.toFixed(2)} (${f.enriched_by})`);
    } else if (f.enriched_by !== "none") {
      lines.push(`- Enriched by: ${f.enriched_by}`);
    }
    if (f.cross_refs && f.cross_refs.length > 0) {
      const refs = [...f.cross_refs]
        .sort((a, b) => `${a.kind}:${a.target}`.localeCompare(`${b.kind}:${b.target}`, "en-US"))
        .map((x) => `${x.kind} → \`${x.target}\``)
        .join(", ");
      lines.push(`- Cross-refs: ${refs}`);
    }
    if (f.fingerprint) lines.push(`- Fingerprint: \`${f.fingerprint.slice(0, 16)}…\``);
  }
  return lines.join("\n");
}

function renderSources(r: InventoryReport): string {
  return [
    "## Sources",
    `- Pack: \`${r.recipe} v${r.recipe_version}\``,
    `- Findings: ${r.findings.length}`,
    `- Generated: ${r.generated_at}`,
  ].join("\n");
}

function humanizeKind(kind: string): string {
  // `kind` values come from a pack's `cross_ref[].kind` field — a free-form
  // string the pack author chooses. This takes the last `_`-delimited segment
  // as a human label: `laravel_route` → "route", `http_endpoint` → "endpoint".
  // Best-effort and language-agnostic — never breaks on an unknown kind.
  const parts = kind.split("_");
  return parts[parts.length - 1] ?? kind;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  let m = Math.floor(s / 60);
  let rem = Math.round(s - m * 60);
  // Carry rounding overflow: 119_999ms → s=119.999, m=1, rem=Math.round(59.999)=60
  // → emits "2m 0s", not "1m 60s".
  if (rem >= 60) {
    m += Math.floor(rem / 60);
    rem = rem % 60;
  }
  return `${m}m ${rem}s`;
}

function yamlString(s: string): string {
  // Quote if any YAML-special characters appear. Otherwise emit bare.
  // Char class covers YAML indicators per YAML 1.2 §5.3 plus literal/folded
  // scalar indicators (`|`, `>`), null shorthand (`~`), and newline.
  return /[:#&*!|~\-?{[\],>%@`"'\n]/.test(s) ? JSON.stringify(s) : s;
}
