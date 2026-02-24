import { describe, it } from "node:test";
import assert from "node:assert";

function buildEndpoint(baseUrl: string, provider: string): string {
  const hasVersion = /\/v\d+\/?$/.test(baseUrl);
  const endpoint = hasVersion 
    ? `${baseUrl.replace(/\/$/, "")}/chat/completions`
    : `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  return endpoint;
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
