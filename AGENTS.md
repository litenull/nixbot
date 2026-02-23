# AGENTS.md

This file documents how to work with the Nanix codebase.

## Overview

Nanix is a NanoClaw-inspired agent isolation system using:
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
                              spawn bwrap sandbox
                                    ↓
                              return output → store in SQLite
```

### Key Files

| File | Purpose |
|------|---------|
| `flake.nix` | Nix configuration (sandbox + dev shell) |
| `src/cli.ts` | Entry point, loads .env |
| `src/repl.ts` | REPL loop, message processing, sandbox spawning |
| `src/llm.ts` | LLM API integration (Anthropic/OpenAI/z.ai) |
| `src/config.ts` | Configuration schema/validation |
| `groups/*/CLAUDE.md` | Per-group context files |
| `data/nanix.db` | SQLite database (created at runtime) |

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

## Testing

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
inputs.nanix.url = "path:/path/to/nanix";

# Use the package
environment.systemPackages = [ nanix.packages.x86_64-linux.default ];
```

### As a systemd service
Create a systemd unit that runs `npm run start` with appropriate env vars.

## Notes

- The sandbox uses `--die-with-parent` so it exits when the parent process dies
- Each group gets its own workspace directory at `~/.bwrapper/nanix/groups/{group}`
- The LLM will automatically execute bash blocks it generates
- Keep `CLAUDE.md` files concise - they go into every LLM prompt
