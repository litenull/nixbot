import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as path from "path";

const TEST_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function importConfigFresh() {
  const uniqueId = `${TEST_ID}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const module = await import(`../src/config.js?cache=${uniqueId}`);
  return module as typeof import("../src/config.js");
}

await describe("config", async () => {
  const originalEnv = process.env;

  await beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NIXBOT_GROUPS_DIR;
    delete process.env.NIXBOT_DATA_DIR;
    delete process.env.NIXBOT_SANDBOX_BIN;
  });

  await afterEach(() => {
    process.env = originalEnv;
  });

  await describe("default values", async () => {
    await it("uses default groupsDir", async () => {
      const { config } = await importConfigFresh();
      assert.strictEqual(config.groupsDir, "./groups");
    });

    await it("uses default dataDir", async () => {
      const { config } = await importConfigFresh();
      assert.strictEqual(config.dataDir, "./data");
    });

    await it("uses default sandboxBin", async () => {
      const { config } = await importConfigFresh();
      assert.ok(config.sandboxBin.includes("run-in-sandbox"));
    });
  });

  await describe("environment variable overrides", async () => {
    await it("reads NIXBOT_GROUPS_DIR from env", async () => {
      process.env.NIXBOT_GROUPS_DIR = "/custom/groups/path";
      const { config } = await importConfigFresh();
      assert.strictEqual(config.groupsDir, "/custom/groups/path");
    });

    await it("reads NIXBOT_DATA_DIR from env", async () => {
      process.env.NIXBOT_DATA_DIR = "/custom/data/path";
      const { config } = await importConfigFresh();
      assert.strictEqual(config.dataDir, "/custom/data/path");
    });

    await it("reads NIXBOT_SANDBOX_BIN from env and resolves path", async () => {
      process.env.NIXBOT_SANDBOX_BIN = "./custom/sandbox";
      const { config } = await importConfigFresh();
      assert.ok(config.sandboxBin.includes("custom/sandbox"));
      assert.ok(path.isAbsolute(config.sandboxBin));
    });

    await it("handles all env vars together", async () => {
      process.env.NIXBOT_GROUPS_DIR = "/my/groups";
      process.env.NIXBOT_DATA_DIR = "/my/data";
      process.env.NIXBOT_SANDBOX_BIN = "/my/sandbox";

      const { config } = await importConfigFresh();
      assert.strictEqual(config.groupsDir, "/my/groups");
      assert.strictEqual(config.dataDir, "/my/data");
      assert.ok(config.sandboxBin.includes("/my/sandbox"));
    });
  });

  await describe("path resolution", async () => {
    await it("resolves relative sandbox path", async () => {
      process.env.NIXBOT_SANDBOX_BIN = "./relative/path/to/sandbox";
      const { config } = await importConfigFresh();
      assert.ok(path.isAbsolute(config.sandboxBin));
      assert.ok(config.sandboxBin.includes("relative/path/to/sandbox"));
    });

    await it("handles absolute sandbox path", async () => {
      process.env.NIXBOT_SANDBOX_BIN = "/absolute/path/to/sandbox";
      const { config } = await importConfigFresh();
      assert.strictEqual(config.sandboxBin, "/absolute/path/to/sandbox");
    });
  });

  await describe("config object structure", async () => {
    await it("has all required properties", async () => {
      const { config } = await importConfigFresh();
      assert.ok("groupsDir" in config);
      assert.ok("dataDir" in config);
      assert.ok("sandboxBin" in config);
    });

    await it("properties are strings", async () => {
      const { config } = await importConfigFresh();
      assert.strictEqual(typeof config.groupsDir, "string");
      assert.strictEqual(typeof config.dataDir, "string");
      assert.strictEqual(typeof config.sandboxBin, "string");
    });
  });
});
