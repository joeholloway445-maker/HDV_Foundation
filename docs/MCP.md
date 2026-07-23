# HDV as an MCP Tool Provider

The `mcp/` package exposes HDV over the [Model Context Protocol](https://modelcontextprotocol.io)
so external agents and IDEs (e.g. **Cursor**) can drive the matrix as a tool provider. It speaks
JSON-RPC over **stdio** using the official `@modelcontextprotocol/sdk`.

> **MCP is just another front door — like the HTTP gateway.**
> Every intent still flows **HOPE → APEX → KNOLL → (DREAM | VISION)**. The MCP server is a
> composition root: it wires the HOPE trio + DREAM + VISION into an `ApexOrchestrator` via
> dependency injection and never bypasses APEX or KNOLL. Read-only tools are pure projections
> of the ledger, audit trail, and matrix topology. **No secrets** (KNOLL tokens, packet hashes,
> API keys) are ever returned.

---

## Start the server

```bash
npm run mcp        # serve MCP over stdio
```

MCP reserves **stdout** for the JSON-RPC stream, so all human-readable logging goes to **stderr**.
The process serves requests until the client disconnects.

A convenience `bin` is also declared (`hdv-mcp`) that points at the compiled entry
(`dist/mcp/cli.js`) after `npm run build`, for clients that prefer to launch a binary.

---

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `hdv_intent` | `{ utterance: string }` | Interprets with HOPE and routes via APEX→KNOLL→(DREAM/VISION). HOPE's voice + routing status + a KNOLL verdict summary + the public intent classification. Low-confidence utterances are **held** (HOPE clarifies) and not dispatched. |
| `hdv_estimate_cost` | `{ activeParams: number, durationSec: number, model?: string }` | Offline, deterministic USD estimate: `(activeParams/1e9) × (durationSec/3600) × ratePerBillionParamHour`, scaled by an optional model hint. No paid API. |
| `hdv_health` | `{}` | Always-on agents (HOPE/KNOLL/APEX), ephemeral idle flags (DREAM/VISION), KNOLL gate state, and matrix topology stats. |
| `hdv_models` | `{}` | Model catalog from `config/models.json` when present, otherwise a static offline list of 7B/local options. |
| `hdv_usage` | `{ limit?: number }` | Recent APEX billing ledger tail, KNOLL audit counts, and an observability metrics snapshot — a read-only projection of traffic this server already routed. |

Each tool advertises a JSON-Schema `inputSchema` in `tools/list`, matching the MCP wire format.
Tool results are returned both as pretty-printed JSON `text` content and as
`structuredContent` for clients that consume structured output.

### Cost estimate rate table

`hdv_estimate_cost` is a heuristic, GPU-amortized estimator (see `mcp/estimate.ts`). The base
rate is `$0.0005` per **billion active parameters per hour**, scaled by a model multiplier:

| Model hint matches | Multiplier |
| --- | --- |
| `stub` | 0.1 |
| `local` / `ollama` / `llama` / `mistral` / `qwen` / `phi` / `gemma` / `7b` / `8b` | 1 |
| `13b` / `mixtral` | 2 |
| `mini` / `small` / `haiku` / `flash` / `gpt-4o-mini` | 4 |
| `gpt-4o` / `gpt-4` / `claude` / `opus` / `sonnet` / `70b` / `large` / `frontier` | 12 |

Idle personas draw ~zero compute (see `nodes/parameters.ts`), so only the **active** parameter
footprint is billed. Negative or non-finite inputs are floored to zero.

---

## Cursor MCP configuration

Add HDV to Cursor's MCP config. Project-scoped config lives in `.cursor/mcp.json` (create it in
the repo root); global config lives in `~/.cursor/mcp.json`.

Run it directly from source with `tsx` (no build step):

```json
{
  "mcpServers": {
    "hdv-matrix": {
      "command": "npx",
      "args": ["tsx", "mcp/cli.ts"],
      "cwd": "/absolute/path/to/big5-matrix"
    }
  }
}
```

Or via the npm script:

```json
{
  "mcpServers": {
    "hdv-matrix": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/absolute/path/to/big5-matrix"
    }
  }
}
```

Or, after `npm run build`, launch the compiled entry point:

```json
{
  "mcpServers": {
    "hdv-matrix": {
      "command": "node",
      "args": ["dist/mcp/cli.js"],
      "cwd": "/absolute/path/to/big5-matrix"
    }
  }
}
```

After saving, reload Cursor's MCP servers (Settings → MCP). The five `hdv_*` tools should appear
and be callable from the agent.

### Optional environment

The MCP server is offline-first and needs **no** configuration. Optional variables (shared with
the rest of HDV) tune model enrichment; none are required and none enable a paid API by default:

| Variable | Purpose |
| --- | --- |
| `HDV_LLM_PROVIDER` | `stub` (default, offline) or `openai_compatible` |
| `HDV_LLM_BASE_URL` | Base URL for an OpenAI-compatible endpoint (local Ollama/vLLM/llama.cpp, etc.) |
| `HDV_LLM_API_KEY` | Optional key for that endpoint (omit for keyless local servers) |
| `HDV_LLM_MODEL` | Model id for that endpoint |

---

## Example JSON-RPC session

The stdio transport uses newline-delimited JSON-RPC. A minimal handshake + call:

```jsonc
// → initialize
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"0"}}}
// → notifications/initialized
{"jsonrpc":"2.0","method":"notifications/initialized"}
// → list tools
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
// → route an intent (HOPE → APEX → KNOLL → VISION)
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hdv_intent","arguments":{"utterance":"run the deployment for \"Gamma\" now"}}}
```

The `hdv_intent` call above returns `routingStatus: "SUCCESS"`, `forwardedTo: "VISION"`, and a
KNOLL verdict summary — the request was gated by KNOLL and billed on the APEX ledger, exactly as
if it had come through the HTTP gateway.

---

## Design notes

- **Testable handlers.** All behavior lives in `HdvToolProvider` (`mcp/tools.ts`) as plain async
  methods returning JSON-serializable objects. `tests/mcp.test.ts` exercises them directly, with
  no MCP wire needed. `mcp/server.ts` is a thin shim that adapts them to the SDK's low-level
  `Server` using the JSON-Schema descriptors as the single source of truth.
- **Shared orchestrator.** One `ApexOrchestrator` backs every tool, so traffic from `hdv_intent`
  shows up in `hdv_health`/`hdv_usage`. A `MetricsCollector` is wired to the orchestrator's
  read-only dispatch observer.
- **Constitution-safe.** Nothing in `mcp/` imports one peer agent from another; DREAM/VISION are
  injected and only ever receive packets from APEX. See `.cursorrules`.
