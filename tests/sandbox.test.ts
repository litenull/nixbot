import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { runInSandbox, handleLiveFeedback } from "../src/sandbox.js";

// A minimal fake sandbox binary: executes its first argument via sh -c
let testBinDir: string;
let fakeSandboxBin: string;

before(() => {
  // Write fake sandbox script
  testBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "nixbot-sandbox-bin-"));
  fakeSandboxBin = path.join(testBinDir, "fake-sandbox");
  fs.writeFileSync(fakeSandboxBin, "#!/bin/sh\neval \"$1\"\n");
  fs.chmodSync(fakeSandboxBin, 0o755);
});

after(() => {
  fs.rmSync(testBinDir, { recursive: true, force: true });
});

await describe("runInSandbox", async () => {

  await it("captures stdout from command", async () => {
    const result = await runInSandbox(fakeSandboxBin, "test-group", "echo hello");
    assert.strictEqual(result.stdout.trim(), "hello");
    assert.strictEqual(result.code, 0);
  });

  await it("captures stderr from command", async () => {
    const result = await runInSandbox(fakeSandboxBin, "test-group", "echo error >&2");
    assert.ok(result.stderr.includes("error"));
  });

  await it("returns non-zero exit code on failure", async () => {
    const result = await runInSandbox(fakeSandboxBin, "test-group", "exit 42");
    assert.strictEqual(result.code, 42);
  });

  await it("captures multiline output", async () => {
    const result = await runInSandbox(fakeSandboxBin, "test-group", "printf 'line1\\nline2\\nline3\\n'");
    const lines = result.stdout.trim().split("\n");
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0], "line1");
    assert.strictEqual(lines[2], "line3");
  });

  await it("passes WORKSPACE env var to command", async () => {
    const result = await runInSandbox(fakeSandboxBin, "test-group", "echo $WORKSPACE");
    assert.ok(result.stdout.includes("nixbot"));
    assert.ok(result.stdout.includes("test-group"));
  });

  await it("creates workspace directory", async () => {
    await runInSandbox(fakeSandboxBin, "workspace-test-group", "echo ok");
    const expectedPath = path.join(process.env.HOME || "/tmp", ".bwrapper", "nixbot", "groups", "workspace-test-group");
    assert.ok(fs.existsSync(expectedPath));
  });

  await it("filters blocked env vars", async () => {
    const savedKey = process.env.MY_API_KEY;
    process.env.MY_API_KEY = "should-not-leak";
    try {
      const result = await runInSandbox(fakeSandboxBin, "test-group", "echo ${MY_API_KEY:-not-set}");
      assert.ok(!result.stdout.includes("should-not-leak"));
    } finally {
      if (savedKey === undefined) delete process.env.MY_API_KEY;
      else process.env.MY_API_KEY = savedKey;
    }
  });

  await it("times out and kills long-running command", async () => {
    const result = await runInSandbox(fakeSandboxBin, "test-group", "sleep 60", 100);
    // Should complete (via timeout kill) well within test timeout
    assert.ok(result.stderr.includes("[Timeout]") || result.code !== 0);
  });
});

await describe("handleLiveFeedback", async () => {
  let llmServer: ReturnType<typeof createServer>;
  let llmPort: number;
  let llmResponseBody = "";

  before(async () => {
    llmServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(llmResponseBody);
    });
    await new Promise<void>(resolve => llmServer.listen(0, resolve));
    llmPort = (llmServer.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>(resolve => llmServer.close(() => resolve()));
  });

  const llmConfig = () => ({
    provider: "openai-compatible" as const,
    apiKey: "test-key",
    model: "test-model",
    baseUrl: `http://localhost:${llmPort}`,
  });

  await it("returns LLM response on success", async () => {
    llmResponseBody = JSON.stringify({ choices: [{ message: { content: "Still working on it!" } }] });

    const result = await handleLiveFeedback(
      "How is it going?",
      { command: "curl https://example.com", partialOutput: "Connecting..." },
      { originalTask: "fetch the page", llmConfig: llmConfig(), group: "main" },
    );

    assert.strictEqual(result, "Still working on it!");
  });

  await it("returns fallback message on LLM error", async () => {
    const result = await handleLiveFeedback(
      "Are you there?",
      { command: "echo test", partialOutput: "" },
      {
        originalTask: "do something",
        llmConfig: { provider: "openai-compatible", apiKey: "test", model: "m", baseUrl: "http://localhost:1" },
        group: "main",
      },
    );

    assert.ok(result.includes("Acknowledged:"));
    assert.ok(result.includes("Are you there"));
  });

  await it("includes context in supervisor prompt", async () => {
    let capturedBody = "";
    const capturingServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c; });
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "got it" } }] }));
      });
    });
    const capPort = await new Promise<number>(resolve => {
      capturingServer.listen(0, () => resolve((capturingServer.address() as { port: number }).port));
    });

    await handleLiveFeedback(
      "what's happening?",
      { command: "npm install", partialOutput: "fetching packages..." },
      {
        originalTask: "install dependencies",
        llmConfig: { provider: "openai-compatible", apiKey: "test", model: "m", baseUrl: `http://localhost:${capPort}` },
        group: "work",
      },
    );

    capturingServer.close();
    const body = JSON.parse(capturedBody);
    const systemMsg = body.messages.find((m: { role: string }) => m.role === "system");
    assert.ok(systemMsg.content.includes("install dependencies"));
    assert.ok(systemMsg.content.includes("npm install"));
    assert.ok(systemMsg.content.includes("fetching packages"));
  });
});
