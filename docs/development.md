# Development Guide

## Development Setup

### Enter dev shell

```bash
nix develop
```

This provides Node.js, npm, TypeScript, tsx, and the sandbox binary.

### Install dependencies

```bash
npm install
```

### Run in dev mode

```bash
npm run dev
```

## Project Structure

```
nixbot/
├── flake.nix              # Nix configuration
├── package.json           # Node.js dependencies
├── tsconfig.json          # TypeScript config
├── src/
│   ├── cli.ts             # Entry point
│   ├── repl.ts            # REPL loop + orchestration
│   ├── llm.ts             # LLM API integration
│   ├── llm.test.ts        # LLM tests
│   ├── config.ts          # Configuration schema
│   ├── credentials.ts     # Credential management
│   ├── credentials.test.ts
│   ├── cron.ts            # Cron scheduling
│   ├── cron.test.ts
│   ├── repl.test.ts
│   └── test-sandbox.ts    # Sandbox manual test
├── groups/
│   ├── main/CLAUDE.md
│   └── work/CLAUDE.md
└── data/                  # SQLite (runtime)
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run in dev mode with tsx |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run start` | Run compiled version |
| `npm test` | Run unit tests |

## Adding a Slash Command

Edit `src/repl.ts` in the REPL loop:

```typescript
if (input.startsWith("/mycommand ")) {
  const arg = input.slice(11).trim();
  // Handle command
  console.log(`You said: ${arg}`);
  continue;
}
```

## Adding an LLM Provider

Edit `src/llm.ts`:

```typescript
if (config.provider === "new-provider") {
  const res = await makeRequest(
    "https://api.newprovider.com/v1/chat",
    {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body
  );
  const data = JSON.parse(res);
  return data.choices?.[0]?.message?.content ?? "";
}
```

Update the provider enum in `src/repl.ts`:

```typescript
llmProvider: z.enum(["anthropic", "openai", "openai-compatible", "new-provider"])
```

## Adding Sandbox Tools

Edit `flake.nix`:

```nix
agentTools = with pkgs; [
  bashInteractive
  coreutils
  curl
  # ... existing tools
  python3
  imagemagick
];
```

Rebuild:

```bash
nix build . -o result
```

## Testing

### Unit Tests

```bash
npm test
```

Uses Node.js built-in test runner with `tsx --test`.

### Manual Sandbox Test

```bash
npx tsx src/test-sandbox.ts
```

### LLM Integration Test

```bash
OPENAI_API_KEY=test npm run dev
# Then type: test
```

## Database

### Location

`data/nixbot.db` (SQLite)

### Reset

```bash
rm -rf data/
```

### Inspect

```bash
sqlite3 data/nixbot.db
sqlite> .tables
sqlite> SELECT * FROM messages LIMIT 10;
```

## Debugging

### Enable verbose output

Add console.log statements in source files.

### Check sandbox binary

```bash
./result/bin/run-in-sandbox "echo test"
```

### Check environment

```bash
./result/bin/run-in-sandbox "env | sort"
```

## Building for Production

### Compile TypeScript

```bash
npm run build
```

Output goes to `dist/`.

### Run compiled

```bash
npm run start
```

Or directly:

```bash
node dist/cli.js
```

## Nix Integration

### As a flake input

```nix
inputs.nixbot.url = "github:user/nixbot";

# Use the package
environment.systemPackages = [ 
  inputs.nixbot.packages.x86_64-linux.default 
];
```

### As a systemd service

Create a unit file:

```ini
[Unit]
Description=Nixbot Agent
After=network.target

[Service]
Type=simple
User=nixbot
WorkingDirectory=/opt/nixbot
Environment="ANTHROPIC_API_KEY=your-key"
ExecStart=/opt/nixbot/dist/cli.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Contributing

1. Make changes
2. Run tests: `npm test`
3. Test manually: `npm run dev`
4. Check lint/types: `npx tsc --noEmit`
