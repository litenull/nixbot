import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { chat } from "../src/llm.js";


function buildEndpoint(baseUrl: string, provider: string): string {
  const hasVersion = /\/v\d+\/?$/.test(baseUrl);
  const endpoint = hasVersion 
    ? `${baseUrl.replace(/\/$/, "")}/chat/completions`
    : `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  return endpoint;
}

function buildOpenAIBody(model: string, messages: Array<{ role: string; content: string }>): object {
  return {
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    max_tokens: 4096,
  };
}

function buildAnthropicBody(model: string, messages: Array<{ role: string; content: string }>): object {
  return {
    model,
    max_tokens: 4096,
    messages: messages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "user" || m.role === "assistant" ? m.role : "user",
      content: m.content,
    })),
    system: messages.find(m => m.role === "system")?.content,
  };
}

function parseOpenAIResponse(data: { choices?: Array<{ message?: { content?: string } }> }): string {
  return data.choices?.[0]?.message?.content ?? "";
}

function parseAnthropicResponse(data: { content?: Array<{ text?: string }> }): string {
  return data.content?.[0]?.text ?? "";
}

function extractBashBlocks(text: string): string[] {
  const pattern = /```bash\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const cmd = match[1].trim();
    if (cmd) blocks.push(cmd);
  }
  return blocks;
}

function extractCronCommands(text: string): { type: string; args: string[] }[] {
  const commands: { type: string; args: string[] }[] = [];
  
  const addPattern = /\/cron add (\S+) '([^']+)' '([^']+)'/g;
  let match;
  while ((match = addPattern.exec(text)) !== null) {
    commands.push({ type: "add", args: [match[1], match[2], match[3]] });
  }
  
  const removePattern = /\/cron remove (\S+)/g;
  while ((match = removePattern.exec(text)) !== null) {
    commands.push({ type: "remove", args: [match[1]] });
  }
  
  if (/\/cron list/.test(text)) {
    commands.push({ type: "list", args: [] });
  }
  
  return commands;
}

function buildSystemPrompt(group: string, context: string): string {
  return `You are a helpful assistant working in a sandboxed environment.

GROUP: ${group}
${context ? `\nGROUP CONTEXT:\n${context}\n` : ""}
CAPABILITIES:
- You can run bash commands by responding with \`\`\`bash blocks
- Commands run in an isolated sandbox`;
}

function validateMessages(messages: Array<{ role: string; content: string }>): { valid: boolean; error?: string } {
  const validRoles = ["system", "user", "assistant"];
  
  for (const msg of messages) {
    if (!validRoles.includes(msg.role)) {
      return { valid: false, error: `Invalid role: ${msg.role}` };
    }
    if (typeof msg.content !== "string") {
      return { valid: false, error: "Content must be a string" };
    }
    if (msg.content.length === 0) {
      return { valid: false, error: "Content cannot be empty" };
    }
  }
  
  return { valid: true };
}

function maskCredentialsInOutput(output: string, credentials: Map<string, string>): string {
  let masked = output;
  for (const [name, value] of credentials) {
    masked = masked.split(value).join("***");
  }
  return masked;
}

await describe("llm endpoint construction", async () => {
  
  await describe("buildEndpoint", async () => {
    
    await it("adds /v1/chat/completions to base URL without version", async () => {
      const endpoint = buildEndpoint("https://api.example.com", "openai-compatible");
      assert.strictEqual(endpoint, "https://api.example.com/v1/chat/completions");
    });
    
    await it("adds /chat/completions to base URL with /v1", async () => {
      const endpoint = buildEndpoint("https://api.example.com/v1", "openai-compatible");
      assert.strictEqual(endpoint, "https://api.example.com/v1/chat/completions");
    });
    
    await it("adds /chat/completions to base URL with /v2", async () => {
      const endpoint = buildEndpoint("https://api.example.com/v2", "openai-compatible");
      assert.strictEqual(endpoint, "https://api.example.com/v2/chat/completions");
    });
    
    await it("handles trailing slash without version", async () => {
      const endpoint = buildEndpoint("https://api.example.com/", "openai-compatible");
      assert.strictEqual(endpoint, "https://api.example.com/v1/chat/completions");
    });
    
    await it("handles trailing slash with version", async () => {
      const endpoint = buildEndpoint("https://api.example.com/v1/", "openai-compatible");
      assert.strictEqual(endpoint, "https://api.example.com/v1/chat/completions");
    });
    
    await it("handles complex URL paths", async () => {
      const endpoint = buildEndpoint("https://api.example.com/proxy/openai/v1", "openai-compatible");
      assert.strictEqual(endpoint, "https://api.example.com/proxy/openai/v1/chat/completions");
    });
  });
});

await describe("request body building", async () => {
  
  await describe("buildOpenAIBody", async () => {
    
    await it("builds correct request body", async () => {
      const messages = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ];
      const body = buildOpenAIBody("gpt-4o", messages);
      
      assert.strictEqual((body as any).model, "gpt-4o");
      assert.strictEqual((body as any).messages.length, 2);
      assert.strictEqual((body as any).max_tokens, 4096);
    });
    
    await it("includes all message roles", async () => {
      const messages = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "User message" },
        { role: "assistant", content: "Assistant response" },
      ];
      const body = buildOpenAIBody("gpt-4", messages);
      
      assert.strictEqual((body as any).messages[0].role, "system");
      assert.strictEqual((body as any).messages[1].role, "user");
      assert.strictEqual((body as any).messages[2].role, "assistant");
    });
  });
  
  await describe("buildAnthropicBody", async () => {
    
    await it("separates system prompt from messages", async () => {
      const messages = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ];
      const body = buildAnthropicBody("claude-3", messages);
      
      assert.strictEqual((body as any).system, "You are helpful");
      assert.strictEqual((body as any).messages.length, 1);
      assert.strictEqual((body as any).messages[0].role, "user");
    });
    
    await it("handles messages without system prompt", async () => {
      const messages = [
        { role: "user", content: "Hello" },
      ];
      const body = buildAnthropicBody("claude-3", messages);
      
      assert.strictEqual((body as any).system, undefined);
      assert.strictEqual((body as any).messages.length, 1);
    });
    
    await it("excludes assistant messages from system field", async () => {
      const messages = [
        { role: "system", content: "System" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ];
      const body = buildAnthropicBody("claude-3", messages);
      
      assert.strictEqual((body as any).system, "System");
      assert.strictEqual((body as any).messages.length, 2);
    });
  });
});

await describe("response parsing", async () => {
  
  await describe("parseOpenAIResponse", async () => {
    
    await it("extracts content from valid response", async () => {
      const response = {
        choices: [{ message: { content: "Hello, world!" } }],
      };
      assert.strictEqual(parseOpenAIResponse(response), "Hello, world!");
    });
    
    await it("returns empty string for missing choices", async () => {
      assert.strictEqual(parseOpenAIResponse({}), "");
      assert.strictEqual(parseOpenAIResponse({ choices: [] }), "");
    });
    
    await it("returns empty string for missing message", async () => {
      assert.strictEqual(parseOpenAIResponse({ choices: [{}] }), "");
    });
    
    await it("handles multiline content", async () => {
      const response = {
        choices: [{ message: { content: "Line 1\nLine 2\nLine 3" } }],
      };
      assert.ok(parseOpenAIResponse(response).includes("\n"));
    });
  });
  
  await describe("parseAnthropicResponse", async () => {
    
    await it("extracts content from valid response", async () => {
      const response = {
        content: [{ text: "Hello from Claude!" }],
      };
      assert.strictEqual(parseAnthropicResponse(response), "Hello from Claude!");
    });
    
    await it("returns empty string for missing content", async () => {
      assert.strictEqual(parseAnthropicResponse({}), "");
      assert.strictEqual(parseAnthropicResponse({ content: [] }), "");
    });
    
    await it("returns empty string for missing text", async () => {
      assert.strictEqual(parseAnthropicResponse({ content: [{}] }), "");
    });
  });
});

await describe("bash block extraction", async () => {
  
  await it("extracts single bash block", async () => {
    const text = "Here's a command:\n```bash\necho hello\n```\nDone.";
    const blocks = extractBashBlocks(text);
    assert.deepStrictEqual(blocks, ["echo hello"]);
  });
  
  await it("extracts multiple bash blocks", async () => {
    const text = "First:\n```bash\necho one\n```\nSecond:\n```bash\necho two\n```";
    const blocks = extractBashBlocks(text);
    assert.deepStrictEqual(blocks, ["echo one", "echo two"]);
  });
  
  await it("handles multiline commands", async () => {
    const text = "```bash\ncurl -X POST \\\n  -H 'Content-Type: json' \\\n  https://api.example.com\n```";
    const blocks = extractBashBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0].includes("curl"));
  });
  
  await it("ignores non-bash code blocks", async () => {
    const text = "```json\n{\"key\": \"value\"}\n```\n```bash\necho hello\n```";
    const blocks = extractBashBlocks(text);
    assert.deepStrictEqual(blocks, ["echo hello"]);
  });
  
  await it("returns empty array when no bash blocks", async () => {
    const text = "Just some text without code blocks.";
    const blocks = extractBashBlocks(text);
    assert.deepStrictEqual(blocks, []);
  });
  
  await it("handles empty bash block", async () => {
    const text = "```bash\n\n```";
    const blocks = extractBashBlocks(text);
    assert.deepStrictEqual(blocks, []);
  });
  
  await it("extracts commands with pipes", async () => {
    const text = "```bash\ncat file.txt | grep pattern | wc -l\n```";
    const blocks = extractBashBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0].includes("|"));
  });
  
  await it("extracts commands with subshells", async () => {
    const text = "```bash\necho \"Result: $(date)\"\n```";
    const blocks = extractBashBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0].includes("$(date)"));
  });
});

await describe("cron command extraction", async () => {
  
  await it("extracts /cron add command", async () => {
    const text = "I'll schedule this:\n/cron add check-site '0 9 * * *' 'Check the website'";
    const commands = extractCronCommands(text);
    
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].type, "add");
    assert.deepStrictEqual(commands[0].args, ["check-site", "0 9 * * *", "Check the website"]);
  });
  
  await it("extracts /cron remove command", async () => {
    const text = "Removing the job:\n/cron remove old-job";
    const commands = extractCronCommands(text);
    
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].type, "remove");
    assert.deepStrictEqual(commands[0].args, ["old-job"]);
  });
  
  await it("extracts /cron list command", async () => {
    const text = "Let me check:\n/cron list";
    const commands = extractCronCommands(text);
    
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].type, "list");
  });
  
  await it("extracts multiple cron commands", async () => {
    const text = `
First: /cron add job1 '*/5 * * * *' 'Run every 5 min'
Then: /cron remove old-job
Finally: /cron list
`;
    const commands = extractCronCommands(text);
    
    assert.strictEqual(commands.length, 3);
    assert.strictEqual(commands[0].type, "add");
    assert.strictEqual(commands[1].type, "remove");
    assert.strictEqual(commands[2].type, "list");
  });
  
  await it("handles prompts with URLs and query params", async () => {
    const text = "/cron add test '0 * * * *' 'Check https://example.com?foo=bar&baz=qux'";
    const commands = extractCronCommands(text);
    
    assert.strictEqual(commands.length, 1);
    assert.ok(commands[0].args[2].includes("https://"));
    assert.ok(commands[0].args[2].includes("foo=bar"));
  });
  
  await it("handles prompts with colons and spaces", async () => {
    const text = "/cron add report '0 9 * * *' 'Generate report: daily summary'";
    const commands = extractCronCommands(text);
    
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].args[2], "Generate report: daily summary");
  });
});

await describe("system prompt building", async () => {
  
  await it("includes group name", async () => {
    const prompt = buildSystemPrompt("work", "");
    assert.ok(prompt.includes("GROUP: work"));
  });
  
  await it("includes context when provided", async () => {
    const prompt = buildSystemPrompt("main", "This is a testing group.");
    assert.ok(prompt.includes("GROUP CONTEXT:"));
    assert.ok(prompt.includes("This is a testing group."));
  });
  
  await it("omits context section when empty", async () => {
    const prompt = buildSystemPrompt("main", "");
    assert.ok(!prompt.includes("GROUP CONTEXT:"));
  });
  
  await it("includes capabilities section", async () => {
    const prompt = buildSystemPrompt("main", "");
    assert.ok(prompt.includes("CAPABILITIES:"));
    assert.ok(prompt.includes("bash"));
  });
});

await describe("message validation", async () => {
  
  await it("validates correct messages", async () => {
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];
    const result = validateMessages(messages);
    assert.strictEqual(result.valid, true);
  });
  
  await it("rejects invalid role", async () => {
    const messages = [
      { role: "invalid", content: "Test" },
    ];
    const result = validateMessages(messages);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("Invalid role"));
  });
  
  await it("rejects empty content", async () => {
    const messages = [
      { role: "user", content: "" },
    ];
    const result = validateMessages(messages);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("empty"));
  });
  
  await it("rejects non-string content", async () => {
    const messages = [
      { role: "user", content: 123 as any },
    ];
    const result = validateMessages(messages);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("string"));
  });
});

await describe("credential masking", async () => {
  
  await it("masks single credential", async () => {
    const output = "Token: secret123";
    const creds = new Map([["API_TOKEN", "secret123"]]);
    const masked = maskCredentialsInOutput(output, creds);
    
    assert.strictEqual(masked, "Token: ***");
  });
  
  await it("masks multiple credentials", async () => {
    const output = "User: admin Pass: password123 Key: abc456";
    const creds = new Map([
      ["PASSWORD", "password123"],
      ["API_KEY", "abc456"],
    ]);
    const masked = maskCredentialsInOutput(output, creds);
    
    assert.ok(!masked.includes("password123"));
    assert.ok(!masked.includes("abc456"));
    assert.ok(masked.includes("admin"));
  });
  
  await it("handles credential appearing multiple times", async () => {
    const output = "Key: mykey and again: mykey";
    const creds = new Map([["KEY", "mykey"]]);
    const masked = maskCredentialsInOutput(output, creds);
    
    assert.strictEqual(masked, "Key: *** and again: ***");
  });
  
  await it("handles empty credentials map", async () => {
    const output = "No secrets here";
    const creds = new Map();
    const masked = maskCredentialsInOutput(output, creds);
    
    assert.strictEqual(masked, output);
  });
  
  await it("handles output with no matching credentials", async () => {
    const output = "Public information";
    const creds = new Map([["SECRET", "hidden"]]);
    const masked = maskCredentialsInOutput(output, creds);
    
    assert.strictEqual(masked, output);
  });
});

await describe("error handling", async () => {
  
  await it("parses HTTP error response", async () => {
    const errorBody = JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } });
    const parsed = JSON.parse(errorBody);
    
    assert.strictEqual(parsed.error.code, 429);
    assert.ok(parsed.error.message.includes("Rate limit"));
  });
  
  await it("handles malformed JSON error", async () => {
    const errorBody = "Not JSON";
    
    assert.throws(() => JSON.parse(errorBody), SyntaxError);
  });
  
  await it("extracts error message from various formats", async () => {
    const formats = [
      { error: { message: "Error 1" } },
      { error: "Error 2" },
      { message: "Error 3" },
      "Error 4",
    ];
    
    const messages = formats.map(f => {
      if (typeof f === "string") return f;
      if ((f as any).error?.message) return (f as any).error.message;
      if (typeof (f as any).error === "string") return (f as any).error;
      if ((f as any).message) return (f as any).message;
      return "Unknown error";
    });
    
    assert.deepStrictEqual(messages, ["Error 1", "Error 2", "Error 3", "Error 4"]);
  });
});

await describe("chat() HTTP integration", async () => {
  let testServer: ReturnType<typeof createServer>;
  let testPort: number;
  let lastRequestBody = "";
  let mockResponseBody = "";
  let mockStatusCode = 200;

  before(async () => {
    testServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        lastRequestBody = body;
        res.writeHead(mockStatusCode, { "Content-Type": "application/json" });
        res.end(mockResponseBody);
      });
    });
    await new Promise<void>(resolve => testServer.listen(0, resolve));
    testPort = (testServer.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>(resolve => testServer.close(() => resolve()));
  });

  const openaiConfig = () => ({
    provider: "openai-compatible" as const,
    apiKey: "test-key",
    model: "test-model",
    baseUrl: `http://localhost:${testPort}`,
  });

  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" },
  ];

  await it("sends request and returns OpenAI response", async () => {
    mockStatusCode = 200;
    mockResponseBody = JSON.stringify({ choices: [{ message: { content: "Hi there!" } }] });

    const result = await chat(openaiConfig(), messages);
    assert.strictEqual(result, "Hi there!");
  });

  await it("sends correct Authorization header", async () => {
    mockStatusCode = 200;
    mockResponseBody = JSON.stringify({ choices: [{ message: { content: "ok" } }] });

    await chat(openaiConfig(), messages);

    // lastRequestBody should contain the model
    const body = JSON.parse(lastRequestBody);
    assert.strictEqual(body.model, "test-model");
    assert.strictEqual(body.max_tokens, 4096);
  });

  await it("sends all messages to openai-compatible endpoint", async () => {
    mockStatusCode = 200;
    mockResponseBody = JSON.stringify({ choices: [{ message: { content: "ok" } }] });

    await chat(openaiConfig(), messages);

    const body = JSON.parse(lastRequestBody);
    assert.strictEqual(body.messages.length, 2);
    assert.strictEqual(body.messages[0].role, "system");
    assert.strictEqual(body.messages[1].role, "user");
  });

  await it("returns empty string for missing choices", async () => {
    mockStatusCode = 200;
    mockResponseBody = JSON.stringify({});

    const result = await chat(openaiConfig(), messages);
    assert.strictEqual(result, "");
  });

  await it("throws on HTTP error status", async () => {
    mockStatusCode = 401;
    mockResponseBody = JSON.stringify({ error: { message: "Unauthorized" } });

    await assert.rejects(() => chat(openaiConfig(), messages), /HTTP 401/);
  });

  await it("uses baseUrl with /v1 suffix correctly", async () => {
    mockStatusCode = 200;
    mockResponseBody = JSON.stringify({ choices: [{ message: { content: "done" } }] });

    const result = await chat({
      provider: "openai-compatible",
      apiKey: "test",
      model: "m",
      baseUrl: `http://localhost:${testPort}/v1`,
    }, [{ role: "user", content: "hi" }]);

    assert.strictEqual(result, "done");
  });

  await it("uses default openai baseUrl when none provided", async () => {
    mockStatusCode = 200;
    mockResponseBody = JSON.stringify({ choices: [{ message: { content: "x" } }] });

    // This will fail to connect to api.openai.com — just verify it tries
    await assert.rejects(
      () => chat({ provider: "openai", apiKey: "test", model: "gpt-4o" }, [{ role: "user", content: "hi" }]),
    );
  });
});
