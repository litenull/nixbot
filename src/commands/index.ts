import type { Command } from "./types.js";
import {
  credListCommand,
  credAddCommand,
  credRemoveCommand,
  credHelpCommand,
} from "./cred-commands.js";
import {
  cronListCommand,
  cronAddCommand,
  cronRemoveCommand,
  cronEnableCommand,
  cronDisableCommand,
  cronHelpCommand,
} from "./cron-commands.js";
import {
  tapeRecentCommand,
  tapeSearchCommand,
  tapeStatsCommand,
  tapeHelpCommand,
} from "./tape-commands.js";
import {
  groupListCommand,
  groupHistoryCommand,
  groupSwitchCommand,
  groupAddCommand,
} from "./group-commands.js";
import { quitCommand } from "./system-commands.js";

// Order matters - more specific patterns should come before general ones
export function loadCommands(): Command[] {
  return [
    // System commands
    quitCommand,

    // Credential commands
    credListCommand,
    credAddCommand,
    credRemoveCommand,
    credHelpCommand,

    // Cron commands
    cronListCommand,
    cronAddCommand,
    cronRemoveCommand,
    cronEnableCommand,
    cronDisableCommand,
    cronHelpCommand,

    // Tape commands
    tapeRecentCommand,
    tapeSearchCommand,
    tapeStatsCommand,
    tapeHelpCommand,

    // Group commands
    groupListCommand,
    groupHistoryCommand,
    groupSwitchCommand,
    groupAddCommand,
  ];
}

export function findCommand(
  commands: Command[],
  input: string,
): Command | undefined {
  return commands.find((cmd) => cmd.matches(input));
}
