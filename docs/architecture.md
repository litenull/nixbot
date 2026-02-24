# Architecture

## System Overview

```
┌─────────────────────────────────────┐
│         Host (Nix dev shell)        │
│  ┌───────────────────────────────┐  │
│  │  TypeScript Orchestrator      │  │
│  │  - REPL/CLI interface         │  │
│  │  - SQLite (messages, groups)  │  │
│  │  - LLM API integration        │  │
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

## Data Flow

```
User Input → TypeScript REPL → LLM API → Parse Response
                                    ↓
                              bash blocks detected
                                    ↓
                        detect $VAR references in command
                                    ↓
                        inject only required credentials
                                    ↓
                              spawn bwrap sandbox
                                    ↓
                              return output → mask credentials → store in SQLite
```

## Components

### Core Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | Entry point, loads .env, initializes credentials |
| `src/repl.ts` | REPL loop, message processing, sandbox spawning |
| `src/llm.ts` | LLM API integration (Anthropic/OpenAI/z.ai) |
| `src/config.ts` | Configuration schema/validation |
| `src/credentials.ts` | Encrypted credential management |
| `src/cron.ts` | Cron job scheduling and management |

### Database Schema

#### messages table
- `id` - INTEGER PRIMARY KEY
- `group_name` - TEXT
- `role` - TEXT (user/assistant)
- `content` - TEXT
- `created_at` - DATETIME

#### groups table
- `name` - TEXT PRIMARY KEY
- `context_path` - TEXT
- `created_at` - DATETIME

#### cron_jobs table
- `id` - INTEGER PRIMARY KEY
- `group_name` - TEXT
- `name` - TEXT UNIQUE
- `schedule` - TEXT (cron format)
- `prompt` - TEXT
- `enabled` - INTEGER (0/1)
- `last_run` - DATETIME
- `next_run` - DATETIME
- `created_at` - DATETIME

## Groups

Groups provide isolated contexts for different projects or topics:

- Each group has its own conversation history
- `groups/<name>/CLAUDE.md` provides context to the LLM
- Separate workspace directories at `~/.bwrapper/nixbot/groups/{group}`

## Sandbox System

Two sandbox types are available:

1. **Headless sandbox** (`result/bin/run-in-sandbox`)
   - No GUI, fast startup
   - Used for bash commands
   - Tools: curl, jq, git, node, chromium, etc.

2. **GUI sandbox** (nix-bwrapper)
   - X11 support via xwayland-satellite
   - For browser automation with Playwright
   - Slower startup due to X11 init
