/**
 * Language detection from a list of changed file paths. Used by
 * `compose_squad_workflow` to surface `detected_languages` so that
 * `compose_advisory_bundle` can pick the right language-specific agent
 * supplements (`agents/<name>.langs/<lang>.md`).
 *
 * Pure parsing — no I/O, no subprocess. Extension-based primary detection
 * with no content sniff. Framework detection is intentionally OUT OF SCOPE
 * here; it's already partially carried by `CONTENT_SIGNALS` in
 * `ownership-matrix.ts` for agent selection and adding a second layer would
 * duplicate maintenance. If framework granularity is needed later, extend
 * this module with an optional `frameworks` field rather than coupling it to
 * the existing signal pipeline.
 *
 * Conventions:
 *  - Test files (`.test.ts`, `.spec.tsx`, `_test.go`) count toward their
 *    base language. A `.test.ts` is TypeScript for our purposes.
 *  - Config / data files (`.json`, `.yaml`, `.toml`, `.md`, `.txt`) are
 *    intentionally NOT mapped to any Language — they don't change the
 *    language profile of a PR that's "TS + some YAML". Returned as
 *    `unrecognised` so callers can surface the share for QA telemetry.
 *  - Multi-dot extensions (`.d.ts`, `.test.ts`) strip the inner suffix and
 *    match on the trailing extension only.
 */

/**
 * Canonical language identifier. Stable contract — the strings appear in
 * `agents/<name>.langs/<lang>.md` filenames, so renaming any of these is a
 * breaking change for the on-disk supplement layout.
 */
export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "cpp"
  | "c";

export const LANGUAGES: readonly Language[] = [
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "csharp",
  "ruby",
  "php",
  "swift",
  "cpp",
  "c",
] as const;

/**
 * File-extension → language mapping. Multi-extension shapes like `.test.ts`
 * trip the trailing `.ts` after `stripTestSuffix`.
 */
const EXTENSION_MAP: Record<string, Language> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  c: "c",
  h: "c",
};

export interface LanguageDetection {
  /**
   * Single most-prevalent language (by file count) in `changed_files`, or
   * `null` when nothing recognised matched. Ties broken by `LANGUAGES`
   * declaration order for determinism.
   */
  primary: Language | null;
  /**
   * Every language that had ≥1 changed file. Empty when nothing matched.
   * Declaration order (matches `LANGUAGES`).
   */
  all: Language[];
  /**
   * Per-language file lists. Empty arrays are pruned — only present languages
   * appear as keys. Caller can use this for per-agent slicing if a future
   * supplement is scoped by language.
   */
  files_by_language: Partial<Record<Language, string[]>>;
  /**
   * Files that did NOT match any extension in `EXTENSION_MAP`. Useful for
   * telemetry ("23% of this PR is in unrecognised extensions"). Not used by
   * downstream language-aware dispatch.
   */
  unrecognised: string[];
  /**
   * Confidence heuristic:
   *  - `high`: ≥80% of recognised files in one language
   *  - `medium`: 50-80% in one language
   *  - `low`: <50% in any language (highly mixed) OR ≤2 total recognised files
   *  - `none`: nothing recognised
   *
   * Caller can use this to decide whether to include language supplements
   * (high/medium) or fall back to the language-agnostic core (low/none).
   */
  confidence: "high" | "medium" | "low" | "none";
}

/**
 * Detect languages from a list of workspace-relative file paths.
 *
 * Pure function. Deterministic. Safe to call on any string array — no fs
 * access. Empty input returns the empty-result shape (primary=null, all=[]).
 */
export function detectLanguages(files: readonly string[]): LanguageDetection {
  const counts = new Map<Language, number>();
  const filesByLang: Partial<Record<Language, string[]>> = {};
  const unrecognised: string[] = [];

  for (const file of files) {
    if (typeof file !== "string" || file.length === 0) continue;
    const lang = classifyByExtension(file);
    if (lang === null) {
      unrecognised.push(file);
      continue;
    }
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
    const bucket = filesByLang[lang] ?? [];
    bucket.push(file);
    filesByLang[lang] = bucket;
  }

  const recognisedTotal = Array.from(counts.values()).reduce((acc, n) => acc + n, 0);
  if (recognisedTotal === 0) {
    return {
      primary: null,
      all: [],
      files_by_language: {},
      unrecognised,
      confidence: "none",
    };
  }

  // Ties broken by LANGUAGES declaration order — iterate that array first.
  let primary: Language | null = null;
  let primaryCount = 0;
  for (const lang of LANGUAGES) {
    const n = counts.get(lang) ?? 0;
    if (n > primaryCount) {
      primary = lang;
      primaryCount = n;
    }
  }

  const all = LANGUAGES.filter((l) => (counts.get(l) ?? 0) > 0);

  // Confidence: ratio of primary language to total recognised. ≤2 files = low.
  let confidence: LanguageDetection["confidence"];
  if (recognisedTotal <= 2) {
    confidence = "low";
  } else {
    const ratio = primaryCount / recognisedTotal;
    if (ratio >= 0.8) confidence = "high";
    else if (ratio >= 0.5) confidence = "medium";
    else confidence = "low";
  }

  return {
    primary,
    all,
    files_by_language: filesByLang,
    unrecognised,
    confidence,
  };
}

/**
 * Map a single file path to a language by extension, returning null when
 * the extension is not in `EXTENSION_MAP`.
 *
 * Strips `.test.<ext>` / `.spec.<ext>` / `.stories.<ext>` / `.d.<ext>` so a
 * `foo.test.ts` is classified by its trailing `.ts`. Without this, a TS
 * test heavy PR would skew toward an imaginary "test" pseudo-language.
 *
 * Exported for tests; not for general use.
 */
export function classifyByExtension(file: string): Language | null {
  // Drop everything up to the last separator. We want only the basename.
  const lastSep = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const basename = lastSep >= 0 ? file.slice(lastSep + 1) : file;
  if (basename.length === 0 || basename.startsWith(".")) {
    // Dotfile (.gitignore, .eslintrc) — no useful language signal.
    return null;
  }

  // Strip well-known test/type/story suffix chains. The capture group ($1)
  // is the inner suffix (test|spec|stories|d) we drop; ($2) is the trailing
  // extension we keep. Replacement glues the basename's prefix back to the
  // extension as `.<ext>`.
  //
  // Examples:
  //   foo.test.ts    → foo.ts
  //   bar.spec.tsx   → bar.tsx
  //   types.d.ts     → types.ts
  //   Component.stories.tsx → Component.tsx
  const stripped = basename.replace(/\.(test|spec|stories|d)\.([A-Za-z0-9]+)$/i, ".$2");

  // Pick the LAST dot in the (possibly stripped) name.
  const lastDot = stripped.lastIndexOf(".");
  if (lastDot < 0 || lastDot === stripped.length - 1) return null;
  const ext = stripped.slice(lastDot + 1).toLowerCase();

  return EXTENSION_MAP[ext] ?? null;
}
