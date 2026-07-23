/**
 * vision/engine.ts — VISION, the Action Layer.
 *
 * VISION performs real task implementation via sandboxed tools (Docker / gVisor). Phase 3
 * routes every task through the tool registry inside a SandboxSession (start → run → stop)
 * and returns a structured ExecutionReport that the APEX ledger can bill.
 *
 * CONSTRAINTS:
 *   - VISION CANNOT create. It executes existing plans; it does not invent scenarios, and
 *     `file_plan` never writes to real disk.
 *   - VISION CANNOT govern. It makes no routing or policy decisions.
 *   - VISION never talks to DREAM (or any peer) directly. Results go back via APEX only.
 *
 * Phase 3: the container runtime is still a safe STUB. Everything around it — tool
 * dispatch, sandbox lifecycle, resource-limit metadata, logs, exit codes, billing — is
 * fully functional.
 */
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import type { AgentHandler, CreatePacketInput, DispatchResult } from '../apex/index.js';
import { executePersona, spawnPersona, terminatePersona } from '../nodes/index.js';
import {
  createSandboxSession,
  type ResourceLimits,
  type SandboxKind,
} from './sandbox.js';
import { ToolRegistry } from './tools.js';
import {
  ResourceMonitor,
  type SessionResourceUsage,
  type ToolInvocationRecord,
} from './resource_monitor.js';

export type { SandboxKind } from './sandbox.js';

/** Structured, billable report of one sandboxed execution. */
export interface ExecutionReport {
  intent: string;
  tool: string;
  sandbox: SandboxKind;
  sessionId: string;
  ok: boolean;
  exitCode: number;
  output: Record<string, unknown>;
  logs: string[];
  durationMs: number;
  resourceLimits: ResourceLimits;
  personaCount: number;
  /** Whether the sandbox was killed for exceeding its timeout. */
  timedOut: boolean;
  /** Peak memory estimate observed for the session, in MB. */
  peakMemMb: number;
  /** Accounting fields the APEX ledger can turn into cost_usd. */
  billable: {
    personas: number;
    sandboxSeconds: number;
    cpuSeconds: number;
  };
}

export type SendViaApex = (input: CreatePacketInput) => DispatchResult;

export interface ExecutionEngineOptions {
  sandbox?: SandboxKind;
  limits?: Partial<ResourceLimits>;
  registry?: ToolRegistry;
  /** Optional shared monitor; when omitted the engine keeps its own. */
  monitor?: ResourceMonitor;
}

export class ExecutionEngine {
  private readonly sandboxKind: SandboxKind;
  private readonly limits?: Partial<ResourceLimits>;
  private readonly registry: ToolRegistry;
  private readonly sendViaApex?: SendViaApex;
  private readonly monitor: ResourceMonitor;

  constructor(sandbox: SandboxKind = 'gvisor', sendViaApex?: SendViaApex, options: ExecutionEngineOptions = {}) {
    this.sandboxKind = options.sandbox ?? sandbox;
    this.limits = options.limits;
    this.registry = options.registry ?? new ToolRegistry();
    this.sendViaApex = sendViaApex;
    this.monitor = options.monitor ?? new ResourceMonitor();
  }

  /** The tools available to VISION (read-only listing). */
  availableTools(): string[] {
    return this.registry.list();
  }

  /** Per-session resource usage accumulated by this engine (observe-only). */
  resourceUsage(): readonly SessionResourceUsage[] {
    return this.monitor.usageAll();
  }

  /** The tool-invocation audit trail accumulated by this engine (observe-only). */
  toolAudit(): readonly ToolInvocationRecord[] {
    return this.monitor.auditLog();
  }

  /**
   * Execute a task: spawn an ephemeral persona, open a sandbox session, run the requested
   * tool inside it, then terminate + stop everything. Returns a billable ExecutionReport.
   */
  execute(intent: string, data: Record<string, unknown> = {}): ExecutionReport {
    const tool = typeof data.tool === 'string' ? data.tool : 'system_info';
    const args = isRecord(data.args) ? (data.args as Record<string, unknown>) : {};

    const persona = spawnPersona(AgentRole.VISION, 'vision-node-0');
    executePersona(persona, { intent, tool });

    const session = createSandboxSession(this.sandboxKind, this.limits, { monitor: this.monitor });
    session.start();

    let ok = false;
    let exitCode = 1;
    let output: Record<string, unknown> = {};
    if (this.registry.has(tool)) {
      const result = this.registry.run(tool, args, { sandbox: session });
      ok = result.ok;
      exitCode = result.exitCode;
      output = result.output;
    } else {
      output = { error: `unknown tool "${tool}"`, available: this.registry.list() };
      exitCode = 127;
    }

    const summary = session.stop();
    terminatePersona(persona);

    const logs = session.logs().map((l) => `[${l.stream}] ${l.message}`);
    const sandboxSeconds = round4(summary.totalDurationMs / 1000);

    return {
      intent,
      tool,
      sandbox: this.sandboxKind,
      sessionId: session.id,
      ok,
      exitCode,
      output,
      logs,
      durationMs: summary.totalDurationMs,
      resourceLimits: summary.limits,
      personaCount: 1,
      timedOut: summary.killedByTimeout,
      peakMemMb: summary.peakMemMb,
      billable: { personas: 1, sandboxSeconds, cpuSeconds: summary.cpuSeconds },
    };
  }

  /** APEX inbound handler. VISION only ever receives packets from APEX. */
  asHandler(): AgentHandler {
    return (packet: RoutingPacket) => {
      const report = this.execute(packet.payload.intent, packet.payload.data);
      if (this.sendViaApex) {
        // Return path mediated by APEX: VISION -> APEX -> HOPE.
        this.sendViaApex({
          source: AgentRole.VISION,
          destination: AgentRole.HOPE,
          intent: `execution-result:${packet.payload.intent}`,
          data: { ok: report.ok, tool: report.tool, exitCode: report.exitCode, output: report.output },
          priority: packet.header.priority,
        });
      }
      return {
        ok: report.ok,
        tool: report.tool,
        exitCode: report.exitCode,
        output: report.output,
        sessionId: report.sessionId,
        personaCount: report.personaCount,
        billable: report.billable,
      };
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
