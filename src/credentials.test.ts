import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const TEST_DIR = path.join(os.tmpdir(), `nixbot-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function importFresh() {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.NIXBOT_TEST_ID = uniqueId;
  const module = await import(`./credentials.js?cache=${uniqueId}`);
  return module as typeof import("./credentials.js");
}

function setupTestEnv() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  process.env.NIXBOT_CRED_DIR = TEST_DIR;
}

function teardownTestEnv() {
  delete process.env.NIXBOT_CRED_DIR;
  
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

await describe("credentials", async () => {
  
  await beforeEach(() => {
    setupTestEnv();
  });
  
  await afterEach(() => {
    teardownTestEnv();
  });
  
  await describe("detectRequiredCreds", async () => {
    
    await it("detects $VAR pattern", async () => {
      const { resetPaths, detectRequiredCreds } = await importFresh();
      resetPaths();
      const vars = detectRequiredCreds("echo $MY_VAR");
      assert.deepStrictEqual(vars, ["MY_VAR"]);
    });
    
    await it("detects ${VAR} pattern", async () => {
      const { resetPaths, detectRequiredCreds } = await importFresh();
      resetPaths();
      const vars = detectRequiredCreds("echo ${MY_VAR}");
      assert.deepStrictEqual(vars, ["MY_VAR"]);
    });
    
    await it("detects multiple variables", async () => {
      const { resetPaths, detectRequiredCreds } = await importFresh();
      resetPaths();
      const vars = detectRequiredCreds("curl -H \"Authorization: $API_KEY\" -H \"X-Token: ${TOKEN}\" https://api.example.com");
      assert.deepStrictEqual(vars.sort(), ["API_KEY", "TOKEN"].sort());
    });
    
    await it("ignores lowercase variables", async () => {
      const { resetPaths, detectRequiredCreds } = await importFresh();
      resetPaths();
      const vars = detectRequiredCreds("echo $home $PATH");
      assert.deepStrictEqual(vars, ["PATH"]);
    });
    
    await it("returns empty array for no matches", async () => {
      const { resetPaths, detectRequiredCreds } = await importFresh();
      resetPaths();
      const vars = detectRequiredCreds("echo hello world");
      assert.deepStrictEqual(vars, []);
    });
    
    await it("handles variables in URLs", async () => {
      const { resetPaths, detectRequiredCreds } = await importFresh();
      resetPaths();
      const vars = detectRequiredCreds("git push https://$TOKEN@github.com/user/repo.git");
      assert.deepStrictEqual(vars, ["TOKEN"]);
    });
  });
  
  await describe("encryption", async () => {
    
    await it("generates key file on first load", async () => {
      const { resetPaths, loadCredentials } = await importFresh();
      resetPaths();
      
      const keyFile = path.join(TEST_DIR, "key");
      assert.strictEqual(fs.existsSync(keyFile), false);
      loadCredentials();
      assert.strictEqual(fs.existsSync(keyFile), true);
      
      const key = fs.readFileSync(keyFile, "utf-8").trim();
      assert.strictEqual(key.length, 64); // 32 bytes = 64 hex chars
    });
    
    await it("creates empty credentials file if missing", async () => {
      const { resetPaths, loadCredentials } = await importFresh();
      resetPaths();
      
      const credsFile = path.join(TEST_DIR, "credentials.json");
      assert.strictEqual(fs.existsSync(credsFile), false);
      loadCredentials();
      assert.strictEqual(fs.existsSync(credsFile), true);
      
      const data = JSON.parse(fs.readFileSync(credsFile, "utf-8"));
      assert.strictEqual(data.version, 1);
      assert.deepStrictEqual(data.credentials, {});
    });
    
    await it("fails with wrong key", async () => {
      const { resetPaths, loadCredentials, setCredential } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("TEST", "value");
      
      const wrongKey = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(path.join(TEST_DIR, "key"), wrongKey);
      
      const { resetPaths: reset2, loadCredentials: load2 } = await importFresh();
      reset2();
      
      assert.throws(() => load2(), /Failed to decrypt/);
    });
  });
  
  await describe("credential operations", async () => {
    
    await it("stores and retrieves credential", async () => {
      const { resetPaths, loadCredentials, setCredential, getCredential } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("TEST_TOKEN", "secret123");
      assert.strictEqual(getCredential("TEST_TOKEN"), "secret123");
    });
    
    await it("stores credential with scope", async () => {
      const { resetPaths, loadCredentials, setCredential, listCredentials } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("GITHUB_TOKEN", "ghp_xxx", "repo");
      
      const creds = listCredentials();
      const cred = creds.find((c: { name: string }) => c.name === "GITHUB_TOKEN");
      assert.ok(cred);
      assert.strictEqual(cred.scope, "repo");
    });
    
    await it("removes credential", async () => {
      const { resetPaths, loadCredentials, setCredential, removeCredential, getCredential } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("TO_REMOVE", "value");
      assert.strictEqual(getCredential("TO_REMOVE"), "value");
      
      const removed = removeCredential("TO_REMOVE");
      assert.strictEqual(removed, true);
      assert.strictEqual(getCredential("TO_REMOVE"), undefined);
    });
    
    await it("returns false when removing non-existent credential", async () => {
      const { resetPaths, loadCredentials, removeCredential } = await importFresh();
      resetPaths();
      loadCredentials();
      
      const removed = removeCredential("NON_EXISTENT");
      assert.strictEqual(removed, false);
    });
    
    await it("lists credentials sorted by name", async () => {
      const { resetPaths, loadCredentials, setCredential, listCredentials } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("ZEBRA", "val1");
      setCredential("ALPHA", "val2");
      setCredential("MIDDLE", "val3");
      
      const creds = listCredentials();
      assert.strictEqual(creds[0].name, "ALPHA");
      assert.strictEqual(creds[1].name, "MIDDLE");
      assert.strictEqual(creds[2].name, "ZEBRA");
    });
    
    await it("persists credentials across reloads", async () => {
      const { resetPaths: reset1, loadCredentials: load1, setCredential } = await importFresh();
      reset1();
      load1();
      setCredential("PERSISTENT", "value123", "test-scope");
      
      const { resetPaths: reset2, loadCredentials: load2, getCredential, listCredentials } = await importFresh();
      reset2();
      load2();
      
      assert.strictEqual(getCredential("PERSISTENT"), "value123");
      const creds = listCredentials();
      const cred = creds.find((c: { name: string }) => c.name === "PERSISTENT");
      assert.strictEqual(cred?.scope, "test-scope");
    });
  });
  
  await describe("maskCredentials", async () => {
    
    await it("masks credential values in text", async () => {
      const { resetPaths, loadCredentials, setCredential, maskCredentials } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("SECRET_TOKEN", "super-secret-123");
      
      const text = "The token is super-secret-123 and should be hidden";
      const masked = maskCredentials(text, ["SECRET_TOKEN"]);
      assert.strictEqual(masked, "The token is *** and should be hidden");
    });
    
    await it("masks multiple occurrences", async () => {
      const { resetPaths, loadCredentials, setCredential, maskCredentials } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("API_KEY", "key123");
      
      const text = "API_KEY=key123 and also key123 appears again";
      const masked = maskCredentials(text, ["API_KEY"]);
      assert.strictEqual(masked, "API_KEY=*** and also *** appears again");
    });
    
    await it("handles multiple credentials", async () => {
      const { resetPaths, loadCredentials, setCredential, maskCredentials } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("KEY1", "val1");
      setCredential("KEY2", "val2");
      
      const text = "Using val1 and val2 together";
      const masked = maskCredentials(text, ["KEY1", "KEY2"]);
      assert.strictEqual(masked, "Using *** and *** together");
    });
    
    await it("returns original text if no credentials to mask", async () => {
      const { resetPaths, loadCredentials, maskCredentials } = await importFresh();
      resetPaths();
      loadCredentials();
      
      const text = "No secrets here";
      const masked = maskCredentials(text, []);
      assert.strictEqual(masked, text);
    });
    
    await it("ignores non-existent credential names", async () => {
      const { resetPaths, loadCredentials, maskCredentials } = await importFresh();
      resetPaths();
      loadCredentials();
      
      const text = "Some text with no matching secrets";
      const masked = maskCredentials(text, ["NON_EXISTENT"]);
      assert.strictEqual(masked, text);
    });
  });
  
  await describe("getRequiredCredsForCommand", async () => {
    
    await it("returns env vars for detected credentials", async () => {
      const { resetPaths, loadCredentials, setCredential, getRequiredCredsForCommand } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("GITHUB_TOKEN", "ghp_abc123");
      
      const env = getRequiredCredsForCommand("git push https://$GITHUB_TOKEN@github.com/repo.git");
      assert.deepStrictEqual(env, { GITHUB_TOKEN: "ghp_abc123" });
    });
    
    await it("updates lastUsed timestamp", async () => {
      const { resetPaths, loadCredentials, setCredential, getRequiredCredsForCommand, listCredentials } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("MY_TOKEN", "val");
      
      const before = listCredentials().find((c: { name: string }) => c.name === "MY_TOKEN")?.lastUsed;
      
      await new Promise(r => setTimeout(r, 10));
      getRequiredCredsForCommand("echo $MY_TOKEN");
      
      const after = listCredentials().find((c: { name: string }) => c.name === "MY_TOKEN")?.lastUsed;
      assert.notStrictEqual(before, after);
    });
    
    await it("only includes credentials that exist", async () => {
      const { resetPaths, loadCredentials, getRequiredCredsForCommand } = await importFresh();
      resetPaths();
      loadCredentials();
      
      const env = getRequiredCredsForCommand("echo $NON_EXISTENT_VAR");
      assert.deepStrictEqual(env, {});
    });
    
    await it("handles multiple variables", async () => {
      const { resetPaths, loadCredentials, setCredential, getRequiredCredsForCommand } = await importFresh();
      resetPaths();
      loadCredentials();
      
      setCredential("KEY1", "val1");
      setCredential("KEY2", "val2");
      
      const env = getRequiredCredsForCommand("curl -H \"X-Key1: $KEY1\" -H \"X-Key2: ${KEY2}\" url");
      assert.deepStrictEqual(env, { KEY1: "val1", KEY2: "val2" });
    });
  });
});
