# Cron Jobs

Nixbot includes a built-in cron scheduler for automated recurring tasks.

## Overview

Cron jobs are stored in the SQLite database and executed by the scheduler running in the REPL. Each job is associated with a specific group and runs with that group's context.

## REPL Commands

### List jobs

```
/cron list [group]
```

Output:
```
Cron jobs:
  check-api [main] [enabled]
    schedule: 0 * * * *
    last: 2024-01-15 09:00:00, next: 2024-01-15 10:00:00
    prompt: Check if the API is responding
```

### Add job

```
/cron add <NAME> <SCHEDULE> <PROMPT>
```

Example:
```
[main]> /cron add check-api '0 * * * *' 'Check if the API is responding'
Job 'check-api' added. Next run: 2024-01-15 10:00:00
```

### Remove job

```
/cron remove <NAME>
```

### Enable/Disable job

```
/cron enable <NAME>
/cron disable <NAME>
```

## Schedule Format

Standard 5-field cron syntax:

```
minute hour day-of-month month day-of-week
```

| Field | Values |
|-------|--------|
| minute | 0-59 |
| hour | 0-23 |
| day-of-month | 1-31 |
| month | 1-12 |
| day-of-week | 0-6 (0 = Sunday) |

### Special Characters

| Character | Meaning |
|-----------|---------|
| `*` | Any value |
| `,` | Value list (e.g., `1,15`) |
| `-` | Range (e.g., `1-5`) |
| `/` | Step (e.g., `*/15` for every 15) |

### Examples

| Schedule | Description |
|----------|-------------|
| `*/1 * * * *` | Every minute |
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * *` | Every day at 9:00 AM |
| `0 9 * * 1` | Every Monday at 9:00 AM |
| `0 9 1 * *` | First day of month at 9:00 AM |
| `0 0 * * 0` | Every Sunday at midnight |

## Natural Language Scheduling

The LLM can create cron jobs from natural language requests:

```
[main]> check https://example.com every day and report changes
```

The LLM will generate:
```
/cron add check-example '0 9 * * *' 'Check https://example.com and report changes'
```

### Supported Patterns

| Request | Schedule |
|---------|----------|
| "every minute" | `*/1 * * * *` |
| "every hour" / "hourly" | `0 * * * *` |
| "every day" / "daily" | `0 9 * * *` |
| "every week" / "weekly" | `0 9 * * 1` |
| "every N minutes" | `*/N * * * *` |

## How It Works

1. **Scheduler Loop**: Runs every 60 seconds
2. **Check Due Jobs**: Queries jobs where `next_run <= now` and `enabled = true`
3. **Execute**: Calls `processMessage()` in the job's group with the prompt
4. **Update**: Sets `last_run` to now, calculates `next_run`

## Job Properties

| Property | Description |
|----------|-------------|
| `name` | Unique identifier |
| `group_name` | Group context for execution |
| `schedule` | Cron schedule expression |
| `prompt` | Prompt sent to the LLM |
| `enabled` | Whether job runs |
| `last_run` | Last execution time |
| `next_run` | Next scheduled time |

## Error Handling

- Failed jobs log errors but don't block other jobs
- Jobs continue to be scheduled even after failures
- Check console output for error details

## Database Schema

```sql
CREATE TABLE cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  schedule TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_run DATETIME,
  next_run DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
