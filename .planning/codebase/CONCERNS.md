# Codebase Concerns

**Analysis Date:** 2026-03-09

## Tech Debt

### Large File: repl.ts

- **Issue:** src/repl.ts is 807 lines - handles CLI commands, REPL loop, cron parsing, tape commands
- **Files:** src/repl.ts
- **Impact:** Difficult to navigate and test individual commands
- **Fix approach:** Extract command handlers to separate modules

### Mixed Concerns in repl.ts

- **Issue:** Database operations, LLM integration, command parsing, and UI output all in one file
- **Files:** src/repl.ts lines 80-806
- **Impact:** High coupling makes changes risky
- **Fix approach:** Implement command pattern with separate handlers

### Unused Variable

- **Issue:** \_TAG_LENGTH declared but never used in credentials.ts
- **Files:** src/credentials.ts line 37
- **Impact:** Minor - dead code
- **Fix approach:** Remove or use for validation

## Type Safety Issues

### Use of any Type

- **Issue:** Several instances of any usage bypassing type checking
- **Files:** tests/llm.test.ts lines 213, 486
- **Impact:** Loses TypeScript compile-time guarantees
- **Fix approach:** Define proper interfaces for request/response bodies

### Unchecked Array Access

- **Issue:** Non-null assertion used on array access without bounds check
- **Files:** tests/credentials.test.ts line 221
- **Impact:** Runtime error if array is empty
- **Fix approach:** Add bounds check or use optional chaining with fallback

## Security Considerations

### SQL Injection Risk

- **Issue:** queryTapeLog uses string concatenation for SQL query
- **Files:** src/tape.ts lines 160-195
- **Current mitigation:** Uses parameterized queries for values
- **Recommendations:** Use LIKE with parameter

### Environment Variable Filtering

- **Issue:** Blocklist approach may miss new sensitive patterns
- **Files:** src/sandbox.ts lines 18-28
- **Current mitigation:** Comprehensive regex patterns for common secrets
- **Recommendations:** Consider safelist approach

### Credential Storage

- **Issue:** Encryption key stored in file system
- **Files:** ~/.nixbot/key
- **Current mitigation:** File permissions set to 0o600
- **Risk:** Key file could be backed up or copied inadvertently

## Performance Bottlenecks

### Synchronous File Operations

- **Issue:** loadCredentials uses sync file operations
- **Files:** src/credentials.ts lines 146-190
- **Impact:** Blocks event loop on startup
- **Fix approach:** Acceptable for CLI tool, document this behavior

### Cron Schedule Calculation

- **Issue:** calculateNextRun iterates minute by minute (up to 366 days)
- **Files:** src/cron.ts lines 252-276
- **Impact:** O(n) where n = minutes until next run
- **Fix approach:** Algorithm is correct but inefficient; acceptable for current use

## Fragile Areas

### Process.stdin Raw Mode

- **Issue:** InputBuffer manipulates process.stdin directly
- **Files:** src/input-buffer.ts lines 44-95
- **Why fragile:** Terminal state can get corrupted on crash
- **Safe modification:** Always wrap in try-finally

### LLM Response Parsing

- **Issue:** Regex-based extraction of bash blocks
- **Files:** src/utils.ts lines 7-16
- **Why fragile:** May break with unusual markdown formatting
- **Current test coverage:** Tests exist in tests/repl.test.ts

### Plugin Error Handling

- **Issue:** Plugin failures logged but do not crash system
- **Files:** src/plugins/manager.ts lines 40-49
- **Why fragile:** Silent failures may hide issues
- **Test coverage:** Limited - only tests missing token scenario

## Test Coverage Gaps

### InputBuffer TTY-Dependent Code

- **What is not tested:** enable and disable methods when process.stdin.isTTY is true
- **Files:** src/input-buffer.ts lines 51-94
- **Risk:** Terminal manipulation code has no automated tests
- **Priority:** Medium - would require mocking TTY

### Telegram Plugin Polling Loop

- **What is not tested:** Main polling loop, message handling
- **Files:** src/plugins/telegram.ts lines 171-243
- **Risk:** Network error handling, rate limiting not verified
- **Priority:** Low - integration tests would be complex

### REPL Command Handlers

- **What is not tested:** Most slash command implementations
- **Files:** src/repl.ts lines 446-696
- **Risk:** Command parsing bugs, edge cases in user input
- **Priority:** Medium - would benefit from extracted command handlers

## Missing Critical Features

### No Request Timeouts on LLM Calls

- **Issue:** makeRequest in src/llm.ts has no timeout
- **Impact:** Hanging requests could block indefinitely
- **Fix approach:** Add timeout parameter to makeRequest

### No Retry Logic

- **Issue:** Failed LLM calls or sandbox executions do not retry
- **Impact:** Transient failures fail the entire task
- **Fix approach:** Implement exponential backoff for retryable errors

### Limited Plugin System

- **Issue:** Only one built-in plugin (Telegram)
- **Impact:** Cannot easily extend with custom plugins
- **Fix approach:** Support dynamic plugin loading from npm or local files

## Documentation Gaps

### Missing JSDoc

- **Issue:** Many exported functions lack documentation
- **Files:**
  - src/cron.ts - Most functions undocumented
  - src/tape.ts - Query functions lack parameter docs
  - src/groups.ts - Database operations undocumented
- **Impact:** IDE hints incomplete, harder for contributors
- **Fix approach:** Add JSDoc to all public APIs

## Dependency Concerns

### better-sqlite3 Native Module

- **Risk:** Requires native compilation, may fail on some systems
- **Current:** Works in Nix environment
- **Mitigation:** Nix handles build dependencies

### Node.js Version

- **Issue:** No .nvmrc or engines field specifying Node version
- **Files:** package.json
- **Impact:** May behave differently on different Node versions
- **Fix approach:** Add engines field

---

_Concerns audit: 2026-03-09_
