# SSH Client MCP Server

[![License](https://img.shields.io/github/license/jordanburke/ssh-client-mcp-server)](./LICENSE)
[![NPM Version](https://img.shields.io/npm/v/ssh-mcp)](https://www.npmjs.com/package/ssh-mcp)

**SSH Client MCP Server** is a local Model Context Protocol (MCP) server that exposes SSH control for Linux and Windows systems, enabling LLMs and other MCP clients to execute shell commands securely via SSH.

## Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Installation](#installation)
- [Client Setup](#client-setup)
- [Testing](#testing)
- [Disclaimer](#disclaimer)
- [Support](#support)

## Quick Start

- [Install](#installation) SSH Client MCP Server
- [Configure](#configuration) SSH Client MCP Server
- [Set up](#client-setup) your MCP Client (e.g. Claude Desktop, Cursor, etc)
- Execute remote shell commands on your Linux or Windows server via natural language

## Features

- MCP-compliant server exposing SSH capabilities
- Execute shell commands on remote Linux and Windows systems
- Secure authentication via password or SSH key
- Built with TypeScript and the official MCP SDK

### Tools

- `exec`: Execute a shell command on the remote server

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/jordanburke/ssh-client-mcp-server.git
   cd ssh-client-mcp-server
   ```
2. **Install dependencies:**
   ```bash
   pnpm install
   ```

## Client Setup

You can configure Claude Desktop to use this MCP Server.
   - `host`: Hostname or IP of the Linux or Windows server
   - `port`: SSH port (default: 22)
   - `user`: SSH username
   - `password`: SSH password (or use `key` for key-based auth) (optional)
   - `key`: Path to private SSH key (optional)


```commandline
{
    "mcpServers": {
        "ssh-client-mcp-server": {
            "command": "npx",
            "args": [
                "ssh-client-mcp-server",
                "-y",
                "--",
                "--host=1.2.3.4",
                "--port=22",
                "--user=root",
                "--password=pass",
                "--key=path/to/key"
            ]
        }
    }
}
```

## Testing

You can use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for visual debugging of this MCP Server.

```sh
pnpm run inspect
```

## Disclaimer

SSH Client MCP Server is provided under the [MIT License](./LICENSE). Use at your own risk. This project is not affiliated with or endorsed by any SSH or MCP provider.

## Support

If you find SSH Client MCP Server helpful, consider starring the repository or contributing! Pull requests and feedback are welcome. 