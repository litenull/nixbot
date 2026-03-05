import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  extractBashBlocks,
  truncateOutput,
  ensureGroupDir,
} from "../src/utils.js";
import { isPauseInput } from "../src/input-buffer.js";

const TEST_DIR = path.join(
  os.tmpdir(),
  `nixbot-repl-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

await describe("repl utilities", async () => {
  await beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  await afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  await describe("ensureGroupDir", async () => {
    await it("creates group directory", async () => {
      const groupsDir = path.join(TEST_DIR, "groups");
      const { groupPath } = ensureGroupDir(groupsDir, "test-group");

      assert.ok(fs.existsSync(groupPath));
      assert.ok(fs.statSync(groupPath).isDirectory());
    });

    await it("creates CLAUDE.md file", async () => {
      const groupsDir = path.join(TEST_DIR, "groups");
      const { claudeMdPath } = ensureGroupDir(groupsDir, "test-group");

      assert.ok(fs.existsSync(claudeMdPath));
      const content = fs.readFileSync(claudeMdPath, "utf-8");
      assert.ok(content.includes("test-group Group"));
    });

    await it("does not overwrite existing CLAUDE.md", async () => {
      const groupsDir = path.join(TEST_DIR, "groups");
      const { claudeMdPath } = ensureGroupDir(groupsDir, "test-group");

      fs.writeFileSync(claudeMdPath, "Custom content");

      ensureGroupDir(groupsDir, "test-group");

      const content = fs.readFileSync(claudeMdPath, "utf-8");
      assert.strictEqual(content, "Custom content");
    });

    await it("handles nested group names", async () => {
      const groupsDir = path.join(TEST_DIR, "groups");
      const { groupPath } = ensureGroupDir(groupsDir, "nested/group/name");

      assert.ok(fs.existsSync(groupPath));
    });

    await it("returns correct paths", async () => {
      const groupsDir = path.join(TEST_DIR, "groups");
      const result = ensureGroupDir(groupsDir, "my-group");

      assert.strictEqual(result.groupPath, path.join(groupsDir, "my-group"));
      assert.strictEqual(
        result.claudeMdPath,
        path.join(groupsDir, "my-group", "CLAUDE.md"),
      );
    });
  });

  await describe("extractBashBlocks", async () => {
    await it("extracts single bash block", async () => {
      const text = "Here's a command:\n```bash\necho hello\n```\nDone.";
      const blocks = extractBashBlocks(text);

      assert.deepStrictEqual(blocks, ["echo hello"]);
    });

    await it("extracts multiple bash blocks", async () => {
      const text =
        "First:\n```bash\necho one\n```\nSecond:\n```bash\necho two\n```";
      const blocks = extractBashBlocks(text);

      assert.deepStrictEqual(blocks, ["echo one", "echo two"]);
    });

    await it("handles multiline commands", async () => {
      const text = "```bash\nline 1\nline 2\nline 3\n```";
      const blocks = extractBashBlocks(text);

      assert.strictEqual(blocks.length, 1);
      assert.ok(blocks[0].includes("line 1"));
      assert.ok(blocks[0].includes("line 2"));
      assert.ok(blocks[0].includes("line 3"));
    });

    await it("ignores non-bash code blocks", async () => {
      const text = '```json\n{"key": "value"}\n```\n```bash\necho hello\n```';
      const blocks = extractBashBlocks(text);

      assert.deepStrictEqual(blocks, ["echo hello"]);
    });

    await it("returns empty array when no blocks", async () => {
      const text = "Just some text.";
      const blocks = extractBashBlocks(text);

      assert.deepStrictEqual(blocks, []);
    });

    await it("skips empty blocks", async () => {
      const text = "```bash\n\n```";
      const blocks = extractBashBlocks(text);

      assert.deepStrictEqual(blocks, []);
    });

    await it("handles commands with special characters", async () => {
      const text = '```bash\necho "Hello $WORLD"\n```';
      const blocks = extractBashBlocks(text);

      assert.strictEqual(blocks.length, 1);
      assert.ok(blocks[0].includes('"Hello $WORLD"'));
    });

    await it("handles commands with pipes and redirects", async () => {
      const text = "```bash\ncat file.txt | grep pattern > output.txt\n```";
      const blocks = extractBashBlocks(text);

      assert.strictEqual(blocks.length, 1);
      assert.ok(blocks[0].includes("|"));
      assert.ok(blocks[0].includes(">"));
    });
  });

  await describe("truncateOutput", async () => {
    await it("returns short output unchanged", async () => {
      const output = "Short output";
      const result = truncateOutput(output, 100);

      assert.strictEqual(result, output);
    });

    await it("truncates long output", async () => {
      const output = "x".repeat(3000);
      const result = truncateOutput(output, 2000);

      assert.ok(result.length < output.length);
      assert.ok(result.endsWith("\n... (truncated)"));
    });

    await it("uses default max length of 2000", async () => {
      const output = "x".repeat(2500);
      const result = truncateOutput(output);

      assert.ok(result.endsWith("\n... (truncated)"));
    });

    await it("truncates at exact boundary", async () => {
      const output = "x".repeat(2001);
      const result = truncateOutput(output, 2000);

      assert.ok(result.endsWith("\n... (truncated)"));
      assert.ok(result.length > 2000);
    });

    await it("handles empty string", async () => {
      const result = truncateOutput("", 100);
      assert.strictEqual(result, "");
    });

    await it("handles exact length match", async () => {
      const output = "x".repeat(2000);
      const result = truncateOutput(output, 2000);

      assert.strictEqual(result, output);
    });

    await it("handles custom max length", async () => {
      const output = "x".repeat(500);
      const result = truncateOutput(output, 100);

      assert.ok(result.endsWith("\n... (truncated)"));
    });
  });

  await describe("isPauseInput", async () => {
    await it("detects 'pause'", async () => {
      assert.strictEqual(isPauseInput("pause"), true);
    });

    await it("detects 'wait'", async () => {
      assert.strictEqual(isPauseInput("wait"), true);
    });

    await it("detects 'hold on'", async () => {
      assert.strictEqual(isPauseInput("hold on"), true);
    });

    await it("detects 'stop'", async () => {
      assert.strictEqual(isPauseInput("stop"), true);
    });

    await it("detects 'hang on'", async () => {
      assert.strictEqual(isPauseInput("hang on"), true);
    });

    await it("detects 'hold up'", async () => {
      assert.strictEqual(isPauseInput("hold up"), true);
    });

    await it("detects 'give me a moment'", async () => {
      assert.strictEqual(isPauseInput("give me a moment"), true);
    });

    await it("detects 'hold it'", async () => {
      assert.strictEqual(isPauseInput("hold it"), true);
    });

    await it("detects 'freeze'", async () => {
      assert.strictEqual(isPauseInput("freeze"), true);
    });

    await it("is case insensitive", async () => {
      assert.strictEqual(isPauseInput("PAUSE"), true);
      assert.strictEqual(isPauseInput("Pause"), true);
      assert.strictEqual(isPauseInput("WAIT"), true);
    });

    await it("detects pause at start of sentence", async () => {
      assert.strictEqual(isPauseInput("pause please"), true);
    });

    await it("detects pause in middle of sentence", async () => {
      assert.strictEqual(isPauseInput("please pause now"), true);
    });

    await it("detects pause at end of sentence", async () => {
      assert.strictEqual(isPauseInput("please wait"), true);
    });

    await it("rejects non-pause input", async () => {
      assert.strictEqual(isPauseInput("continue"), false);
      assert.strictEqual(isPauseInput("resume"), false);
      assert.strictEqual(isPauseInput("hello world"), false);
    });

    await it("rejects partial matches", async () => {
      assert.strictEqual(isPauseInput("paused"), false);
      assert.strictEqual(isPauseInput("stopping"), false);
      assert.strictEqual(isPauseInput("waiting room"), false);
      assert.strictEqual(isPauseInput("please wait"), true);
    });

    await it("handles whitespace", async () => {
      assert.strictEqual(isPauseInput("  pause  "), true);
      assert.strictEqual(isPauseInput("\twait\n"), true);
    });

    await it("handles empty string", async () => {
      assert.strictEqual(isPauseInput(""), false);
    });
  });
});
