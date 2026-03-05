import Database from "better-sqlite3";

// Constants for group management
const DEFAULT_HISTORY_LIMIT = 50;

export interface GroupInfo {
  name: string;
  contextPath: string;
}

export function initGroupsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_name TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS groups (
      name TEXT PRIMARY KEY,
      context_path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

interface GroupRow {
  name: string;
  context_path: string;
}

function isGroupRow(row: unknown): row is GroupRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.name === "string" && typeof r.context_path === "string";
}

export function getGroup(
  db: Database.Database,
  name: string,
): GroupInfo | undefined {
  const row = db
    .prepare("SELECT name, context_path FROM groups WHERE name = ?")
    .get(name);
  if (!isGroupRow(row)) return undefined;
  return { name: row.name, contextPath: row.context_path };
}

export function registerGroup(
  db: Database.Database,
  name: string,
  contextPath: string,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO groups (name, context_path) VALUES (?, ?)",
  ).run(name, contextPath);
}

export function listGroups(db: Database.Database): GroupInfo[] {
  const rows = db.prepare("SELECT name, context_path FROM groups").all();
  return rows
    .filter(isGroupRow)
    .map((row) => ({ name: row.name, contextPath: row.context_path }));
}

export function addMessage(
  db: Database.Database,
  group: string,
  role: "user" | "assistant",
  content: string,
): void {
  db.prepare(
    "INSERT INTO messages (group_name, role, content) VALUES (?, ?, ?)",
  ).run(group, role, content);
}

interface MessageRow {
  role: string;
  content: string;
}

function isMessageRow(row: unknown): row is MessageRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.role === "string" && typeof r.content === "string";
}

export function getHistory(
  db: Database.Database,
  group: string,
  limit = DEFAULT_HISTORY_LIMIT,
): Array<{ role: string; content: string }> {
  const rows = db
    .prepare(
      `
    SELECT role, content FROM messages
    WHERE group_name = ?
    ORDER BY created_at DESC
    LIMIT ?
  `,
    )
    .all(group, limit)
    .reverse();
  return rows.filter(isMessageRow);
}
