import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import type { LLMConfig } from "./llm.js";
import { config } from "./config.js";
import { InputBuffer } from "./input-buffer.js";
import { setCredential } from "./credentials.js";
import { initGroupsTable, getGroup, registerGroup } from "./groups.js";
import { ensureGroupDir } from "./utils.js";
import { initCronTable } from "./cron.js";
import {
  initTapeTable,
  cleanExpiredTapeEntries,
  logTapeAction,
} from "./tape.js";
import { getErrorMessage } from "./utils.js";
import { processMessage as _processMessageImpl } from "./orchestrator/message-processor.js";
import { startScheduler, stopScheduler } from "./scheduler/cron-scheduler.js";
import { loadCommands, findCommand } from "./commands/index.js";
import type { CommandContext, ReplState } from "./types/repl.js";

export { InputBuffer };

export async function processMessage(
  group: string,
  message: string,
  llmConfig: LLMConfig,
): Promise<string | import("./types/repl.js").PauseResult> {
  return _processMessageImpl(db, group, message, llmConfig);
}

// Initialize directories and database
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, "ipc"), { recursive: true });

const db = new Database(join(config.dataDir, "nixbot.db"));

initGroupsTable(db);
initCronTable(db);
initTapeTable(db);

export function ensureGroup(name: string): void {
  const { groupPath } = ensureGroupDir(config.groupsDir, name);
  registerGroup(db, name, groupPath);
}

export function ensureDefaultGroups(): void {
  ensureGroup("main");
  ensureGroup("work");
}

export async function repl(llmConfig: LLMConfig): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const inputBuffer = new InputBuffer();
  const commands = loadCommands();

  const state: ReplState = {
    currentGroup: "main",
    pausedState: null,
  };

  ensureDefaultGroups();

  printWelcomeMessage();

  cleanExpiredTapeEntries(db);

  startScheduler(db, async (group, prompt) => {
    try {
      await _processMessageImpl(db, group, prompt, llmConfig);
    } catch (err) {
      console.error(`[cron] Error in group ${group}:`, getErrorMessage(err));
    }
  });

  while (true) {
    const input = await question(`[${state.currentGroup}]> `);

    // Handle paused state first
    if (state.pausedState) {
      const result = await handlePausedState(
        input,
        state,
        llmConfig,
        inputBuffer,
        db,
      );
      if (result === "continue") continue;
      if (result === "break") break;
    }

    // Find and execute command
    const command = findCommand(commands, input);
    if (command) {
      const ctx: CommandContext = {
        db,
        currentGroup: state.currentGroup,
        llmConfig,
        inputBuffer,
      };

      const result = await command.execute(input, ctx);

      // Handle special command results
      if (result === "__QUIT__") {
        rl.close();
        console.log("Goodbye!");
        break;
      }

      if (typeof result === "string") {
        if (result.startsWith("__PROMPT_FOR_CRED__")) {
          await handleCredPrompt(result, question);
        } else if (result.startsWith("__SWITCH_GROUP__")) {
          const newGroup = result.slice(17);
          state.currentGroup = newGroup;
        } else if (result.startsWith("__CREATE_GROUP__")) {
          const name = result.slice(17);
          ensureGroup(name);
          console.log(`Created group: ${name}`);
        } else {
          console.log(result);
        }
      }
      continue;
    }

    // Handle @group message syntax
    if (input.startsWith("@")) {
      await handleAtMessage(input, state, llmConfig, inputBuffer, db);
      continue;
    }

    // Default: process as regular message
    if (input.trim()) {
      await handleRegularMessage(input, state, llmConfig, inputBuffer, db);
    }
  }

  stopScheduler();
}

async function handlePausedState(
  input: string,
  state: ReplState,
  llmConfig: LLMConfig,
  inputBuffer: InputBuffer,
  db: Database.Database,
): Promise<string> {
  const normalizedInput = input.toLowerCase().trim();

  if (normalizedInput === "resume" || normalizedInput === "continue") {
    console.log("\x1b[32m▶️  Resuming...\x1b[0m");
    logTapeAction(db, state.currentGroup, "resume", "User resumed execution");

    try {
      const response = await _processMessageImpl(
        db,
        state.currentGroup,
        "Continue from where you left off.",
        llmConfig,
        {
          inputBuffer,
          onFeedback: (fb) =>
            console.log(`\x1b[36m[Feedback: ${fb.slice(0, 30)}...]\x1b[0m`),
        },
      );

      if (typeof response === "object" && response.type === "paused") {
        state.pausedState = {
          group: state.currentGroup,
          partialResponse: response.partialResponse,
          originalMessage: input,
        };
        console.log(
          "\n\x1b[35m⏸️  Paused again. Type 'resume' to continue.\x1b[0m\n",
        );
      } else {
        state.pausedState = null;
        console.log(`\n${response}\n`);
      }
    } catch (err) {
      console.error(`\nError: ${getErrorMessage(err)}\n`);
    }
    return "continue";
  }

  // New instruction while paused - cancel the pause
  console.log(
    "\x1b[33m⏸️  You have a paused task. Type 'resume' to continue, or give new instructions.\x1b[0m",
  );
  state.pausedState = null;
  return "continue";
}

async function handleCredPrompt(
  result: string,
  question: (prompt: string) => Promise<string>,
): Promise<void> {
  const [, name, scope] = result.split(":");
  const value = await question(`Enter value for ${name}: `);
  if (!value.trim()) {
    console.log("Cancelled - no value provided.");
    return;
  }
  setCredential(name, value.trim(), scope || undefined);
  console.log(`Credential '${name}' stored.`);
}

async function handleAtMessage(
  input: string,
  state: ReplState,
  llmConfig: LLMConfig,
  inputBuffer: InputBuffer,
  db: Database.Database,
): Promise<void> {
  const spaceIdx = input.indexOf(" ");
  if (spaceIdx === -1) {
    console.log("Usage: @<group> <message>");
    return;
  }

  const group = input.slice(1, spaceIdx);
  const msg = input.slice(spaceIdx + 1);

  if (!getGroup(db, group)) {
    console.log(`Unknown group: ${group}. Create it first with /add ${group}`);
    return;
  }

  state.currentGroup = group;
  const response = await _processMessageImpl(db, group, msg, llmConfig, {
    inputBuffer,
    onFeedback: (fb) =>
      console.log(`\x1b[36m[Feedback: ${fb.slice(0, 30)}...]\x1b[0m`),
  });
  console.log(`\n${response}\n`);
}

async function handleRegularMessage(
  input: string,
  state: ReplState,
  llmConfig: LLMConfig,
  inputBuffer: InputBuffer,
  db: Database.Database,
): Promise<void> {
  try {
    const response = await _processMessageImpl(
      db,
      state.currentGroup,
      input,
      llmConfig,
      {
        inputBuffer,
        onFeedback: (fb) =>
          console.log(`\x1b[36m[Feedback: ${fb.slice(0, 30)}...]\x1b[0m`),
      },
    );

    if (typeof response === "object" && response.type === "paused") {
      state.pausedState = {
        group: state.currentGroup,
        partialResponse: response.partialResponse,
        originalMessage: input,
      };
      console.log(
        "\n\x1b[35m⏸️  Paused. Type 'resume' to continue or give new instructions.\x1b[0m\n",
      );
    } else {
      console.log(`\n${response}\n`);
    }
  } catch (err) {
    console.error(`\nError: ${getErrorMessage(err)}\n`);
  }
}

function printWelcomeMessage(): void {
  console.log("\n  Nixbot Agent v0.1.0");
  console.log("  ───────────────────");
  console.log("  Commands:");
  console.log("    @<group> <msg>  - Send to group");
  console.log("    /switch <group> - Change active group");
  console.log("    /list           - List groups");
  console.log("    /history        - Show conversation history");
  console.log("    /cred list      - List stored credentials");
  console.log(
    "    /cred add <NAME> [SCOPE] - Add credential (prompts for value)",
  );
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
}
