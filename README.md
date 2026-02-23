# Nanix

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
NANIX_LLM_PROVIDER=openai-compatible
OPENAI_API_KEY=your-zhipu-key
NANIX_LLM_MODEL=glm-4-flash
NANIX_LLM_BASE_URL=https://api.z.ai/api/coding/paas/v4

# Example for Anthropic
NANIX_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-key
NANIX_LLM_MODEL=claude-sonnet-4-20250514

# Example for OpenAI
NANIX_LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
NANIX_LLM_MODEL=gpt-4o
```

## Commands

```
[main]> hello              # Send message to current group
@work check the logs       # Send to specific group
/switch work               # Change active group
/list                      # List all groups
/history                   # Show conversation history
/add personal              # Create new group
/quit                      # Exit
```

## Groups

Each group has:
- Isolated conversation history
- `groups/<name>/CLAUDE.md` - Context file
- Separate sandbox workspace

## Files

```
nanix/
├── flake.nix          # Nix config (sandbox + dev shell)
├── src/
│   ├── cli.ts         # Entry point
│   ├── repl.ts        # REPL loop + orchestration
│   └── llm.ts         # LLM API calls
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
