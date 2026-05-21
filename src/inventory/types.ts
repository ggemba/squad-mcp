/**
 * Inventory skill (`/squad:inventory`) — pure type/schema module.
 *
 * The skill itself orchestrates from `skills/inventory/SKILL.md` (rg sweep,
 * code-explorer dispatch, MD render). This module pins the JSON intermediate
 * shape — the contract between the rg sweep step and the deterministic MD
 * renderer (`render-md.ts`).
 *
 * NO runtime logic here. Schemas only. Loaded by the skill at orchestration
 * time and by `tests/inventory-render.test.ts` for snapshot pinning.
 */

import { z } from "zod";

/** A single inventory finding row. */
export const InventoryFindingSchema = z.object({
  /** Stable per-finding id of the form `F-NNNN` (sorted: file path then line). */
  id: z.string().regex(/^F-\d{4,}$/),
  /** Repo-relative path. */
  file: z.string().min(1),
  /** 1-based start line. */
  line_start: z.number().int().positive(),
  /** 1-based end line, inclusive. May equal `line_start` for single-line matches. */
  line_end: z.number().int().positive(),
  /** Verbatim excerpt of the matched code (trimmed, max ~500 chars). */
  excerpt: z.string(),
  /** Category from the pack rule that matched. e.g. `ddl`, `query`, `dynamic`. */
  category: z.string().min(1),
  /** The pack rule id that fired. */
  rule_id: z.string().min(1),
  /** Severity from the pack rule. */
  severity: z.enum(["info", "warning", "critical"]).default("info"),
  /**
   * Per-finding LLM-enriched summary. One sentence. Filled in by the
   * orchestrator after the dispatch step; absent for `--dry-run` runs.
   */
  summary: z.string().optional(),
  /**
   * Confidence the enrichment tier emitted (Haiku self-report). Range [0,1].
   * `null` means no enrichment was attempted (dry-run / mode=quick + no
   * fallback). The cross-tier-escalation rule in the skill uses this.
   */
  confidence: z.number().min(0).max(1).nullable().optional(),
  /**
   * Which model produced `summary`. Stable label so `/squad:stats` can audit
   * cost per finding.
   */
  enriched_by: z.enum(["haiku", "sonnet", "opus", "none"]).default("none"),
  /**
   * Cross-references resolved during the cross-ref pass. The orchestrator
   * fills this when the pack declares a `cross_ref` section. Optional —
   * the skill can disable cross-ref via `--no-cross-ref` (expert flag).
   */
  cross_refs: z
    .array(
      z.object({
        kind: z.string().min(1),
        target: z.string().min(1),
        evidence: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * SARIF-style fingerprint for re-run stability. sha256 of
   * `rule_id + file + normalized(excerpt)`. Lets a future cache layer skip
   * unchanged findings on re-runs. Optional in v1 — emitted when the
   * renderer can compute it.
   */
  fingerprint: z.string().optional(),
});

export type InventoryFinding = z.infer<typeof InventoryFindingSchema>;

/** Coverage header captured at the top of the rendered MD. */
export const InventoryCoverageSchema = z.object({
  files_scanned: z.number().int().nonnegative(),
  files_skipped: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
  duration_ms: z.number().int().nonnegative(),
  tokens_used_estimate: z.number().int().nonnegative(),
  cache_hits: z.number().int().nonnegative().default(0),
  cache_misses: z.number().int().nonnegative().default(0),
});

export type InventoryCoverage = z.infer<typeof InventoryCoverageSchema>;

/** Top-level inventory report (JSON intermediate fed to render-md.ts). */
export const InventoryReportSchema = z.object({
  /** Pack name that produced this inventory. */
  recipe: z.string().min(1),
  /** Pack version pin. */
  recipe_version: z.union([z.number().int(), z.string()]),
  /** Repo-relative project name (typically the workspace dir basename). */
  project: z.string().min(1),
  /** ISO 8601 of when the inventory completed. */
  generated_at: z.string(),
  /** Mode the user (or auto) picked. Same vocabulary as the rest of squad. */
  depth: z.enum(["quick", "normal", "deep"]),
  /** Counts by category — derived from findings, but pinned for stable rendering. */
  findings_by_category: z.record(z.string(), z.number().int().nonnegative()),
  /** Coverage + cost. */
  coverage: InventoryCoverageSchema,
  /** All findings, pre-sorted (file path asc, then line_start asc). */
  findings: z.array(InventoryFindingSchema),
  /**
   * Optional cross-ref index built during the cross-ref pass. Maps a
   * cross-ref kind (e.g. `laravel_route`) to a list of `{target, finding_ids}`.
   * The renderer uses this to emit the "Findings by route" / "Findings by
   * endpoint" section when present.
   */
  cross_ref_index: z
    .record(
      z.string(),
      z.array(
        z.object({
          target: z.string(),
          finding_ids: z.array(z.string()),
        }),
      ),
    )
    .optional(),
});

export type InventoryReport = z.infer<typeof InventoryReportSchema>;

/** Rule definition inside a pack YAML. */
export const PackRuleSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(["info", "warning", "critical"]).default("info"),
    category: z.string().min(1),
    /**
     * If true, every finding from this rule is dispatched to the Sonnet tier
     * regardless of mode (except `--quick`, which never escalates). Used for
     * security-sensitive rules where Haiku-class classification is unsafe.
     */
    requires_semantic: z.boolean().default(false),
    /** Optional one-liner shown in the MD header for this rule. */
    description: z.string().optional(),
    /**
     * Hint passed to the enrichment prompt — anchors the LLM toward the
     * expected purpose of the matched code. Optional.
     */
    summary_hint: z.string().optional(),
    /**
     * The pattern. v1 supports rg-flavored regex only. Ast-grep is planned
     * for v2 (`ast_grep_pattern` will land alongside). At least one must
     * be present — schema validation enforces this via `superRefine`.
     */
    regex: z.string().optional(),
    /** Future v2 — reserved. Validated as a string for forward-compat. */
    ast_grep_pattern: z.string().optional(),
  })
  .superRefine((rule, ctx) => {
    if (!rule.regex && !rule.ast_grep_pattern) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rule '${rule.id}' must define either 'regex' or 'ast_grep_pattern'`,
      });
    }
  });

export type PackRule = z.infer<typeof PackRuleSchema>;

/** Pack YAML schema. Loaded once at the start of each inventory run. */
export const PackSchema = z.object({
  name: z.string().min(1),
  version: z.union([z.number().int(), z.string()]),
  description: z.string().optional(),
  /** Primary language the pack targets. Free-form so packs can name SQL, mixed, etc. */
  language: z.string().min(1),
  /**
   * Glob patterns the rg sweep includes. Defaults applied if absent
   * (`**\/*.<language ext>`).
   */
  file_patterns: z.array(z.string()).default([]),
  /**
   * Additional excludes on top of skill-default (`vendor/`, `node_modules/`,
   * etc.).
   */
  exclude_patterns: z.array(z.string()).default([]),
  rules: z.array(PackRuleSchema).min(1),
  /**
   * Cross-ref configuration. The orchestrator runs each entry as a separate
   * scan to build the cross-ref index (e.g. Laravel route file → controller
   * method map).
   */
  cross_ref: z
    .array(
      z.object({
        kind: z.string().min(1),
        glob: z.string().min(1),
        /** Optional rg pattern for extraction. Default depends on `kind`. */
        regex: z.string().optional(),
      }),
    )
    .default([]),
});

export type Pack = z.infer<typeof PackSchema>;
