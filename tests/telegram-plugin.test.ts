import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseAllowedChatIds, parseGroupCommand, splitTelegramMessage } from "../src/plugins/telegram.js";

await describe("telegram plugin helpers", async () => {
  await describe("parseAllowedChatIds", async () => {
    await it("returns null when empty", async () => {
      assert.equal(parseAllowedChatIds(), null);
      assert.equal(parseAllowedChatIds(""), null);
    });

    await it("parses comma-separated ids", async () => {
      const ids = parseAllowedChatIds("123, 456, 789");
      assert.ok(ids);
      assert.equal(ids!.has(123), true);
      assert.equal(ids!.has(456), true);
      assert.equal(ids!.has(789), true);
    });

    await it("ignores invalid ids", async () => {
      const ids = parseAllowedChatIds("1,abc,2.5,3");
      assert.ok(ids);
      assert.deepEqual([...ids!].sort((a, b) => a - b), [1, 3]);
    });
  });

  await describe("parseGroupCommand", async () => {
    await it("extracts group from /group command", async () => {
      assert.equal(parseGroupCommand("/group work"), "work");
      assert.equal(parseGroupCommand("/group@my_bot main"), "main");
    });

    await it("returns null for non-group command", async () => {
      assert.equal(parseGroupCommand("/start"), null);
      assert.equal(parseGroupCommand("hello"), null);
    });
  });

  await describe("splitTelegramMessage", async () => {
    await it("returns single chunk for short text", async () => {
      const chunks = splitTelegramMessage("hello", 10);
      assert.deepEqual(chunks, ["hello"]);
    });

    await it("splits long text into chunks", async () => {
      const text = "A".repeat(25);
      const chunks = splitTelegramMessage(text, 10);
      assert.equal(chunks.length, 3);
      assert.equal(chunks[0].length <= 10, true);
      assert.equal(chunks[1].length <= 10, true);
      assert.equal(chunks[2].length <= 10, true);
      assert.equal(chunks.join(""), text);
    });
  });
});
