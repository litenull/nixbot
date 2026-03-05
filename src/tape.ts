import Database from "better-sqlite3";

export interface TapeEntry {
  id: number;
  groupName: string;
  actionType:
    | "command"
    | "output"
    | "feedback"
    | "llm_request"
    | "llm_response"
    | "pause"
    | "cancel"
    | "resume";
  content: string;
  metadata: string | null;
  createdAt: Date;
  expiresAt: Date;
}

const TAPE_RETENTION_DAYS = 30;

interface TapeRow {
  id: number;
  group_name: string;
  action_type: string;
  content: string;
  metadata: string | null;
  created_at: string;
  expires_at: string;
}

function isTapeRow(row: unknown): row is TapeRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.id === "number" &&
    typeof r.group_name === "string" &&
    typeof r.action_type === "string" &&
    typeof r.content === "string" &&
    (r.metadata === null || typeof r.metadata === "string") &&
    typeof r.created_at === "string" &&
    typeof r.expires_at === "string"
  );
}

const validActionTypes: TapeEntry["actionType"][] = [
  "command",
  "output",
  "feedback",
  "llm_request",
  "llm_response",
  "pause",
  "cancel",
  "resume",
];

function isValidActionType(type: string): type is TapeEntry["actionType"] {
  return validActionTypes.includes(type as TapeEntry["actionType"]);
}

interface CountRow {
  count: number;
}

function isCountRow(row: unknown): row is CountRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.count === "number";
}

interface TypeCountRow {
  action_type: string;
  count: number;
}

function isTypeCountRow(row: unknown): row is TypeCountRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.action_type === "string" && typeof r.count === "number";
}

interface OldestRow {
  oldest: string | null;
}

function isOldestRow(row: unknown): row is OldestRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return r.oldest === null || typeof r.oldest === "string";
}

export function initTapeTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tape_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_name TEXT NOT NULL,
      action_type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_tape_group ON tape_log(group_name);
    CREATE INDEX IF NOT EXISTS idx_tape_created ON tape_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_tape_expires ON tape_log(expires_at);
    CREATE INDEX IF NOT EXISTS idx_tape_type ON tape_log(action_type);
  `);
}

export function logTapeAction(
  db: Database.Database,
  groupName: string,
  actionType: TapeEntry["actionType"],
  content: string,
  metadata?: Record<string, unknown>,
): void {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + TAPE_RETENTION_DAYS);

  db.prepare(
    `
    INSERT INTO tape_log (group_name, action_type, content, metadata, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    groupName,
    actionType,
    content,
    metadata ? JSON.stringify(metadata) : null,
    expiresAt.toISOString(),
  );
}

export function cleanExpiredTapeEntries(db: Database.Database): number {
  const result = db
    .prepare(
      `
    DELETE FROM tape_log WHERE expires_at < datetime('now')
  `,
    )
    .run();
  return result.changes;
}

export interface TapeQueryOptions {
  groupName?: string;
  actionType?: TapeEntry["actionType"];
  since?: Date;
  until?: Date;
  limit?: number;
  search?: string;
}

export function queryTapeLog(
  db: Database.Database,
  options: TapeQueryOptions = {},
): TapeEntry[] {
  let sql = "SELECT * FROM tape_log WHERE 1=1";
  const params: (string | number)[] = [];

  if (options.groupName) {
    sql += " AND group_name = ?";
    params.push(options.groupName);
  }

  if (options.actionType) {
    sql += " AND action_type = ?";
    params.push(options.actionType);
  }

  if (options.since) {
    sql += " AND created_at >= ?";
    params.push(options.since.toISOString());
  }

  if (options.until) {
    sql += " AND created_at <= ?";
    params.push(options.until.toISOString());
  }

  if (options.search) {
    sql += " AND content LIKE ?";
    params.push(`%${options.search}%`);
  }

  sql += " ORDER BY created_at DESC";

  if (options.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params);

  return rows.filter(isTapeRow).map((row) => ({
    id: row.id,
    groupName: row.group_name,
    actionType: isValidActionType(row.action_type)
      ? row.action_type
      : "command",
    content: row.content,
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
  }));
}

export function getRecentTapeSummary(
  db: Database.Database,
  groupName: string,
  hours = 24,
): string {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  const entries = queryTapeLog(db, { groupName, since, limit: 100 });

  if (entries.length === 0) {
    return `No activity in the last ${hours} hours.`;
  }

  const summary: string[] = [];
  const typeEmoji: Record<string, string> = {
    command: "⚡",
    output: "📤",
    feedback: "💬",
    llm_request: "🤖",
    llm_response: "💭",
    pause: "⏸️",
    cancel: "🛑",
    resume: "▶️",
  };

  for (const entry of entries.reverse()) {
    const emoji = typeEmoji[entry.actionType] || "•";
    const time = entry.createdAt.toLocaleTimeString();
    const preview =
      entry.content.length > 100
        ? entry.content.slice(0, 100) + "..."
        : entry.content;
    summary.push(
      `${emoji} [${time}] ${entry.actionType}: ${preview.replace(/\n/g, " ")}`,
    );
  }

  return summary.join("\n");
}

export function getTapeStats(db: Database.Database): {
  totalEntries: number;
  entriesByType: Record<string, number>;
  oldestEntry: Date | null;
  entriesExpiringSoon: number;
} {
  const totalRow = db.prepare("SELECT COUNT(*) as count FROM tape_log").get();
  const total = isCountRow(totalRow) ? totalRow : { count: 0 };

  const byTypeRows = db
    .prepare(
      `
    SELECT action_type, COUNT(*) as count 
    FROM tape_log 
    GROUP BY action_type
  `,
    )
    .all();
  const byType = byTypeRows.filter(isTypeCountRow);

  const oldestRow = db
    .prepare(
      `
    SELECT MIN(created_at) as oldest FROM tape_log
  `,
    )
    .get();
  const oldest = isOldestRow(oldestRow) ? oldestRow : { oldest: null };

  const expiringRow = db
    .prepare(
      `
    SELECT COUNT(*) as count FROM tape_log 
    WHERE expires_at < datetime('now', '+3 days')
  `,
    )
    .get();
  const expiring = isCountRow(expiringRow) ? expiringRow : { count: 0 };

  const entriesByType: Record<string, number> = {};
  for (const row of byType) {
    entriesByType[row.action_type] = row.count;
  }

  return {
    totalEntries: total.count,
    entriesByType,
    oldestEntry: oldest.oldest ? new Date(oldest.oldest) : null,
    entriesExpiringSoon: expiring.count,
  };
}
