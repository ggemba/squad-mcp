/**
 * Pack-loading + pack-schema coverage for the inventory skill.
 *
 * Two concerns:
 *  1. The BUNDLED pack (`skills/inventory/packs/php-inline-sql.yaml`) ships as
 *     runtime data. A typo in a regex or a missing required field would only
 *     surface on a live run. This suite parses it through `PackSchema` at PR
 *     time so a broken pack edit fails CI, not a user.
 *  2. `PackRuleSchema.superRefine` is the only custom validation in
 *     `src/inventory/types.ts` — it requires `regex` OR `ast_grep_pattern`.
 *     Exercised here directly.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { PackSchema, PackRuleSchema } from "../src/inventory/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const bundledPackPath = join(here, "..", "skills", "inventory", "packs", "php-inline-sql.yaml");

describe("bundled pack: php-inline-sql.yaml", () => {
  it("loads and validates against PackSchema", () => {
    const raw = yaml.load(readFileSync(bundledPackPath, "utf8"));
    const parsed = PackSchema.parse(raw);
    expect(parsed.name).toBe("php-inline-sql");
    expect(parsed.language).toBe("php");
    expect(parsed.rules.length).toBeGreaterThan(0);
  });

  it("every rule regex compiles as a valid RegExp", () => {
    const parsed = PackSchema.parse(yaml.load(readFileSync(bundledPackPath, "utf8")));
    for (const rule of parsed.rules) {
      if (rule.regex) {
        expect(() => new RegExp(rule.regex as string), `rule ${rule.id}`).not.toThrow();
      }
    }
  });

  it("every cross_ref regex compiles as a valid RegExp", () => {
    const parsed = PackSchema.parse(yaml.load(readFileSync(bundledPackPath, "utf8")));
    for (const xref of parsed.cross_ref) {
      if (xref.regex) {
        expect(() => new RegExp(xref.regex as string), `cross_ref ${xref.kind}`).not.toThrow();
      }
    }
  });

  it("rule ids are unique", () => {
    const parsed = PackSchema.parse(yaml.load(readFileSync(bundledPackPath, "utf8")));
    const ids = parsed.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("flags every dynamic-SQL rule with requires_semantic", () => {
    // Concatenation / DB::raw rules detect injection-prone code — Haiku-tier
    // classification is unsafe, so they must escalate. Pinned so a future pack
    // edit can't silently drop the flag.
    const parsed = PackSchema.parse(yaml.load(readFileSync(bundledPackPath, "utf8")));
    const dynamicRules = parsed.rules.filter((r) => r.category === "dynamic");
    expect(dynamicRules.length).toBeGreaterThan(0);
    for (const rule of dynamicRules) {
      expect(rule.requires_semantic, `rule ${rule.id}`).toBe(true);
    }
  });
});

describe("PackRuleSchema.superRefine", () => {
  const base = { id: "r1", category: "query" };

  it("accepts a rule with only regex", () => {
    const r = PackRuleSchema.parse({ ...base, regex: "SELECT" });
    expect(r.regex).toBe("SELECT");
  });

  it("accepts a rule with only ast_grep_pattern", () => {
    const r = PackRuleSchema.parse({ ...base, ast_grep_pattern: "DB::statement($SQL)" });
    expect(r.ast_grep_pattern).toBe("DB::statement($SQL)");
  });

  it("accepts a rule with both regex and ast_grep_pattern", () => {
    const r = PackRuleSchema.parse({
      ...base,
      regex: "SELECT",
      ast_grep_pattern: "DB::statement($SQL)",
    });
    expect(r.regex).toBe("SELECT");
  });

  it("rejects a rule with neither regex nor ast_grep_pattern", () => {
    expect(() => PackRuleSchema.parse(base)).toThrow(
      /must define either 'regex' or 'ast_grep_pattern'/,
    );
  });

  it("defaults severity to info and requires_semantic to false", () => {
    const r = PackRuleSchema.parse({ ...base, regex: "SELECT" });
    expect(r.severity).toBe("info");
    expect(r.requires_semantic).toBe(false);
  });
});

describe("PackSchema", () => {
  it("rejects a pack with zero rules", () => {
    expect(() =>
      PackSchema.parse({ name: "empty", version: 1, language: "php", rules: [] }),
    ).toThrow();
  });

  it("applies defaults for file_patterns / exclude_patterns / cross_ref", () => {
    const p = PackSchema.parse({
      name: "minimal",
      version: 1,
      language: "php",
      rules: [{ id: "r1", category: "query", regex: "SELECT" }],
    });
    expect(p.file_patterns).toEqual([]);
    expect(p.exclude_patterns).toEqual([]);
    expect(p.cross_ref).toEqual([]);
  });
});
