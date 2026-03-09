import {
  listCronJobs,
  addCronJob,
  removeCronJob,
  toggleCronJob,
  validateSchedule,
  calculateNextRun,
  getCronJobByName,
} from "../cron.js";
import type { Command } from "./types.js";

export const cronListCommand: Command = {
  name: "cron-list",
  description: "List cron jobs",
  matches: (input) => input === "/cron list" || input.startsWith("/cron list "),
  execute: async (input, ctx) => {
    const group = input.slice(11).trim() || undefined;
    const jobs = listCronJobs(ctx.db, group);

    if (jobs.length === 0) {
      return "No cron jobs found.";
    }

    const lines = ["Cron jobs:"];
    for (const job of jobs) {
      const status = job.enabled ? "enabled" : "disabled";
      const lastRun = job.lastRun
        ? new Date(job.lastRun).toLocaleString()
        : "never";
      const nextRun = job.nextRun
        ? new Date(job.nextRun).toLocaleString()
        : "N/A";
      lines.push(`  ${job.name} [${job.groupName}] [${status}]`);
      lines.push(`    schedule: ${job.schedule}`);
      lines.push(`    last: ${lastRun}, next: ${nextRun}`);
      lines.push(
        `    prompt: ${job.prompt.slice(0, 50)}${job.prompt.length > 50 ? "..." : ""}`,
      );
    }
    return lines.join("\n");
  },
};

export const cronAddCommand: Command = {
  name: "cron-add",
  description: "Add a cron job",
  matches: (input) => input.startsWith("/cron add "),
  execute: async (input, ctx) => {
    const args = input.slice(10).trim();
    const firstSpace = args.indexOf(" ");
    if (firstSpace === -1) {
      return `Usage: /cron add <NAME> <SCHEDULE> <PROMPT>
Schedule format: minute hour day-of-month month day-of-week
Example: /cron add check-api '0 * * * *' 'Check if the API is responding'`;
    }
    const name = args.slice(0, firstSpace);
    const rest = args.slice(firstSpace + 1);

    const scheduleMatch = rest.match(/^'([^']+)'\s+(.+)$/);
    const scheduleUnquoted = rest.match(/^(\S+)\s+(.+)$/);

    let schedule: string;
    let prompt: string;

    if (scheduleMatch) {
      schedule = scheduleMatch[1];
      prompt = scheduleMatch[2];
    } else if (scheduleUnquoted) {
      schedule = scheduleUnquoted[1];
      prompt = scheduleUnquoted[2];
    } else {
      return "Usage: /cron add <NAME> <SCHEDULE> <PROMPT>";
    }

    const validation = validateSchedule(schedule);
    if (!validation.valid) {
      return `Invalid schedule: ${validation.error}`;
    }

    if (getCronJobByName(ctx.db, name)) {
      return `Job '${name}' already exists. Use /cron remove ${name} first.`;
    }

    addCronJob(ctx.db, {
      groupName: ctx.currentGroup,
      name,
      schedule,
      prompt,
    });
    const nextRun = calculateNextRun(schedule);
    return `Job '${name}' added. Next run: ${nextRun?.toLocaleString() || "N/A"}`;
  },
};

export const cronRemoveCommand: Command = {
  name: "cron-remove",
  description: "Remove a cron job",
  matches: (input) => input.startsWith("/cron remove "),
  execute: async (input, ctx) => {
    const name = input.slice(13).trim();
    if (!name) {
      return "Usage: /cron remove <NAME>";
    }

    if (removeCronJob(ctx.db, name)) {
      return `Job '${name}' removed.`;
    } else {
      return `Job '${name}' not found.`;
    }
  },
};

export const cronEnableCommand: Command = {
  name: "cron-enable",
  description: "Enable a cron job",
  matches: (input) => input.startsWith("/cron enable "),
  execute: async (input, ctx) => {
    const name = input.slice(13).trim();
    if (toggleCronJob(ctx.db, name, true)) {
      return `Job '${name}' enabled.`;
    } else {
      return `Job '${name}' not found.`;
    }
  },
};

export const cronDisableCommand: Command = {
  name: "cron-disable",
  description: "Disable a cron job",
  matches: (input) => input.startsWith("/cron disable "),
  execute: async (input, ctx) => {
    const name = input.slice(14).trim();
    if (toggleCronJob(ctx.db, name, false)) {
      return `Job '${name}' disabled.`;
    } else {
      return `Job '${name}' not found.`;
    }
  },
};

export const cronHelpCommand: Command = {
  name: "cron-help",
  description: "Show cron command help",
  matches: (input) =>
    input.startsWith("/cron ") &&
    !input.startsWith("/cron list") &&
    !input.startsWith("/cron add") &&
    !input.startsWith("/cron remove") &&
    !input.startsWith("/cron enable") &&
    !input.startsWith("/cron disable"),
  execute: async () => {
    return `Usage:
  /cron list [group]
  /cron add <NAME> <SCHEDULE> <PROMPT>
  /cron remove <NAME>
  /cron enable|disable <NAME>
Schedule: minute hour day-of-month month day-of-week (e.g., '0 * * * *' = hourly)`;
  },
};
