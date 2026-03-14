import { listCredentials, removeCredential } from "../credentials.js";
import type { Command } from "./types.js";

export const credListCommand: Command = {
  name: "cred-list",
  description: "List stored credentials",
  matches: (input) => input === "/cred list",
  execute: async () => {
    const creds = listCredentials();
    if (creds.length === 0) {
      return "No credentials stored.";
    }

    const lines = ["Stored credentials:"];
    for (const c of creds) {
      const lastUsed = c.lastUsed
        ? new Date(c.lastUsed).toLocaleString()
        : "never";
      const scope = c.scope || "-";
      lines.push(`  ${c.name}  [scope: ${scope}]  [last used: ${lastUsed}]`);
    }
    return lines.join("\n");
  },
};

export const credAddCommand: Command = {
  name: "cred-add",
  description: "Add a credential",
  matches: (input) => input.startsWith("/cred add "),
  execute: async (input, _ctx) => {
    const args = input.slice(10).trim().split(/\s+/);
    if (args.length < 1 || !args[0]) {
      return "Usage: /cred add <NAME> [SCOPE]";
    }
    const name = args[0];
    const scope = args.length > 1 ? args.slice(1).join(" ") : undefined;

    // We need to prompt for value - this requires readline access
    // For now, return instruction - we'll handle this specially in repl.ts
    return `__PROMPT_FOR_CRED__:${name}:${scope || ""}`;
  },
};

export const credRemoveCommand: Command = {
  name: "cred-remove",
  description: "Remove a credential",
  matches: (input) => input.startsWith("/cred remove "),
  execute: async (input) => {
    const name = input.slice(13).trim();
    if (!name) {
      return "Usage: /cred remove <NAME>";
    }

    if (removeCredential(name)) {
      return `Credential '${name}' removed.`;
    } else {
      return `Credential '${name}' not found.`;
    }
  },
};

export const credHelpCommand: Command = {
  name: "cred-help",
  description: "Show credential command help",
  matches: (input) =>
    input.startsWith("/cred ") &&
    !input.startsWith("/cred list") &&
    !input.startsWith("/cred add") &&
    !input.startsWith("/cred remove"),
  execute: async () => {
    return "Usage:\n  /cred list\n  /cred add <NAME> [SCOPE]\n  /cred remove <NAME>";
  },
};
