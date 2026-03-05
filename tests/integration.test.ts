import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initGroupsTable,
  registerGroup,
  getGroup,
  addMessage,
  getHistory,
} from "../src/groups.js";
import {
  listCronJobs,
  getDueJobs,
  initCronTable,
  addCronJob,
  getCronJobByName,
  CronJobInput,
} from "../src/cron.js";
import { queryTapeLog, logTapeAction, initTapeTable } from "../src/tape.js";
import { detectRequiredCreds, maskCredentials } from "../src/credentials.js";
import { extractBashBlocks, truncateOutput } from "../src/utils.js";

let db: Database.Database;
let tempDir: string;
let groupsDir: string;

await describe("integration", async () => {
  await beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nixbot-int-test-"));
    groupsDir = join(tempDir, "groups");
    mkdirSync(groupsDir, { recursive: true });

    const groupDir = join(groupsDir, "test-group");
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(join(groupDir, "CLAUDE.md"), "Test context");

    db = new Database(join(tempDir, "test.db"));
    initGroupsTable(db);
    initCronTable(db);
    initTapeTable(db);
  });

  await afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  await describe("group lifecycle", async () => {
    await it("creates group, adds messages, and queries history", async () => {
      registerGroup(db, "test-group", join(groupsDir, "test-group"));

      addMessage(db, "test-group", "user", "Hello");
      addMessage(db, "test-group", "assistant", "Hi there!");
      addMessage(db, "test-group", "user", "How are you?");

      const group = getGroup(db, "test-group");
      assert.ok(group, "group should exist");
      assert.strictEqual(group?.name, "test-group");

      const history = getHistory(db, "test-group");
      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[0].content, "How are you?");
      assert.strictEqual(history[2].content, "Hello");
    });

    await it("isolates groups with separate histories", async () => {
      registerGroup(db, "group-a", join(groupsDir, "group-a"));
      registerGroup(db, "group-b", join(groupsDir, "group-b"));

      addMessage(db, "group-a", "user", "Message for A");
      addMessage(db, "group-b", "user", "Message for B");
      addMessage(db, "group-a", "assistant", "Response for A");

      const historyA = getHistory(db, "group-a");
      const historyB = getHistory(db, "group-b");

      assert.strictEqual(historyA.length, 2);
      assert.strictEqual(historyB.length, 1);
      assert.ok(historyA.every((m) => m.content.includes("A")));
      assert.ok(historyB.every((m) => m.content.includes("B")));
    });
  });

  await describe("cron job integration", async () => {
    await it("creates job and lists it with group", async () => {
      registerGroup(db, "main", join(groupsDir, "main"));

      const jobInput: CronJobInput = {
        groupName: "main",
        name: "test-job",
        schedule: "*/5 * * * *",
        prompt: "Check something",
      };
      addCronJob(db, jobInput);

      const jobs = listCronJobs(db);
      assert.strictEqual(jobs.length, 1);
      assert.strictEqual(jobs[0].name, "test-job");
      assert.strictEqual(jobs[0].groupName, "main");
    });

    await it("tracks due jobs correctly", async () => {
      registerGroup(db, "main", join(groupsDir, "main"));

      const pastTime = new Date(Date.now() - 60000).toISOString();
      const futureTime = new Date(Date.now() + 60000).toISOString();

      const job1: CronJobInput = {
        groupName: "main",
        name: "past-job",
        schedule: "* * * * *",
        prompt: "Past job",
      };
      addCronJob(db, job1);

      db.prepare("UPDATE cron_jobs SET next_run = ? WHERE name = ?").run(
        pastTime,
        "past-job",
      );

      const job2: CronJobInput = {
        groupName: "main",
        name: "future-job",
        schedule: "* * * * *",
        prompt: "Future job",
      };
      addCronJob(db, job2);

      db.prepare("UPDATE cron_jobs SET next_run = ? WHERE name = ?").run(
        futureTime,
        "future-job",
      );

      const dueJobs = getDueJobs(db);
      assert.strictEqual(dueJobs.length, 1);
      assert.strictEqual(dueJobs[0].name, "past-job");
    });
  });

  await describe("tape logging integration", async () => {
    await it("logs actions and queries across multiple types", async () => {
      registerGroup(db, "main", join(groupsDir, "main"));

      logTapeAction(db, "main", "command", "npm run build");
      logTapeAction(db, "main", "output", "Build completed");
      logTapeAction(db, "main", "feedback", "Try production mode");
      logTapeAction(db, "main", "command", "npm run build --mode production");

      const allEntries = queryTapeLog(db, {});
      assert.strictEqual(allEntries.length, 4);

      const commands = queryTapeLog(db, { actionType: "command" });
      assert.strictEqual(commands.length, 2);

      const bySearch = queryTapeLog(db, { search: "build" });
      assert.strictEqual(bySearch.length, 3);
    });

    await it("filters by group and action type", async () => {
      registerGroup(db, "main", join(groupsDir, "main"));
      registerGroup(db, "work", join(groupsDir, "work"));

      logTapeAction(db, "main", "command", "echo main");
      logTapeAction(db, "work", "command", "echo work");
      logTapeAction(db, "main", "output", "main output");

      const mainCommands = queryTapeLog(db, {
        groupName: "main",
        actionType: "command",
      });
      assert.strictEqual(mainCommands.length, 1);
      assert.strictEqual(mainCommands[0].content, "echo main");
    });
  });

  await describe("credential integration", async () => {
    await it("detects credentials in command strings", async () => {
      const command = `curl -H "Authorization: $API_KEY" https://api.example.com`;

      const vars = detectRequiredCreds(command);
      assert.deepStrictEqual(vars, ["API_KEY"]);
    });

    await it("maskCredentials handles non-existent vars", async () => {
      const output = `Bearer sk-abc123\nToken: abc123\nSome other output`;
      const masked = maskCredentials(output, ["NONEXISTENT"]);
      assert.strictEqual(masked, output);
    });
  });

  await describe("LLM response parsing integration", async () => {
    await it("extracts multiple bash blocks from response", async () => {
      const response = `I'll check the version first.

\`\`\`bash
node --version
\`\`\`

Then install dependencies:

\`\`\`bash
npm install
\`\`\`

Finally run the build.`;

      const blocks = extractBashBlocks(response);
      assert.strictEqual(blocks.length, 2);
      assert.strictEqual(blocks[0], "node --version");
      assert.strictEqual(blocks[1], "npm install");
    });

    await it("handles nested backticks in content", async () => {
      const response = `Here's a command:
\`\`\`bash
echo "foo \`nested\` bar"
\`\`\`

And some text with \`inline\` code.`;

      const blocks = extractBashBlocks(response);
      assert.strictEqual(blocks.length, 1);
      assert.ok(blocks[0].includes("nested"));
    });

    await it("truncates long output correctly", async () => {
      const longOutput = "a".repeat(5000);
      const truncated = truncateOutput(longOutput, 1000);

      assert.strictEqual(truncated.length, 1016);
      assert.ok(truncated.includes("... (truncated)"));
    });
  });

  await describe("cross-component workflow", async () => {
    await it("full message flow: create group, add cron, log tape", async () => {
      registerGroup(db, "workflow-group", join(groupsDir, "workflow-group"));

      addMessage(db, "workflow-group", "user", "Check the API every 5 minutes");
      logTapeAction(
        db,
        "workflow-group",
        "llm_request",
        "Check the API every 5 minutes",
      );

      const jobInput: CronJobInput = {
        groupName: "workflow-group",
        name: "check-api",
        schedule: "*/5 * * * *",
        prompt: "Check API status",
      };
      addCronJob(db, jobInput);

      const job = getCronJobByName(db, "check-api");
      assert.ok(job);
      assert.strictEqual(job?.schedule, "*/5 * * * *");

      const history = getHistory(db, "workflow-group");
      assert.strictEqual(history.length, 1);

      const tape = queryTapeLog(db, { groupName: "workflow-group" });
      assert.strictEqual(tape.length, 1);
    });

    await it("handles rapid sequential operations", async () => {
      registerGroup(db, "rapid", join(groupsDir, "rapid"));

      for (let i = 0; i < 100; i++) {
        addMessage(db, "rapid", "user", `Message ${i}`);
        logTapeAction(db, "rapid", "command", `command-${i}`);
      }

      const history = getHistory(db, "rapid");
      assert.strictEqual(history.length, 50);

      const tape = queryTapeLog(db, {
        groupName: "rapid",
        actionType: "command",
      });
      assert.strictEqual(tape.length, 100);
    });
  });
});
