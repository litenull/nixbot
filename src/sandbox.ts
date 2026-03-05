import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";
import { chat, LLMConfig } from "./llm.js";
import { getRequiredCredsForCommand } from "./credentials.js";
import { InputBuffer } from "./input-buffer.js";
import { getErrorMessage } from "./utils.js";

// Constants for sandbox execution
const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds
const DEFAULT_POLL_INTERVAL_MS = 500; // 0.5 seconds

export interface EnvBlocklistEntry {
  pattern: RegExp;
  description: string;
}

export const envBlocklist: EnvBlocklistEntry[] = [
  { pattern: /_API_KEY$/i, description: "API keys" },
  { pattern: /_SECRET$/i, description: "Secrets" },
  { pattern: /_PASSWORD$/i, description: "Passwords" },
  { pattern: /_TOKEN$/i, description: "Tokens" },
  { pattern: /_CREDENTIAL/i, description: "Credentials" },
  { pattern: /^ANTHROPIC_/i, description: "Anthropic vars" },
  { pattern: /^OPENAI_/i, description: "OpenAI vars" },
  { pattern: /^AWS_/i, description: "AWS vars" },
  { pattern: /^GITHUB_/i, description: "GitHub vars" },
];

export function isBlockedEnvVar(key: string): boolean {
  return envBlocklist.some((entry) => entry.pattern.test(key));
}

export function filterEnvVars(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isBlockedEnvVar(key)) {
      safeEnv[key] = value;
    }
  }
  return safeEnv;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  code: number;
  interrupted?: boolean;
}

export interface SandboxOptions {
  inputBuffer?: InputBuffer;
  pollIntervalMs?: number;
  onFeedback?: (
    feedback: string,
    context: { command: string; partialOutput: string },
  ) => Promise<void>;
}

export function runInSandbox(
  sandboxBin: string,
  group: string,
  command: string,
  timeout = DEFAULT_TIMEOUT_MS,
  options?: SandboxOptions,
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const workspace = join(
      process.env.HOME || "/tmp",
      ".bwrapper",
      "nixbot",
      "groups",
      group,
    );
    mkdirSync(workspace, { recursive: true });

    const safeEnv = filterEnvVars(process.env);
    const credEnv = getRequiredCredsForCommand(command);

    const proc = spawn(sandboxBin, [command], {
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

    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    proc.stderr.on("data", (data) => {
      stderr += data;
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      stderr += "\n[Timeout]";
    }, timeout);

    let pollTimer: ReturnType<typeof setInterval> | null = null;

    if (options?.inputBuffer) {
      const pollInterval = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
      pollTimer = setInterval(async () => {
        try {
          if (
            options.inputBuffer!.isPauseRequested() ||
            options.inputBuffer!.isCancelRequested()
          ) {
            proc.kill("SIGTERM");
            interrupted = true;
            stderr += "\n[Interrupted by user]";
            if (pollTimer) clearInterval(pollTimer);
            return;
          }

          if (options.inputBuffer!.hasPending() && options?.onFeedback) {
            const feedbackItems = options
              .inputBuffer!.popAll()
              .filter((f) => f !== "__CANCEL__" && f !== "__PAUSE__");
            if (feedbackItems.length > 0) {
              const feedback = feedbackItems.join("\n");
              const partialOutput = (stdout + stderr).slice(-1000);
              await options.onFeedback(feedback, { command, partialOutput });
            }
          }
        } catch (err) {
          console.error(`[poll error] ${getErrorMessage(err)}`);
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

export interface SupervisorContext {
  originalTask: string;
  llmConfig: LLMConfig;
  group: string;
}

export async function handleLiveFeedback(
  feedback: string,
  context: { command: string; partialOutput: string },
  supervisorContext: SupervisorContext,
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
  } catch {
    return `Acknowledged: "${feedback.slice(0, 30)}..." (will be processed after current command)`;
  }
}
