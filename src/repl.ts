import Database from "better-sqlite3";
import { z } from "zod";
import { spawn } from "child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { chat, LLMConfig } from "./llm.js";

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

const db = new Database(join(config.dataDir, "nanix.db"));
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
    const workspace = join(process.env.HOME || "/tmp", ".bwrapper", "nanix", "groups", group);
    mkdirSync(workspace, { recursive: true });
    
    const proc = spawn(config.sandboxBin, [command], {
      env: {
        ...process.env,
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

RULES:
- Be concise and direct
- When asked to do something, do it (run commands as needed)
- Report results clearly
- If a command fails, explain what went wrong`;

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
  
  for (const block of bashBlocks) {
    const cmd = block.replace(/```bash\n?/g, "").replace(/```/g, "").trim();
    if (!cmd) continue;
    
    console.log(`[${group}] Running: ${cmd.split("\n")[0].slice(0, 50)}...`);
    
    const result = await runInSandbox(group, cmd);
    const output = result.stdout.trim() || result.stderr.trim() || "(no output)";
    
    const truncated = output.length > 2000 ? output.slice(0, 2000) + "\n... (truncated)" : output;
    response += `\n\n\`\`\`output\n${truncated}\n\`\`\``;
  }
  
  addMessage(group, "assistant", response);
  return response;
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
  
  console.log("\n  Nanix Agent v0.1.0");
  console.log("  ───────────────────");
  console.log("  Commands:");
  console.log("    @<group> <msg>  - Send to group");
  console.log("    /switch <group> - Change active group");
  console.log("    /list           - List groups");
  console.log("    /history        - Show conversation history");
  console.log("    /quit           - Exit\n");
  
  let currentGroup = "main";
  
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


