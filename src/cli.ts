#!/usr/bin/env node
import "dotenv/config";
import { repl, processMessage, ensureDefaultGroups, ensureGroup } from "./repl.js";
import { LLMConfig } from "./llm.js";
import { loadCredentials } from "./credentials.js";
import { startPlugins } from "./plugins/manager.js";

async function main(): Promise<void> {
  let stopPlugins: (() => Promise<void>) | null = null;

  try {
    loadCredentials();

    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.error("Error: No API key found.");
      console.error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.");
      process.exit(1);
    }

    const provider = process.env.NIXBOT_LLM_PROVIDER as "anthropic" | "openai" | "openai-compatible" || "anthropic";

    const llmConfig: LLMConfig = {
      provider,
      apiKey,
      model: process.env.NIXBOT_LLM_MODEL || (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o"),
      baseUrl: process.env.NIXBOT_LLM_BASE_URL,
    };

    ensureDefaultGroups();

    stopPlugins = await startPlugins({
      llmConfig,
      processMessage: async (group: string, message: string) => {
        const result = await processMessage(group, message, llmConfig);
        return typeof result === "string" ? result : result.partialResponse;
      },
      ensureGroup,
      log: (message: string) => console.log(message),
    });

    await repl(llmConfig);
  } finally {
    if (stopPlugins) {
      await stopPlugins();
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
