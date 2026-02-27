import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { startPlugins } from "../src/plugins/manager.js";
import { PluginContext } from "../src/plugins/types.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function makeContext(logs: string[]): PluginContext {
  return {
    llmConfig: {
      provider: "openai",
      apiKey: "test",
      model: "test",
    },
    processMessage: async () => "ok",
    ensureGroup: () => {},
    log: (message: string) => logs.push(message),
  };
}

await describe("plugin manager", async () => {
  await it("logs when no plugins are enabled", async () => {
    await withEnv({ NIXBOT_PLUGINS: undefined, NIXBOT_TELEGRAM_BOT_TOKEN: undefined }, async () => {
      const logs: string[] = [];
      const stop = await startPlugins(makeContext(logs));
      await stop();

      assert.equal(logs.includes("[plugins] No plugins enabled (set NIXBOT_PLUGINS)"), true);
    });
  });

  await it("logs unknown plugins", async () => {
    await withEnv({ NIXBOT_PLUGINS: "unknown-plugin", NIXBOT_TELEGRAM_BOT_TOKEN: undefined }, async () => {
      const logs: string[] = [];
      const stop = await startPlugins(makeContext(logs));
      await stop();

      assert.equal(logs.includes("[plugins] Unknown plugin: unknown-plugin"), true);
    });
  });

  await it("starts telegram plugin and skips when token is missing", async () => {
    await withEnv({ NIXBOT_PLUGINS: " TELEGRAM ", NIXBOT_TELEGRAM_BOT_TOKEN: undefined }, async () => {
      const logs: string[] = [];
      const stop = await startPlugins(makeContext(logs));
      await stop();

      assert.equal(logs.includes("[plugin:telegram] Skipping (NIXBOT_TELEGRAM_BOT_TOKEN is not set)"), true);
    });
  });
});
