# Configuration

## Environment Variables

Configuration is handled via environment variables, typically set in a `.env` file.

### LLM Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `NIXBOT_LLM_PROVIDER` | Yes | LLM provider: `anthropic`, `openai`, or `openai-compatible` |
| `NIXBOT_LLM_MODEL` | Yes | Model name to use |
| `NIXBOT_LLM_BASE_URL` | For openai-compatible | API base URL |
| `ANTHROPIC_API_KEY` | For Anthropic | Anthropic API key |
| `OPENAI_API_KEY` | For OpenAI/compatible | OpenAI API key |

### Path Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NIXBOT_SANDBOX_BIN` | `./result/bin/run-in-sandbox` | Path to sandbox binary |
| `NIXBOT_GROUPS_DIR` | `./groups` | Directory for group contexts |
| `NIXBOT_DATA_DIR` | `./data` | Directory for SQLite database |
| `NIXBOT_CRED_DIR` | `~/.nixbot` | Directory for credentials |

## Provider Examples

### z.ai (GLM)

```env
NIXBOT_LLM_PROVIDER=openai-compatible
OPENAI_API_KEY=your-zhipu-api-key
NIXBOT_LLM_MODEL=glm-4-flash
NIXBOT_LLM_BASE_URL=https://api.z.ai/api/coding/paas/v4
```

### Anthropic

```env
NIXBOT_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-api-key
NIXBOT_LLM_MODEL=claude-sonnet-4-20250514
```

### OpenAI

```env
NIXBOT_LLM_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key
NIXBOT_LLM_MODEL=gpt-4o
```

### OpenAI-Compatible (self-hosted)

```env
NIXBOT_LLM_PROVIDER=openai-compatible
OPENAI_API_KEY=your-api-key
NIXBOT_LLM_MODEL=llama-3
NIXBOT_LLM_BASE_URL=http://localhost:11434
```

## Group Context Files

Each group has a `CLAUDE.md` file in its directory that provides context to the LLM:

```
groups/
├── main/
│   └── CLAUDE.md    # Context for main group
└── work/
    └── CLAUDE.md    # Context for work group
```

Example `CLAUDE.md`:

```markdown
# Main Group

This is the default group for general tasks.

## Preferences
- Be concise in responses
- Use jq for JSON processing
- Prefer curl over wget
```

## Nix Configuration

The `flake.nix` file defines:

1. **Development shell** - Provides Node.js, npm, TypeScript, and sandbox
2. **Headless sandbox** - Bubblewrap-based isolation for CLI commands
3. **GUI sandbox** - Full X11 support for browser automation

### Adding Tools to Sandbox

Edit `flake.nix` and add packages to `agentTools`:

```nix
agentTools = with pkgs; [
  # existing tools...
  python3        # Add Python
  imagemagick    # Add image tools
];
```

Rebuild the sandbox:

```bash
nix build . -o result
```

## Runtime Files

| Path | Purpose |
|------|---------|
| `data/nixbot.db` | SQLite database (auto-created) |
| `~/.nixbot/key` | Encryption key for credentials |
| `~/.nixbot/credentials.json` | Encrypted credential store |
| `~/.bwrapper/nixbot/groups/{group}` | Group workspace directories |
