#!/usr/bin/env node
/**
 * mcp/cli.ts — stdio entry point for the HDV MCP server.
 *
 * Usage:
 *   npm run mcp                 # serve MCP over stdio (for Cursor / other MCP clients)
 *
 * MCP speaks JSON-RPC over stdout/stdin, so this process MUST keep stdout clean: all human
 * logging goes to stderr. See docs/MCP.md for the Cursor `mcp.json` config snippet.
 *
 * Every intent submitted via the `hdv_intent` tool still flows HOPE → APEX → KNOLL → target;
 * MCP is just another front door, exactly like the HTTP gateway. No endpoint bypasses APEX.
 */
import { startStdioServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  // stderr only — stdout is reserved for the MCP JSON-RPC stream.
  process.stderr.write(
    `[${SERVER_NAME} v${SERVER_VERSION}] HDV MCP server on stdio — ` +
      `KNOLL gate enforced · APEX sole router · tools: hdv_intent, hdv_estimate_cost, hdv_health, hdv_models, hdv_usage\n`,
  );

  const { server } = await startStdioServer();

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`hdv mcp server failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
