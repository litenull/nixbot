import type Database from "better-sqlite3";
import { getDueJobs, updateJobLastRun } from "../cron.js";
import { getErrorMessage } from "../utils.js";

const DEFAULT_CRON_CHECK_INTERVAL_MS = 60000; // 60 seconds

interface SchedulerState {
  interval: ReturnType<typeof setInterval> | null;
  callback: ((group: string, prompt: string) => Promise<void>) | null;
}

const state: SchedulerState = {
  interval: null,
  callback: null,
};

export function startScheduler(
  db: Database.Database,
  callback: (group: string, prompt: string) => Promise<void>,
  intervalMs = DEFAULT_CRON_CHECK_INTERVAL_MS,
): void {
  state.callback = callback;
  state.interval = setInterval(async () => {
    const dueJobs = getDueJobs(db);
    for (const job of dueJobs) {
      console.log(
        `[cron] Running job '${job.name}' in group '${job.groupName}'`,
      );
      try {
        await state.callback!(job.groupName, job.prompt);
        updateJobLastRun(db, job.id);
      } catch (err) {
        console.error(`[cron] Job '${job.name}' failed:`, getErrorMessage(err));
      }
    }
  }, intervalMs);
}

export function stopScheduler(): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
  state.callback = null;
}

export function isSchedulerRunning(): boolean {
  return state.interval !== null;
}
