import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

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

export function truncateOutput(output: string, maxLength = 2000): string {
  if (output.length > maxLength) {
    return output.slice(0, maxLength) + "\n... (truncated)";
  }
  return output;
}

export function ensureGroupDir(groupsDir: string, name: string): { groupPath: string; claudeMdPath: string } {
  const groupPath = join(groupsDir, name);
  mkdirSync(groupPath, { recursive: true });
  const claudeMdPath = join(groupPath, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `# ${name} Group\n\nContext for this group.\n`);
  }
  return { groupPath, claudeMdPath };
}
