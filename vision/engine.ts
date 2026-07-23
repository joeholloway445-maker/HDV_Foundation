/**
 * vision/engine.ts — VISION, the Action Layer.
 *
 * VISION performs real task implementation via sandboxed tools (Docker / gVisor). It is
 * spun up on demand and terminated after use.
 *
 * CONSTRAINTS:
 *   - VISION CANNOT create. It executes existing plans; it does not invent scenarios.
 *   - VISION CANNOT govern. It makes no routing or policy decisions.
 *   - VISION never talks to DREAM (or any peer) directly. Results go back via APEX only.
 *
 * Phase 1: the sandbox internals are safe STUBS. The routing/lifecycle/billing around
 * them is fully functional; only the actual containerized tool execution is mocked.
 */
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import type { AgentHandler, CreatePacketInput, DispatchResult } from '../apex/index.js';
import { spawnPersona, executePersona, terminatePersona } from '../nodes/index.js';

export type SandboxKind = 'docker' | 'gvisor';

export interface ExecutionResult {
  intent: string;
  tool: string;
  sandbox: SandboxKind;
  ok: boolean;
  output: Record<string, unknown>;
  personaCount: number;
}

export type SendViaApex = (input: CreatePacketInput) => DispatchResult;

export class ExecutionEngine {
  constructor(
    private readonly sandbox: SandboxKind = 'gvisor',
    private readonly sendViaApex?: SendViaApex,
  ) {}

  /**
   * Execute a task in a sandbox using an ephemeral persona (spawn -> execute -> terminate).
   * STUB: this does not launch a real container; it simulates a successful tool run so the
   * backbone (routing, lifecycle, billing) is exercised end-to-end.
   */
  execute(intent: string, data: Record<string, unknown> = {}): ExecutionResult {
    const tool = typeof data.tool === 'string' ? data.tool : 'noop';
    const persona = spawnPersona(AgentRole.VISION, 'vision-node-0');
    const exec = executePersona(persona, { intent, tool, ...data });
    terminatePersona(persona);

    return {
      intent,
      tool,
      sandbox: this.sandbox,
      ok: true,
      output: {
        note: `[stub] executed "${tool}" in ${this.sandbox} sandbox`,
        score: exec.score,
      },
      personaCount: 1,
    };
  }

  /** APEX inbound handler. VISION only ever receives packets from APEX. */
  asHandler(): AgentHandler {
    return (packet: RoutingPacket) => {
      const result = this.execute(packet.payload.intent, packet.payload.data);
      if (this.sendViaApex) {
        // Return path mediated by APEX: VISION -> APEX -> HOPE.
        this.sendViaApex({
          source: AgentRole.VISION,
          destination: AgentRole.HOPE,
          intent: `execution-result:${packet.payload.intent}`,
          data: { ok: result.ok, output: result.output },
          priority: packet.header.priority,
        });
      }
      return { ok: result.ok, output: result.output, personaCount: result.personaCount };
    };
  }
}
