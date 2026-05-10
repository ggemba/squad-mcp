// Flat config (ESLint 9). Minimal ruleset: type-aware checks for src/, looser
// rules for tools/*.mjs and tests/*. The point is to catch real issues without
// reformatting battles — Prettier owns format, ESLint owns logic.

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".squad/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Surfaces accidental `any` introductions but allows the explicit casts
      // we need for some MCP SDK boundaries.
      "@typescript-eslint/no-explicit-any": "warn",
      // Unused imports / vars get flagged; underscore-prefixed allowed.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // `void someExpr` is fine — used in select-squad.ts as a no-op marker.
      "@typescript-eslint/no-meaningless-void-operator": "off",
    },
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["tools/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
