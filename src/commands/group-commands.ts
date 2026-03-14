import { getGroup, listGroups, getHistory } from "../groups.js";
import type { Command } from "./types.js";

export const groupListCommand: Command = {
  name: "group-list",
  description: "List all groups",
  matches: (input) => input === "/list",
  execute: async (input, ctx) => {
    const groups = listGroups(ctx.db);
    const lines: string[] = [];
    for (const g of groups) {
      const prefix = g.name === ctx.currentGroup ? "* " : "  ";
      lines.push(`${prefix}${g.name} (${g.contextPath})`);
    }
    return lines.join("\n") || "No groups found.";
  },
};

export const groupHistoryCommand: Command = {
  name: "group-history",
  description: "Show conversation history",
  matches: (input) => input === "/history",
  execute: async (input, ctx) => {
    const history = getHistory(ctx.db, ctx.currentGroup, 10);
    const lines: string[] = [];
    for (const h of history) {
      const preview = h.content.slice(0, 80).replace(/\n/g, " ");
      lines.push(
        `  ${h.role}: ${preview}${h.content.length > 80 ? "..." : ""}`,
      );
    }
    return lines.join("\n") || "No history found.";
  },
};

export const groupSwitchCommand: Command = {
  name: "group-switch",
  description: "Switch to a different group",
  matches: (input) => input.startsWith("/switch "),
  execute: async (input, ctx) => {
    const newGroup = input.slice(8).trim();
    if (getGroup(ctx.db, newGroup)) {
      // We can't modify ctx.currentGroup directly, return special marker
      return `__SWITCH_GROUP__:${newGroup}`;
    } else {
      return `Unknown group: ${newGroup}`;
    }
  },
};

export const groupAddCommand: Command = {
  name: "group-add",
  description: "Create a new group",
  matches: (input) => input.startsWith("/add "),
  execute: async (input, _ctx) => {
    const name = input.slice(5).trim();
    // Return special marker to be handled by repl.ts
    return `__CREATE_GROUP__:${name}`;
  },
};
