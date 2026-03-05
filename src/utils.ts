import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

// Constants for output handling
const DEFAULT_MAX_OUTPUT_LENGTH = 2000;

export function extractBashBlocks(text: string): string[] {
  const pattern = /```bash\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const cmd = match[1].trim();
    if (cmd) blocks.push(cmd);
  }
  return blocks;
}

export function truncateOutput(
  output: string,
  maxLength = DEFAULT_MAX_OUTPUT_LENGTH,
): string {
  if (output.length > maxLength) {
    return output.slice(0, maxLength) + "\n... (truncated)";
  }
  return output;
}

export function ensureGroupDir(
  groupsDir: string,
  name: string,
): { groupPath: string; claudeMdPath: string } {
  const groupPath = join(groupsDir, name);
  mkdirSync(groupPath, { recursive: true });
  const claudeMdPath = join(groupPath, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `# ${name} Group\n\nContext for this group.\n`);
  }
  return { groupPath, claudeMdPath };
}

/**
 * Safely extracts an error message from an unknown error value.
 * Handles cases where the error might not be an Error instance.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string") {
      return msg;
    }
  }
  return String(err);
}
