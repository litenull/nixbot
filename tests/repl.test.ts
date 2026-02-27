import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const BASH_BLOCK_PATTERN = /```bash\n([\s\S]*?)```/g;

function extractBashBlocks(text: string): string[] {
  const blocks: string[] = [];
  let match;
  const pattern = new RegExp(BASH_BLOCK_PATTERN.source, "g");
  
  while ((match = pattern.exec(text)) !== null) {
    const cmd = match[1].trim();
    if (cmd) blocks.push(cmd);
  }
  return blocks;
}

function truncateOutput(output: string, maxLength = 2000): string {
  if (output.length > maxLength) {
    return output.slice(0, maxLength) + "\n... (truncated)";
  }
  return output;
}

const TEST_DIR = path.join(os.tmpdir(), `nixbot-repl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

await describe("repl utilities", async () => {
  
  await describe("extractBashBlocks", async () => {
    
    await it("extracts single bash block", async () => {
      const text = "Here's a command:\n```bash\necho hello\n```\nDone.";
      const blocks = extractBashBlocks(text);
      assert.deepStrictEqual(blocks, ["echo hello"]);
    });
    
    await it("extracts multiple bash blocks", async () => {
      const text = "First:\n```bash\necho one\n```\nSecond:\n```bash\necho two\n```";
      const blocks = extractBashBlocks(text);
      assert.deepStrictEqual(blocks, ["echo one", "echo two"]);
    });
    
    await it("handles multiline commands", async () => {
      const text = "```bash\ncurl -X POST \\\n  -H 'Content-Type: json' \\\n  https://api.example.com\n```";
      const blocks = extractBashBlocks(text);
      assert.strictEqual(blocks.length, 1);
      assert.ok(blocks[0].includes("curl"));
      assert.ok(blocks[0].includes("-X POST"));
    });
    
    await it("ignores non-bash code blocks", async () => {
      const text = "```json\n{\"key\": \"value\"}\n```\n```bash\necho hello\n```";
      const blocks = extractBashBlocks(text);
      assert.deepStrictEqual(blocks, ["echo hello"]);
    });
    
    await it("returns empty array when no bash blocks", async () => {
      const text = "Just some text without code blocks.";
      const blocks = extractBashBlocks(text);
      assert.deepStrictEqual(blocks, []);
    });
    
    await it("handles empty bash block", async () => {
      const text = "```bash\n\n```";
      const blocks = extractBashBlocks(text);
      assert.deepStrictEqual(blocks, []);
    });
    
    await it("handles whitespace-only bash block", async () => {
      const text = "```bash\n   \n```";
      const blocks = extractBashBlocks(text);
      assert.deepStrictEqual(blocks, []);
    });
    
    await it("extracts command with environment variables", async () => {
      const text = "```bash\ncurl -H \"Authorization: Bearer $API_TOKEN\" https://api.example.com\n```";
      const blocks = extractBashBlocks(text);
      assert.strictEqual(blocks.length, 1);
      assert.ok(blocks[0].includes("$API_TOKEN"));
    });
    
    await it("extracts git commands", async () => {
      const text = "```bash\ngit clone https://github.com/user/repo.git\ncd repo\nnpm install\n```";
      const blocks = extractBashBlocks(text);
      assert.strictEqual(blocks.length, 1);
      assert.ok(blocks[0].includes("git clone"));
      assert.ok(blocks[0].includes("npm install"));
    });
  });
  
  await describe("truncateOutput", async () => {
    
    await it("returns short output unchanged", async () => {
      const output = "hello world";
      const result = truncateOutput(output);
      assert.strictEqual(result, "hello world");
    });
    
    await it("truncates long output", async () => {
      const output = "x".repeat(3000);
      const result = truncateOutput(output);
      assert.ok(result.length < 3000);
      assert.ok(result.endsWith("... (truncated)"));
    });
    
    await it("preserves output at exactly max length", async () => {
      const output = "x".repeat(2000);
      const result = truncateOutput(output);
      assert.strictEqual(result, output);
    });
    
    await it("uses custom max length", async () => {
      const output = "x".repeat(100);
      const result = truncateOutput(output, 50);
      assert.ok(result.length < 100);
      assert.ok(result.endsWith("... (truncated)"));
    });
    
    await it("handles empty output", async () => {
      const result = truncateOutput("");
      assert.strictEqual(result, "");
    });
  });
  
  await describe("credential integration", async () => {
    
    await beforeEach(() => {
      fs.mkdirSync(TEST_DIR, { recursive: true });
      process.env.NIXBOT_CRED_DIR = TEST_DIR;
    });
    
    await afterEach(() => {
      delete process.env.NIXBOT_CRED_DIR;
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    });
    
    await it("detects credentials in extracted commands", async () => {
      const { detectRequiredCreds } = await import("../src/credentials.js");
      const text = "```bash\ncurl -H \"X-Token: $SECRET_TOKEN\" https://api.example.com\n```";
      const blocks = extractBashBlocks(text);
      const vars = detectRequiredCreds(blocks[0]);
      assert.deepStrictEqual(vars, ["SECRET_TOKEN"]);
    });
    
    await it("detects multiple credentials in command", async () => {
      const { detectRequiredCreds } = await import("../src/credentials.js");
      const text = "```bash\ngit push https://$GITHUB_TOKEN@github.com/$REPO.git\n```";
      const blocks = extractBashBlocks(text);
      const vars = detectRequiredCreds(blocks[0]);
      assert.deepStrictEqual(vars.sort(), ["GITHUB_TOKEN", "REPO"].sort());
    });
  });
});
