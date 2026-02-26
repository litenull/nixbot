import Database from "better-sqlite3";
import { z } from "zod";
import { spawn } from "child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import * as readline from "readline";
import { chat, LLMConfig } from "./llm.js";
import {
  listCredentials,
  setCredential,
  removeCredential,
  maskCredentials,
  getRequiredCredsForCommand,
  detectRequiredCreds,
} from "./credentials.js";
import {
  initCronTable,
  addCronJob,
  removeCronJob,
  listCronJobs,
  getDueJobs,
  updateJobLastRun,
  toggleCronJob,
  validateSchedule,
  calculateNextRun,
  getCronJobByName,
  CronJob,
} from "./cron.js";
import {
  initTapeTable,
  logTapeAction,
  cleanExpiredTapeEntries,
  queryTapeLog,
  getRecentTapeSummary,
  getTapeStats,
  TapeEntry,
} from "./tape.js";

class InputBuffer {
  private queue: string[] = [];
  private enabled = false;
  private currentLine = "";
  private onDataHandler: ((chunk: Buffer) => void) | null = null;
  
  private static PAUSE_KEYWORDS = [
    "pause", "wait", "hold on", "stop", "hang on", "hold up",
    "give me a moment", "hold it", "freeze"
  ];
  
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.currentLine = "";
    
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      
      this.onDataHandler = (chunk: Buffer) => {
        if (!this.enabled) return;
        
        const data = chunk.toString();
        
        for (const char of data) {
          if (char === "\x03") {
            this.queue.push("__CANCEL__");
            process.stdout.write("\n\x1b[33m● Cancel requested\x1b[0m\n");
            continue;
          }
          
          if (char === "\r" || char === "\n") {
            if (this.currentLine.trim()) {
              const input = this.currentLine.trim();
              if (this.isPauseInput(input)) {
                this.queue.push("__PAUSE__");
                process.stdout.write("\n\x1b[35m● Paused\x1b[0m\n");
              } else {
                this.queue.push(input);
                process.stdout.write("\n\x1b[32m● Feedback queued\x1b[0m\n");
              }
            }
            this.currentLine = "";
            continue;
          }
          
          if (char === "\x7f" || char === "\x08") {
            this.currentLine = this.currentLine.slice(0, -1);
            continue;
          }
          
          if (char.charCodeAt(0) >= 32) {
            this.currentLine += char;
          }
        }
      };
      
      process.stdin.on("data", this.onDataHandler);
    }
  }
  
  private isPauseInput(input: string): boolean {
    const lower = input.toLowerCase().trim();
    return InputBuffer.PAUSE_KEYWORDS.some(kw => 
      lower === kw || lower.startsWith(kw + " ") || lower.includes(" " + kw + " ") || lower.endsWith(" " + kw)
    );
  }
  
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    
    if (this.onDataHandler) {
      process.stdin.off("data", this.onDataHandler);
      this.onDataHandler = null;
    }
    
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.resume();
    }
    
    this.currentLine = "";
  }
  
  push(input: string): void {
    this.queue.push(input);
  }
  
  pop(): string | undefined {
    return this.queue.shift();
  }
  
  popAll(): string[] {
    const all = [...this.queue];
    this.queue = [];
    return all;
  }
  
  hasPending(): boolean {
    return this.queue.length > 0;
  }
  
  isCancelRequested(): boolean {
    return this.queue.includes("__CANCEL__");
  }
  
  isPauseRequested(): boolean {
    return this.queue.includes("__PAUSE__");
  }
  
  consumeCancel(): boolean {
    const idx = this.queue.indexOf("__CANCEL__");
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }
  
  consumePause(): boolean {
    const idx = this.queue.indexOf("__PAUSE__");
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }
  
  getPendingCount(): number {
    return this.queue.filter(s => s !== "__CANCEL__" && s !== "__PAUSE__").length;
  }
}

export { InputBuffer };

const config = z.object({
  groupsDir: z.string().default("./groups"),
  dataDir: z.string().default("./data"),
  sandboxBin: z.string().default("./result/bin/run-in-sandbox"),
  llmProvider: z.enum(["anthropic", "openai", "openai-compatible"]).default("anthropic"),
  llmModel: z.string().default("claude-sonnet-4-20250514"),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
}).parse({
  groupsDir: process.env.NIXBOT_GROUPS_DIR,
  dataDir: process.env.NIXBOT_DATA_DIR,
  sandboxBin: process.env.NIXBOT_SANDBOX_BIN ? resolve(process.env.NIXBOT_SANDBOX_BIN) : resolve("./result/bin/run-in-sandbox"),
  llmProvider: process.env.NIXBOT_LLM_PROVIDER as "anthropic" | "openai" | "openai-compatible",
  llmModel: process.env.NIXBOT_LLM_MODEL,
  llmApiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
  llmBaseUrl: process.env.NIXBOT_LLM_BASE_URL,
});

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, "ipc"), { recursive: true });

const db = new Database(join(config.dataDir, "nixbot.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS groups (
    name TEXT PRIMARY KEY,
    context_path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

initCronTable(db);
initTapeTable(db);

interface GroupInfo {
  name: string;
  contextPath: string;
}

function getGroup(name: string): GroupInfo | undefined {
  const row = db.prepare("SELECT name, context_path FROM groups WHERE name = ?").get(name) as { name: string; context_path: string } | undefined;
  if (!row) return undefined;
  return { name: row.name, contextPath: row.context_path };
}

function registerGroup(name: string, contextPath: string): void {
  db.prepare("INSERT OR REPLACE INTO groups (name, context_path) VALUES (?, ?)").run(name, contextPath);
}

export function ensureGroup(name: string): void {
  const groupPath = join(config.groupsDir, name);
  mkdirSync(groupPath, { recursive: true });
  const claudeMd = join(groupPath, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    writeFileSync(claudeMd, `# ${name} Group\n\nContext for this group.\n`);
  }
  registerGroup(name, groupPath);
}

export function ensureDefaultGroups(): void {
  ensureGroup("main");
  ensureGroup("work");
}

function addMessage(group: string, role: "user" | "assistant", content: string): void {
  db.prepare("INSERT INTO messages (group_name, role, content) VALUES (?, ?, ?)").run(group, role, content);
}

function getHistory(group: string, limit = 50): Array<{ role: string; content: string }> {
  return db.prepare(`
    SELECT role, content FROM messages 
    WHERE group_name = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(group, limit).reverse() as Array<{ role: string; content: string }>;
}

interface SandboxResult {
  stdout: string;
  stderr: string;
  code: number;
  interrupted?: boolean;
}

interface SandboxOptions {
  inputBuffer?: InputBuffer;
  pollIntervalMs?: number;
  onFeedback?: (feedback: string, context: { command: string; partialOutput: string }) => Promise<void>;
}

function runInSandbox(
  group: string,
  command: string,
  timeout = 60000,
  options?: SandboxOptions
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const workspace = join(process.env.HOME || "/tmp", ".bwrapper", "nixbot", "groups", group);
    mkdirSync(workspace, { recursive: true });
    
    const safeEnv: Record<string, string> = {};
    const blocklist = [
      /_API_KEY$/i, /_SECRET$/i, /_PASSWORD$/i, /_TOKEN$/i, /_CREDENTIAL/i,
      /^ANTHROPIC_/i, /^OPENAI_/i, /^AWS_/i, /^GITHUB_/i,
    ];
    
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !blocklist.some(p => p.test(key))) {
        safeEnv[key] = value;
      }
    }
    
    const credEnv = getRequiredCredsForCommand(command);
    
    const proc = spawn(config.sandboxBin, [command], {
      env: {
        ...safeEnv,
        ...credEnv,
        HOME: process.env.HOME || "/tmp",
        WORKSPACE: workspace,
      },
      cwd: process.env.HOME,
      shell: false,
    });
    
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    
    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });
    
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      stderr += "\n[Timeout]";
    }, timeout);
    
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    
    if (options?.inputBuffer) {
      const pollInterval = options.pollIntervalMs || 500;
      pollTimer = setInterval(async () => {
        try {
          if (options.inputBuffer!.isPauseRequested() || options.inputBuffer!.isCancelRequested()) {
            proc.kill("SIGTERM");
            interrupted = true;
            stderr += "\n[Interrupted by user]";
            if (pollTimer) clearInterval(pollTimer);
            return;
          }
          
          if (options.inputBuffer!.hasPending() && options?.onFeedback) {
            const feedbackItems = options.inputBuffer!.popAll().filter(f => f !== "__CANCEL__" && f !== "__PAUSE__");
            if (feedbackItems.length > 0) {
              const feedback = feedbackItems.join("\n");
              const partialOutput = (stdout + stderr).slice(-1000);
              await options.onFeedback(feedback, { command, partialOutput });
            }
          }
        } catch (err) {
          console.error(`[poll error] ${(err as Error).message}`);
        }
      }, pollInterval);
    }
    
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      resolve({ stdout, stderr, code: code ?? 1, interrupted });
    });
  });
}

interface SupervisorContext {
  originalTask: string;
  llmConfig: LLMConfig;
  group: string;
}

async function handleLiveFeedback(
  feedback: string,
  context: { command: string; partialOutput: string },
  supervisorContext: SupervisorContext
): Promise<string> {
  const supervisorPrompt = `You are a supervisor monitoring an agent that is currently working on a task.

CURRENT TASK: ${supervisorContext.originalTask}
CURRENTLY RUNNING COMMAND: ${context.command}

LATEST OUTPUT:
${context.partialOutput || "(no output yet)"}

A user has sent a message while the task is running. Respond briefly and helpfully.
- If they're asking about progress, summarize what's happening based on the output
- If they're giving feedback, acknowledge it and say it will be incorporated after this command
- If they're asking a question, answer concisely
- Keep your response SHORT (1-3 sentences max)
- The main task is still running, so don't suggest stopping unless they explicitly ask`;

  try {
    const response = await chat(supervisorContext.llmConfig, [
      { role: "system", content: supervisorPrompt },
      { role: "user", content: feedback },
    ]);
    return response;
  } catch (err) {
    return `Acknowledged: "${feedback.slice(0, 30)}..." (will be processed after current command)`;
  }
}

interface ProcessMessageOptions {
  inputBuffer?: InputBuffer;
  onFeedback?: (feedback: string) => void;
  isPaused?: () => boolean;
  onResume?: () => Promise<string | null>;
}

interface PauseResult {
  type: "paused";
  partialResponse: string;
}

export async function processMessage(group: string, message: string, llmConfig: LLMConfig, options?: ProcessMessageOptions): Promise<string | PauseResult> {
  addMessage(group, "user", message);
  logTapeAction(db, group, "llm_request", message);
  
  const groupInfo = getGroup(group);
  if (!groupInfo) {
    return `Unknown group: ${group}`;
  }
  
  console.log(`[${group}] Processing: ${message.slice(0, 60)}...`);
  
  const history = getHistory(group, 20);
  const contextPath = join(groupInfo.contextPath, "CLAUDE.md");
  const context = existsSync(contextPath) ? readFileSync(contextPath, "utf-8") : "";
  
  const systemPrompt = `You are a helpful assistant working in a sandboxed environment.

GROUP: ${group}
${context ? `\nGROUP CONTEXT:\n${context}\n` : ""}
CAPABILITIES:
- You can run bash commands by responding with \`\`\`bash blocks
- Commands run in a Nix sandbox with: curl, jq, git, chromium, node
- You have network access for web requests and API calls
- Workspace files are in the current directory
- You can schedule recurring tasks using /cron commands
- You can query past activity with /tape commands

NIX SANDBOX NOTES:
- DO NOT use shebangs (#!/bin/bash, #!/usr/bin/env) - they don't work
- Instead, run scripts directly: bash script.sh or bash -c 'commands'
- Write multi-line scripts with heredocs, then run with bash

RULES:
- Be concise and direct
- When asked to do something, do it (run commands as needed)
- Report results clearly
- If a command fails, explain what went wrong

MID-TASK FEEDBACK:
- The user may provide feedback while you're executing commands
- If you see "USER FEEDBACK: [message]", incorporate it into your next action
- You can modify your plan, explain what you're doing, or answer questions
- If feedback says to stop/cancel, acknowledge and halt execution

TAPE LOGGING:
- All commands and outputs are logged automatically
- Use /tape recent to see recent activity
- Use /tape search <query> to find past actions
- Use /tape stats to see logging statistics

SCHEDULING TASKS:
When asked to do something repeatedly (e.g., "check this every day", "run hourly"):
1. Determine the schedule from natural language:
   - "every minute" → */1 * * * *
   - "every hour"/"hourly" → 0 * * * *
   - "every day"/"daily" → 0 9 * * *
   - "every week"/"weekly" → 0 9 * * 1
   - "every N minutes" → */N * * * *
2. Create a descriptive job name (lowercase, dashes)
3. Output a line with: /cron add <name> '<schedule>' '<prompt>'
   Example: /cron add check-website '0 9 * * *' 'Check https://example.com and summarize any changes'

CRON COMMANDS (use these, NOT system crontab):
- /cron list [group] - List scheduled jobs
- /cron add <name> '<schedule>' '<prompt>' - Create a job
- /cron remove <name> - Delete a job
- /cron enable <name> - Enable a disabled job
- /cron disable <name> - Disable a job`;

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    ...history.slice(-10),
    { role: "user", content: message },
  ];
  
  let response: string;
  try {
    response = await chat(llmConfig, messages);
    logTapeAction(db, group, "llm_response", response.slice(0, 1000));
  } catch (err) {
    const error = err as Error;
    return `LLM error: ${error.message}`;
  }
  
  let bashBlocks: string[] = response.match(/```bash\n([\s\S]*?)```/g) || [];
  const allDetectedVars: string[] = [];
  let accumulatedResponse = response;
  
  for (let i = 0; i < bashBlocks.length; i++) {
    const block = bashBlocks[i];
    const cmd = block.replace(/```bash\n?/g, "").replace(/```/g, "").trim();
    if (!cmd) continue;
    
    allDetectedVars.push(...detectRequiredCreds(cmd));
    
    console.log(`[${group}] Running: ${cmd.split("\n")[0].slice(0, 50)}...`);
    logTapeAction(db, group, "command", cmd);
    
    if (options?.inputBuffer) {
      options.inputBuffer.enable();
    }
    
    const supervisorContext: SupervisorContext = {
      originalTask: message,
      llmConfig,
      group,
    };
    
    const result = await runInSandbox(group, cmd, 60000, {
      inputBuffer: options?.inputBuffer,
      onFeedback: async (feedback, context) => {
        logTapeAction(db, group, "feedback", feedback);
        console.log(`\x1b[36m↳ Processing: ${feedback.slice(0, 40)}...\x1b[0m`);
        const supervisorResponse = await handleLiveFeedback(feedback, context, supervisorContext);
        console.log(`\x1b[34m💬 ${supervisorResponse}\x1b[0m`);
      },
    });
    
    if (options?.inputBuffer) {
      options.inputBuffer.disable();
    }
    
    if (options?.inputBuffer?.isPauseRequested()) {
      options.inputBuffer.consumePause();
      logTapeAction(db, group, "pause", "User requested pause");
      console.log("\x1b[35m⏸️  Paused. Type 'resume' to continue or give new instructions.\x1b[0m");
      
      const partialOutput = result.interrupted 
        ? (result.stdout.trim() || result.stderr.trim() || "(command interrupted)")
        : (result.stdout.trim() || result.stderr.trim() || "(no output)");
      const truncated = partialOutput.length > 2000 ? partialOutput.slice(0, 2000) + "\n... (truncated)" : partialOutput;
      accumulatedResponse += `\n\n\`\`\`output\n${truncated}\n\`\`\``;
      
      return {
        type: "paused",
        partialResponse: accumulatedResponse,
      };
    }
    
    if (options?.inputBuffer?.isCancelRequested()) {
      options.inputBuffer.consumeCancel();
      logTapeAction(db, group, "cancel", "User cancelled execution");
      const cancelMsg = "\n\n[Execution cancelled by user]";
      accumulatedResponse += cancelMsg;
      const maskedResponse = maskCredentials(accumulatedResponse, allDetectedVars);
      addMessage(group, "assistant", maskedResponse);
      return maskedResponse;
    }
    
    const output = result.stdout.trim() || result.stderr.trim() || "(no output)";
    const truncated = output.length > 2000 ? output.slice(0, 2000) + "\n... (truncated)" : output;
    accumulatedResponse += `\n\n\`\`\`output\n${truncated}\n\`\`\``;
    logTapeAction(db, group, "output", truncated);
  }
  
  const cronAddPattern = /\/cron add (\S+) '([^']+)' '([^']+)'/g;
  let cronMatch;
  while ((cronMatch = cronAddPattern.exec(accumulatedResponse)) !== null) {
    const [, name, schedule, promptText] = cronMatch;
    const validation = validateSchedule(schedule);
    if (!validation.valid) {
      accumulatedResponse += `\n\n[Error: Invalid schedule '${schedule}': ${validation.error}]`;
      continue;
    }
    if (getCronJobByName(db, name)) {
      accumulatedResponse += `\n\n[Error: Job '${name}' already exists]`;
      continue;
    }
    addCronJob(db, { groupName: group, name, schedule, prompt: promptText });
    const nextRun = calculateNextRun(schedule);
    accumulatedResponse += `\n\n[Scheduled: '${name}' will run next at ${nextRun?.toLocaleString() || "N/A"}]`;
  }
  
  const cronRemovePattern = /\/cron remove (\S+)/g;
  while ((cronMatch = cronRemovePattern.exec(accumulatedResponse)) !== null) {
    const [, name] = cronMatch;
    if (removeCronJob(db, name)) {
      accumulatedResponse += `\n\n[Removed cron job '${name}']`;
    } else {
      accumulatedResponse += `\n\n[Error: No cron job named '${name}']`;
    }
  }
  
  if (/\/cron list/.test(accumulatedResponse)) {
    const jobs = listCronJobs(db);
    if (jobs.length === 0) {
      accumulatedResponse += `\n\n[No cron jobs scheduled]`;
    } else {
      const jobList = jobs.map(j => 
        `- ${j.name}: ${j.schedule} (${j.enabled ? "enabled" : "disabled"}, next: ${j.nextRun?.toLocaleString() || "N/A"})`
      ).join("\n");
      accumulatedResponse += `\n\n[Cron jobs:]\n${jobList}`;
    }
  }
  
  const maskedResponse = maskCredentials(accumulatedResponse, allDetectedVars);
  
  addMessage(group, "assistant", maskedResponse);
  return maskedResponse;
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let schedulerCallback: ((group: string, prompt: string) => Promise<void>) | null = null;

export function startScheduler(callback: (group: string, prompt: string) => Promise<void>, intervalMs = 60000): void {
  schedulerCallback = callback;
  schedulerInterval = setInterval(async () => {
    const dueJobs = getDueJobs(db);
    for (const job of dueJobs) {
      console.log(`[cron] Running job '${job.name}' in group '${job.groupName}'`);
      try {
        await schedulerCallback!(job.groupName, job.prompt);
        updateJobLastRun(db, job.id);
      } catch (err) {
        console.error(`[cron] Job '${job.name}' failed:`, (err as Error).message);
      }
    }
  }, intervalMs);
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

export async function repl(llmConfig: LLMConfig): Promise<void> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));
  
  const inputBuffer = new InputBuffer();
  
  ensureDefaultGroups();
  
  console.log("\n  Nixbot Agent v0.1.0");
  console.log("  ───────────────────");
  console.log("  Commands:");
  console.log("    @<group> <msg>  - Send to group");
  console.log("    /switch <group> - Change active group");
  console.log("    /list           - List groups");
  console.log("    /history        - Show conversation history");
  console.log("    /cred list      - List stored credentials");
  console.log("    /cred add <NAME> [SCOPE] - Add credential (prompts for value)");
  console.log("    /cred remove <NAME> - Remove credential");
  console.log("    /cron list [group] - List cron jobs");
  console.log("    /cron add <NAME> <SCHEDULE> <PROMPT> - Add job");
  console.log("    /cron remove <NAME> - Remove job");
  console.log("    /cron enable|disable <NAME> - Toggle job");
  console.log("    /tape recent [hours] - Show recent activity");
  console.log("    /tape search <query> - Search tape logs");
  console.log("    /tape stats - Show tape statistics");
  console.log("    /quit           - Exit");
  console.log("\n  Mid-Task Input:");
  console.log("    While agent is working, type feedback and press Enter");
  console.log("    Type 'pause' or 'wait' to pause execution");
  console.log("    Ctrl+C to cancel current task\n");
  
  let currentGroup = "main";
  let pausedState: { group: string; partialResponse: string; originalMessage: string } | null = null;
  
  cleanExpiredTapeEntries(db);
  
  startScheduler(async (group, prompt) => {
    try {
      await processMessage(group, prompt, llmConfig);
    } catch (err) {
      console.error(`[cron] Error in group ${group}:`, (err as Error).message);
    }
  });
  
  while (true) {
    const input = await question(`[${currentGroup}]> `);
    
    if (input.startsWith("/quit") || input.startsWith("/exit")) {
      rl.close();
      console.log("Goodbye!");
      break;
    }
    
    if (input === "/list") {
      const groups = db.prepare("SELECT name, context_path FROM groups").all() as GroupInfo[];
      for (const g of groups) {
        const prefix = g.name === currentGroup ? "* " : "  ";
        console.log(`${prefix}${g.name} (${g.contextPath})`);
      }
      continue;
    }
    
    if (input === "/history") {
      const history = getHistory(currentGroup, 10);
      for (const h of history) {
        const preview = h.content.slice(0, 80).replace(/\n/g, " ");
        console.log(`  ${h.role}: ${preview}${h.content.length > 80 ? "..." : ""}`);
      }
      continue;
    }
    
    if (input === "/cred list") {
      const creds = listCredentials();
      if (creds.length === 0) {
        console.log("No credentials stored.");
      } else {
        console.log("Stored credentials:");
        for (const c of creds) {
          const lastUsed = c.lastUsed ? new Date(c.lastUsed).toLocaleString() : "never";
          const scope = c.scope || "-";
          console.log(`  ${c.name}  [scope: ${scope}]  [last used: ${lastUsed}]`);
        }
      }
      continue;
    }
    
    if (input.startsWith("/cred add ")) {
      const args = input.slice(10).trim().split(/\s+/);
      if (args.length < 1 || !args[0]) {
        console.log("Usage: /cred add <NAME> [SCOPE]");
        continue;
      }
      const name = args[0];
      const scope = args.length > 1 ? args.slice(1).join(" ") : undefined;
      
      const value = await question(`Enter value for ${name}: `);
      if (!value.trim()) {
        console.log("Cancelled - no value provided.");
        continue;
      }
      
      setCredential(name, value.trim(), scope);
      console.log(`Credential '${name}' stored.`);
      continue;
    }
    
    if (input.startsWith("/cred remove ")) {
      const name = input.slice(13).trim();
      if (!name) {
        console.log("Usage: /cred remove <NAME>");
        continue;
      }
      
      if (removeCredential(name)) {
        console.log(`Credential '${name}' removed.`);
      } else {
        console.log(`Credential '${name}' not found.`);
      }
      continue;
    }
    
    if (input.startsWith("/cred ")) {
      console.log("Usage: /cred list | /cred add <NAME> [SCOPE] | /cred remove <NAME>");
      continue;
    }
    
    if (input === "/cron list" || input.startsWith("/cron list ")) {
      const group = input.slice(11).trim() || undefined;
      const jobs = listCronJobs(db, group);
      if (jobs.length === 0) {
        console.log("No cron jobs found.");
      } else {
        console.log("Cron jobs:");
        for (const job of jobs) {
          const status = job.enabled ? "enabled" : "disabled";
          const lastRun = job.lastRun ? new Date(job.lastRun).toLocaleString() : "never";
          const nextRun = job.nextRun ? new Date(job.nextRun).toLocaleString() : "N/A";
          console.log(`  ${job.name} [${job.groupName}] [${status}]`);
          console.log(`    schedule: ${job.schedule}`);
          console.log(`    last: ${lastRun}, next: ${nextRun}`);
          console.log(`    prompt: ${job.prompt.slice(0, 50)}${job.prompt.length > 50 ? "..." : ""}`);
        }
      }
      continue;
    }
    
    if (input.startsWith("/cron add ")) {
      const args = input.slice(10).trim();
      const firstSpace = args.indexOf(" ");
      if (firstSpace === -1) {
        console.log("Usage: /cron add <NAME> <SCHEDULE> <PROMPT>");
        console.log("Schedule format: minute hour day-of-month month day-of-week");
        console.log("Example: /cron add check-api '0 * * * *' 'Check if the API is responding'");
        continue;
      }
      const name = args.slice(0, firstSpace);
      const rest = args.slice(firstSpace + 1);
      
      const scheduleMatch = rest.match(/^'([^']+)'\s+(.+)$/);
      const scheduleUnquoted = rest.match(/^(\S+)\s+(.+)$/);
      
      let schedule: string;
      let prompt: string;
      
      if (scheduleMatch) {
        schedule = scheduleMatch[1];
        prompt = scheduleMatch[2];
      } else if (scheduleUnquoted) {
        schedule = scheduleUnquoted[1];
        prompt = scheduleUnquoted[2];
      } else {
        console.log("Usage: /cron add <NAME> <SCHEDULE> <PROMPT>");
        continue;
      }
      
      const validation = validateSchedule(schedule);
      if (!validation.valid) {
        console.log(`Invalid schedule: ${validation.error}`);
        continue;
      }
      
      if (getCronJobByName(db, name)) {
        console.log(`Job '${name}' already exists. Use /cron remove ${name} first.`);
        continue;
      }
      
      addCronJob(db, { groupName: currentGroup, name, schedule, prompt });
      const nextRun = calculateNextRun(schedule);
      console.log(`Job '${name}' added. Next run: ${nextRun?.toLocaleString() || "N/A"}`);
      continue;
    }
    
    if (input.startsWith("/cron remove ")) {
      const name = input.slice(13).trim();
      if (!name) {
        console.log("Usage: /cron remove <NAME>");
        continue;
      }
      
      if (removeCronJob(db, name)) {
        console.log(`Job '${name}' removed.`);
      } else {
        console.log(`Job '${name}' not found.`);
      }
      continue;
    }
    
    if (input.startsWith("/cron enable ")) {
      const name = input.slice(13).trim();
      if (toggleCronJob(db, name, true)) {
        console.log(`Job '${name}' enabled.`);
      } else {
        console.log(`Job '${name}' not found.`);
      }
      continue;
    }
    
    if (input.startsWith("/cron disable ")) {
      const name = input.slice(14).trim();
      if (toggleCronJob(db, name, false)) {
        console.log(`Job '${name}' disabled.`);
      } else {
        console.log(`Job '${name}' not found.`);
      }
      continue;
    }
    
    if (input.startsWith("/cron ")) {
      console.log("Usage:");
      console.log("  /cron list [group]");
      console.log("  /cron add <NAME> <SCHEDULE> <PROMPT>");
      console.log("  /cron remove <NAME>");
      console.log("  /cron enable|disable <NAME>");
      console.log("Schedule: minute hour day-of-month month day-of-week (e.g., '0 * * * *' = hourly)");
      continue;
    }
    
    if (input === "/tape recent" || input.startsWith("/tape recent ")) {
      const hours = input.startsWith("/tape recent ") 
        ? parseInt(input.slice(13), 10) || 24 
        : 24;
      const summary = getRecentTapeSummary(db, currentGroup, hours);
      console.log(`\n${summary}\n`);
      continue;
    }
    
    if (input.startsWith("/tape search ")) {
      const query = input.slice(13).trim();
      if (!query) {
        console.log("Usage: /tape search <query>");
        continue;
      }
      const entries = queryTapeLog(db, { groupName: currentGroup, search: query, limit: 20 });
      if (entries.length === 0) {
        console.log("No matching entries found.");
      } else {
        console.log(`\nFound ${entries.length} entries:\n`);
        for (const entry of entries) {
          const time = entry.createdAt.toLocaleString();
          const preview = entry.content.length > 80 ? entry.content.slice(0, 80) + "..." : entry.content;
          console.log(`[${time}] ${entry.actionType}: ${preview.replace(/\n/g, " ")}`);
        }
      }
      continue;
    }
    
    if (input === "/tape stats") {
      const stats = getTapeStats(db);
      console.log("\nTape Log Statistics:");
      console.log(`  Total entries: ${stats.totalEntries}`);
      console.log(`  Oldest entry: ${stats.oldestEntry?.toLocaleString() || "N/A"}`);
      console.log(`  Expiring soon (< 3 days): ${stats.entriesExpiringSoon}`);
      console.log("  By type:");
      for (const [type, count] of Object.entries(stats.entriesByType)) {
        console.log(`    ${type}: ${count}`);
      }
      continue;
    }
    
    if (input.startsWith("/tape ")) {
      console.log("Usage:");
      console.log("  /tape recent [hours] - Show recent activity (default: 24h)");
      console.log("  /tape search <query> - Search tape logs");
      console.log("  /tape stats - Show tape statistics");
      continue;
    }
    
    if (input.startsWith("/switch ")) {
      const newGroup = input.slice(8).trim();
      if (getGroup(newGroup)) {
        currentGroup = newGroup;
      } else {
        console.log(`Unknown group: ${newGroup}`);
      }
      continue;
    }
    
    if (input.startsWith("@")) {
      const spaceIdx = input.indexOf(" ");
      if (spaceIdx === -1) {
        console.log("Usage: @<group> <message>");
        continue;
      }
      const group = input.slice(1, spaceIdx);
      const msg = input.slice(spaceIdx + 1);
      if (!getGroup(group)) {
        console.log(`Unknown group: ${group}. Create it first with /add ${group}`);
        continue;
      }
      currentGroup = group;
      const response = await processMessage(group, msg, llmConfig, {
        inputBuffer,
        onFeedback: (fb) => console.log(`\x1b[36m[Feedback: ${fb.slice(0, 30)}...]\x1b[0m`),
      });
      console.log(`\n${response}\n`);
      continue;
    }
    
    if (input.startsWith("/add ")) {
      const name = input.slice(5).trim();
      ensureGroup(name);
      console.log(`Created group: ${name}`);
      continue;
    }
    
    if (input.trim()) {
      if (pausedState && (input.toLowerCase() === "resume" || input.toLowerCase() === "continue")) {
        console.log("\x1b[32m▶️  Resuming...\x1b[0m");
        logTapeAction(db, currentGroup, "resume", "User resumed execution");
        const resumeMessage = "Continue from where you left off.";
        try {
          const response = await processMessage(currentGroup, resumeMessage, llmConfig, {
            inputBuffer,
            onFeedback: (fb) => console.log(`\x1b[36m[Feedback: ${fb.slice(0, 30)}...]\x1b[0m`),
          });
          if (typeof response === "object" && response.type === "paused") {
            pausedState = { group: currentGroup, partialResponse: response.partialResponse, originalMessage: input };
            console.log("\n\x1b[35m⏸️  Paused again. Type 'resume' to continue.\x1b[0m\n");
          } else {
            pausedState = null;
            console.log(`\n${response}\n`);
          }
        } catch (err) {
          console.error(`\nError: ${(err as Error).message}\n`);
        }
        continue;
      }
      
      if (pausedState) {
        console.log("\x1b[33m⏸️  You have a paused task. Type 'resume' to continue, or give new instructions.\x1b[0m");
        pausedState = null;
      }
      
      try {
        const response = await processMessage(currentGroup, input, llmConfig, {
          inputBuffer,
          onFeedback: (fb) => console.log(`\x1b[36m[Feedback: ${fb.slice(0, 30)}...]\x1b[0m`),
        });
        if (typeof response === "object" && response.type === "paused") {
          pausedState = { group: currentGroup, partialResponse: response.partialResponse, originalMessage: input };
          console.log("\n\x1b[35m⏸️  Paused. Type 'resume' to continue or give new instructions.\x1b[0m\n");
        } else {
          console.log(`\n${response}\n`);
        }
      } catch (err) {
        console.error(`\nError: ${(err as Error).message}\n`);
      }
    }
  }
}

