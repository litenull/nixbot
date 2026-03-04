import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function getNixbotDir(): string {
  const override = process.env.NIXBOT_CRED_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".nixbot");
}

let _nixbotDir: string | null = null;
let _keyFile: string | null = null;
let _credsFile: string | null = null;

function getPaths(): { nixbotDir: string; keyFile: string; credsFile: string } {
  if (!_nixbotDir) {
    _nixbotDir = getNixbotDir();
    _keyFile = path.join(_nixbotDir, "key");
    _credsFile = path.join(_nixbotDir, "credentials.json");
  }
  return { nixbotDir: _nixbotDir!, keyFile: _keyFile!, credsFile: _credsFile! };
}

export function resetPaths(): void {
  _nixbotDir = null;
  _keyFile = null;
  _credsFile = null;
  key = null;
  credentials = new Map();
}

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

const ENV_VAR_PATTERN = /\$\{?([A-Z_][A-Z0-9_]*)\}?/g;

interface CredentialEntry {
  encrypted: string;
  iv: string;
  tag: string;
  scope?: string;
  lastUsed?: string;
}

interface CredentialsFile {
  version: number;
  credentials: Record<string, CredentialEntry>;
}

interface CredentialInfo {
  name: string;
  scope?: string;
  lastUsed?: string;
}

let credentials: Map<
  string,
  { value: string; scope?: string; lastUsed?: string }
> = new Map();
let key: Buffer | null = null;

function ensureDir(): void {
  const { nixbotDir } = getPaths();
  if (!fs.existsSync(nixbotDir)) {
    fs.mkdirSync(nixbotDir, { recursive: true, mode: 0o700 });
  }
}

function generateKey(): Buffer {
  const { keyFile } = getPaths();
  ensureDir();
  const newKey = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(keyFile, newKey.toString("hex"), { mode: 0o600 });
  console.log(`Generated new key file: ${keyFile}`);
  console.log("Keep this file secure - it cannot be recovered if lost.");
  return newKey;
}

function loadKey(): Buffer {
  const { keyFile } = getPaths();
  if (key) return key;

  ensureDir();

  if (!fs.existsSync(keyFile)) {
    key = generateKey();
    return key;
  }

  const keyHex = fs.readFileSync(keyFile, "utf-8").trim();
  if (keyHex.length !== KEY_LENGTH * 2) {
    throw new Error(
      `Invalid key file: expected ${KEY_LENGTH * 2} hex chars, got ${keyHex.length}`,
    );
  }

  key = Buffer.from(keyHex, "hex");
  return key;
}

function encrypt(
  plaintext: string,
  key: Buffer,
): { encrypted: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decrypt(
  encrypted: string,
  iv: string,
  tag: string,
  key: Buffer,
): string {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf-8");
}

export function loadCredentials(): void {
  const { credsFile } = getPaths();
  const k = loadKey();

  if (!fs.existsSync(credsFile)) {
    const empty: CredentialsFile = { version: 1, credentials: {} };
    fs.writeFileSync(credsFile, JSON.stringify(empty, null, 2), {
      mode: 0o600,
    });
    credentials = new Map();
    return;
  }

  try {
    const data: CredentialsFile = JSON.parse(
      fs.readFileSync(credsFile, "utf-8"),
    );

    if (data.version !== 1) {
      throw new Error(`Unsupported credentials version: ${data.version}`);
    }

    credentials = new Map();

    for (const [name, entry] of Object.entries(data.credentials)) {
      try {
        const value = decrypt(entry.encrypted, entry.iv, entry.tag, k);
        credentials.set(name, {
          value,
          scope: entry.scope,
          lastUsed: entry.lastUsed,
        });
      } catch (err) {
        throw new Error(
          `Failed to decrypt credential '${name}': ${(err as Error).message}`,
        );
      }
    }
  } catch (err) {
    if ((err as Error).message.includes("Failed to decrypt")) {
      throw err;
    }
    throw new Error(`Failed to load credentials: ${(err as Error).message}`);
  }
}

function saveCredentials(): void {
  const { credsFile } = getPaths();
  const k = loadKey();

  const data: CredentialsFile = {
    version: 1,
    credentials: {},
  };

  for (const [name, { value, scope, lastUsed }] of credentials) {
    const { encrypted, iv, tag } = encrypt(value, k);
    data.credentials[name] = {
      encrypted,
      iv,
      tag,
      scope,
      lastUsed,
    };
  }

  fs.writeFileSync(credsFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function getCredential(name: string): string | undefined {
  return credentials.get(name)?.value;
}

export function setCredential(
  name: string,
  value: string,
  scope?: string,
): void {
  credentials.set(name, { value, scope, lastUsed: new Date().toISOString() });
  saveCredentials();
}

export function removeCredential(name: string): boolean {
  if (!credentials.has(name)) return false;
  credentials.delete(name);
  saveCredentials();
  return true;
}

export function updateLastUsed(name: string): void {
  const cred = credentials.get(name);
  if (cred) {
    cred.lastUsed = new Date().toISOString();
    saveCredentials();
  }
}

export function listCredentials(): CredentialInfo[] {
  const result: CredentialInfo[] = [];
  for (const [name, { scope, lastUsed }] of credentials) {
    result.push({ name, scope, lastUsed });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function detectRequiredCreds(command: string): string[] {
  const vars = new Set<string>();
  let match;
  const pattern = new RegExp(ENV_VAR_PATTERN.source, "g");

  while ((match = pattern.exec(command)) !== null) {
    vars.add(match[1]);
  }

  return Array.from(vars);
}

export function maskCredentials(text: string, vars: string[]): string {
  let masked = text;

  for (const varName of vars) {
    const value = credentials.get(varName)?.value;
    if (value && masked.includes(value)) {
      masked = masked.split(value).join("***");
    }
  }

  return masked;
}

export function getRequiredCredsForCommand(
  command: string,
): Record<string, string> {
  const vars = detectRequiredCreds(command);
  const env: Record<string, string> = {};

  for (const varName of vars) {
    const value = getCredential(varName);
    if (value) {
      env[varName] = value;
      updateLastUsed(varName);
    }
  }

  return env;
}
