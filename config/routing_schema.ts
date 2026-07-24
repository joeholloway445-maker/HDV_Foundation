/**
 * routing_schema.ts — THE contract for all inter-agent traffic.
 *
 * Per the System Manifest (.cursorrules): if any data passed between agents does not
 * strictly adhere to the RoutingPacket interface, the system is considered compromised.
 *
 * This file is intentionally dependency-free so every layer (APEX, KNOLL, HOPE, DREAM,
 * VISION, nodes) can import it without creating cross-agent coupling.
 */

/** The five Big AI roles. These are the ONLY legal packet endpoints. */
export enum AgentRole {
  HOPE = 'HOPE',
  DREAM = 'DREAM',
  VISION = 'VISION',
  KNOLL = 'KNOLL',
  APEX = 'APEX',
}

/** Priority tiers understood by the APEX router. */
export type PacketPriority = 'CRITICAL' | 'STANDARD' | 'BACKGROUND';

/** Ledger / audit outcome for a routed packet. */
export type RoutingStatus = 'SUCCESS' | 'BLOCKED' | 'FAILED';

/**
 * RoutingPacket — the single legal transport structure between agents.
 * Every field is mandatory. KNOLL validates structure, hash, and endpoint legality.
 */
export interface RoutingPacket {
  header: {
    packetId: string;
    timestamp: number;
    source: AgentRole;
    destination: AgentRole;
    priority: PacketPriority;
    /**
     * Optional tenant identifier (Phase 8 multi-tenancy). ADDITIVE: legacy Phase 1 packets
     * omit this field and remain valid. When present it is folded into the tamper hash and is
     * enforced by KNOLL's NO_CROSS_TENANT law. Absence means "dev / single-tenant mode".
     */
    tenantId?: string;
  };
  payload: {
    intent: string;
    data: Record<string, unknown>;
  };
  security: {
    knoll_token: string;
    hash: string; // SHA-256 for tampering detection
  };
}

/**
 * KnollValidationResponse — the verdict KNOLL returns to APEX for every packet.
 * APEX MUST honor `isAllowed`; a false verdict means the packet is dropped and logged.
 */
export interface KnollValidationResponse {
  isAllowed: boolean;
  reasoning?: string;
  enforcedConstraints?: string[];
}
