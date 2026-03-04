import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  resetPaths,
  loadCredentials,
  setCredential,
  getCredential,
  removeCredential,
  updateLastUsed,
  listCredentials,
  detectRequiredCreds,
  maskCredentials,
  getRequiredCredsForCommand,
} from "../src/credentials.js";

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "nixbot-cred-test-"));
  process.env.NIXBOT_CRED_DIR = testDir;
  resetPaths();
});

afterEach(() => {
  resetPaths();
  delete process.env.NIXBOT_CRED_DIR;
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

await describe("credentials", async () => {

  await describe("detectRequiredCreds", async () => {

    await it("detects $VAR pattern", async () => {
      const vars = detectRequiredCreds("echo $MY_VAR");
      assert.deepStrictEqual(vars, ["MY_VAR"]);
    });

    await it("detects ${VAR} pattern", async () => {
      const vars = detectRequiredCreds("echo ${MY_VAR}");
      assert.deepStrictEqual(vars, ["MY_VAR"]);
    });

    await it("detects multiple variables", async () => {
      const vars = detectRequiredCreds('curl -H "Authorization: $API_KEY" -H "X-Token: ${TOKEN}" https://api.example.com');
      assert.deepStrictEqual(vars.sort(), ["API_KEY", "TOKEN"].sort());
    });

    await it("ignores lowercase variables", async () => {
      const vars = detectRequiredCreds("echo $home $PATH");
      assert.deepStrictEqual(vars, ["PATH"]);
    });

    await it("returns empty array for no matches", async () => {
      const vars = detectRequiredCreds("echo hello world");
      assert.deepStrictEqual(vars, []);
    });

    await it("handles variables in URLs", async () => {
      const vars = detectRequiredCreds("git push https://$TOKEN@github.com/user/repo.git");
      assert.deepStrictEqual(vars, ["TOKEN"]);
    });
  });

  await describe("key management", async () => {

    await it("generates key file on first load", async () => {
      const keyFile = path.join(testDir, "key");
      assert.strictEqual(fs.existsSync(keyFile), false);
      loadCredentials();
      assert.strictEqual(fs.existsSync(keyFile), true);
      const key = fs.readFileSync(keyFile, "utf-8").trim();
      assert.strictEqual(key.length, 64); // 32 bytes = 64 hex chars
    });

    await it("creates empty credentials file if missing", async () => {
      const credsFile = path.join(testDir, "credentials.json");
      assert.strictEqual(fs.existsSync(credsFile), false);
      loadCredentials();
      assert.strictEqual(fs.existsSync(credsFile), true);
      const data = JSON.parse(fs.readFileSync(credsFile, "utf-8"));
      assert.strictEqual(data.version, 1);
      assert.deepStrictEqual(data.credentials, {});
    });

    await it("reuses existing key on reload", async () => {
      loadCredentials();
      const keyFile = path.join(testDir, "key");
      const originalKey = fs.readFileSync(keyFile, "utf-8").trim();

      resetPaths();
      loadCredentials();
      const reloadedKey = fs.readFileSync(keyFile, "utf-8").trim();

      assert.strictEqual(originalKey, reloadedKey);
    });

    await it("throws on invalid key file length", async () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, "key"), "tooshort");
      assert.throws(() => loadCredentials(), /Invalid key file/);
    });

    await it("throws on wrong key (decrypt failure)", async () => {
      loadCredentials();
      setCredential("TEST", "value");

      const wrongKey = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(path.join(testDir, "key"), wrongKey);
      resetPaths();

      assert.throws(() => loadCredentials(), /Failed to decrypt/);
    });
  });

  await describe("loadCredentials", async () => {

    await it("decrypts and restores saved credentials", async () => {
      loadCredentials();
      setCredential("API_TOKEN", "secret123");
      setCredential("OTHER_KEY", "other456");

      resetPaths();
      loadCredentials();

      assert.strictEqual(getCredential("API_TOKEN"), "secret123");
      assert.strictEqual(getCredential("OTHER_KEY"), "other456");
    });

    await it("throws on unsupported credentials version", async () => {
      loadCredentials(); // creates key file
      const credsFile = path.join(testDir, "credentials.json");
      fs.writeFileSync(credsFile, JSON.stringify({ version: 2, credentials: {} }));
      resetPaths();

      assert.throws(() => loadCredentials(), /Unsupported credentials version/);
    });

    await it("throws on corrupted JSON", async () => {
      loadCredentials(); // creates key file
      const credsFile = path.join(testDir, "credentials.json");
      fs.writeFileSync(credsFile, "not valid json{{");
      resetPaths();

      assert.throws(() => loadCredentials(), /Failed to load credentials/);
    });

    await it("preserves scope and lastUsed on reload", async () => {
      loadCredentials();
      setCredential("SCOPED", "val", "production");

      resetPaths();
      loadCredentials();

      const creds = listCredentials();
      const cred = creds.find(c => c.name === "SCOPED");
      assert.ok(cred);
      assert.strictEqual(cred.scope, "production");
      assert.ok(cred.lastUsed);
    });
  });

  await describe("credential operations", async () => {

    await it("stores and retrieves credential", async () => {
      loadCredentials();
      setCredential("TEST_TOKEN", "secret123");
      assert.strictEqual(getCredential("TEST_TOKEN"), "secret123");
    });

    await it("returns undefined for unknown credential", async () => {
      loadCredentials();
      assert.strictEqual(getCredential("NONEXISTENT"), undefined);
    });

    await it("stores credential with scope", async () => {
      loadCredentials();
      setCredential("GITHUB_TOKEN", "ghp_xxx", "repo");
      const creds = listCredentials();
      const cred = creds.find(c => c.name === "GITHUB_TOKEN");
      assert.ok(cred);
      assert.strictEqual(cred.scope, "repo");
    });

    await it("removes credential", async () => {
      loadCredentials();
      setCredential("TO_REMOVE", "value");
      assert.strictEqual(getCredential("TO_REMOVE"), "value");
      assert.strictEqual(removeCredential("TO_REMOVE"), true);
      assert.strictEqual(getCredential("TO_REMOVE"), undefined);
    });

    await it("returns false when removing non-existent credential", async () => {
      loadCredentials();
      assert.strictEqual(removeCredential("NONEXISTENT"), false);
    });

    await it("lists credentials sorted by name", async () => {
      loadCredentials();
      setCredential("ZEBRA_KEY", "z");
      setCredential("ALPHA_KEY", "a");
      setCredential("MIDDLE_KEY", "m");
      const creds = listCredentials();
      assert.strictEqual(creds[0].name, "ALPHA_KEY");
      assert.strictEqual(creds[1].name, "MIDDLE_KEY");
      assert.strictEqual(creds[2].name, "ZEBRA_KEY");
    });

    await it("updates lastUsed timestamp", async () => {
      loadCredentials();
      setCredential("MY_KEY", "val");
      const before = listCredentials().find(c => c.name === "MY_KEY")!.lastUsed!;

      await new Promise(r => setTimeout(r, 5));
      updateLastUsed("MY_KEY");

      const after = listCredentials().find(c => c.name === "MY_KEY")!.lastUsed!;
      assert.ok(new Date(after) > new Date(before));
    });

    await it("updateLastUsed ignores unknown credential", async () => {
      loadCredentials();
      // should not throw
      updateLastUsed("UNKNOWN");
    });

    await it("persists credentials across reloads", async () => {
      loadCredentials();
      setCredential("PERSIST", "value", "scope1");
      removeCredential("PERSIST"); // also tests save after delete

      resetPaths();
      loadCredentials();

      assert.strictEqual(getCredential("PERSIST"), undefined);
    });
  });

  await describe("maskCredentials", async () => {

    await it("masks credential values in text", async () => {
      loadCredentials();
      setCredential("API_KEY", "supersecret");
      const masked = maskCredentials("Token: supersecret", ["API_KEY"]);
      assert.strictEqual(masked, "Token: ***");
    });

    await it("masks multiple occurrences", async () => {
      loadCredentials();
      setCredential("TOKEN", "abc123");
      const masked = maskCredentials("First: abc123 Second: abc123", ["TOKEN"]);
      assert.strictEqual(masked, "First: *** Second: ***");
    });

    await it("handles multiple credentials", async () => {
      loadCredentials();
      setCredential("KEY1", "val1");
      setCredential("KEY2", "val2");
      const masked = maskCredentials("a: val1 b: val2", ["KEY1", "KEY2"]);
      assert.ok(!masked.includes("val1"));
      assert.ok(!masked.includes("val2"));
    });

    await it("returns original text if no credentials to mask", async () => {
      loadCredentials();
      const text = "nothing secret here";
      assert.strictEqual(maskCredentials(text, []), text);
    });

    await it("ignores non-existent credential names", async () => {
      loadCredentials();
      const text = "some output";
      assert.strictEqual(maskCredentials(text, ["MISSING"]), text);
    });
  });

  await describe("getRequiredCredsForCommand", async () => {

    await it("returns env vars for detected credentials", async () => {
      loadCredentials();
      setCredential("SECRET_TOKEN", "tok123");
      const env = getRequiredCredsForCommand("curl -H \"X-Token: $SECRET_TOKEN\" https://api.example.com");
      assert.strictEqual(env["SECRET_TOKEN"], "tok123");
    });

    await it("updates lastUsed timestamp", async () => {
      loadCredentials();
      setCredential("API_KEY", "key123");
      const before = listCredentials().find(c => c.name === "API_KEY")!.lastUsed!;

      await new Promise(r => setTimeout(r, 5));
      getRequiredCredsForCommand("curl $API_KEY");

      const after = listCredentials().find(c => c.name === "API_KEY")!.lastUsed!;
      assert.ok(new Date(after) > new Date(before));
    });

    await it("only includes credentials that exist", async () => {
      loadCredentials();
      const env = getRequiredCredsForCommand("curl $MISSING_VAR https://api.example.com");
      assert.strictEqual(env["MISSING_VAR"], undefined);
    });

    await it("handles multiple variables", async () => {
      loadCredentials();
      setCredential("KEY_A", "valA");
      setCredential("KEY_B", "valB");
      const env = getRequiredCredsForCommand("echo $KEY_A $KEY_B");
      assert.strictEqual(env["KEY_A"], "valA");
      assert.strictEqual(env["KEY_B"], "valB");
    });
  });
});
