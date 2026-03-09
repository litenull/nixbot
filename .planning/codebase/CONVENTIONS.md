# Coding Conventions

**Analysis Date:** 2026-03-09

## Naming Patterns

**Files:**

- Source files use kebab-case: `input-buffer.ts`, `credentials.ts`
- Test files use `.test.ts` suffix: `credentials.test.ts`, `sandbox.test.ts`
- Utility files are named by purpose: `utils.ts`, `config.ts`

**Functions:**

- camelCase for all functions: `extractBashBlocks()`, `getErrorMessage()`
- Async functions prefixed with async keyword: `async function processMessage()`
- Predicate functions use "is" prefix: `isBlockedEnvVar()`, `isCountRow()`
- Type guards follow pattern `isTypeName`: `isTapeRow()`, `isCronJobRow()`

**Variables:**

- camelCase for variables: `sandboxBin`, `inputBuffer`
- Constants use UPPER_SNAKE_CASE: `DEFAULT_TIMEOUT_MS`, `TAPE_RETENTION_DAYS`
- Private class members: private keyword (not underscore prefix)
- Unused parameters prefixed with underscore: `argsIgnorePattern: "^_"` (ESLint rule)

**Types:**

- Interfaces use PascalCase: `SandboxResult`, `TapeEntry`
- Type guards return `value is Type`: `row is CronJobRow`
- Optional properties use `?`: `scope?: string`
- Readonly where applicable (implied by const usage)

## Code Style

**Formatting:**

- Prettier configured with:
  - `semi: true`
  - `trailingComma: "all"`
  - `singleQuote: false`
  - `printWidth: 80`
  - `tabWidth: 2`
  - `useTabs: false`

**Linting:**

- ESLint with TypeScript plugin
- Rules:
  - `@typescript-eslint/no-explicit-any: "warn"`
  - `@typescript-eslint/no-unused-vars: ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]`
  - `@typescript-eslint/prefer-nullish-coalescing: "off"`

## Import Organization

**Order:**

1. Node.js built-ins: `import { spawn } from "child_process"`
2. Third-party packages: `import Database from "better-sqlite3"`
3. Local modules: `import { chat } from "./llm.js"`

**Path Aliases:**

- Use `.js` extension for TypeScript imports (NodeNext module resolution)
- Relative paths for same directory: `./utils.js`
- Parent directory with `../`: `../src/credentials.js`

## Error Handling

**Patterns:**

- Use `getErrorMessage()` utility for unknown error types (`src/utils.ts` lines 45-59)
- Type guards for database rows to validate unknown data
- Try-catch with typed errors:

```typescript
try {
  const data = JSON.parse(res);
} catch (err) {
  const error = err as Error;
  return `LLM error: ${error.message}`;
}
```

## Logging

**Framework:** console with color codes

**Patterns:**

- Prefix with component: `[plugins]`, `[cron]`, `[sandbox]`
- Use ANSI color codes for REPL feedback:
  - `\x1b[32m` - green (success/feedback)
  - `\x1b[36m` - cyan (processing)
  - `\x1b[34m` - blue (supervisor response)
  - `\x1b[35m` - purple (pause)
  - `\x1b[33m` - yellow (cancel/warning)

## Comments

**When to Comment:**

- JSDoc for exported utilities: `src/utils.ts` lines 41-44
- Inline comments for constants explaining purpose
- Section headers for related functions

**JSDoc/TSDoc:**

```typescript
/**
 * Safely extracts an error message from an unknown error value.
 * Handles cases where the error might not be an Error instance.
 */
export function getErrorMessage(err: unknown): string;
```

## Function Design

**Size:** Functions generally under 50 lines, with clear single responsibility

**Parameters:**

- Destructure options objects for named parameters
- Database passed as first parameter for data functions
- Options objects for optional parameters

**Return Values:**

- Explicit return types on exported functions
- Use undefined over null for missing values: `GroupInfo | undefined`
- Result objects for complex returns: `SandboxResult { stdout, stderr, code }`

## Module Design

**Exports:**

- Named exports preferred over default exports
- Export interfaces used by other modules
- Re-export from index where appropriate

**Barrel Files:**

- Not used in this codebase
- Direct imports from source files

## Type Safety

**Strict TypeScript:**

- `strict: true` in `tsconfig.json`
- Type guards for runtime validation of database rows
- Avoid `any` when possible (warned by ESLint)
- Use `unknown` for truly unknown values

**Database Type Guards:**

```typescript
function isCountRow(row: unknown): row is CountRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.count === "number";
}
```

## Constants

**Location:** Top of files or near usage

**Naming:**

- Time-based: `DEFAULT_TIMEOUT_MS`, `TAPE_RETENTION_DAYS`
- Length-based: `KEY_LENGTH = 32`, `IV_LENGTH = 16`
- Feature flags: `DEFAULT_CRON_CHECK_INTERVAL_MS`

---

_Convention analysis: 2026-03-09_
