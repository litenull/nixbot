import { z } from "zod";
import { request } from "https";
import { request as httpRequest } from "http";

const Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const ChatRequest = z.object({
  model: z.string(),
  messages: z.array(Message),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
});

type ChatRequestType = z.infer<typeof ChatRequest>;

export interface LLMConfig {
  provider: "anthropic" | "openai" | "openai-compatible";
  apiKey: string;
  baseUrl?: string;
  model: string;
}

function makeRequest(url: string, headers: Record<string, string>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https");
    const req = isHttps 
      ? request(url, { method: "POST", headers })
      : httpRequest(url, { method: "POST", headers });
    
    req.on("response", (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
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

export async function chat(config: LLMConfig, messages: Array<{ role: string; content: string }>): Promise<string> {
  const chatReq: ChatRequestType = {
    model: config.model,
    messages: messages.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
    max_tokens: 4096,
  };
  
  const body = JSON.stringify(chatReq);
  
  if (config.provider === "anthropic") {
    const res = await makeRequest(
      "https://api.anthropic.com/v1/messages",
      {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      JSON.stringify({
        model: config.model,
        max_tokens: 4096,
        messages: messages.filter(m => m.role !== "system").map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        system: messages.find(m => m.role === "system")?.content,
      })
    );
    
    const data = JSON.parse(res);
    return data.content?.[0]?.text ?? "";
  }
  
  const baseUrl = config.baseUrl || (config.provider === "openai" ? "https://api.openai.com" : "");
  const hasVersion = /\/v\d+\/?$/.test(baseUrl);
  const endpoint = hasVersion 
    ? `${baseUrl.replace(/\/$/, "")}/chat/completions`
    : `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  
  const res = await makeRequest(
    endpoint,
    {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body
  );
  
  const data = JSON.parse(res);
  return data.choices?.[0]?.message?.content ?? "";
}
