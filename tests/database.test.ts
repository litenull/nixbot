import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initGroupsTable,
  getGroup,
  registerGroup,
  listGroups,
  addMessage,
  getHistory,
} from "../src/groups.js";

let db: Database.Database;
let tempDir: string;

await describe("database operations", async () => {
  await beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nixbot-db-test-"));
    db = new Database(join(tempDir, "test.db"));
    initGroupsTable(db);
  });

  await afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  await describe("messages", async () => {
    await it("adds a message", async () => {
      addMessage(db, "main", "user", "Hello!");

      const history = getHistory(db, "main");
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].role, "user");
      assert.strictEqual(history[0].content, "Hello!");
    });

    await it("gets history with limit", async () => {
      for (let i = 0; i < 10; i++) {
        addMessage(
          db,
          "main",
          i % 2 === 0 ? "user" : "assistant",
          `Message ${i}`,
        );
      }

      const history = getHistory(db, "main", 5);
      assert.strictEqual(history.length, 5);
    });

    await it("returns messages in chronological order", async () => {
      // Insert messages with explicit delays for ordering
      const startTime = Date.now();
      db.prepare(
        "INSERT INTO messages (group_name, role, content, created_at) VALUES (?, ?, ?, ?)",
      ).run("main", "user", "First", new Date(startTime).toISOString());
      db.prepare(
        "INSERT INTO messages (group_name, role, content, created_at) VALUES (?, ?, ?, ?)",
      ).run(
        "main",
        "assistant",
        "Second",
        new Date(startTime + 100).toISOString(),
      );
      db.prepare(
        "INSERT INTO messages (group_name, role, content, created_at) VALUES (?, ?, ?, ?)",
      ).run("main", "user", "Third", new Date(startTime + 200).toISOString());

      const history = getHistory(db, "main");
      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[0].content, "First");
      assert.strictEqual(history[1].content, "Second");
      assert.strictEqual(history[2].content, "Third");
    });

    await it("isolates messages by group", async () => {
      addMessage(db, "main", "user", "Main message");
      addMessage(db, "work", "user", "Work message");

      const mainHistory = getHistory(db, "main");
      const workHistory = getHistory(db, "work");

      assert.strictEqual(mainHistory.length, 1);
      assert.strictEqual(workHistory.length, 1);
      assert.strictEqual(mainHistory[0].content, "Main message");
      assert.strictEqual(workHistory[0].content, "Work message");
    });

    await it("returns empty array for unknown group", async () => {
      const history = getHistory(db, "non-existent");
      assert.deepStrictEqual(history, []);
    });

    await it("stores both user and assistant messages", async () => {
      const startTime = Date.now();
      db.prepare(
        "INSERT INTO messages (group_name, role, content, created_at) VALUES (?, ?, ?, ?)",
      ).run("main", "user", "Question?", new Date(startTime).toISOString());
      db.prepare(
        "INSERT INTO messages (group_name, role, content, created_at) VALUES (?, ?, ?, ?)",
      ).run(
        "main",
        "assistant",
        "Answer!",
        new Date(startTime + 100).toISOString(),
      );

      const history = getHistory(db, "main");
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].role, "user");
      assert.strictEqual(history[1].role, "assistant");
    });

    await it("handles multiline content", async () => {
      const multiline = "Line 1\nLine 2\nLine 3";
      addMessage(db, "main", "user", multiline);

      const history = getHistory(db, "main");
      assert.strictEqual(history[0].content, multiline);
    });

    await it("handles special characters", async () => {
      const special = 'Hello "world" <script> & more';
      addMessage(db, "main", "user", special);

      const history = getHistory(db, "main");
      assert.strictEqual(history[0].content, special);
    });
  });

  await describe("groups", async () => {
    await it("registers a new group", async () => {
      registerGroup(db, "test-group", "/path/to/group");

      const group = getGroup(db, "test-group");
      assert.ok(group);
      assert.strictEqual(group?.name, "test-group");
      assert.strictEqual(group?.contextPath, "/path/to/group");
    });

    await it("returns undefined for unknown group", async () => {
      const group = getGroup(db, "unknown");
      assert.strictEqual(group, undefined);
    });

    await it("lists all groups", async () => {
      registerGroup(db, "group-a", "/path/a");
      registerGroup(db, "group-b", "/path/b");
      registerGroup(db, "group-c", "/path/c");

      const groups = listGroups(db);
      assert.strictEqual(groups.length, 3);
    });

    await it("updates existing group", async () => {
      registerGroup(db, "test", "/old/path");
      registerGroup(db, "test", "/new/path");

      const group = getGroup(db, "test");
      assert.strictEqual(group?.contextPath, "/new/path");
    });

    await it("preserves groups across multiple operations", async () => {
      registerGroup(db, "persistent", "/persistent/path");

      for (let i = 0; i < 5; i++) {
        addMessage(db, "persistent", "user", `Message ${i}`);
      }

      const group = getGroup(db, "persistent");
      const history = getHistory(db, "persistent");

      assert.ok(group);
      assert.strictEqual(history.length, 5);
    });
  });

  await describe("complex scenarios", async () => {
    await it("handles concurrent group operations", async () => {
      registerGroup(db, "main", "/main");
      registerGroup(db, "work", "/work");

      addMessage(db, "main", "user", "Main question");
      addMessage(db, "work", "user", "Work question");
      addMessage(db, "main", "assistant", "Main answer");
      addMessage(db, "work", "assistant", "Work answer");

      const mainHistory = getHistory(db, "main");
      const workHistory = getHistory(db, "work");

      assert.strictEqual(mainHistory.length, 2);
      assert.strictEqual(workHistory.length, 2);
      assert.ok(mainHistory.every((m) => m.content.includes("Main")));
      assert.ok(workHistory.every((m) => m.content.includes("Work")));
    });

    await it("handles large content", async () => {
      const largeContent = "x".repeat(10000);
      addMessage(db, "main", "user", largeContent);

      const history = getHistory(db, "main");
      assert.strictEqual(history[0].content.length, 10000);
    });

    await it("handles empty content", async () => {
      addMessage(db, "main", "user", "");

      const history = getHistory(db, "main");
      assert.strictEqual(history[0].content, "");
    });
  });
});
