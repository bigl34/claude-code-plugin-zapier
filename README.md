<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-zapier

Zapier automation actions + Zap management via browser automation

![Version](https://img.shields.io/badge/version-1.1.6-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- MCP Commands (Action Execution)
- **list-tools** — List all available Zapier MCP actions (raw)
- **list-actions** — List MCP actions with parameter details
- **execute** — Execute a Zapier MCP action by name
- Zap Management Commands (Browser-Based)
- **list-zaps** — List all Zaps with on/off/error status
- **view-history** — `--zap-id`, `--limit`
- **view-error** — `--run-id` (required)
- **replay-run** — `--run-id` (required)
- **toggle-zap** — `--zap-id` (required), `--enable` (required)
- **discover-endpoints** — Discover internal API endpoints (dev tool)
- **screenshot** — `--filename`, `--full-page`
- **reset** — Close browser and clear session

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- MCP server binary for the target service (configured via `config.json`)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-zapier.git
cd claude-code-plugin-zapier
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js list-tools
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```
4. Ensure the MCP server binary is available on your system (see the service's documentation)

## Available Commands

### MCP Commands (Action Execution)

| Command        | Description                                 |
| -------------- | ------------------------------------------- |
| `list-tools`   | List all available Zapier MCP actions (raw) |
| `list-actions` | List MCP actions with parameter details     |
| `execute`      | Execute a Zapier MCP action by name         |

### Zap Management Commands (Browser-Based)

| Command              | Options                                      | Description                             |
| -------------------- | -------------------------------------------- | --------------------------------------- |
| `list-zaps`          | List all Zaps with on/off/error status       |                                         |
| `view-history`       | `--zap-id`, `--limit`                        | View Zap run history                    |
| `view-error`         | `--run-id` (required)                        | Drill into a failed run's error details |
| `replay-run`         | `--run-id` (required)                        | Re-execute a failed run                 |
| `toggle-zap`         | `--zap-id` (required), `--enable` (required) | Turn a Zap on or off                    |
| `discover-endpoints` | Discover internal API endpoints (dev tool)   |                                         |
| `screenshot`         | `--filename`, `--full-page`                  | Take screenshot of current browser page |
| `reset`              | Close browser and clear session              |                                         |

## How It Works

This plugin wraps an MCP (Model Context Protocol) server, providing a CLI interface that communicates with the service's MCP binary. The CLI translates commands into MCP tool calls and returns structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| MCP connection timeout | Ensure the MCP server binary is installed and accessible |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
