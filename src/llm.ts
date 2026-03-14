import { z } from "zod";
import { request } from "https";
import { request as httpRequest } from "http";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_BASE_URL = "https://api.openai.com";

// Constants for LLM API
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Initial retry delay

const Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const _ChatRequest = z.object({
  model: z.string(),
  messages: z.array(Message),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
});

type ChatRequestType = z.infer<typeof _ChatRequest>;

export interface LLMConfig {
  provider: "anthropic" | "openai" | "openai-compatible";
  apiKey: string;
  baseUrl?: string;
  model: string;
}

function makeRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https");
    const req = isHttps
      ? request(url, { method: "POST", headers })
      : httpRequest(url, { method: "POST", headers });

    // Set timeout
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    });

    req.on("response", (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: Error): boolean {
  // Retry on network errors and timeout errors
  const message = error.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up")
  );
}

function isRetryableStatus(statusCode: number): boolean {
  // Retry on 5xx server errors and rate limiting (429)
  return statusCode >= 500 || statusCode === 429;
}

async function makeRequestWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = MAX_RETRIES,
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await makeRequest(url, headers, body, timeoutMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const shouldRetry =
        isRetryableError(lastError) ||
        (lastError.message.includes("HTTP") &&
          isRetryableStatus(
            parseInt(lastError.message.match(/HTTP (\d+)/)?.[1] || "0", 10),
          ));

      if (!shouldRetry || attempt === retries) {
        throw lastError;
      }

      // Exponential backoff: 1s, 2s, 4s
      const backoffMs = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `[llm] Request failed (attempt ${attempt}/${retries}), retrying in ${backoffMs}ms: ${lastError.message}`,
      );
      await delay(backoffMs);
    }
  }

  throw lastError || new Error("Request failed after retries");
}

export async function chat(
  config: LLMConfig,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const chatReq: ChatRequestType = {
    model: config.model,
    messages: messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    })),
    max_tokens: DEFAULT_MAX_TOKENS,
  };

  let endpoint = "";
  let headers: Record<string, string> = {};
  let payload: unknown;

  if (config.provider === "anthropic") {
    endpoint = ANTHROPIC_MESSAGES_URL;
    headers = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    payload = {
      model: config.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      system: messages.find((m) => m.role === "system")?.content,
    };
  } else {
    const baseUrl =
      config.baseUrl || (config.provider === "openai" ? OPENAI_BASE_URL : "");
    const hasVersion = /\/v\d+\/?$/.test(baseUrl);
    endpoint = hasVersion
      ? `${baseUrl.replace(/\/$/, "")}/chat/completions`
      : `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
    payload = chatReq;
  }

  const res = await makeRequestWithRetry(
    endpoint,
    headers,
    JSON.stringify(payload),
  );

  const data = JSON.parse(res);
  if (config.provider === "anthropic") {
    return data.content?.[0]?.text ?? "";
  }

  return data.choices?.[0]?.message?.content ?? "";
}
