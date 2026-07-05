#!/usr/bin/env node
/**
 * @nit-in/acil-mcp — ACIL MCP Server
 *
 * Exposes ACIL pre-execution cost governance as Model Context Protocol tools.
 * Connects to the same acil-outcomes.json / acil-feedback.json / acil-audit.json
 * that the VS Code extension writes — no extra sync needed.
 *
 * Transport: stdio JSON-RPC 2.0 (MCP spec)
 *
 * Tools exposed:
 *   acil_preflight      — pre-execute cost check before sending to LLM
 *   acil_status         — current budget, balance, archetype summary
 *   acil_forecast       — exhaustion date + risk level
 *   acil_budget         — get or set monthly budget
 *   acil_feedback       — record accept/reject on ACIL recommendations
 *   acil_compliance     — export HMAC-signed audit batch
 *
 * Wire for Cursor (.vscode/mcp.json):
 *   {
 *     "servers": {
 *       "acil": {
 *         "type": "stdio",
 *         "command": "node",
 *         "args": ["${workspaceFolder}/tools/acil-mcp/dist/server.js"],
 *         "env": { "ACIL_STORAGE": "${env:HOME}/.acil" }
 *       }
 *     }
 *   }
 *
 * Wire for Claude Desktop (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "acil": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/acil-mcp/dist/server.js"]
 *       }
 *     }
 *   }
 *
 * Author: imKrisK — Wave 11 MCP Integration Feature
 */

import * as os   from 'os';
import * as path from 'path';
import { ACILRuntime } from './ACILRuntime';
import { MCPServer }   from './MCPServer';

// ── Storage path resolution ──────────────────────────────────────────────────
// Priority: ACIL_STORAGE env → ~/.acil
const storagePath = process.env.ACIL_STORAGE
  ?? path.join(os.homedir(), '.acil');

const runtime = new ACILRuntime({ storagePath });
const server  = new MCPServer(runtime);

// Boot sequence
void (async () => {
  await runtime.load();
  server.start();
  // Flush on exit
  const shutdown = async () => {
    await runtime.save();
    process.exit(0);
  };
  process.on('SIGINT',  () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
})();
