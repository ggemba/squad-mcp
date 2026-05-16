import { describe, it, expect } from "vitest";
import {
  detectLanguages,
  classifyByExtension,
  LANGUAGES,
  detectFrameworks,
  FRAMEWORKS,
} from "../src/exec/detect-languages.js";

describe("classifyByExtension", () => {
  it("recognises common extensions", () => {
    expect(classifyByExtension("src/foo.ts")).toBe("typescript");
    expect(classifyByExtension("src/bar.tsx")).toBe("typescript");
    expect(classifyByExtension("src/baz.mts")).toBe("typescript");
    expect(classifyByExtension("src/qux.js")).toBe("javascript");
    expect(classifyByExtension("src/x.py")).toBe("python");
    expect(classifyByExtension("src/y.go")).toBe("go");
    expect(classifyByExtension("src/z.rs")).toBe("rust");
    expect(classifyByExtension("src/a.cs")).toBe("csharp");
    expect(classifyByExtension("Foo.java")).toBe("java");
    expect(classifyByExtension("Bar.kt")).toBe("kotlin");
  });

  it("strips test/spec/stories/d suffixes before extension lookup", () => {
    expect(classifyByExtension("foo.test.ts")).toBe("typescript");
    expect(classifyByExtension("foo.spec.ts")).toBe("typescript");
    expect(classifyByExtension("Component.stories.tsx")).toBe("typescript");
    expect(classifyByExtension("types.d.ts")).toBe("typescript");
    expect(classifyByExtension("module_test.go")).toBe("go"); // go convention via underscore
  });

  it("returns null for unrecognised extensions", () => {
    expect(classifyByExtension("README.md")).toBeNull();
    expect(classifyByExtension("config.yaml")).toBeNull();
    expect(classifyByExtension("Dockerfile")).toBeNull();
    expect(classifyByExtension("Makefile")).toBeNull();
    expect(classifyByExtension("package.json")).toBeNull();
  });

  it("returns null for dotfiles", () => {
    expect(classifyByExtension(".gitignore")).toBeNull();
    expect(classifyByExtension(".eslintrc.js")).toBeNull(); // dotfile pattern wins
  });

  it("handles paths with directory separators (POSIX + Windows)", () => {
    expect(classifyByExtension("src/components/Button.tsx")).toBe("typescript");
    expect(classifyByExtension("src\\components\\Button.tsx")).toBe("typescript");
    expect(classifyByExtension("a/b/c/d/e/f.py")).toBe("python");
  });

  it("returns null for files ending in a dot or with no extension", () => {
    expect(classifyByExtension("src/foo.")).toBeNull();
    expect(classifyByExtension("src/foo")).toBeNull();
  });

  it("is case-insensitive on the extension itself", () => {
    expect(classifyByExtension("Bar.TS")).toBe("typescript");
    expect(classifyByExtension("Foo.PY")).toBe("python");
  });
});

describe("detectLanguages — overall result", () => {
  it("empty input returns empty result", () => {
    const r = detectLanguages([]);
    expect(r.primary).toBeNull();
    expect(r.all).toEqual([]);
    expect(r.files_by_language).toEqual({});
    expect(r.unrecognised).toEqual([]);
    expect(r.confidence).toBe("none");
  });

  it("only unrecognised files returns confidence 'none'", () => {
    const r = detectLanguages(["README.md", "package.json", ".gitignore"]);
    expect(r.primary).toBeNull();
    expect(r.all).toEqual([]);
    expect(r.unrecognised.sort()).toEqual([".gitignore", "README.md", "package.json"]);
    expect(r.confidence).toBe("none");
  });

  it("single file → low confidence (≤ 2 recognised files)", () => {
    const r = detectLanguages(["src/foo.ts"]);
    expect(r.primary).toBe("typescript");
    expect(r.all).toEqual(["typescript"]);
    expect(r.confidence).toBe("low");
  });

  it("uniform single-language PR → high confidence", () => {
    const r = detectLanguages(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
    expect(r.primary).toBe("typescript");
    expect(r.all).toEqual(["typescript"]);
    expect(r.confidence).toBe("high");
  });

  it("mixed primary + secondary → medium confidence", () => {
    // 4 TS, 2 Python = 4/6 = 67% (medium band 50-80%)
    const r = detectLanguages([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "scripts/x.py",
      "scripts/y.py",
    ]);
    expect(r.primary).toBe("typescript");
    expect(r.all.sort()).toEqual(["python", "typescript"]);
    expect(r.confidence).toBe("medium");
  });

  it("highly mixed → low confidence", () => {
    // 1 each of TS, Python, Go, Rust, Java = 1/5 = 20% (low band)
    const r = detectLanguages([
      "src/a.ts",
      "scripts/x.py",
      "cmd/main.go",
      "core/lib.rs",
      "src/Foo.java",
    ]);
    expect(r.confidence).toBe("low");
  });

  it("ties broken by LANGUAGES declaration order (deterministic)", () => {
    // 2 TS, 2 Python — TS comes first in LANGUAGES tuple
    const r = detectLanguages(["a.ts", "b.ts", "x.py", "y.py"]);
    expect(r.primary).toBe("typescript");
  });

  it("populates files_by_language with the right buckets", () => {
    const r = detectLanguages(["a.ts", "b.tsx", "x.py"]);
    expect(r.files_by_language.typescript?.sort()).toEqual(["a.ts", "b.tsx"]);
    expect(r.files_by_language.python).toEqual(["x.py"]);
  });

  it("counts test files toward their base language", () => {
    const r = detectLanguages([
      "src/foo.ts",
      "src/foo.test.ts",
      "src/bar.spec.ts",
      "types/foo.d.ts",
    ]);
    expect(r.primary).toBe("typescript");
    expect(r.files_by_language.typescript?.length).toBe(4);
  });

  it("LANGUAGES tuple is non-empty and stable", () => {
    expect(LANGUAGES.length).toBeGreaterThan(10);
    expect(LANGUAGES).toContain("typescript");
    expect(LANGUAGES).toContain("python");
    expect(LANGUAGES).toContain("csharp");
  });

  it("ignores non-string and empty entries", () => {
    // @ts-expect-error intentional bad input
    const r = detectLanguages(["src/a.ts", null, "", undefined, "src/b.py"]);
    expect(r.files_by_language.typescript).toEqual(["src/a.ts"]);
    expect(r.files_by_language.python).toEqual(["src/b.py"]);
  });
});

describe("detectFrameworks", () => {
  it("detects Vue from .vue files", () => {
    expect(detectFrameworks(["src/App.vue", "src/components/Btn.vue"])).toEqual(["vue"]);
  });

  it("detects Svelte from .svelte files", () => {
    expect(detectFrameworks(["src/App.svelte"])).toEqual(["svelte"]);
  });

  it("detects React from .tsx / .jsx files", () => {
    expect(detectFrameworks(["src/App.tsx"])).toEqual(["react"]);
    expect(detectFrameworks(["src/legacy.jsx"])).toEqual(["react"]);
  });

  it("detects Angular from component-style filenames and angular.json", () => {
    expect(detectFrameworks(["src/app/foo.component.ts"])).toEqual(["angular"]);
    expect(detectFrameworks(["src/app/data.service.ts"])).toEqual(["angular"]);
    expect(detectFrameworks(["angular.json"])).toEqual(["angular"]);
  });

  it("returns empty for plain language files with no framework signal", () => {
    expect(detectFrameworks(["src/lib.ts", "src/util.py", "cmd/main.go"])).toEqual([]);
  });

  it("returns multiple frameworks in FRAMEWORKS declaration order", () => {
    const r = detectFrameworks(["src/App.svelte", "src/Widget.tsx", "src/Page.vue"]);
    expect(r).toEqual(["react", "vue", "svelte"]);
  });

  it("empty input returns empty array", () => {
    expect(detectFrameworks([])).toEqual([]);
  });

  it("is case-insensitive and handles path separators", () => {
    expect(detectFrameworks(["SRC\\App.VUE"])).toEqual(["vue"]);
    expect(detectFrameworks(["a/b/c/Foo.Component.TS"])).toEqual(["angular"]);
  });

  it("ignores non-string and empty entries", () => {
    // @ts-expect-error intentional bad input
    expect(detectFrameworks(["src/App.vue", null, "", undefined])).toEqual(["vue"]);
  });

  it("FRAMEWORKS tuple is the stable contract", () => {
    expect(FRAMEWORKS).toEqual(["react", "vue", "angular", "svelte"]);
  });
});
