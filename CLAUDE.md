# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SSH Client MCP Server is a Model Context Protocol (MCP) server that exposes SSH capabilities to LLMs and MCP clients. It's a single-file TypeScript application that provides secure remote shell command execution via SSH.

## Development Commands

- **Build**: `pnpm run build` - Compiles TypeScript and makes build files executable
- **Testing**: `pnpm run inspect` - Use MCP Inspector for visual debugging
- **Development**: No watch mode available; rebuild after changes

## Architecture

### Core Components
- **Single entry point**: `src/index.ts` contains the entire MCP server implementation
- **MCP Tool**: `exec` tool for executing shell commands on remote servers
- **SSH Client**: Uses `ssh2` library for SSH connections with password or key authentication
- **Configuration**: Command-line argument parsing for SSH connection parameters

### Key Dependencies
- `@modelcontextprotocol/sdk` - MCP server framework
- `ssh2` - SSH client implementation  
- `zod` - Schema validation for tool parameters

## Configuration

Server accepts these CLI arguments:
- `--host` (required): SSH server hostname/IP
- `--user` (required): SSH username  
- `--port` (optional): SSH port (default: 22)
- `--password` (optional): SSH password
- `--key` (optional): Path to private SSH key

Either `--password` or `--key` must be provided for authentication.

## Build Output

- TypeScript compiles to `build/` directory
- Binary entry point: `build/index.js` (executable)
- Package distributed via `build/` folder only