import { LLMConfig } from "../llm.js";

export interface PluginContext {
  llmConfig: LLMConfig;
  processMessage: (group: string, message: string) => Promise<string>;
  ensureGroup: (name: string) => void;
  log: (message: string) => void;
}

export interface PluginHandle {
  stop: () => void | Promise<void>;
}

export interface BotPlugin {
  name: string;
  start: (context: PluginContext) => Promise<PluginHandle | void> | PluginHandle | void;
}
