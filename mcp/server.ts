/**
 * mcp/server.ts — adapt the HdvToolProvider to the Model Context Protocol over stdio.
 *
 * This is a thin transport shim. All the logic lives in HdvToolProvider (mcp/tools.ts); here
 * we only translate MCP `tools/list` / `tools/call` requests into provider calls and shape the
 * results back into MCP `CallToolResult`s. Because the provider is testable on its own, this
 * file needs no unit tests of its own — it is pure wiring.
 *
 * We use the low-level `Server` + JSON-Schema tool descriptors (what actually travels on the
 * MCP wire) rather than the zod-based high-level helper, so the tool schemas defined in
 * mcp/tools.ts are the single source of truth.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { HdvToolProvider, type HdvToolProviderOptions } from './tools.js';

export const SERVER_NAME = 'hdv-matrix';
export const SERVER_VERSION = '0.5.0';

export interface HdvMcpServerOptions extends HdvToolProviderOptions {
  /** Provide a pre-built provider (e.g. sharing an orchestrator); otherwise one is built. */
  provider?: HdvToolProvider;
}

/**
 * Build an MCP `Server` whose tools are backed by an HdvToolProvider. The returned server is
 * not yet connected to a transport — call `connect(transport)` (see `startStdioServer`).
 */
export function createHdvMcpServer(options: HdvMcpServerOptions = {}): { server: Server; provider: HdvToolProvider } {
  const provider = options.provider ?? new HdvToolProvider(options);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: provider.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const result = await provider.callTool(name, (args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
      structuredContent: result.data,
      isError: result.isError,
    };
  });

  return { server, provider };
}

/**
 * Start the HDV MCP server on stdio. Resolves once connected. The process then serves MCP
 * requests until the transport closes (e.g. the parent IDE disconnects).
 */
export async function startStdioServer(options: HdvMcpServerOptions = {}): Promise<{ server: Server; provider: HdvToolProvider }> {
  const { server, provider } = createHdvMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, provider };
}
