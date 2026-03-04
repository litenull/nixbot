export const PAUSE_KEYWORDS = [
  "pause", "wait", "hold on", "stop", "hang on", "hold up",
  "give me a moment", "hold it", "freeze",
];

export function isPauseInput(input: string): boolean {
  const lower = input.toLowerCase().trim();
  return PAUSE_KEYWORDS.some(kw =>
    lower === kw || lower.startsWith(kw + " ") || lower.includes(" " + kw + " ") || lower.endsWith(" " + kw)
  );
}

export class InputBuffer {
  private queue: string[] = [];
  private enabled = false;
  private currentLine = "";
  private onDataHandler: ((chunk: Buffer) => void) | null = null;

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.currentLine = "";

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();

      this.onDataHandler = (chunk: Buffer) => {
        if (!this.enabled) return;

        const data = chunk.toString();

        for (const char of data) {
          if (char === "\x03") {
            this.queue.push("__CANCEL__");
            process.stdout.write("\n\x1b[33m● Cancel requested\x1b[0m\n");
            continue;
          }

          if (char === "\r" || char === "\n") {
            if (this.currentLine.trim()) {
              const input = this.currentLine.trim();
              if (isPauseInput(input)) {
                this.queue.push("__PAUSE__");
                process.stdout.write("\n\x1b[35m● Paused\x1b[0m\n");
              } else {
                this.queue.push(input);
                process.stdout.write("\n\x1b[32m● Feedback queued\x1b[0m\n");
              }
            }
            this.currentLine = "";
            continue;
          }

          if (char === "\x7f" || char === "\x08") {
            this.currentLine = this.currentLine.slice(0, -1);
            continue;
          }

          if (char.charCodeAt(0) >= 32) {
            this.currentLine += char;
          }
        }
      };

      process.stdin.on("data", this.onDataHandler);
    }
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;

    if (this.onDataHandler) {
      process.stdin.off("data", this.onDataHandler);
      this.onDataHandler = null;
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.resume();
    }

    this.currentLine = "";
  }

  push(input: string): void {
    this.queue.push(input);
  }

  pop(): string | undefined {
    return this.queue.shift();
  }

  popAll(): string[] {
    const all = [...this.queue];
    this.queue = [];
    return all;
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  isCancelRequested(): boolean {
    return this.queue.includes("__CANCEL__");
  }

  isPauseRequested(): boolean {
    return this.queue.includes("__PAUSE__");
  }

  consumeCancel(): boolean {
    const idx = this.queue.indexOf("__CANCEL__");
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  consumePause(): boolean {
    const idx = this.queue.indexOf("__PAUSE__");
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  getPendingCount(): number {
    return this.queue.filter(s => s !== "__CANCEL__" && s !== "__PAUSE__").length;
  }
}
