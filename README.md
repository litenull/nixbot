# Nix Jail Bot

NanoClaw-inspired agent isolation using Nix + nix-bwrapper.

## Architecture

```
┌─────────────────────────────────────┐
│         Host (Nix dev shell)        │
│  ┌───────────────────────────────┐  │
│  │  TypeScript Orchestrator      │  │
│  │  - REPL/CLI interface         │  │
│  │  - SQLite (messages, groups)  │  │
│  │  - LLM API integration        │  │
│  │  - Tape logging (30d retention)│  │
│  │  - Spawns bwrap per task      │  │
│  └──────────────┬────────────────┘  │
└─────────────────┼───────────────────┘
                  │ spawn
                  ▼
┌─────────────────────────────────────┐
│   bwrap sandbox (nix-bwrapper)      │
│   - FHS environment                 │
│   - Chromium + Node.js              │
│   - Group workspace mounted         │
│   - X11 (isolated xwayland)         │
│   - DBus proxy (filtered)           │
└─────────────────────────────────────┘
```

## Quick Start

```bash
# Enter dev shell
nix develop

# Install dependencies
npm install

# Configure (copy example and edit)
cp .env.example .env
# Edit .env with your API keys

# Run agent
npm run dev
```

Or set environment variables directly:

```bash
ANTHROPIC_API_KEY=your-key npm run dev
```

## Configuration (`.env` file)

```env
# Example for z.ai (GLM)
NIXBOT_LLM_PROVIDER=openai-compatible
OPENAI_API_KEY=your-zhipu-key
NIXBOT_LLM_MODEL=glm-4-flash
NIXBOT_LLM_BASE_URL=https://api.z.ai/api/coding/paas/v4

# Example for Anthropic
NIXBOT_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-key
NIXBOT_LLM_MODEL=claude-sonnet-4-20250514

# Example for OpenAI
NIXBOT_LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
NIXBOT_LLM_MODEL=gpt-4o

# Plugin system (comma-separated names)
NIXBOT_PLUGINS=telegram

# Telegram plugin (BotFather token)
NIXBOT_TELEGRAM_BOT_TOKEN=123456:ABCDEF...
# Optional: default group for Telegram chats
NIXBOT_TELEGRAM_GROUP=main
# Optional: allowlist chat IDs
# NIXBOT_TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
```

## Plugin System

Plugins are loaded from `NIXBOT_PLUGINS` at startup. Built-in plugins:

- `telegram` - receives Telegram messages and routes them to Nixbot groups

If no plugins are enabled, the core REPL still works normally.

## Telegram Plugin (BotFather)

1. In Telegram, open `@BotFather`.
2. Run `/newbot`, set a name/username, and copy the bot token.
3. Set:
   - `NIXBOT_PLUGINS=telegram`
   - `NIXBOT_TELEGRAM_BOT_TOKEN=<your token>`
4. Start Nixbot with `npm run dev`.

In Telegram:
- Send `/start` to verify the connector is live.
- Send `/group work` to route this chat to group `work`.
- Send normal messages to run tasks through the bot.

## Commands

```
[main]> hello              # Send message to current group
@work check the logs       # Send to specific group
/switch work               # Change active group
/list                      # List all groups
/history                   # Show conversation history
/add personal              # Create new group
/quit                      # Exit

# Tape logging
/tape recent [hours]       # Show recent activity (default: 24h)
/tape search <query>       # Search tape logs
/tape stats                # Show tape statistics
```

## Mid-Task Input

While the agent is working, you can provide feedback and get an immediate response from a supervisor agent:

```
[main]> deploy the app
[main] Running: npm run build...
<type: what are you doing?>
● Feedback queued
↳ Processing: what are you doing?
💬 I'm currently running `npm run build` to compile the application.
```

The supervisor responds within ~500ms while the main task continues. Use `pause` or `Ctrl+C` to actually stop execution.

### Pause

Type `pause`, `wait`, `hold on`, etc. to pause execution:

```
[main]> run tests
<pause>
⏸️  Paused. Type 'resume' to continue or give new instructions.

[main]> resume
▶️  Resuming...
```

### Cancel

Press `Ctrl+C` to cancel the current task.

## Groups

Each group has:
- Isolated conversation history
- `groups/<name>/CLAUDE.md` - Context file
- Separate sandbox workspace

## Files

```
nix-jail-bot/
├── flake.nix          # Nix config (sandbox + dev shell)
├── src/
│   ├── cli.ts         # Entry point
│   ├── repl.ts        # REPL loop + orchestration + mid-task input
│   ├── llm.ts         # LLM API calls
│   ├── tape.ts        # Tape logging (30d retention)
│   └── cron.ts        # Scheduled tasks
├── groups/
│   ├── main/CLAUDE.md
│   └── work/CLAUDE.md
└── data/              # SQLite + IPC (created at runtime)
```

## Sandbox Features

- Host filesystem isolated
- Network enabled (for Playwright/API calls)
- Chromium + Node.js available
- Tools: curl, jq, git, ripgrep, fd, bat
- Per-app X11 via xwayland-satellite
- DBus filtering via xdg-dbus-proxy

## Why Not Docker?

**Attack Surface**: Bubblewrap is ~8,000 lines of C vs Docker's ~2 million lines of Go. Docker has 250x more code that could have vulnerabilities.

**Privilege**: Bubblewrap runs entirely as your user. Docker requires a root daemon—container escape = host root access.

**CVEs**: Docker has 200+ including container escapes. Bubblewrap has ~5, mostly DoS.

**Trade-off**: Docker offers convenience (images, networking). Bubblewrap offers minimalism and security. Same isolation quality, different risk profiles.

## Extending

Add tools to sandbox in `flake.nix`:

```nix
addPkgs = with pkgs; [
  chromium
  nodejs
  python3    # Add Python
  imagemagick  # Add image tools
];
```

Add Playwright:

```bash
# In sandbox:
npx playwright install chromium
```
