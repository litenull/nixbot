import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initCronTable,
  addCronJob,
  removeCronJob,
  getCronJob,
  getCronJobByName,
  listCronJobs,
  getDueJobs,
  updateJobLastRun,
  toggleCronJob,
  parseSchedule,
  calculateNextRun,
  validateSchedule,
  formatSchedule,
} from "./cron.js";

let db: Database.Database;
let tempDir: string;

await describe("cron", async () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cron-test-"));
    db = new Database(join(tempDir, "test.db"));
    initCronTable(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  await describe("initCronTable", async () => {
    it("creates cron_jobs table", () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_jobs'").all();
      assert.strictEqual(tables.length, 1);
    });

    it("creates indexes", () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cron_jobs'").all();
      assert.ok(indexes.length >= 2);
    });
  });

  await describe("addCronJob", async () => {
    it("adds a cron job", () => {
      const job = addCronJob(db, {
        groupName: "main",
        name: "test-job",
        schedule: "0 * * * *",
        prompt: "Test prompt",
      });

      assert.ok(job.id > 0);
      assert.strictEqual(job.groupName, "main");
      assert.strictEqual(job.name, "test-job");
      assert.strictEqual(job.schedule, "0 * * * *");
      assert.strictEqual(job.prompt, "Test prompt");
      assert.strictEqual(job.enabled, true);
      assert.ok(job.nextRun);
    });

    it("adds a disabled job when enabled is false", () => {
      const job = addCronJob(db, {
        groupName: "main",
        name: "disabled-job",
        schedule: "0 * * * *",
        prompt: "Test",
        enabled: false,
      });

      assert.strictEqual(job.enabled, false);
    });

    it("calculates nextRun based on schedule", () => {
      const job = addCronJob(db, {
        groupName: "main",
        name: "hourly",
        schedule: "0 * * * *",
        prompt: "Hourly task",
      });

      assert.ok(job.nextRun);
      const nextRun = new Date(job.nextRun!);
      assert.strictEqual(nextRun.getMinutes(), 0);
    });
  });

  await describe("removeCronJob", async () => {
    it("removes an existing job", () => {
      addCronJob(db, { groupName: "main", name: "to-remove", schedule: "* * * * *", prompt: "test" });
      assert.strictEqual(removeCronJob(db, "to-remove"), true);
      assert.strictEqual(getCronJobByName(db, "to-remove"), undefined);
    });

    it("returns false for non-existent job", () => {
      assert.strictEqual(removeCronJob(db, "nonexistent"), false);
    });
  });

  await describe("getCronJob", async () => {
    it("returns job by id", () => {
      const added = addCronJob(db, { groupName: "main", name: "by-id", schedule: "* * * * *", prompt: "test" });
      const found = getCronJob(db, added.id);
      assert.strictEqual(found?.name, "by-id");
    });

    it("returns undefined for invalid id", () => {
      assert.strictEqual(getCronJob(db, 9999), undefined);
    });
  });

  await describe("getCronJobByName", async () => {
    it("returns job by name", () => {
      addCronJob(db, { groupName: "main", name: "by-name", schedule: "* * * * *", prompt: "test" });
      const found = getCronJobByName(db, "by-name");
      assert.strictEqual(found?.name, "by-name");
    });

    it("returns undefined for invalid name", () => {
      assert.strictEqual(getCronJobByName(db, "nonexistent"), undefined);
    });
  });

  await describe("listCronJobs", async () => {
    it("lists all jobs", () => {
      addCronJob(db, { groupName: "main", name: "job1", schedule: "* * * * *", prompt: "test" });
      addCronJob(db, { groupName: "work", name: "job2", schedule: "* * * * *", prompt: "test" });
      const jobs = listCronJobs(db);
      assert.strictEqual(jobs.length, 2);
    });

    it("filters by group", () => {
      addCronJob(db, { groupName: "main", name: "job1", schedule: "* * * * *", prompt: "test" });
      addCronJob(db, { groupName: "work", name: "job2", schedule: "* * * * *", prompt: "test" });
      const jobs = listCronJobs(db, "main");
      assert.strictEqual(jobs.length, 1);
      assert.strictEqual(jobs[0].groupName, "main");
    });

    it("returns empty array when no jobs", () => {
      assert.strictEqual(listCronJobs(db).length, 0);
    });
  });

  await describe("getDueJobs", async () => {
    it("returns enabled jobs with nextRun in the past", () => {
      const pastDate = new Date();
      pastDate.setMinutes(pastDate.getMinutes() - 5);

      db.prepare(`
        INSERT INTO cron_jobs (group_name, name, schedule, prompt, enabled, next_run)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("main", "due-job", "* * * * *", "test", 1, pastDate.toISOString());

      const due = getDueJobs(db);
      assert.strictEqual(due.length, 1);
      assert.strictEqual(due[0].name, "due-job");
    });

    it("excludes disabled jobs", () => {
      const pastDate = new Date();
      pastDate.setMinutes(pastDate.getMinutes() - 5);

      db.prepare(`
        INSERT INTO cron_jobs (group_name, name, schedule, prompt, enabled, next_run)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("main", "disabled-due", "* * * * *", "test", 0, pastDate.toISOString());

      assert.strictEqual(getDueJobs(db).length, 0);
    });

    it("excludes future jobs", () => {
      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 1);

      db.prepare(`
        INSERT INTO cron_jobs (group_name, name, schedule, prompt, enabled, next_run)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("main", "future-job", "* * * * *", "test", 1, futureDate.toISOString());

      assert.strictEqual(getDueJobs(db).length, 0);
    });
  });

  await describe("updateJobLastRun", async () => {
    it("updates last_run and calculates new next_run", () => {
      const job = addCronJob(db, { groupName: "main", name: "update-test", schedule: "0 * * * *", prompt: "test" });
      updateJobLastRun(db, job.id);

      const updated = getCronJob(db, job.id);
      assert.ok(updated?.lastRun);
      assert.ok(updated?.nextRun);
    });
  });

  await describe("toggleCronJob", async () => {
    it("enables a disabled job", () => {
      addCronJob(db, { groupName: "main", name: "toggle-test", schedule: "* * * * *", prompt: "test", enabled: false });
      assert.strictEqual(toggleCronJob(db, "toggle-test", true), true);
      assert.strictEqual(getCronJobByName(db, "toggle-test")?.enabled, true);
    });

    it("disables an enabled job", () => {
      addCronJob(db, { groupName: "main", name: "toggle-test2", schedule: "* * * * *", prompt: "test" });
      assert.strictEqual(toggleCronJob(db, "toggle-test2", false), true);
      assert.strictEqual(getCronJobByName(db, "toggle-test2")?.enabled, false);
    });

    it("returns false for non-existent job", () => {
      assert.strictEqual(toggleCronJob(db, "nonexistent", true), false);
    });
  });
});

await describe("parseSchedule", async () => {
  it("parses * * * * *", () => {
    const parsed = parseSchedule("* * * * *");
    assert.ok(parsed);
    assert.strictEqual(parsed!.minutes.length, 60);
    assert.strictEqual(parsed!.hours.length, 24);
  });

  it("parses specific values", () => {
    const parsed = parseSchedule("30 9 * * *");
    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.minutes, [30]);
    assert.deepStrictEqual(parsed!.hours, [9]);
  });

  it("parses comma-separated values", () => {
    const parsed = parseSchedule("0,30 * * * *");
    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.minutes, [0, 30]);
  });

  it("parses ranges", () => {
    const parsed = parseSchedule("0-5 * * * *");
    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.minutes, [0, 1, 2, 3, 4, 5]);
  });

  it("parses step values", () => {
    const parsed = parseSchedule("*/15 * * * *");
    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.minutes, [0, 15, 30, 45]);
  });

  it("returns null for invalid schedule (wrong field count)", () => {
    assert.strictEqual(parseSchedule("* * * *"), null);
    assert.strictEqual(parseSchedule("* * * * * *"), null);
  });

  it("returns null for out-of-range values", () => {
    assert.strictEqual(parseSchedule("60 * * * *"), null);
    assert.strictEqual(parseSchedule("* 24 * * *"), null);
  });

  it("parses day of week (0-6)", () => {
    const parsed = parseSchedule("* * * * 0");
    assert.deepStrictEqual(parsed!.daysOfWeek, [0]);
  });

  it("parses month (1-12)", () => {
    const parsed = parseSchedule("* * * 1 *");
    assert.deepStrictEqual(parsed!.months, [1]);
  });
});

await describe("calculateNextRun", async () => {
  it("calculates next run for hourly schedule", () => {
    const now = new Date();
    now.setMinutes(30, 0, 0);

    const next = calculateNextRun("0 * * * *", now);
    assert.ok(next);
    assert.strictEqual(next!.getMinutes(), 0);
    assert.strictEqual(next!.getHours(), now.getHours() + 1);
  });

  it("calculates next run for every minute", () => {
    const now = new Date();
    const next = calculateNextRun("* * * * *", now);
    assert.ok(next);
    assert.ok(next!.getTime() >= now.getTime());
  });

  it("returns null for invalid schedule", () => {
    assert.strictEqual(calculateNextRun("invalid"), null);
  });

  it("handles end of day rollover", () => {
    const now = new Date();
    now.setHours(23, 59, 0, 0);

    const next = calculateNextRun("0 0 * * *", now);
    assert.ok(next);
    assert.strictEqual(next!.getHours(), 0);
    assert.strictEqual(next!.getMinutes(), 0);
  });
});

await describe("validateSchedule", async () => {
  it("validates correct schedules", () => {
    assert.strictEqual(validateSchedule("* * * * *").valid, true);
    assert.strictEqual(validateSchedule("0 * * * *").valid, true);
    assert.strictEqual(validateSchedule("0 9 * * 1").valid, true);
    assert.strictEqual(validateSchedule("*/15 * * * *").valid, true);
  });

  it("rejects wrong field count", () => {
    const result = validateSchedule("* * * *");
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("5 fields"));
  });

  it("rejects invalid values", () => {
    const result = validateSchedule("60 * * * *");
    assert.strictEqual(result.valid, false);
  });
});

await describe("formatSchedule", async () => {
  it("formats valid schedule", () => {
    assert.notStrictEqual(formatSchedule("* * * * *"), "invalid");
  });

  it("returns invalid for bad schedule", () => {
    assert.strictEqual(formatSchedule("bad"), "invalid");
  });
});
