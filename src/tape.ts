import Database from "better-sqlite3";

export interface TapeEntry {
  id: number;
  groupName: string;
  actionType: "command" | "output" | "feedback" | "llm_request" | "llm_response" | "pause" | "cancel" | "resume";
  content: string;
  metadata: string | null;
  createdAt: Date;
  expiresAt: Date;
}

const TAPE_RETENTION_DAYS = 30;

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
  metadata?: Record<string, unknown>
): void {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + TAPE_RETENTION_DAYS);
  
  db.prepare(`
    INSERT INTO tape_log (group_name, action_type, content, metadata, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    groupName,
    actionType,
    content,
    metadata ? JSON.stringify(metadata) : null,
    expiresAt.toISOString()
  );
}

export function cleanExpiredTapeEntries(db: Database.Database): number {
  const result = db.prepare(`
    DELETE FROM tape_log WHERE expires_at < datetime('now')
  `).run();
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

export function queryTapeLog(db: Database.Database, options: TapeQueryOptions = {}): TapeEntry[] {
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
  
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    group_name: string;
    action_type: string;
    content: string;
    metadata: string | null;
    created_at: string;
    expires_at: string;
  }>;
  
  return rows.map(row => ({
    id: row.id,
    groupName: row.group_name,
    actionType: row.action_type as TapeEntry["actionType"],
    content: row.content,
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
  }));
}

export function getRecentTapeSummary(db: Database.Database, groupName: string, hours = 24): string {
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
    const preview = entry.content.length > 100 
      ? entry.content.slice(0, 100) + "..." 
      : entry.content;
    summary.push(`${emoji} [${time}] ${entry.actionType}: ${preview.replace(/\n/g, " ")}`);
  }
  
  return summary.join("\n");
}

export function getTapeStats(db: Database.Database): {
  totalEntries: number;
  entriesByType: Record<string, number>;
  oldestEntry: Date | null;
  entriesExpiringSoon: number;
} {
  const total = db.prepare("SELECT COUNT(*) as count FROM tape_log").get() as { count: number };
  
  const byType = db.prepare(`
    SELECT action_type, COUNT(*) as count 
    FROM tape_log 
    GROUP BY action_type
  `).all() as Array<{ action_type: string; count: number }>;
  
  const oldest = db.prepare(`
    SELECT MIN(created_at) as oldest FROM tape_log
  `).get() as { oldest: string | null };
  
  const expiring = db.prepare(`
    SELECT COUNT(*) as count FROM tape_log 
    WHERE expires_at < datetime('now', '+3 days')
  `).get() as { count: number };
  
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
