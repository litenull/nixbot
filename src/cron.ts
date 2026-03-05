import Database from "better-sqlite3";

export interface CronJob {
  id: number;
  groupName: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  createdAt: string;
}

export interface CronJobInput {
  groupName: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled?: boolean;
}

export function initCronTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_name TEXT NOT NULL,
      name TEXT NOT NULL UNIQUE,
      schedule TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_run DATETIME,
      next_run DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_cron_group ON cron_jobs(group_name);
    CREATE INDEX IF NOT EXISTS idx_cron_next_run ON cron_jobs(next_run);
  `);
}

export function addCronJob(db: Database.Database, job: CronJobInput): CronJob {
  const nextRun = calculateNextRun(job.schedule);
  const result = db
    .prepare(
      `
    INSERT INTO cron_jobs (group_name, name, schedule, prompt, enabled, next_run)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      job.groupName,
      job.name,
      job.schedule,
      job.prompt,
      job.enabled !== false ? 1 : 0,
      nextRun?.toISOString() || null,
    );

  return getCronJob(db, Number(result.lastInsertRowid))!;
}

export function removeCronJob(db: Database.Database, name: string): boolean {
  const result = db.prepare("DELETE FROM cron_jobs WHERE name = ?").run(name);
  return result.changes > 0;
}

export function getCronJob(
  db: Database.Database,
  id: number,
): CronJob | undefined {
  const row = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id);
  return row ? rowToCronJob(row) : undefined;
}

export function getCronJobByName(
  db: Database.Database,
  name: string,
): CronJob | undefined {
  const row = db.prepare("SELECT * FROM cron_jobs WHERE name = ?").get(name);
  return row ? rowToCronJob(row) : undefined;
}

export function listCronJobs(
  db: Database.Database,
  groupName?: string,
): CronJob[] {
  const rows = groupName
    ? db
        .prepare("SELECT * FROM cron_jobs WHERE group_name = ? ORDER BY name")
        .all(groupName)
    : db.prepare("SELECT * FROM cron_jobs ORDER BY group_name, name").all();
  return rows.map(rowToCronJob);
}

export function getDueJobs(db: Database.Database): CronJob[] {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `
    SELECT * FROM cron_jobs 
    WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?
  `,
    )
    .all(now);
  return rows.map(rowToCronJob);
}

export function updateJobLastRun(db: Database.Database, id: number): void {
  const now = new Date();
  const job = getCronJob(db, id);
  const nextRun = job ? calculateNextRun(job.schedule) : null;

  db.prepare(
    `
    UPDATE cron_jobs SET last_run = ?, next_run = ? WHERE id = ?
  `,
  ).run(now.toISOString(), nextRun?.toISOString() || null, id);
}

export function toggleCronJob(
  db: Database.Database,
  name: string,
  enabled: boolean,
): boolean {
  const result = db
    .prepare("UPDATE cron_jobs SET enabled = ? WHERE name = ?")
    .run(enabled ? 1 : 0, name);
  return result.changes > 0;
}

interface CronJobRow {
  id: number;
  group_name: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: number;
  last_run: string | null;
  next_run: string | null;
  created_at: string;
}

function isCronJobRow(row: unknown): row is CronJobRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "number" &&
    typeof r.group_name === "string" &&
    typeof r.name === "string" &&
    typeof r.schedule === "string" &&
    typeof r.prompt === "string" &&
    typeof r.enabled === "number" &&
    (r.last_run === null || typeof r.last_run === "string") &&
    (r.next_run === null || typeof r.next_run === "string") &&
    typeof r.created_at === "string"
  );
}

function rowToCronJob(row: unknown): CronJob {
  if (!isCronJobRow(row)) {
    throw new Error("Invalid cron job row from database");
  }
  return {
    id: row.id,
    groupName: row.group_name,
    name: row.name,
    schedule: row.schedule,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    lastRun: row.last_run,
    nextRun: row.next_run,
    createdAt: row.created_at,
  };
}

interface ParsedSchedule {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

export function parseSchedule(schedule: string): ParsedSchedule | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const parseField = (
    field: string,
    min: number,
    max: number,
  ): number[] | null => {
    if (field === "*") {
      return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    }

    if (/^\d+$/.test(field)) {
      const val = parseInt(field, 10);
      if (val < min || val > max) return null;
      return [val];
    }

    if (field.includes(",")) {
      const vals: number[] = [];
      for (const part of field.split(",")) {
        const parsed = parseField(part, min, max);
        if (!parsed) return null;
        vals.push(...parsed);
      }
      return [...new Set(vals)].sort((a, b) => a - b);
    }

    if (field.includes("/")) {
      const [base, stepStr] = field.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) return null;

      const baseVals = parseField(base || "*", min, max);
      if (!baseVals) return null;

      const result: number[] = [];
      for (let i = min; i <= max; i += step) {
        if (baseVals.includes(i)) result.push(i);
      }
      return result;
    }

    if (field.includes("-")) {
      const [startStr, endStr] = field.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end)
        return null;
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }

    return null;
  };

  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const daysOfMonth = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const daysOfWeek = parseField(parts[4], 0, 6);

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

export function calculateNextRun(schedule: string, from?: Date): Date | null {
  const parsed = parseSchedule(schedule);
  if (!parsed) return null;

  const start = from || new Date();
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    const candidate = new Date(start);
    candidate.setMinutes(candidate.getMinutes() + i);

    if (
      parsed.minutes.includes(candidate.getMinutes()) &&
      parsed.hours.includes(candidate.getHours()) &&
      parsed.daysOfMonth.includes(candidate.getDate()) &&
      parsed.months.includes(candidate.getMonth() + 1) &&
      parsed.daysOfWeek.includes(candidate.getDay())
    ) {
      return candidate;
    }
  }

  return null;
}

export function formatSchedule(schedule: string): string {
  const parsed = parseSchedule(schedule);
  if (!parsed) return "invalid";

  const formatField = (vals: number[], names?: string[]): string => {
    if (vals.length === 1) return vals[0].toString();
    if (names && vals.length === names.length) return "every";
    return vals.join(",");
  };

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const min = formatField(parsed.minutes);
  const hour = formatField(parsed.hours);
  const dom = formatField(parsed.daysOfMonth);
  const month = formatField(parsed.months, monthNames);
  const dow = formatField(parsed.daysOfWeek, dayNames);

  return `${min} ${hour} ${dom} ${month} ${dow}`;
}

export function validateSchedule(schedule: string): {
  valid: boolean;
  error?: string;
} {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return {
      valid: false,
      error:
        "Schedule must have 5 fields: minute hour day-of-month month day-of-week",
    };
  }

  const parsed = parseSchedule(schedule);
  if (!parsed) {
    return { valid: false, error: "Invalid schedule format" };
  }

  return { valid: true };
}
