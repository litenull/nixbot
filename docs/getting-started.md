# Getting Started

## Prerequisites

- Linux or macOS environment
- [Nix](https://nixos.org/download/) installed with flakes enabled
- At least one LLM API key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)
- Node.js 18+ (provided automatically by the Nix dev shell)

## Installation

### 1. Enter the Nix development shell

```bash
nix develop
```

This provides Node.js, npm, TypeScript, and the sandbox binary.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

Copy the example configuration and edit it:

```bash
cp .env.example .env
```

Edit `.env` with your LLM provider settings:

```env
# For z.ai (GLM)
NIXBOT_LLM_PROVIDER=openai-compatible
OPENAI_API_KEY=your-zhipu-key
NIXBOT_LLM_MODEL=glm-4-flash
NIXBOT_LLM_BASE_URL=https://api.z.ai/api/coding/paas/v4

# For Anthropic
NIXBOT_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-key
NIXBOT_LLM_MODEL=claude-sonnet-4-20250514

# For OpenAI
NIXBOT_LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
NIXBOT_LLM_MODEL=gpt-4o
```

### 4. Build the sandbox

```bash
nix build . -o result
```

### 5. Run Nixbot

```bash
npm run dev
```

## First Steps

When Nixbot starts, you'll see:

```
  Nixbot Agent v0.1.0
  ───────────────────
  Commands:
    @<group> <msg>  - Send to group
    /switch <group> - Change active group
    /list           - List groups
    /history        - Show conversation history
    /quit           - Exit

[main]>
```

### Basic Usage

Send a message to the current group:

```
[main]> what tools are available?
```

The LLM can execute bash commands:

```
[main]> list the files in the workspace
```

### Working with Groups

Create a new group:

```
[main]> /add myproject
Created group: myproject
```

Switch between groups:

```
[main]> /switch myproject
[myproject]>
```

Send a message to a specific group without switching:

```
[main]> @work check the build logs
```

## Running Modes

### Development mode (auto-reload)

```bash
npm run dev
```

### Production build

```bash
npm run build
npm run start
```

### Direct execution

```bash
npx tsx src/cli.ts
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NIXBOT_LLM_PROVIDER` | LLM provider | `anthropic` |
| `NIXBOT_LLM_MODEL` | Model name | `claude-sonnet-4-20250514` |
| `NIXBOT_LLM_BASE_URL` | API base URL (for openai-compatible) | - |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `OPENAI_API_KEY` | OpenAI API key | - |
| `NIXBOT_SANDBOX_BIN` | Sandbox binary path | `./result/bin/run-in-sandbox` |
| `NIXBOT_GROUPS_DIR` | Groups directory | `./groups` |
| `NIXBOT_DATA_DIR` | Data directory | `./data` |
| `NIXBOT_CRED_DIR` | Credentials directory | `~/.nixbot` |
