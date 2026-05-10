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
        // Floor — current pass is well above 80; this catches new code added
        // without tests rather than asking for a one-time spike.
        lines: 80,
        statements: 80,
        functions: 75,
        branches: 70,
      },
    },
  },
});
