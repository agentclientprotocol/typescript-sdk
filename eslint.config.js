import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/",
      "dist/",
      "scripts/",
      "coverage/",
      "*.min.js",
      "*.config.js",
      ".github/",
      "src/schema.ts",
      "src/.schema-*/",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
        },
      ],
      "no-console": "off",
      "no-constant-condition": "off",
      // TS checks redeclaration itself (ts2451), and the core rule false-positives
      // on same-name type + value declarations (schema/guards.gen.ts merges a type
      // and a const per extensible union). Matches typescript-eslint's own
      // eslint-recommended override; the TS-aware variant also flags this pattern.
      "no-redeclare": "off",
      "default-case": "error",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
      curly: ["error", "all"],
    },
  },
  prettierConfig,
];
