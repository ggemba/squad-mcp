/**
 * Pack-loading + pack-schema coverage for the inventory skill.
 *
 * Three concerns:
 *  1. The BUNDLED packs (`skills/inventory/packs/*.yaml`) ship as runtime data.
 *     A typo in a regex or a missing required field would only surface on a
 *     live run. This suite parses every pack through `PackSchema` at PR time so
 *     a broken pack edit fails CI, not a user.
 *  2. `PackRuleSchema.superRefine` is the only custom validation in
 *     `src/inventory/types.ts` — it requires `regex` OR `ast_grep_pattern`.
 *     Exercised here directly.
 *  3. The rg sweep runs ripgrep WITHOUT `--pcre2`, so its default Rust regex
 *     engine rejects lookaround and backreferences. A pattern can compile fine
 *     under JS `RegExp` yet break the live run — the static rg-compat check
 *     below catches that class of bug at PR time.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { PackSchema, PackRuleSchema } from "../src/inventory/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const packsDir = join(here, "..", "skills", "inventory", "packs");
const bundledPackPath = join(packsDir, "php-inline-sql.yaml");

/**
 * Patterns ripgrep cannot evaluate under its default Rust engine: lookahead,
 * lookbehind, named groups, and backreferences. A pattern containing any of
 * these compiles under JS `RegExp` but fails the live `rg` sweep.
 */
const RG_INCOMPATIBLE: Array<[string, RegExp]> = [
  ["lookahead (?=", /\(\?=/],
  ["negative lookahead (?!", /\(\?!/],
  ["lookbehind (?<=", /\(\?<=/],
  ["negative lookbehind (?<!", /\(\?<!/],
  ["named group (?<name>", /\(\?<[A-Za-z_]/],
  ["backreference \\1-\\9", /\\[1-9]/],
];

/** Load + parse a pack file at an absolute path. */
function loadPack(absPath: string) {
  return PackSchema.parse(yaml.load(readFileSync(absPath, "utf8")));
}

/**
 * Build a JS `RegExp` from a pack's rg-flavored pattern for fixture matching.
 *
 * ripgrep accepts a leading inline `(?i)` case-insensitive flag; JS `RegExp`
 * does NOT (it throws "Invalid group"). The fixture tests below match in JS,
 * so a leading `(?i)` is lifted to the `i` constructor flag here — the live
 * `rg` sweep still sees the original `(?i)` in the YAML, which it supports.
 */
function compilePackRegex(pattern: string): RegExp {
  const m = /^\(\?i\)/.exec(pattern);
  return m ? new RegExp(pattern.slice(m[0].length), "i") : new RegExp(pattern);
}

describe("bundled pack: php-inline-sql.yaml", () => {
  it("loads and validates against PackSchema", () => {
    const parsed = loadPack(bundledPackPath);
    expect(parsed.name).toBe("php-inline-sql");
    expect(parsed.language).toBe("php");
    expect(parsed.rules.length).toBeGreaterThan(0);
  });

  it("every rule regex compiles as a valid RegExp", () => {
    const parsed = loadPack(bundledPackPath);
    for (const rule of parsed.rules) {
      if (rule.regex) {
        expect(() => new RegExp(rule.regex as string), `rule ${rule.id}`).not.toThrow();
      }
    }
  });

  it("every cross_ref regex compiles as a valid RegExp", () => {
    const parsed = loadPack(bundledPackPath);
    for (const xref of parsed.cross_ref) {
      if (xref.regex) {
        expect(() => new RegExp(xref.regex as string), `cross_ref ${xref.kind}`).not.toThrow();
      }
    }
  });

  it("rule ids are unique", () => {
    const parsed = loadPack(bundledPackPath);
    const ids = parsed.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("flags every dynamic-SQL rule with requires_semantic", () => {
    // Concatenation / DB::raw rules detect injection-prone code — Haiku-tier
    // classification is unsafe, so they must escalate. Pinned so a future pack
    // edit can't silently drop the flag.
    const parsed = loadPack(bundledPackPath);
    const dynamicRules = parsed.rules.filter((r) => r.category === "dynamic");
    expect(dynamicRules.length).toBeGreaterThan(0);
    for (const rule of dynamicRules) {
      expect(rule.requires_semantic, `rule ${rule.id}`).toBe(true);
    }
  });
});

describe("all bundled packs", () => {
  const packFiles = readdirSync(packsDir).filter((f) => f.endsWith(".yaml"));

  it("discovers at least 4 packs (php-inline-sql + 3 agnostic packs)", () => {
    // A broken glob or a deleted pack would otherwise let this suite pass
    // vacuously. Pinned so a regression in the bundle fails loudly.
    expect(packFiles.length).toBeGreaterThanOrEqual(4);
  });

  it.each(packFiles)("%s parses against PackSchema", (file) => {
    expect(() => loadPack(join(packsDir, file))).not.toThrow();
  });

  it.each(packFiles)("%s — every rule regex is ripgrep-compatible", (file) => {
    const parsed = loadPack(join(packsDir, file));
    for (const rule of parsed.rules) {
      if (!rule.regex) continue;
      for (const [label, probe] of RG_INCOMPATIBLE) {
        expect(
          probe.test(rule.regex),
          `pack ${file} rule ${rule.id} uses ${label}, unsupported by ripgrep's default engine`,
        ).toBe(false);
      }
    }
  });

  it.each(packFiles)("%s — every rule has a summary_hint", (file) => {
    const parsed = loadPack(join(packsDir, file));
    for (const rule of parsed.rules) {
      expect(rule.summary_hint, `pack ${file} rule ${rule.id}`).toBeTruthy();
    }
  });

  it.each(packFiles)("%s — every dynamic-category rule sets requires_semantic", (file) => {
    // Generic across all packs: a rule categorised `dynamic` detects
    // injection-prone code and must escalate to the semantic tier.
    const parsed = loadPack(join(packsDir, file));
    for (const rule of parsed.rules) {
      if (rule.category === "dynamic") {
        expect(rule.requires_semantic, `pack ${file} rule ${rule.id}`).toBe(true);
      }
    }
  });
});

describe("agnostic pack: todo-fixme-debt.yaml", () => {
  const pack = loadPack(join(packsDir, "todo-fixme-debt.yaml"));

  it("uses the debt category and todo- id prefix on every rule", () => {
    for (const rule of pack.rules) {
      expect(rule.category, rule.id).toBe("debt");
      expect(rule.id.startsWith("todo-"), rule.id).toBe(true);
    }
  });

  // One known-positive per rule: the rule's regex MUST match it.
  const positives: Record<string, string> = {
    "todo-marker": "// TODO: extract this into a helper",
    "todo-fixme": "# FIXME this breaks on empty input",
    "todo-hack": "/* HACK: relies on insertion order */",
    "todo-xxx": "// XXX revisit before release",
    "todo-debt": "// DEBT: duplicated validation logic",
  };

  it("every rule matches its known-positive fixture", () => {
    for (const rule of pack.rules) {
      const fixture = positives[rule.id];
      expect(fixture, `no fixture for ${rule.id}`).toBeDefined();
      expect(
        compilePackRegex(rule.regex as string).test(fixture),
        `rule ${rule.id} should match its positive fixture`,
      ).toBe(true);
    }
  });

  it("does not fire on a known false-positive", () => {
    // `0xXXXX` is a hex literal, not an XXX marker; `HACKATHON` and `TODOS`
    // are longer words. `\b` anchoring must keep all rules silent here.
    const negatives = ["const mask = 0xXXXX;", "register for the HACKATHON", "load TODOS list"];
    for (const negative of negatives) {
      for (const rule of pack.rules) {
        expect(
          compilePackRegex(rule.regex as string).test(negative),
          `rule ${rule.id} false-matched "${negative}"`,
        ).toBe(false);
      }
    }
  });
});

describe("agnostic pack: deprecated-api-markers.yaml", () => {
  const pack = loadPack(join(packsDir, "deprecated-api-markers.yaml"));

  it("uses the deprecation category and deprecated- id prefix on every rule", () => {
    for (const rule of pack.rules) {
      expect(rule.category, rule.id).toBe("deprecation");
      expect(rule.id.startsWith("deprecated-"), rule.id).toBe(true);
    }
  });

  const positives: Record<string, string> = {
    "deprecated-doc-tag": " * @deprecated use fetchUser() instead",
    "deprecated-java-annotation": "@Deprecated public void oldApi() {}",
    "deprecated-rust-attribute": '#[deprecated(since = "1.2.0")]',
    "deprecated-python-warning": 'warnings.warn("old", DeprecationWarning)',
    "deprecated-dotnet-obsolete": '[Obsolete("Use NewApi")]',
  };

  it("every rule matches its known-positive fixture", () => {
    for (const rule of pack.rules) {
      const fixture = positives[rule.id];
      expect(fixture, `no fixture for ${rule.id}`).toBeDefined();
      expect(
        compilePackRegex(rule.regex as string).test(fixture),
        `rule ${rule.id} should match its positive fixture`,
      ).toBe(true);
    }
  });

  it("does not fire on marker-free prose", () => {
    // The patterns are anchored to actual markers (`@deprecated`, brackets,
    // the warning class name) — plain English about deprecation must not match.
    const negatives = [
      "// this function is not deprecated, leave it",
      "the obsolete plan was abandoned years ago",
    ];
    for (const negative of negatives) {
      for (const rule of pack.rules) {
        expect(
          compilePackRegex(rule.regex as string).test(negative),
          `rule ${rule.id} false-matched "${negative}"`,
        ).toBe(false);
      }
    }
  });

  it("the [Obsolete rule does not prefix-match unrelated attributes", () => {
    // `\[Obsolete` alone would false-match `[ObsoleteHelper]`; the trailing
    // char class requires `]`, `(`, or whitespace right after `Obsolete`.
    const obsoleteRule = pack.rules.find((r) => r.id === "deprecated-dotnet-obsolete");
    expect(obsoleteRule, "deprecated-dotnet-obsolete rule missing").toBeDefined();
    expect(
      compilePackRegex(obsoleteRule!.regex as string).test('[ObsoleteHelper("x")]'),
      "deprecated-dotnet-obsolete should not match [ObsoleteHelper(...)]",
    ).toBe(false);
  });
});

describe("agnostic pack: debug-leftovers.yaml", () => {
  const pack = loadPack(join(packsDir, "debug-leftovers.yaml"));

  it("uses the debug category and debug- id prefix on every rule", () => {
    for (const rule of pack.rules) {
      expect(rule.category, rule.id).toBe("debug");
      expect(rule.id.startsWith("debug-"), rule.id).toBe(true);
    }
  });

  it("flags the variable-argument rule with requires_semantic", () => {
    // A debug call dumping a bare variable can leak a secret — Haiku-tier
    // classification is unsafe, so this rule must escalate.
    const varRule = pack.rules.find((r) => r.id === "debug-variable-argument");
    expect(varRule, "debug-variable-argument rule missing").toBeDefined();
    expect(varRule?.requires_semantic).toBe(true);
  });

  it("excludes test directories", () => {
    // Debug calls inside tests are intentional; the pack must exclude them.
    for (const glob of ["**/test/**", "**/tests/**", "**/*.test.*", "**/*.spec.*"]) {
      expect(pack.exclude_patterns, `missing exclude ${glob}`).toContain(glob);
    }
  });

  const positives: Record<string, string> = {
    "debug-console-call": 'console.log("hello world")',
    "debug-print-call": 'print("debug value")',
    "debug-php-dump": "var_dump($result);",
    "debug-java-stdout": 'System.out.println("trace");',
    "debug-go-fmt-print": 'fmt.Println("checkpoint")',
    "debug-rust-ruby-macro": "dbg!(42);",
    "debug-variable-argument": "console.log(token)",
  };

  it("every rule matches its known-positive fixture", () => {
    for (const rule of pack.rules) {
      const fixture = positives[rule.id];
      expect(fixture, `no fixture for ${rule.id}`).toBeDefined();
      expect(
        compilePackRegex(rule.regex as string).test(fixture),
        `rule ${rule.id} should match its positive fixture`,
      ).toBe(true);
    }
  });

  it("variable-argument rule matches Java System.out.println of a variable", () => {
    // The variable-argument escalation must cover `System.out.println` (a call
    // form named in the pack header), not just the JS/Python/Go idioms.
    const varRule = pack.rules.find((r) => r.id === "debug-variable-argument");
    expect(varRule, "debug-variable-argument rule missing").toBeDefined();
    expect(
      compilePackRegex(varRule!.regex as string).test("System.out.println(token);"),
      "debug-variable-argument should match System.out.println(token)",
    ).toBe(true);
  });

  it("does not fire on a known false-positive", () => {
    // `sprint` / `pprint` are not `print(` calls; a comment naming console.log
    // without invoking it should also stay silent for the literal-call rules.
    const negatives = ["const s = sprint(buf);", "// remember to remove every consoleLog later"];
    for (const negative of negatives) {
      for (const rule of pack.rules) {
        expect(
          compilePackRegex(rule.regex as string).test(negative),
          `rule ${rule.id} false-matched "${negative}"`,
        ).toBe(false);
      }
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
