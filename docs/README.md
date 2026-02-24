# Nixbot Documentation

A NanoClaw-inspired agent isolation system using Nix + bubblewrap for secure sandboxed LLM agent execution.

## Overview

Nixbot provides a secure environment for running LLM-powered agents that can execute commands, interact with APIs, and automate tasks—all within isolated sandboxes.

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | System design and data flow |
| [Getting Started](./getting-started.md) | Installation and quick start |
| [Configuration](./configuration.md) | Environment variables and settings |
| [Credentials](./credentials.md) | Secure credential management |
| [Cron Jobs](./cron.md) | Scheduled task automation |
| [Sandbox](./sandbox.md) | Isolation and security model |
| [Development](./development.md) | Building and extending Nixbot |

## Key Features

- **Sandboxed Execution**: Commands run in isolated bubblewrap containers
- **Multi-Group Support**: Separate contexts and workspaces per project/topic
- **Credential Management**: Encrypted storage with per-command injection
- **Cron Scheduling**: Natural language and standard cron syntax support
- **Multiple LLM Providers**: Anthropic, OpenAI, and OpenAI-compatible APIs

## Quick Start

```bash
nix develop
npm install
cp .env.example .env
npm run dev
```

## REPL Commands

```
[main]> hello              # Send message to current group
@work check the logs       # Send to specific group
/switch work               # Change active group
/list                      # List all groups
/history                   # Show conversation history
/add personal              # Create new group
/quit                      # Exit
```

## Project Structure

```
nixbot/
├── flake.nix              # Nix configuration
├── src/
│   ├── cli.ts             # Entry point
│   ├── repl.ts            # REPL loop + orchestration
│   ├── llm.ts             # LLM API integration
│   ├── config.ts          # Configuration schema
│   ├── credentials.ts     # Encrypted credential storage
│   └── cron.ts            # Cron job scheduling
├── groups/
│   ├── main/CLAUDE.md     # Main group context
│   └── work/CLAUDE.md     # Work group context
└── data/                  # SQLite database (runtime)
```
