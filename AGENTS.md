# AGENTS.md

This file documents how to work with the Nixbot codebase.

## Overview

Nixbot is a NanoClaw-inspired agent isolation system using:
- **Nix** for reproducible sandbox environments
- **nix-bwrapper** for application sandboxing (with custom headless variant)
- **TypeScript** for orchestration logic
- **bubblewrap** for process isolation

## Architecture

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

### Key Files

| File | Purpose |
|------|---------|
| `flake.nix` | Nix configuration (sandbox + dev shell) |
| `src/cli.ts` | Entry point, loads .env, initializes credentials |
| `src/repl.ts` | REPL loop, message processing, sandbox spawning |
| `src/llm.ts` | LLM API integration (Anthropic/OpenAI/z.ai) |
| `src/config.ts` | Configuration schema/validation |
| `src/credentials.ts` | Encrypted credential management |
| `src/credentials.test.ts` | Unit tests for credential system |
| `src/cron.ts` | Cron job scheduling and management |
| `groups/*/CLAUDE.md` | Per-group context files |
| `data/nixbot.db` | SQLite database (created at runtime) |

## Development Workflow

### Enter the dev shell
```bash
nix develop
```

### Install dependencies
```bash
npm install
```

### Run in dev mode (auto-reload)
```bash
npm run dev
```

### Build for production
```bash
npm run build
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `NANIX_LLM_PROVIDER` - `anthropic`, `openai`, or `openai-compatible`
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` - API key
- `NANIX_LLM_MODEL` - Model name (e.g., `glm-4-flash`, `claude-sonnet-4-20250514`)
- `NANIX_LLM_BASE_URL` - For openai-compatible providers

## Sandbox System

There are two sandboxes:

1. **Headless sandbox** (`result/bin/run-in-sandbox`)
   - No GUI, fast startup
   - Used for bash commands
   - Tools: curl, jq, git, node, chromium, etc.

2. **GUI sandbox** (nix-bwrapper)
   - X11 support via xwayland-satellite
   - For browser automation with Playwright
   - Slower startup due to X11 init

### Spawning the sandbox

```typescript
import { spawn } from "child_process";

const proc = spawn(config.sandboxBin, [command], {
  env: { HOME: process.env.HOME, WORKSPACE: workspacePath }
});
```

## Why Bubblewrap Over Docker?

**Attack Surface**
- **Bubblewrap**: ~8,000 lines of C, single purpose
- **Docker**: ~2 million lines of Go with daemon, networking, registries
- Result: Docker has 250x more code that could have vulnerabilities

**Privilege Model**
- **Bubblewrap**: Runs entirely as user, no root required
- **Docker**: Daemon runs as root, container escape = host root access
- Result: Bubblewrap escape stays in user context

**CVE History**
- **Docker**: 200+ CVEs including container escapes (runc exploits)
- **Bubblewrap**: ~5 CVEs total, mostly DoS not escapes

**Trade-off**
- Docker offers convenience (images, layers, networking)
- Bubblewrap offers minimalism (no daemon, no root, fast startup)
- Same namespace isolation quality, different trust assumptions

## LLM Integration

The LLM receives a system prompt with:
- Group context from `CLAUDE.md`
- Recent conversation history
- Capability instructions

When the LLM responds with ` ```bash ` blocks, those commands are:
1. Extracted from the response
2. Run in the sandbox
3. Output appended to the response

### Adding a new provider

Edit `src/llm.ts`:

```typescript
if (config.provider === "new-provider") {
  // Make API call
  // Parse response
  return content;
}
```

## Database Schema

### messages table
- `id` - INTEGER PRIMARY KEY
- `group_name` - TEXT
- `role` - TEXT (user/assistant)
- `content` - TEXT
- `created_at` - DATETIME

### groups table
- `name` - TEXT PRIMARY KEY
- `context_path` - TEXT
- `created_at` - DATETIME

### cron_jobs table
- `id` - INTEGER PRIMARY KEY
- `group_name` - TEXT
- `name` - TEXT UNIQUE
- `schedule` - TEXT (cron format: `minute hour day-of-month month day-of-week`)
- `prompt` - TEXT
- `enabled` - INTEGER (0/1)
- `last_run` - DATETIME
- `next_run` - DATETIME
- `created_at` - DATETIME

## Cron Service

Scheduled agent tasks run per-group using standard cron syntax.

### REPL Commands

| Command | Description |
|---------|-------------|
| `/cron list [group]` | List cron jobs (optionally filtered by group) |
| `/cron add <NAME> <SCHEDULE> <PROMPT>` | Add a new job |
| `/cron remove <NAME>` | Remove a job |
| `/cron enable <NAME>` | Enable a disabled job |
| `/cron disable <NAME>` | Disable a job |

### Schedule Format

Standard 5-field cron: `minute hour day-of-month month day-of-week`

| Field | Values |
|-------|--------|
| minute | 0-59 |
| hour | 0-23 |
| day-of-month | 1-31 |
| month | 1-12 |
| day-of-week | 0-6 (0 = Sunday) |

Special characters: `*` (any), `,` (list), `-` (range), `/` (step)

### Examples

```
# Hourly API check
/cron add check-api '0 * * * *' 'Check if the API is responding'

# Daily report at 9am
/cron add daily-report '0 9 * * *' 'Generate a summary of yesterday's activity'

# Every 15 minutes
/cron add frequent-check '*/15 * * * *' 'Check queue depth'
```

### How It Works

1. Scheduler runs every 60 seconds checking for due jobs
2. When a job is due, it triggers `processMessage()` in the job's group
3. Job's `last_run` is updated and `next_run` is calculated
4. Failed jobs log errors but don't block other jobs

### Natural Language Scheduling

The agent can create cron jobs from natural language requests:

```
[main]> check https://example.com every day and report changes
```

The LLM will automatically generate and execute:
```
/cron add check-example '0 9 * * *' 'Check https://example.com and report changes'
```

Common patterns:
- "every minute" → `*/1 * * * *`
- "every hour"/"hourly" → `0 * * * *`
- "every day"/"daily" → `0 9 * * *`
- "every week"/"weekly" → `0 9 * * 1`

## Credential Management

Credentials are stored encrypted at `~/.nixbot/credentials.json` using AES-256-GCM. The encryption key is at `~/.nixbot/key`.

### Security Model

- **Blocklist filtering**: Sensitive env vars (e.g., `*_API_KEY`, `*_SECRET`, `*_TOKEN`) are never passed to the sandbox
- **Per-command injection**: Credentials are only injected when a command references them via `$VAR` or `${VAR}`
- **Output masking**: Credential values are replaced with `***` in logs and stored messages

### Files

| Path | Purpose |
|------|---------|
| `~/.nixbot/key` | 32-byte encryption key (auto-generated, mode 0600) |
| `~/.nixbot/credentials.json` | Encrypted credential store |

### REPL Commands

| Command | Description |
|---------|-------------|
| `/cred list` | List all credentials (name, scope, last used) |
| `/cred add <NAME> [SCOPE]` | Add credential (prompts for value) |
| `/cred remove <NAME>` | Remove credential |

### Example

```
[main]> /cred add GITHUB_TOKEN repo
Enter value for GITHUB_TOKEN: <hidden>
Credential 'GITHUB_TOKEN' stored.

[main]> push to github
... agent runs: git push https://$GITHUB_TOKEN@github.com/...
... output shows: *** instead of actual token
```

### Key File

- Auto-generated on first run if missing
- **Cannot be recovered if lost** - all stored credentials become inaccessible
- Keep secure and backed up separately

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `NANIX_CRED_DIR` | Override credentials directory (for testing) |

## Common Tasks

### Add a tool to the sandbox

Edit `flake.nix`, add to `agentTools`:

```nix
agentTools = with pkgs; [
  # existing tools...
  imagemagick  # new tool
];
```

Rebuild:
```bash
nix build . -o result
```

### Add a new slash command

Edit `src/repl.ts`, add to the REPL loop:

```typescript
if (input.startsWith("/mycommand ")) {
  const arg = input.slice(11).trim();
  // Handle command
  continue;
}
```

### Debug sandbox issues

Run the test:
```bash
npx tsx src/test-sandbox.ts
```

Or manually:
```bash
./result/bin/run-in-sandbox "echo test"
```

## Troubleshooting

### "Cannot find module"
Make sure you're in the nix dev shell and ran `npm install`

### "No API key found"
Check that `.env` file exists and has correct variables, or set env vars directly

### Sandbox hangs
The GUI sandbox starts xwayland-satellite which can block. Use the headless sandbox for CLI commands.

### Database errors
Delete `data/` directory to reset:
```bash
rm -rf data/
```

### Credential errors
If credentials fail to decrypt, the key file may be corrupted or mismatched:
```bash
# Warning: this will make all stored credentials inaccessible
rm ~/.nixbot/key ~/.nixbot/credentials.json
```

## Testing

### Unit tests
```bash
npm test
```

### Unit test the sandbox
```bash
npx tsx src/test-sandbox.ts
```

### Manual test
```bash
echo "hello" | npm run dev
```

### Test LLM integration
```bash
OPENAI_API_KEY=test npm run dev
# Then type: test
```

## Deployment

### As a Nix package
```nix
# In another flake
inputs.nixbot.url = "path:/path/to/nixbot";

# Use the package
environment.systemPackages = [ nixbot.packages.x86_64-linux.default ];
```

### As a systemd service
Create a systemd unit that runs `npm run start` with appropriate env vars.

## Notes

- The sandbox uses `--die-with-parent` so it exits when the parent process dies
- Each group gets its own workspace directory at `~/.bwrapper/nixbot/groups/{group}`
- The LLM will automatically execute bash blocks it generates
- Keep `CLAUDE.md` files concise - they go into every LLM prompt
