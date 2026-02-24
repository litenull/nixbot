import Database from "better-sqlite3";
import { z } from "zod";
import { spawn } from "child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
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

const config = z.object({
  groupsDir: z.string().default("./groups"),
  dataDir: z.string().default("./data"),
  sandboxBin: z.string().default("./result/bin/browser-agent"),
  llmProvider: z.enum(["anthropic", "openai", "openai-compatible"]).default("anthropic"),
  llmModel: z.string().default("claude-sonnet-4-20250514"),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
}).parse({
  groupsDir: process.env.NANIX_GROUPS_DIR,
  dataDir: process.env.NANIX_DATA_DIR,
  sandboxBin: process.env.NANIX_SANDBOX_BIN,
  llmProvider: process.env.NANIX_LLM_PROVIDER as "anthropic" | "openai" | "openai-compatible",
  llmModel: process.env.NANIX_LLM_MODEL,
  llmApiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
  llmBaseUrl: process.env.NANIX_LLM_BASE_URL,
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
}

function runInSandbox(group: string, command: string, timeout = 60000): Promise<SandboxResult> {
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
    
    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });
    
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      stderr += "\n[Timeout]";
    }, timeout);
    
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function processMessage(group: string, message: string, llmConfig: LLMConfig): Promise<string> {
  addMessage(group, "user", message);
  
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
- Commands run in an isolated sandbox with: curl, jq, git, chromium, node
- You have network access for web requests and API calls
- Workspace files are in the current directory
- You can schedule recurring tasks using /cron commands

RULES:
- Be concise and direct
- When asked to do something, do it (run commands as needed)
- Report results clearly
- If a command fails, explain what went wrong

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
   Example: /cron add check-website '0 9 * * *' 'Check https://example.com and summarize any changes'`;

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    ...history.slice(-10),
    { role: "user", content: message },
  ];
  
  let response: string;
  try {
    response = await chat(llmConfig, messages);
  } catch (err) {
    const error = err as Error;
    return `LLM error: ${error.message}`;
  }
  
  const bashBlocks = response.match(/```bash\n([\s\S]*?)```/g) || [];
  const allDetectedVars: string[] = [];
  
  for (const block of bashBlocks) {
    const cmd = block.replace(/```bash\n?/g, "").replace(/```/g, "").trim();
    if (!cmd) continue;
    
    allDetectedVars.push(...detectRequiredCreds(cmd));
    
    console.log(`[${group}] Running: ${cmd.split("\n")[0].slice(0, 50)}...`);
    
    const result = await runInSandbox(group, cmd);
    const output = result.stdout.trim() || result.stderr.trim() || "(no output)";
    
    const truncated = output.length > 2000 ? output.slice(0, 2000) + "\n... (truncated)" : output;
    response += `\n\n\`\`\`output\n${truncated}\n\`\`\``;
  }
  
  const cronAddPattern = /\/cron add (\S+) '([^']+)' '([^']+)'/g;
  let cronMatch;
  while ((cronMatch = cronAddPattern.exec(response)) !== null) {
    const [, name, schedule, promptText] = cronMatch;
    const validation = validateSchedule(schedule);
    if (!validation.valid) {
      response += `\n\n[Error: Invalid schedule '${schedule}': ${validation.error}]`;
      continue;
    }
    if (getCronJobByName(db, name)) {
      response += `\n\n[Error: Job '${name}' already exists]`;
      continue;
    }
    addCronJob(db, { groupName: group, name, schedule, prompt: promptText });
    const nextRun = calculateNextRun(schedule);
    response += `\n\n[Scheduled: '${name}' will run next at ${nextRun?.toLocaleString() || "N/A"}]`;
  }
  
  const maskedResponse = maskCredentials(response, allDetectedVars);
  
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
  
  registerGroup("main", join(config.groupsDir, "main"));
  registerGroup("work", join(config.groupsDir, "work"));
  
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
  console.log("    /quit           - Exit\n");
  
  let currentGroup = "main";
  
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
      const response = await processMessage(group, msg, llmConfig);
      console.log(`\n${response}\n`);
      continue;
    }
    
    if (input.startsWith("/add ")) {
      const name = input.slice(5).trim();
      const groupPath = join(config.groupsDir, name);
      mkdirSync(groupPath, { recursive: true });
      const claudeMd = join(groupPath, "CLAUDE.md");
      if (!existsSync(claudeMd)) {
        writeFileSync(claudeMd, `# ${name} Group\n\nContext for this group.\n`);
      }
      registerGroup(name, groupPath);
      console.log(`Created group: ${name}`);
      continue;
    }
    
    if (input.trim()) {
      try {
        const response = await processMessage(currentGroup, input, llmConfig);
        console.log(`\n${response}\n`);
      } catch (err) {
        console.error(`\nError: ${(err as Error).message}\n`);
      }
    }
  }
}


