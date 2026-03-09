import { queryTapeLog, getRecentTapeSummary, getTapeStats } from "../tape.js";
import type { Command } from "./types.js";

export const tapeRecentCommand: Command = {
  name: "tape-recent",
  description: "Show recent tape activity",
  matches: (input) =>
    input === "/tape recent" || input.startsWith("/tape recent "),
  execute: async (input, ctx) => {
    const hours = input.startsWith("/tape recent ")
      ? parseInt(input.slice(13), 10) || 24
      : 24;
    const summary = getRecentTapeSummary(ctx.db, ctx.currentGroup, hours);
    return `\n${summary}\n`;
  },
};

export const tapeSearchCommand: Command = {
  name: "tape-search",
  description: "Search tape logs",
  matches: (input) => input.startsWith("/tape search "),
  execute: async (input, ctx) => {
    const query = input.slice(13).trim();
    if (!query) {
      return "Usage: /tape search <query>";
    }

    const entries = queryTapeLog(ctx.db, {
      groupName: ctx.currentGroup,
      search: query,
      limit: 20,
    });

    if (entries.length === 0) {
      return "No matching entries found.";
    }

    const lines = [`\nFound ${entries.length} entries:\n`];
    for (const entry of entries) {
      const time = entry.createdAt.toLocaleString();
      const preview =
        entry.content.length > 80
          ? entry.content.slice(0, 80) + "..."
          : entry.content;
      lines.push(
        `[${time}] ${entry.actionType}: ${preview.replace(/\n/g, " ")}`,
      );
    }
    return lines.join("\n");
  },
};

export const tapeStatsCommand: Command = {
  name: "tape-stats",
  description: "Show tape statistics",
  matches: (input) => input === "/tape stats",
  execute: async (input, ctx) => {
    const stats = getTapeStats(ctx.db);
    const lines = [
      "\nTape Log Statistics:",
      `  Total entries: ${stats.totalEntries}`,
      `  Oldest entry: ${stats.oldestEntry?.toLocaleString() || "N/A"}`,
      `  Expiring soon (< 3 days): ${stats.entriesExpiringSoon}`,
      "  By type:",
    ];
    for (const [type, count] of Object.entries(stats.entriesByType)) {
      lines.push(`    ${type}: ${count}`);
    }
    return lines.join("\n");
  },
};

export const tapeHelpCommand: Command = {
  name: "tape-help",
  description: "Show tape command help",
  matches: (input) =>
    input.startsWith("/tape ") &&
    !input.startsWith("/tape recent") &&
    !input.startsWith("/tape search") &&
    !input.startsWith("/tape stats"),
  execute: async () => {
    return `Usage:
  /tape recent [hours] - Show recent activity (default: 24h)
  /tape search <query> - Search tape logs
  /tape stats - Show tape statistics`;
  },
};
