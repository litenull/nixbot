# Testing Patterns

**Analysis Date:** 2026-03-09

## Test Framework

**Runner:** Node.js built-in test runner (`node:test`)

- No external test framework (Jest, Mocha, etc.)
- Native TypeScript support via `tsx`

**Assertion Library:** Node.js built-in `node:assert`

- Uses `strict` mode: `import assert from "node:assert"`
- Both `assert` and `strict as assert` patterns used

**Config:** No separate test config file

- Tests run via: `tsx --test tests/*.test.ts`
- Defined in `package.json` scripts

**Run Commands:**

```bash
npm test                 # Run all tests
npm run test -- --test-name-pattern="credentials"  # Filter tests
```

## Test File Organization

**Location:** `tests/` directory, co-located by feature

**Naming:**

- `tests/{feature}.test.ts` - Unit tests for specific feature
- `tests/integration.test.ts` - Cross-component integration tests

**Structure:**

```
tests/
├── credentials.test.ts      # Credential encryption/masking
├── sandbox.test.ts          # Sandbox execution
├── sandbox-filter.test.ts   # Environment filtering
├── cron.test.ts             # Cron job scheduling
├── tape.test.ts             # Tape logging
├── database.test.ts         # Groups/messages database
├── input-buffer.test.ts     # Input buffering
├── mid-task-input.test.ts   # Pause/cancel flow
├── repl.test.ts             # REPL utilities
├── repl-utils.test.ts       # Extended REPL utils
├── llm.test.ts              # LLM API integration
├── telegram-plugin.test.ts  # Telegram plugin
├── plugins-manager.test.ts  # Plugin system
├── config.test.ts           # Configuration
└── integration.test.ts      # Full workflows
```

## Test Structure

**Suite Organization:**

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

await describe("feature name", async () => {
  await describe("sub-feature", async () => {
    await it("should do something", async () => {
      // Arrange
      const input = "test";

      // Act
      const result = functionUnderTest(input);

      // Assert
      assert.strictEqual(result, "expected");
    });
  });
});
```

**Patterns:**

- Top-level `await describe()` for async test loading
- Nested `describe` blocks for grouping related tests
- `it()` for individual test cases
- Both `async` and sync test functions supported

## Setup and Teardown

**Pattern:**

```typescript
let db: Database.Database;
let tempDir: string;

await beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "test-prefix-"));
  db = new Database(join(tempDir, "test.db"));
});

await afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
```

**Common Setup:**

- Create temp directories with unique prefixes
- Initialize database tables
- Set environment variables
- Import modules fresh with cache-busting: `import("../src/config.js?cache=${uniqueId}")`

**Cleanup:**

- Close database connections
- Remove temp directories
- Restore original environment
- Reset global state (credentials, paths)

## Mocking

**Approach:** Minimal mocking, prefer real implementations

**HTTP Mocking:**

```typescript
import { createServer } from "http";

let testServer: ReturnType<typeof createServer>;
let testPort: number;

before(async () => {
  testServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "test" } }] }));
  });
  await new Promise<void>((resolve) => testServer.listen(0, resolve));
  testPort = (testServer.address() as AddressInfo).port;
});
```

**Filesystem Mocking:**

- Create actual temp directories/files
- No virtual filesystem mocks

**Process Mocking:**

- Use fake sandbox binary written to temp

## Fixtures and Factories

**Test Data:**

- Inline test data within test cases
- Helper functions for complex setup

**Location:** Inline within test files, no separate fixtures directory

## Coverage

**Requirements:** Not enforced

**View Coverage:**

```bash
# No built-in coverage command
# Can use c8 or node --experimental-test-coverage
```

## Test Types

**Unit Tests:**

- Single function/class in isolation
- Fast execution (< 100ms per test)
- Examples: `credentials.test.ts`, `input-buffer.test.ts`

**Integration Tests:**

- Multiple components together
- Real database operations
- Examples: `integration.test.ts`, `sandbox.test.ts`

**E2E Tests:**

- Not present in this codebase
- Would require full system setup

## Common Patterns

**Database Tests:**

```typescript
await describe("database operations", async () => {
  let db: Database.Database;

  await beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "db-test-"));
    db = new Database(join(tempDir, "test.db"));
    initTable(db);
  });

  await afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true });
  });

  await it("should create record", async () => {
    addRecord(db, "data");
    const result = db.prepare("SELECT * FROM table").get();
    assert.ok(result);
  });
});
```

**Type Guard Tests:**

```typescript
await it("validates correct type", async () => {
  const row = { count: 5 };
  assert.strictEqual(isCountRow(row), true);
});

await it("rejects invalid type", async () => {
  const row = { count: "not a number" };
  assert.strictEqual(isCountRow(row), false);
});
```

**Async Testing:**

```typescript
await it("handles async operation", async () => {
  const result = await asyncFunction();
  assert.strictEqual(result, "expected");
});

await it("rejects on error", async () => {
  await assert.rejects(() => failingAsyncFunction(), /expected error message/);
});
```

**Error Testing:**

```typescript
await it("throws on invalid input", async () => {
  assert.throws(() => functionWithValidation("invalid"), /Validation error/);
});
```

## Test Utilities

**Environment Helpers:**

```typescript
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
```

**Type Guards:**

```typescript
function isAddressInfo(addr: string | AddressInfo | null): addr is AddressInfo {
  return addr !== null && typeof addr === "object" && "port" in addr;
}
```

## Test Count Summary

| File                    | Lines     | Test Count |
| ----------------------- | --------- | ---------- |
| credentials.test.ts     | 332       | ~20        |
| sandbox.test.ts         | 235       | ~10        |
| sandbox-filter.test.ts  | 197       | ~15        |
| cron.test.ts            | 418       | ~25        |
| tape.test.ts            | 336       | ~18        |
| database.test.ts        | 217       | ~15        |
| input-buffer.test.ts    | 189       | ~16        |
| mid-task-input.test.ts  | 220       | ~14        |
| repl.test.ts            | 144       | ~10        |
| repl-utils.test.ts      | 272       | ~20        |
| llm.test.ts             | 712       | ~35        |
| telegram-plugin.test.ts | 63        | ~8         |
| plugins-manager.test.ts | 99        | ~5         |
| config.test.ts          | 107       | ~10        |
| integration.test.ts     | 288       | ~12        |
| **Total**               | **~3827** | **~233**   |

---

_Testing analysis: 2026-03-09_
