import { z } from "zod";
import { BotPlugin, PluginContext, PluginHandle } from "./types.js";

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  text?: string;
  chat: { id: number };
  from?: { is_bot?: boolean };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

interface TelegramSendResponse {
  ok: boolean;
}

const telegramEnvSchema = z.object({
  token: z.string().optional(),
  defaultGroup: z.string().default("main"),
  allowedChatIdsRaw: z.string().optional(),
  pollTimeoutSeconds: z.coerce.number().int().min(1).max(60).default(20),
});

function telegramApiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

export function parseAllowedChatIds(raw?: string): Set<number> | null {
  if (!raw || !raw.trim()) {
    return null;
  }

  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n));

  return ids.length > 0 ? new Set(ids) : null;
}

export function parseGroupCommand(text: string): string | null {
  const match = text
    .trim()
    .match(/^\/group(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]+)$/);
  return match ? match[1] : null;
}

export function splitTelegramMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < Math.floor(maxLen * 0.5)) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, "");
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

async function getUpdates(
  token: string,
  offset: number,
  timeoutSeconds: number,
): Promise<TelegramUpdate[]> {
  const res = await fetch(telegramApiUrl(token, "getUpdates"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    }),
  });

  if (!res.ok) {
    throw new Error(`Telegram getUpdates failed (${res.status})`);
  }

  const data = (await res.json()) as TelegramGetUpdatesResponse;
  if (!data.ok) {
    throw new Error("Telegram getUpdates returned ok=false");
  }

  return data.result;
}

async function sendMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  const res = await fetch(telegramApiUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed (${res.status})`);
  }

  const data = (await res.json()) as TelegramSendResponse;
  if (!data.ok) {
    throw new Error("Telegram sendMessage returned ok=false");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const telegramPlugin: BotPlugin = {
  name: "telegram",
  start(context: PluginContext): PluginHandle | void {
    const telegramEnv = telegramEnvSchema.parse({
      token: process.env.NIXBOT_TELEGRAM_BOT_TOKEN,
      defaultGroup: process.env.NIXBOT_TELEGRAM_GROUP,
      allowedChatIdsRaw: process.env.NIXBOT_TELEGRAM_ALLOWED_CHAT_IDS,
      pollTimeoutSeconds: process.env.NIXBOT_TELEGRAM_POLL_TIMEOUT_SECONDS,
    });

    const token = telegramEnv.token;
    if (!token) {
      context.log(
        "[plugin:telegram] Skipping (NIXBOT_TELEGRAM_BOT_TOKEN is not set)",
      );
      return;
    }

    const allowedChatIds = parseAllowedChatIds(telegramEnv.allowedChatIdsRaw);
    const defaultGroup = telegramEnv.defaultGroup;

    context.ensureGroup(defaultGroup);

    let stopped = false;
    let offset = 0;
    const chatGroupMap = new Map<number, string>();

    const run = async () => {
      context.log(`[plugin:telegram] Started (default group: ${defaultGroup})`);

      while (!stopped) {
        try {
          const updates = await getUpdates(
            token,
            offset,
            telegramEnv.pollTimeoutSeconds,
          );

          for (const update of updates) {
            offset = Math.max(offset, update.update_id + 1);
            const message = update.message;
            if (!message?.text) {
              continue;
            }
            if (message.from?.is_bot) {
              continue;
            }

            const chatId = message.chat.id;
            if (allowedChatIds && !allowedChatIds.has(chatId)) {
              continue;
            }

            const text = message.text.trim();

            if (/^\/(start|help)(?:@[A-Za-z0-9_]+)?(?:\s+.*)?$/i.test(text)) {
              const help = [
                "Nixbot Telegram plugin is active.",
                "",
                `Current group: ${chatGroupMap.get(chatId) || defaultGroup}`,
                "Use /group <name> to switch group for this chat.",
                "Then send normal messages to run tasks.",
              ].join("\n");
              await sendMessage(token, chatId, help);
              continue;
            }

            const requestedGroup = parseGroupCommand(text);
            if (requestedGroup) {
              context.ensureGroup(requestedGroup);
              chatGroupMap.set(chatId, requestedGroup);
              await sendMessage(
                token,
                chatId,
                `Group set to '${requestedGroup}'.`,
              );
              continue;
            }

            const group = chatGroupMap.get(chatId) || defaultGroup;
            context.ensureGroup(group);

            context.log(`[plugin:telegram] chat ${chatId} -> group ${group}`);
            const response = await context.processMessage(group, text);
            const chunks = splitTelegramMessage(response);
            for (const chunk of chunks) {
              await sendMessage(token, chatId, chunk);
            }
          }
        } catch (err) {
          if (stopped) {
            break;
          }
          context.log(`[plugin:telegram] Error: ${(err as Error).message}`);
          await sleep(3000);
        }
      }

      context.log("[plugin:telegram] Stopped");
    };

    void run();

    return {
      stop: () => {
        stopped = true;
      },
    };
  },
};
