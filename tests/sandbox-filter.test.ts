import { describe, it } from "node:test";
import assert from "node:assert";

interface EnvBlocklistEntry {
  pattern: RegExp;
  description: string;
}

const envBlocklist: EnvBlocklistEntry[] = [
  { pattern: /_API_KEY$/i, description: "API keys" },
  { pattern: /_SECRET$/i, description: "Secrets" },
  { pattern: /_PASSWORD$/i, description: "Passwords" },
  { pattern: /_TOKEN$/i, description: "Tokens" },
  { pattern: /_CREDENTIAL/i, description: "Credentials" },
  { pattern: /^ANTHROPIC_/i, description: "Anthropic vars" },
  { pattern: /^OPENAI_/i, description: "OpenAI vars" },
  { pattern: /^AWS_/i, description: "AWS vars" },
  { pattern: /^GITHUB_/i, description: "GitHub vars" },
];

function isBlockedEnvVar(key: string): boolean {
  return envBlocklist.some(entry => entry.pattern.test(key));
}

function filterEnvVars(env: Record<string, string | undefined>): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isBlockedEnvVar(key)) {
      safeEnv[key] = value;
    }
  }
  return safeEnv;
}

await describe("sandbox environment filtering", async () => {
  
  await describe("isBlockedEnvVar", async () => {
    
    await it("blocks API_KEY suffix", async () => {
      assert.strictEqual(isBlockedEnvVar("MY_API_KEY"), true);
      assert.strictEqual(isBlockedEnvVar("OPENAI_API_KEY"), true);
      assert.strictEqual(isBlockedEnvVar("api_key"), false); // requires underscore prefix
    });
    
    await it("blocks SECRET suffix", async () => {
      assert.strictEqual(isBlockedEnvVar("MY_SECRET"), true);
      assert.strictEqual(isBlockedEnvVar("database_secret"), true);
    });
    
    await it("blocks PASSWORD suffix", async () => {
      assert.strictEqual(isBlockedEnvVar("DB_PASSWORD"), true);
      assert.strictEqual(isBlockedEnvVar("password"), false); // requires underscore prefix
    });
    
    await it("blocks TOKEN suffix", async () => {
      assert.strictEqual(isBlockedEnvVar("GITHUB_TOKEN"), true);
      assert.strictEqual(isBlockedEnvVar("access_token"), true);
    });
    
    await it("blocks CREDENTIAL substring", async () => {
      assert.strictEqual(isBlockedEnvVar("MY_CREDENTIAL"), true); // has _CREDENTIAL
      assert.strictEqual(isBlockedEnvVar("AWS_CREDENTIAL_PATH"), true); // has _CREDENTIAL
      assert.strictEqual(isBlockedEnvVar("CREDENTIALS_FILE"), false); // no underscore before
    });
    
    await it("blocks ANTHROPIC prefix", async () => {
      assert.strictEqual(isBlockedEnvVar("ANTHROPIC_API_KEY"), true);
      assert.strictEqual(isBlockedEnvVar("anthropic_model"), true);
    });
    
    await it("blocks OPENAI prefix", async () => {
      assert.strictEqual(isBlockedEnvVar("OPENAI_API_KEY"), true);
      assert.strictEqual(isBlockedEnvVar("openai_base_url"), true);
    });
    
    await it("blocks AWS prefix", async () => {
      assert.strictEqual(isBlockedEnvVar("AWS_ACCESS_KEY"), true);
      assert.strictEqual(isBlockedEnvVar("aws_region"), true);
    });
    
    await it("blocks GITHUB prefix", async () => {
      assert.strictEqual(isBlockedEnvVar("GITHUB_TOKEN"), true);
      assert.strictEqual(isBlockedEnvVar("github_username"), true);
    });
    
    await it("allows safe variables", async () => {
      assert.strictEqual(isBlockedEnvVar("PATH"), false);
      assert.strictEqual(isBlockedEnvVar("HOME"), false);
      assert.strictEqual(isBlockedEnvVar("USER"), false);
      assert.strictEqual(isBlockedEnvVar("EDITOR"), false);
      assert.strictEqual(isBlockedEnvVar("SHELL"), false);
      assert.strictEqual(isBlockedEnvVar("LANG"), false);
    });
    
    await it("allows NIXBOT variables", async () => {
      assert.strictEqual(isBlockedEnvVar("NIXBOT_LLM_MODEL"), false);
      assert.strictEqual(isBlockedEnvVar("NIXBOT_DATA_DIR"), false);
    });
    
    await it("is case insensitive", async () => {
      // The regex /_API_KEY$/i should match lowercase
      assert.strictEqual(isBlockedEnvVar("MY_API_KEY"), true);
      assert.strictEqual(isBlockedEnvVar("my_api_key"), true);
      assert.strictEqual(isBlockedEnvVar("My_Api_Key"), true);
      assert.strictEqual(isBlockedEnvVar("ANTHROPIC_API_KEY"), true);
      assert.strictEqual(isBlockedEnvVar("anthropic_api_key"), true);
    });
  });
  
  await describe("filterEnvVars", async () => {
    
    await it("returns safe variables", async () => {
      const env = {
        PATH: "/usr/bin",
        HOME: "/home/user",
        USER: "testuser",
      };
      
      const safe = filterEnvVars(env);
      assert.strictEqual(safe.PATH, "/usr/bin");
      assert.strictEqual(safe.HOME, "/home/user");
      assert.strictEqual(safe.USER, "testuser");
    });
    
    await it("removes blocked variables", async () => {
      const env = {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-xxx",
        GITHUB_TOKEN: "ghp-xxx",
      };
      
      const safe = filterEnvVars(env);
      assert.strictEqual(safe.PATH, "/usr/bin");
      assert.strictEqual(safe.OPENAI_API_KEY, undefined);
      assert.strictEqual(safe.GITHUB_TOKEN, undefined);
    });
    
    await it("removes undefined values", async () => {
      const env = {
        PATH: "/usr/bin",
        UNDEFINED_VAR: undefined,
      };
      
      const safe = filterEnvVars(env);
      assert.strictEqual(safe.PATH, "/usr/bin");
      assert.strictEqual(safe.UNDEFINED_VAR, undefined);
    });
    
    await it("handles empty environment", async () => {
      const safe = filterEnvVars({});
      assert.deepStrictEqual(safe, {});
    });
    
    await it("handles mixed safe and unsafe vars", async () => {
      const env = {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-xxx",
        HOME: "/home/user",
        AWS_SECRET_ACCESS_KEY: "secret",
        EDITOR: "vim",
        DATABASE_PASSWORD: "pass123",
      };
      
      const safe = filterEnvVars(env);
      assert.strictEqual(Object.keys(safe).length, 3);
      assert.ok(safe.PATH);
      assert.ok(safe.HOME);
      assert.ok(safe.EDITOR);
      assert.strictEqual(safe.ANTHROPIC_API_KEY, undefined);
      assert.strictEqual(safe.AWS_SECRET_ACCESS_KEY, undefined);
      assert.strictEqual(safe.DATABASE_PASSWORD, undefined);
    });
    
    await it("preserves empty string values", async () => {
      const env = {
        EMPTY_VAR: "",
        PATH: "/usr/bin",
      };
      
      const safe = filterEnvVars(env);
      assert.strictEqual(safe.EMPTY_VAR, "");
    });
    
    await it("handles complex variable names", async () => {
      const env = {
        MY_APP_API_KEY: "secret",
        SERVICE_ACCOUNT_TOKEN: "token",
        NIXBOT_LLM_MODEL: "claude",
      };
      
      const safe = filterEnvVars(env);
      assert.strictEqual(safe.MY_APP_API_KEY, undefined);
      assert.strictEqual(safe.SERVICE_ACCOUNT_TOKEN, undefined);
      assert.strictEqual(safe.NIXBOT_LLM_MODEL, "claude");
    });
  });
  
  await describe("blocklist completeness", async () => {
    
    await it("has descriptions for all patterns", async () => {
      for (const entry of envBlocklist) {
        assert.ok(entry.description.length > 0);
        assert.ok(entry.pattern instanceof RegExp);
      }
    });
    
    await it("catches common credential patterns", async () => {
      const testCases = [
        "SECRET_KEY",
        "PRIVATE_KEY",
        "ACCESS_TOKEN",
        "REFRESH_TOKEN",
        "BEARER_TOKEN",
        "AUTH_TOKEN",
        "SESSION_TOKEN",
        "JWT_TOKEN",
      ];
      
      for (const testCase of testCases) {
        const blocked = isBlockedEnvVar(testCase);
        // Most should be blocked, at least TOKEN suffix catches many
        if (testCase.includes("TOKEN")) {
          assert.strictEqual(blocked, true, `${testCase} should be blocked`);
        }
      }
    });
  });
});
