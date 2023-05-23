module.exports = {
  extends: [
    "prettier",
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
  ],

  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],

  ignorePatterns: [
    "dist",
    "coverage",
    "vite.config.ts",
    "vitest.js",
    "tsup.config.ts",
    ".eslintrc.cjs",
  ],

  parserOptions: {
    project: "./tsconfig.json",
  },

  rules: {
    "@typescript-eslint/no-non-null-assertion": "off",
    "one-var": ["warn", "never"],
    "sort-imports": "warn",
  },
};
