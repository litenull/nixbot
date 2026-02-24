# Sandbox System

Nixbot uses bubblewrap for process isolation, providing a secure environment for executing LLM-generated commands.

## Overview

Two sandbox types are available:

1. **Headless sandbox** - Fast, no GUI, for CLI commands
2. **GUI sandbox** - X11 support for browser automation

## Why Bubblewrap?

### Attack Surface

| System | Code Lines | CVEs |
|--------|------------|------|
| Bubblewrap | ~8,000 | ~5 |
| Docker | ~2,000,000 | 200+ |

Bubblewrap has 250x less code and far fewer vulnerabilities.

### Privilege Model

| System | Privileges | Escape Impact |
|--------|------------|---------------|
| Bubblewrap | User only | User context |
| Docker | Root daemon | Host root access |

Bubblewrap runs entirely as your user—no root required.

### Security History

- **Docker**: 200+ CVEs including container escapes (runc exploits)
- **Bubblewrap**: ~5 CVEs total, mostly denial-of-service, not escapes

## Headless Sandbox

The default sandbox for bash command execution.

### Features

- No GUI, minimal attack surface
- Fast startup (<100ms)
- Network enabled (for API calls)
- Isolated filesystem with workspace mount

### Available Tools

- `bash` - Shell
- `curl` - HTTP client
- `jq` - JSON processor
- `git` - Version control
- `ripgrep` (rg) - Search
- `fd` - File finder
- `bat` - Cat with syntax highlighting
- `findutils` - Find utilities
- `gnused` - Stream editor
- `gawk` - AWK processor
- `node` - Node.js runtime
- `chromium` - Headless browser
- `which` - Command locator

### Isolation

```
bwrap \
  --unshare-all          \  # Isolate namespaces
  --share-net            \  # Enable network
  --die-with-parent      \  # Exit when parent exits
  --new-session          \  # New session
  --ro-bind /nix/store   \  # Read-only Nix store
  --proc /proc           \  # Proc filesystem
  --dev /dev             \  # Device filesystem
  --tmpfs /tmp           \  # Isolated temp
  --tmpfs /run           \  # Isolated run
  --ro-bind /etc/resolv.conf \  # DNS resolution
  --ro-bind /etc/ssl/certs    \  # SSL certificates
  --bind $WORKSPACE /workspace \  # Workspace mount
  --setenv PATH $TOOL_PATH    \  # Tool binaries
  --chdir /workspace          \  # Working directory
  -- bash -c "$COMMAND"
```

## GUI Sandbox

For browser automation with Playwright or other GUI applications.

### Features

- X11 support via xwayland-satellite
- Full Chromium browser
- DBus filtering via xdg-dbus-proxy

### Usage

Built with nix-bwrapper, provides:
- Isolated X11 display
- Audio routing (configurable)
- Persistent workspace mount

### When to Use

- Browser automation with Playwright
- GUI testing
- Visual scraping

## Adding Tools

Edit `flake.nix` and add to `agentTools`:

```nix
agentTools = with pkgs; [
  # existing tools...
  python3        # Python interpreter
  imagemagick    # Image manipulation
  ffmpeg         # Video processing
];
```

Rebuild:

```bash
nix build . -o result
```

## Workspace

Each group has an isolated workspace:

```
~/.bwrapper/nixbot/groups/
├── main/     # Main group workspace
├── work/     # Work group workspace
└── custom/   # Custom group workspace
```

Inside the sandbox, the workspace is mounted at `/workspace`.

## Security Considerations

### What's Protected

- Host filesystem is isolated
- No access to user home directory
- Sensitive env vars blocked
- Credentials only injected when referenced

### What's Allowed

- Network access (required for API calls)
- Write access to workspace
- Read access to Nix store (read-only)

### Timeout

Commands timeout after 60 seconds by default. Configurable in `runInSandbox()`.

## Testing

### Manual Test

```bash
./result/bin/run-in-sandbox "echo hello"
./result/bin/run-in-sandbox "curl https://example.com"
```

### Unit Test

```bash
npx tsx src/test-sandbox.ts
```

## Troubleshooting

### Sandbox hangs

- GUI sandbox may block on xwayland-satellite
- Use headless sandbox for CLI commands
- Check for interactive prompts in commands

### Command not found

- Verify tool is in `agentTools` in `flake.nix`
- Rebuild sandbox with `nix build . -o result`

### Permission denied

- Check workspace directory permissions
- Verify WORKSPACE env var is set correctly
