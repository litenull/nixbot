import { telegramPlugin } from "./telegram.js";
import { BotPlugin, PluginContext, PluginHandle } from "./types.js";

const builtInPlugins: Record<string, BotPlugin> = {
  telegram: telegramPlugin,
};

function parseEnabledPlugins(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

export async function startPlugins(context: PluginContext): Promise<() => Promise<void>> {
  const enabled = parseEnabledPlugins(process.env.NIXBOT_PLUGINS);

  if (enabled.length === 0) {
    context.log("[plugins] No plugins enabled (set NIXBOT_PLUGINS)");
    return async () => {};
  }

  const handles: PluginHandle[] = [];

  for (const name of enabled) {
    const plugin = builtInPlugins[name];
    if (!plugin) {
      context.log(`[plugins] Unknown plugin: ${name}`);
      continue;
    }

    try {
      const handle = await plugin.start(context);
      if (handle) {
        handles.push(handle);
      }
    } catch (err) {
      context.log(`[plugins] Failed to start '${name}': ${(err as Error).message}`);
    }
  }

  return async () => {
    for (const handle of handles.reverse()) {
      await handle.stop();
    }
  };
}
