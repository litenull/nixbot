import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { initGroupsTable, registerGroup, getHistory } from "../src/groups.js";
import { initCronTable } from "../src/cron.js";
import { initTapeTable } from "../src/tape.js";
import { processMessage } from "../src/orchestrator/message-processor.js";

function isAddressInfo(addr: string | AddressInfo | null): addr is AddressInfo {
  return addr !== null && typeof addr === "object" && "port" in addr;
}

let db: Database.Database;
let tempDir: string;
let groupsDir: string;
let llmServer: ReturnType<typeof createServer>;
let llmPort: number;
let fakeSandboxBin: string;
let testBinDir: string;

let llmCallCount = 0;
let llmResponses: string[] = [];
let capturedMessages: Array<Array<{ role: string; content: string }>> = [];

function resetMocks() {
  llmCallCount = 0;
  llmResponses = [];
  capturedMessages = [];
}

function pushResponse(content: string) {
  llmResponses.push(JSON.stringify({ choices: [{ message: { content } }] }));
}

before(async () => {
  testBinDir = mkdtempSync(join(tmpdir(), "nixbot-mt-bin-"));
  fakeSandboxBin = join(testBinDir, "fake-sandbox");
  writeFileSync(fakeSandboxBin, '#!/bin/sh\neval "$1"\n');
  chmodSync(fakeSandboxBin, 0o755);

  llmServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      capturedMessages.push(parsed.messages || []);

      const responseIdx = llmCallCount;
      if (responseIdx >= llmResponses.length) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no more mock responses" }));
        return;
      }

      const responseBody = llmResponses[responseIdx];

      // Simulate HTTP errors for non-JSON responses
      if (responseBody.startsWith("HTTP_")) {
        const statusCode = parseInt(responseBody.split("_")[1], 10);
        res.writeHead(statusCode || 500, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: "simulated error" }));
        llmCallCount++;
        return;
      }

      llmCallCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(responseBody);
    });
  });

  await new Promise<void>((resolve) => llmServer.listen(0, resolve));
  const address = llmServer.address();
  assert.ok(isAddressInfo(address));
  llmPort = address.port;
});

after(async () => {
  await new Promise<void>((resolve) => llmServer.close(() => resolve()));
  rmSync(testBinDir, { recursive: true, force: true });
});

const llmConfig = () => ({
  provider: "openai-compatible" as const,
  apiKey: "test-key",
  model: "test-model",
  baseUrl: `http://localhost:${llmPort}`,
});

const processOpts = () => ({
  sandboxBin: fakeSandboxBin,
});

await describe("multi-turn message processor", async () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nixbot-mt-test-"));
    groupsDir = join(tempDir, "groups");
    mkdirSync(groupsDir, { recursive: true });

    const groupDir = join(groupsDir, "main");
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(join(groupDir, "CLAUDE.md"), "Test context");

    db = new Database(join(tempDir, "test.db"));
    initGroupsTable(db);
    initCronTable(db);
    initTapeTable(db);
    registerGroup(db, "main", join(groupsDir, "main"));

    resetMocks();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  await it("single round: LLM responds with text, no commands", async () => {
    pushResponse("Hello! How can I help?");

    const result = await processMessage(
      db,
      "main",
      "hi",
      llmConfig(),
      processOpts(),
    );

    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("Hello!"));
    assert.strictEqual(llmCallCount, 1);
  });

  await it("single round: LLM runs one command, then stops (no more bash blocks)", async () => {
    pushResponse("Let me check the version.\n\n```bash\necho hello\n```\n");
    pushResponse("The version is displayed. Done!");

    const result = await processMessage(
      db,
      "main",
      "say hi",
      llmConfig(),
      processOpts(),
    );

    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("hello"));
    assert.ok((result as string).includes("Done"));
    assert.strictEqual(llmCallCount, 2);
  });

  await it("multi-turn: LLM runs command, observes output, runs another", async () => {
    pushResponse("Let me check the directory.\n\n```bash\nls /tmp\n```\n");
    pushResponse(
      "Now let me create a file.\n\n```bash\ntouch /tmp/nixbot-test-file\n```\n",
    );
    pushResponse("File created successfully.");

    const result = await processMessage(
      db,
      "main",
      "create a test file",
      llmConfig(),
      processOpts(),
    );

    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("File created successfully"));
    assert.strictEqual(llmCallCount, 3);
    assert.ok(
      capturedMessages[1].some(
        (m) =>
          m.role === "user" && m.content.includes("Tool results for round 1"),
      ),
    );
  });

  await it("multi-turn: LLM fixes a failing command on second round", async () => {
    pushResponse("I'll run the command.\n\n```bash\nexit 1\n```\n");
    pushResponse(
      "That failed. Let me try differently.\n\n```bash\necho success\n```\n",
    );
    pushResponse("All done.");

    const result = await processMessage(
      db,
      "main",
      "do something",
      llmConfig(),
      processOpts(),
    );

    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("success"));
    assert.ok((result as string).includes("All done"));
    assert.strictEqual(llmCallCount, 3);
  });

  await it("respects max tool rounds limit", async () => {
    for (let i = 0; i < 10; i++) {
      pushResponse(`Round ${i + 1}\n\n\`\`\`bash\necho round-${i}\n\`\`\`\n`);
    }

    const result = await processMessage(db, "main", "loop", llmConfig(), {
      sandboxBin: fakeSandboxBin,
      maxToolRounds: 3,
    });

    assert.strictEqual(typeof result, "string");
    assert.strictEqual(llmCallCount, 3);
  });

  await it("stops when LLM responds without bash blocks", async () => {
    pushResponse("Let me check.\n\n```bash\necho first\n```\n");
    pushResponse("I've checked and everything looks good.");

    const result = await processMessage(
      db,
      "main",
      "check things",
      llmConfig(),
      processOpts(),
    );

    assert.strictEqual(typeof result, "string");
    assert.strictEqual(llmCallCount, 2);
    assert.ok((result as string).includes("I've checked"));
  });

  await it("handles multiple bash blocks in a single response", async () => {
    pushResponse(
      "Running two commands.\n\n```bash\necho one\n```\n\n```bash\necho two\n```\n",
    );
    pushResponse("Both commands completed successfully.");

    const result = await processMessage(
      db,
      "main",
      "run two commands",
      llmConfig(),
      processOpts(),
    );

    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("one"));
    assert.ok((result as string).includes("two"));
    assert.ok((result as string).includes("successfully"));
    assert.strictEqual(llmCallCount, 2);
  });

  await it("stores final masked response in database", async () => {
    pushResponse("Here is my answer.");

    await processMessage(db, "main", "hello", llmConfig(), processOpts());

    const history = getHistory(db, "main");
    assert.ok(history.some((m) => m.content.includes("Here is my answer")));
  });

  await it("handles LLM error on first round gracefully", async () => {
    const badConfig = {
      provider: "openai-compatible" as const,
      apiKey: "test",
      model: "m",
      baseUrl: "http://localhost:1",
    };

    const result = await processMessage(
      db,
      "main",
      "hello",
      badConfig,
      processOpts(),
    );

    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("LLM error"));
  });

  await it("handles LLM error mid-loop and returns accumulated response", async () => {
    pushResponse("First round.\n\n```bash\necho round1\n```\n");
    // Second response is a 400 (non-retryable) to fail fast
    llmResponses.push("HTTP_400_ERROR");

    const result = await processMessage(
      db,
      "main",
      "multi",
      llmConfig(),
      processOpts(),
    );

    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("round1"));
    assert.ok((result as string).includes("LLM error"));
  });

  await it("conversation messages include tool results between rounds", async () => {
    pushResponse("Checking.\n\n```bash\necho test-output\n```\n");
    pushResponse("Got it.");

    await processMessage(db, "main", "check", llmConfig(), processOpts());

    assert.ok(capturedMessages.length >= 2);
    const secondCallMessages = capturedMessages[1];
    const toolResultMsg = secondCallMessages.find(
      (m) => m.role === "user" && m.content.includes("Tool results"),
    );
    assert.ok(toolResultMsg);
    assert.ok(toolResultMsg.content.includes("test-output"));
  });

  await it("processes cron commands in final response", async () => {
    pushResponse(
      "Scheduling.\n\n/cron add test-job '0 * * * *' 'Check something'\n",
    );

    const result = await processMessage(
      db,
      "main",
      "schedule a job",
      llmConfig(),
      processOpts(),
    );

    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("Scheduled"));
  });
});
