/**
 * Snapshot pinning for the inventory MD renderer.
 *
 * Determinism contract: same JSON → byte-identical MD. We pin a representative
 * fixture so any drift in renderer formatting is caught at PR time.
 *
 * Coverage:
 *  - Frontmatter shape
 *  - Coverage section (with and without skipped files)
 *  - Findings by file (sorted, ranges, fingerprints elided to first 16 chars)
 *  - Cross-ref index → "Findings by <kind>" emission
 *  - Empty cross-ref → section skipped entirely
 *  - Idempotency: rendering the same input twice → identical bytes
 */

import { describe, it, expect } from "vitest";
import { renderInventoryMd } from "../src/inventory/render-md.js";
import type { InventoryReport } from "../src/inventory/types.js";

const fixture: InventoryReport = {
  recipe: "php-inline-sql",
  recipe_version: 1,
  project: "pagcorp.gestor.web",
  generated_at: "2026-05-20T23:59:00.000Z",
  depth: "normal",
  findings_by_category: { ddl: 1, query: 2, dynamic: 1 },
  coverage: {
    files_scanned: 1023,
    files_skipped: [
      { path: "app/Generated/Stub.php", reason: "exceeds size cap" },
      { path: "vendor/legacy.php", reason: "excluded by pack" },
    ],
    duration_ms: 42100,
    tokens_used_estimate: 118400,
    cache_hits: 134,
    cache_misses: 53,
  },
  findings: [
    {
      id: "F-0001",
      file: "app/Http/Controllers/CartoesController.php",
      line_start: 142,
      line_end: 142,
      excerpt:
        "DB::statement(\"INSERT INTO ACG_Pre.dbo.cartoes_pending (cardholder_id, status) VALUES (?, 'pending')\")",
      category: "ddl",
      rule_id: "php-db-statement",
      severity: "info",
      summary: "Cria registro em ACG_Pre.cartoes_pending antes da chamada à API Pismo.",
      confidence: 0.92,
      enriched_by: "haiku",
      cross_refs: [
        { kind: "laravel_route", target: "POST /api/cartoes/criar", evidence: "routes/api.php:48" },
      ],
      fingerprint: "a".repeat(64),
    },
    {
      id: "F-0002",
      file: "app/Services/CartoesService.php",
      line_start: 87,
      line_end: 89,
      excerpt:
        '$sql = "SELECT id, status FROM cartoes WHERE "\n     . $where\n     . " AND deleted_at IS NULL";',
      category: "dynamic",
      rule_id: "php-db-raw-concat",
      severity: "warning",
      summary: "Query dinâmica com concat de variável local — checar se $where é sanitizado.",
      confidence: 0.55,
      enriched_by: "sonnet",
      fingerprint: "b".repeat(64),
    },
    {
      id: "F-0003",
      file: "app/Services/CartoesService.php",
      line_start: 220,
      line_end: 220,
      excerpt: '$pdo->query("SELECT * FROM cartoes WHERE cardholder_id = ?")',
      category: "query",
      rule_id: "php-pdo-query",
      severity: "info",
      summary: "Leitura simples por cardholder_id.",
      confidence: 0.95,
      enriched_by: "haiku",
      fingerprint: "c".repeat(64),
    },
    {
      id: "F-0004",
      file: "app/Services/ExtratoService.php",
      line_start: 14,
      line_end: 14,
      excerpt: 'DB::select("SELECT * FROM extrato WHERE conta = ?", [$id])',
      category: "query",
      rule_id: "php-db-select",
      severity: "info",
      summary: "Extrato por conta — read-only.",
      confidence: 0.91,
      enriched_by: "haiku",
      fingerprint: "d".repeat(64),
    },
  ],
  cross_ref_index: {
    laravel_route: [{ target: "POST /api/cartoes/criar", finding_ids: ["F-0001"] }],
  },
};

describe("renderInventoryMd", () => {
  it("renders fixture to stable MD", () => {
    const md = renderInventoryMd(fixture);
    expect(md).toMatchInlineSnapshot(`
      "---
      recipe: "php-inline-sql"
      recipe_version: 1
      project: pagcorp.gestor.web
      generated_at: 2026-05-20T23:59:00.000Z
      depth: normal
      findings_total: 4
      findings_by_category: { ddl: 1, dynamic: 1, query: 2 }
      files_scanned: 1023
      files_skipped: 2
      duration_ms: 42100
      tokens_used_estimate: 118400
      cache_hits: 134
      ---

      # Inventory: php-inline-sql — pagcorp.gestor.web

      ## Coverage
      - Files scanned: 1023
      - Files skipped: 2
        - \`app/Generated/Stub.php\` — exceeds size cap
        - \`vendor/legacy.php\` — excluded by pack
      - Duration: 42.1s
      - Tokens used (estimate): 118,400
      - Cache: 134/187 hits (72%)

      ## Findings by route

      ### \`POST /api/cartoes/criar\`

      #### [F-0001] \`app/Http/Controllers/CartoesController.php:142\` — ddl (info)
      **Summary:** Cria registro em ACG_Pre.cartoes_pending antes da chamada à API Pismo.
      \`\`\`
      DB::statement("INSERT INTO ACG_Pre.dbo.cartoes_pending (cardholder_id, status) VALUES (?, 'pending')")
      \`\`\`

      ## Findings by file

      ### \`app/Http/Controllers/CartoesController.php\`

      #### [F-0001] \`app/Http/Controllers/CartoesController.php:142\` — ddl (info)
      **Summary:** Cria registro em ACG_Pre.cartoes_pending antes da chamada à API Pismo.
      \`\`\`
      DB::statement("INSERT INTO ACG_Pre.dbo.cartoes_pending (cardholder_id, status) VALUES (?, 'pending')")
      \`\`\`
      - Rule: \`php-db-statement\`
      - Confidence: 0.92 (haiku)
      - Cross-refs: laravel_route → \`POST /api/cartoes/criar\`
      - Fingerprint: \`aaaaaaaaaaaaaaaa…\`

      ### \`app/Services/CartoesService.php\`

      #### [F-0002] \`app/Services/CartoesService.php:87-89\` — dynamic (warning)
      **Summary:** Query dinâmica com concat de variável local — checar se $where é sanitizado.
      \`\`\`
      $sql = "SELECT id, status FROM cartoes WHERE "
           . $where
           . " AND deleted_at IS NULL";
      \`\`\`
      - Rule: \`php-db-raw-concat\`
      - Confidence: 0.55 (sonnet)
      - Fingerprint: \`bbbbbbbbbbbbbbbb…\`

      #### [F-0003] \`app/Services/CartoesService.php:220\` — query (info)
      **Summary:** Leitura simples por cardholder_id.
      \`\`\`
      $pdo->query("SELECT * FROM cartoes WHERE cardholder_id = ?")
      \`\`\`
      - Rule: \`php-pdo-query\`
      - Confidence: 0.95 (haiku)
      - Fingerprint: \`cccccccccccccccc…\`

      ### \`app/Services/ExtratoService.php\`

      #### [F-0004] \`app/Services/ExtratoService.php:14\` — query (info)
      **Summary:** Extrato por conta — read-only.
      \`\`\`
      DB::select("SELECT * FROM extrato WHERE conta = ?", [$id])
      \`\`\`
      - Rule: \`php-db-select\`
      - Confidence: 0.91 (haiku)
      - Fingerprint: \`dddddddddddddddd…\`

      ## Sources
      - Pack: \`php-inline-sql v1\`
      - Findings: 4
      - Generated: 2026-05-20T23:59:00.000Z
      "
    `);
  });

  it("is byte-identical on re-render (deterministic)", () => {
    const a = renderInventoryMd(fixture);
    const b = renderInventoryMd(fixture);
    expect(a).toBe(b);
  });

  it("skips the cross-ref section when the index is absent", () => {
    const noXref: InventoryReport = { ...fixture, cross_ref_index: undefined };
    const md = renderInventoryMd(noXref);
    expect(md).not.toContain("## Findings by route");
    expect(md).toContain("## Findings by file");
  });

  it("emits 'Files skipped: 0' when nothing was skipped", () => {
    const clean: InventoryReport = {
      ...fixture,
      coverage: { ...fixture.coverage, files_skipped: [] },
    };
    const md = renderInventoryMd(clean);
    expect(md).toContain("Files skipped: 0");
  });

  it("rejects schema violations at the boundary", () => {
    const bad = { ...fixture, depth: "extreme" };
    expect(() => renderInventoryMd(bad)).toThrow();
  });

  it("formats duration_ms < 1s as 'NNN ms'", () => {
    const fast: InventoryReport = {
      ...fixture,
      coverage: { ...fixture.coverage, duration_ms: 850 },
    };
    const md = renderInventoryMd(fast);
    expect(md).toContain("Duration: 850 ms");
  });

  it("formats duration_ms >= 60s as 'Nm Ms'", () => {
    const slow: InventoryReport = {
      ...fixture,
      coverage: { ...fixture.coverage, duration_ms: 125_000 },
    };
    const md = renderInventoryMd(slow);
    expect(md).toContain("Duration: 2m 5s");
  });
});
