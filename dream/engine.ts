/**
 * dream/engine.ts — DREAM, the Simulation Layer.
 *
 * DREAM generates all *possible* outcomes for a request (ephemeral creation of
 * scenarios). It is spun up on demand and terminated after use.
 *
 * CONSTRAINTS:
 *   - DREAM CANNOT govern. It makes no routing or policy decisions.
 *   - DREAM CANNOT execute. It never runs a tool or touches a sandbox.
 *   - DREAM never talks to VISION (or any peer) directly. Results go back via APEX only.
 *
 * DREAM registers a handler with APEX; APEX is the only source of its inbound packets.
 */
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import type { AgentHandler, CreatePacketInput, DispatchResult } from '../apex/index.js';
import { spawnPersona, executePersona, terminatePersona } from '../nodes/index.js';

export interface Outcome {
  id: string;
  scenario: string;
  probability: number;
  utility: number;
}

export interface SimulationResult {
  intent: string;
  outcomes: Outcome[];
  personaCount: number;
}

/** Optional back-channel so DREAM can return results through APEX (never directly). */
export type SendViaApex = (input: CreatePacketInput) => DispatchResult;

export class SimulationEngine {
  constructor(private readonly sendViaApex?: SendViaApex) {}

  /**
   * Simulate outcomes for a request. Uses ephemeral personas from DREAM's node matrix:
   * spawn -> execute -> terminate. Pure simulation; no governance, no execution.
   */
  simulate(intent: string, data: Record<string, unknown> = {}, breadth = 3): SimulationResult {
    const outcomes: Outcome[] = [];
    let personaCount = 0;

    for (let i = 0; i < breadth; i++) {
      // Ephemeral matrix hook: each scenario is dreamed by a short-lived persona.
      const persona = spawnPersona(AgentRole.DREAM, `dream-node-${i}`);
      const exec = executePersona(persona, { intent, ...data, branch: i });
      terminatePersona(persona);
      personaCount += 1;

      outcomes.push({
        id: `${persona.id}`,
        scenario: `Scenario ${i + 1} for "${intent}"`,
        probability: round4(1 / breadth),
        utility: round4(exec.score),
      });
    }

    return { intent, outcomes, personaCount };
  }

  /**
   * APEX inbound handler. DREAM only ever receives packets from APEX. If a back-channel
   * was injected, DREAM returns its results by asking APEX to route them (never direct).
   */
  asHandler(): AgentHandler {
    return (packet: RoutingPacket) => {
      const result = this.simulate(packet.payload.intent, packet.payload.data);
      if (this.sendViaApex) {
        // Return path is mediated by APEX: DREAM -> APEX -> HOPE.
        this.sendViaApex({
          source: AgentRole.DREAM,
          destination: AgentRole.HOPE,
          intent: `simulation-result:${packet.payload.intent}`,
          data: { outcomes: result.outcomes, personaCount: result.personaCount },
          priority: packet.header.priority,
        });
      }
      return { outcomes: result.outcomes, personaCount: result.personaCount };
    };
  }
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
