import type Database from "better-sqlite3";
import type { LLMConfig } from "../llm.js";
import type { InputBuffer } from "../input-buffer.js";

export interface ProcessMessageOptions {
  inputBuffer?: InputBuffer;
  onFeedback?: (feedback: string) => void;
  isPaused?: () => boolean;
  onResume?: () => Promise<string | null>;
  sandboxBin?: string;
  maxToolRounds?: number;
}

export interface PauseResult {
  type: "paused";
  partialResponse: string;
}

export interface CommandContext {
  db: Database.Database;
  currentGroup: string;
  llmConfig: LLMConfig;
  inputBuffer: InputBuffer;
}

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  execute(input: string, ctx: CommandContext): Promise<string | void>;
  matches(input: string): boolean;
}

export interface ReplState {
  currentGroup: string;
  pausedState: {
    group: string;
    partialResponse: string;
    originalMessage: string;
  } | null;
}
