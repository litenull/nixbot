import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type Database from "better-sqlite3";
import { chat, type LLMConfig } from "../llm.js";
import {
  addCronJob,
  removeCronJob,
  listCronJobs,
  getCronJobByName,
  validateSchedule,
  calculateNextRun,
} from "../cron.js";
import { logTapeAction } from "../tape.js";
import { getGroup, addMessage, getHistory } from "../groups.js";
import { config } from "../config.js";
import {
  runInSandbox,
  handleLiveFeedback,
  type SupervisorContext,
  type SandboxOptions,
} from "../sandbox.js";
import {
  extractBashBlocks,
  truncateOutput,
  getErrorMessage,
} from "../utils.js";
import { detectRequiredCreds, maskCredentials } from "../credentials.js";
import type { ProcessMessageOptions, PauseResult } from "../types/repl.js";

export async function processMessage(
  db: Database.Database,
  group: string,
  message: string,
  llmConfig: LLMConfig,
  options?: ProcessMessageOptions,
): Promise<string | PauseResult> {
  addMessage(db, group, "user", message);
  logTapeAction(db, group, "llm_request", message);

  const groupInfo = getGroup(db, group);
  if (!groupInfo) {
    return `Unknown group: ${group}`;
  }

  console.log(`[${group}] Processing: ${message.slice(0, 60)}...`);

  const history = getHistory(db, group, 20);
  const contextPath = join(groupInfo.contextPath, "CLAUDE.md");
  const context = existsSync(contextPath)
    ? readFileSync(contextPath, "utf-8")
    : "";

  const systemPrompt = buildSystemPrompt(group, context);

  const conversationMessages: Array<{ role: string; content: string }> = [
    ...history.slice(-10),
    { role: "user", content: message },
  ];

  const sandboxBin = options?.sandboxBin ?? config.sandboxBin;
  const allDetectedVars: string[] = [];
  let accumulatedResponse = "";
  const maxRounds = options?.maxToolRounds ?? config.maxToolRounds;

  for (let round = 0; round < maxRounds; round++) {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      ...conversationMessages,
    ];

    let response: string;
    try {
      response = await chat(llmConfig, messages);
      logTapeAction(db, group, "llm_response", response.slice(0, 1000));
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      if (accumulatedResponse) {
        accumulatedResponse += `\n\n[LLM error on round ${round + 1}: ${errorMsg}]`;
        break;
      }
      return `LLM error: ${errorMsg}`;
    }

    const bashBlocks = extractBashBlocks(response);

    if (bashBlocks.length === 0) {
      if (accumulatedResponse) {
        accumulatedResponse += "\n\n" + response;
      } else {
        accumulatedResponse = response;
      }
      break;
    }

    if (accumulatedResponse) {
      accumulatedResponse += "\n\n" + response;
    } else {
      accumulatedResponse = response;
    }

    conversationMessages.push({ role: "assistant", content: response });

    let roundOutput = "";

    for (const cmd of bashBlocks) {
      allDetectedVars.push(...detectRequiredCreds(cmd));

      console.log(
        `[${group}] Round ${round + 1}: ${cmd.split("\n")[0].slice(0, 50)}...`,
      );
      logTapeAction(db, group, "command", cmd);

      if (options?.inputBuffer) {
        options.inputBuffer.enable();
      }

      const supervisorContext: SupervisorContext = {
        originalTask: message,
        llmConfig,
        group,
      };

      const sandboxOptions: SandboxOptions = {
        inputBuffer: options?.inputBuffer,
        onFeedback: async (feedback, context) => {
          logTapeAction(db, group, "feedback", feedback);
          console.log(
            `\x1b[36m↳ Processing: ${feedback.slice(0, 40)}...\x1b[0m`,
          );
          const supervisorResponse = await handleLiveFeedback(
            feedback,
            context,
            supervisorContext,
          );
          console.log(`\x1b[34m💬 ${supervisorResponse}\x1b[0m`);
        },
      };

      const result = await runInSandbox(
        sandboxBin,
        group,
        cmd,
        60000,
        sandboxOptions,
      );

      if (options?.inputBuffer) {
        options.inputBuffer.disable();
      }

      if (options?.inputBuffer?.isPauseRequested()) {
        options.inputBuffer.consumePause();
        logTapeAction(db, group, "pause", "User requested pause");
        console.log(
          "\x1b[35m⏸️  Paused. Type 'resume' to continue or give new instructions.\x1b[0m",
        );

        const partialOutput = result.interrupted
          ? result.stdout.trim() ||
            result.stderr.trim() ||
            "(command interrupted)"
          : result.stdout.trim() || result.stderr.trim() || "(no output)";

        accumulatedResponse += `\n\n\`\`\`output\n${truncateOutput(partialOutput)}\n\`\`\``;

        return {
          type: "paused",
          partialResponse: accumulatedResponse,
        };
      }

      if (options?.inputBuffer?.isCancelRequested()) {
        options.inputBuffer.consumeCancel();
        logTapeAction(db, group, "cancel", "User cancelled execution");
        accumulatedResponse += "\n\n[Execution cancelled by user]";
        const maskedResponse = maskCredentials(
          accumulatedResponse,
          allDetectedVars,
        );
        addMessage(db, group, "assistant", maskedResponse);
        return maskedResponse;
      }

      const output =
        result.stdout.trim() || result.stderr.trim() || "(no output)";
      const truncated = truncateOutput(output);
      accumulatedResponse += `\n\n\`\`\`output\n${truncated}\n\`\`\``;
      logTapeAction(db, group, "output", truncated);

      roundOutput += `Command: ${cmd.split("\n")[0].slice(0, 60)}\nOutput:\n${truncated}\n\n`;
    }

    conversationMessages.push({
      role: "user",
      content: `[Tool results for round ${round + 1}]\n${roundOutput}`,
    });
  }

  if (accumulatedResponse.includes("Maximum tool rounds reached")) {
    accumulatedResponse +=
      "\n\n[Warning: Reached maximum tool execution rounds]";
  }

  accumulatedResponse = processCronCommands(db, group, accumulatedResponse);

  const maskedResponse = maskCredentials(accumulatedResponse, allDetectedVars);
  addMessage(db, group, "assistant", maskedResponse);
  return maskedResponse;
}

function buildSystemPrompt(group: string, context: string): string {
  return `You are a helpful assistant working in a sandboxed environment.

GROUP: ${group}
${context ? `\nGROUP CONTEXT:\n${context}\n` : ""}
CAPABILITIES:
- You can run bash commands by responding with \`\`\`bash blocks
- Commands run in a Nix sandbox with: curl, jq, git, chromium, node
- You have network access for web requests and API calls
- Workspace files are in the current directory
- You can schedule recurring tasks using /cron commands
- You can query past activity with /tape commands

MULTI-TURN EXECUTION:
- You can run multiple rounds of commands
- After executing your commands, you'll receive the output and can decide what to do next
- If a command fails, you can inspect the error, fix it, and try again
- If you need to read a file to decide your next step, run a command to read it
- When your task is complete, respond WITHOUT any \`\`\`bash blocks to stop execution
- Break complex tasks into steps: observe → decide → act → observe again
- You have up to ${config.maxToolRounds} rounds of tool execution - use them wisely

NIX SANDBOX NOTES:
- DO NOT use shebangs (#!/bin/bash, #!/usr/bin/env) - they don't work
- Instead, run scripts directly: bash script.sh or bash -c 'commands'
- Write multi-line scripts with heredocs, then run with bash

RULES:
- Be concise and direct
- When asked to do something, do it (run commands as needed)
- Report results clearly
- If a command fails, explain what went wrong and try to fix it
- Always respond WITHOUT bash blocks when your task is done

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
- /cron disable <name> - Disable a disabled job`;
}

function processCronCommands(
  db: Database.Database,
  group: string,
  response: string,
): string {
  let result = response;

  const cronAddPattern = /\/cron add (\S+) '([^']+)' '([^']+)'/g;
  let match;
  while ((match = cronAddPattern.exec(response)) !== null) {
    const [, name, schedule, promptText] = match;
    const validation = validateSchedule(schedule);
    if (!validation.valid) {
      result += `\n\n[Error: Invalid schedule '${schedule}': ${validation.error}]`;
      continue;
    }
    if (getCronJobByName(db, name)) {
      result += `\n\n[Error: Job '${name}' already exists]`;
      continue;
    }
    addCronJob(db, { groupName: group, name, schedule, prompt: promptText });
    const nextRun = calculateNextRun(schedule);
    result += `\n\n[Scheduled: '${name}' will run next at ${nextRun?.toLocaleString() || "N/A"}]`;
  }

  const cronRemovePattern = /\/cron remove (\S+)/g;
  while ((match = cronRemovePattern.exec(response)) !== null) {
    const [, name] = match;
    if (removeCronJob(db, name)) {
      result += `\n\n[Removed cron job '${name}']`;
    } else {
      result += `\n\n[Error: No cron job named '${name}']`;
    }
  }

  if (/\/cron list/.test(response)) {
    const jobs = listCronJobs(db);
    if (jobs.length === 0) {
      result += `\n\n[No cron jobs scheduled]`;
    } else {
      const jobList = jobs
        .map(
          (j) =>
            `- ${j.name}: ${j.schedule} (${j.enabled ? "enabled" : "disabled"}, next: ${j.nextRun?.toLocaleString() || "N/A"})`,
        )
        .join("\n");
      result += `\n\n[Cron jobs:]\n${jobList}`;
    }
  }

  return result;
}
