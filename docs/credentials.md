# Credential Management

Nixbot provides secure credential storage with encrypted persistence and selective injection.

## Overview

Credentials are stored encrypted at `~/.nixbot/credentials.json` using AES-256-GCM. The encryption key is stored at `~/.nixbot/key`.

## Security Model

### Blocklist Filtering

Sensitive environment variables are never passed to the sandbox:

- `*_API_KEY`
- `*_SECRET`
- `*_PASSWORD`
- `*_TOKEN`
- `*_CREDENTIAL`
- `ANTHROPIC_*`
- `OPENAI_*`
- `AWS_*`
- `GITHUB_*`

### Per-Command Injection

Credentials are only injected when a command explicitly references them:

```bash
# Only GITHUB_TOKEN is injected
git push https://$GITHUB_TOKEN@github.com/user/repo.git
```

### Output Masking

Credential values are replaced with `***` in:
- Console output
- Stored messages in SQLite

## File Locations

| Path | Purpose | Permissions |
|------|---------|-------------|
| `~/.nixbot/key` | 32-byte encryption key | 0600 |
| `~/.nixbot/credentials.json` | Encrypted credential store | 0600 |
| `~/.nixbot/` | Credentials directory | 0700 |

## REPL Commands

### List credentials

```
/cred list
```

Output:
```
Stored credentials:
  GITHUB_TOKEN  [scope: repo]  [last used: 2024-01-15 10:30:00]
  API_KEY       [scope: prod]  [last used: never]
```

### Add credential

```
/cred add <NAME> [SCOPE]
```

Example:
```
[main]> /cred add GITHUB_TOKEN repo
Enter value for GITHUB_TOKEN: <hidden input>
Credential 'GITHUB_TOKEN' stored.
```

The scope is optional metadata for organizing credentials.

### Remove credential

```
/cred remove <NAME>
```

Example:
```
[main]> /cred remove GITHUB_TOKEN
Credential 'GITHUB_TOKEN' removed.
```

## Usage in Commands

Reference credentials using environment variable syntax:

```bash
# $VAR syntax
curl -H "Authorization: Bearer $API_KEY" https://api.example.com

# ${VAR} syntax
git clone https://${GITHUB_TOKEN}@github.com/user/repo.git
```

When the LLM generates a command with `$VAR` or `${VAR}`, Nixbot:
1. Detects the variable reference
2. Retrieves the credential value
3. Injects only that credential into the sandbox environment
4. Executes the command
5. Masks the credential value in output

## Key Management

### First Run

On first use, Nixbot automatically generates:
- A random 32-byte encryption key
- An empty credentials file

### Key Security

- **The key cannot be recovered if lost** - all stored credentials become inaccessible
- Back up the key file separately from credentials
- Store in a secure location (e.g., password manager, encrypted backup)

### Resetting Credentials

If the key is lost or corrupted:

```bash
# Warning: this makes all stored credentials inaccessible
rm ~/.nixbot/key ~/.nixbot/credentials.json
```

Nixbot will generate new files on next run.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NIXBOT_CRED_DIR` | `~/.nixbot` | Override credentials directory |

Useful for testing:

```bash
NIXBOT_CRED_DIR=/tmp/test-creds npm run dev
```

## Encryption Details

- **Algorithm**: AES-256-GCM
- **Key length**: 32 bytes (256 bits)
- **IV length**: 16 bytes (128 bits)
- **Auth tag**: 16 bytes

Each credential is encrypted with a unique random IV and authenticated with an auth tag.
