import { defineConfig } from "vitest/config";

/**
 * Vitest configuration with explicit timeout and coverage thresholds.
 *
 * Coverage gates the runtime modules (src/) where a regression has user
 * impact; tests/, examples/ and tools/*.mjs scripts are excluded. Thresholds
 * are set just below the current measured numbers so a new submission cannot
 * land code that regresses coverage in critical modules.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [
        "src/tools/**/*.ts",
        "src/tasks/**/*.ts",
        "src/learning/**/*.ts",
        "src/util/**/*.ts",
        "src/exec/**/*.ts",
        "src/config/**/*.ts",
        "src/format/**/*.ts",
        "src/observability/**/*.ts",
        "src/resources/**/*.ts",
        "src/prompts/**/*.ts",
        "src/errors.ts",
      ],
      exclude: ["src/index.ts", "**/*.d.ts"],
      thresholds: {
        // Floor — re-calibrated for v1.5 after the v1.5 test cut (64 → 8 test
        // files). The 8 surviving files cover the trust boundaries the squad
        // actually relies on (path-safety, prompt-sanitize, exec-git,
        // atomic-rewrite-jsonl, jsonl-store, runs-store) and land near the
        // floor below. This catches new code that drops coverage further
        // without asking for a re-pad of the deleted suites.
        lines: 40,
        statements: 40,
        functions: 45,
        branches: 60,
      },
    },
  },
});
