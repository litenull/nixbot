#!/usr/bin/env node
import "dotenv/config";
import { repl } from "./repl.js";
import { chat, LLMConfig } from "./llm.js";
import { loadCredentials } from "./credentials.js";

async function main(): Promise<void> {
  try {
    loadCredentials();
  } catch (err) {
    console.error(`Failed to load credentials: ${(err as Error).message}`);
    process.exit(1);
  }
  
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    console.error("Error: No API key found.");
    console.error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.");
    process.exit(1);
  }
  
  const provider = process.env.NANIX_LLM_PROVIDER as "anthropic" | "openai" | "openai-compatible" || "anthropic";
  
  const llmConfig: LLMConfig = {
    provider,
    apiKey,
    model: process.env.NANIX_LLM_MODEL || (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o"),
    baseUrl: process.env.NANIX_LLM_BASE_URL,
  };
  
  await repl(llmConfig);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
