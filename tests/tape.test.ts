import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import {
  initTapeTable,
  logTapeAction,
  cleanExpiredTapeEntries,
  queryTapeLog,
  getRecentTapeSummary,
  getTapeStats,
  TapeEntry,
} from "../src/tape.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("Tape Logging", () => {
  let db: Database.Database;
  let tempDir: string;
  
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nixbot-tape-test-"));
    db = new Database(join(tempDir, "test.db"));
    initTapeTable(db);
  });
  
  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
  
  describe("initTapeTable", () => {
    it("should create tape_log table", () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tape_log'").all();
      assert.strictEqual(tables.length, 1);
    });
    
    it("should create indexes", () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tape_log'").all() as Array<{ name: string }>;
      const indexNames = indexes.map(i => i.name);
      assert.ok(indexNames.some(n => n.includes("tape_group")));
      assert.ok(indexNames.some(n => n.includes("tape_created")));
    });
  });
  
  describe("logTapeAction", () => {
    it("should log an action", () => {
      logTapeAction(db, "main", "command", "echo hello");
      
      const rows = db.prepare("SELECT * FROM tape_log").all() as Array<{ id: number }>;
      assert.strictEqual(rows.length, 1);
    });
    
    it("should log action with metadata", () => {
      logTapeAction(db, "main", "output", "hello", { exitCode: 0, duration: 100 });
      
      const row = db.prepare("SELECT * FROM tape_log").get() as { metadata: string | null };
      assert.ok(row.metadata);
      const metadata = JSON.parse(row.metadata!);
      assert.strictEqual(metadata.exitCode, 0);
      assert.strictEqual(metadata.duration, 100);
    });
    
    it("should set expiration date 30 days in future", () => {
      logTapeAction(db, "main", "command", "test");
      
      const row = db.prepare("SELECT created_at, expires_at FROM tape_log").get() as { created_at: string; expires_at: string };
      const created = new Date(row.created_at);
      const expires = new Date(row.expires_at);
      const diffDays = (expires.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      
      assert.ok(diffDays >= 29 && diffDays <= 31);
    });
    
    it("should log all action types", () => {
      const types: TapeEntry["actionType"][] = ["command", "output", "feedback", "llm_request", "llm_response", "pause", "cancel", "resume"];
      
      for (const type of types) {
        logTapeAction(db, "main", type, `test ${type}`);
      }
      
      const rows = db.prepare("SELECT action_type FROM tape_log ORDER BY id").all() as Array<{ action_type: string }>;
      assert.strictEqual(rows.length, types.length);
      for (let i = 0; i < types.length; i++) {
        assert.strictEqual(rows[i].action_type, types[i]);
      }
    });
  });
  
  describe("queryTapeLog", () => {
    beforeEach(() => {
      logTapeAction(db, "main", "command", "echo hello");
      logTapeAction(db, "main", "output", "hello");
      logTapeAction(db, "work", "command", "ls -la");
      logTapeAction(db, "main", "feedback", "try again");
    });
    
    it("should query all entries", () => {
      const entries = queryTapeLog(db);
      assert.strictEqual(entries.length, 4);
    });
    
    it("should filter by group name", () => {
      const entries = queryTapeLog(db, { groupName: "main" });
      assert.strictEqual(entries.length, 3);
      for (const entry of entries) {
        assert.strictEqual(entry.groupName, "main");
      }
    });
    
    it("should filter by action type", () => {
      const entries = queryTapeLog(db, { actionType: "command" });
      assert.strictEqual(entries.length, 2);
      for (const entry of entries) {
        assert.strictEqual(entry.actionType, "command");
      }
    });
    
    it("should search content", () => {
      const entries = queryTapeLog(db, { search: "hello" });
      assert.strictEqual(entries.length, 2);
    });
    
    it("should limit results", () => {
      const entries = queryTapeLog(db, { limit: 2 });
      assert.strictEqual(entries.length, 2);
    });
    
    it("should return entries in reverse chronological order", () => {
      const entries = queryTapeLog(db, { groupName: "main" });
      assert.ok(entries[0].createdAt <= entries[1].createdAt);
    });
  });
  
  describe("getRecentTapeSummary", () => {
    it("should return summary of recent activity", () => {
      logTapeAction(db, "main", "command", "echo hello");
      logTapeAction(db, "main", "output", "hello world");
      
      const summary = getRecentTapeSummary(db, "main", 24);
      
      assert.ok(summary.includes("command"));
      assert.ok(summary.includes("output"));
    });
    
    it("should return message when no activity", () => {
      const summary = getRecentTapeSummary(db, "main", 24);
      assert.ok(summary.includes("No activity"));
    });
    
    it("should truncate long content", () => {
      const longContent = "a".repeat(200);
      logTapeAction(db, "main", "command", longContent);
      
      const summary = getRecentTapeSummary(db, "main", 24);
      
      assert.ok(summary.includes("..."));
    });
  });
  
  describe("getTapeStats", () => {
    it("should return statistics", () => {
      logTapeAction(db, "main", "command", "test1");
      logTapeAction(db, "main", "command", "test2");
      logTapeAction(db, "main", "output", "result");
      logTapeAction(db, "work", "command", "test3");
      
      const stats = getTapeStats(db);
      
      assert.strictEqual(stats.totalEntries, 4);
      assert.strictEqual(stats.entriesByType["command"], 3);
      assert.strictEqual(stats.entriesByType["output"], 1);
      assert.ok(stats.oldestEntry !== null);
    });
    
    it("should handle empty database", () => {
      const stats = getTapeStats(db);
      
      assert.strictEqual(stats.totalEntries, 0);
      assert.strictEqual(stats.oldestEntry, null);
      assert.strictEqual(stats.entriesExpiringSoon, 0);
    });
  });
  
  describe("cleanExpiredTapeEntries", () => {
    it("should remove expired entries", () => {
      db.prepare(`
        INSERT INTO tape_log (group_name, action_type, content, expires_at)
        VALUES ('main', 'command', 'old', datetime('now', '-1 day'))
      `).run();
      
      db.prepare(`
        INSERT INTO tape_log (group_name, action_type, content, expires_at)
        VALUES ('main', 'command', 'new', datetime('now', '+30 days'))
      `).run();
      
      const removed = cleanExpiredTapeEntries(db);
      
      assert.strictEqual(removed, 1);
      const remaining = db.prepare("SELECT COUNT(*) as count FROM tape_log").get() as { count: number };
      assert.strictEqual(remaining.count, 1);
    });
    
    it("should return 0 when nothing to clean", () => {
      logTapeAction(db, "main", "command", "test");
      const removed = cleanExpiredTapeEntries(db);
      assert.strictEqual(removed, 0);
    });
  });
  
  describe("combined filters", () => {
    beforeEach(() => {
      logTapeAction(db, "main", "command", "npm install");
      logTapeAction(db, "main", "output", "installed 100 packages");
      logTapeAction(db, "work", "command", "npm test");
      logTapeAction(db, "main", "feedback", "use npm ci instead");
    });
    
    it("should combine group and type filters", () => {
      const entries = queryTapeLog(db, { groupName: "main", actionType: "command" });
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].content, "npm install");
    });
    
    it("should combine search with other filters", () => {
      const entries = queryTapeLog(db, { groupName: "main", search: "npm" });
      assert.strictEqual(entries.length, 2);
    });
  });
});
