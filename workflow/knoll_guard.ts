/**
 * workflow/knoll_guard.ts — KNOLL-gated workflow validation.
 *
 * Validates a workflow definition and its execution trigger data before the
 * DAG executor processes any node. KNOLL checks:
 *   - payload size limits
 *   - forbidden key patterns (secrets, credentials, PII markers)
 *   - SSRF vectors in URL-shaped values
 *   - cross-tenant data leakage (tenantId mismatch)
 *   - workflow node type allowlist (no unknown/dangerous node types)
 *
 * WorkflowGuard is stateless — construct once per process and call
 * `validate()` on every incoming workflow trigger.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowValidationResult } from './types.js';

const FORBIDDEN_KEY_RE = [
  /password/i, /secret/i, /private[_-]?key/i, /creditcard/i, /credit[_-]?card/i,
  /\bssn\b/i, /social.security/i, /\bcvv\b/i, /api[_-]?key/i, /auth[_-]?token/i,
];

const PRIVATE_IP_RE = /^(https?:\/\/)(localhost|127\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.|169\.254\.|::1|fc00:|fd)/i;

const ALLOWED_NODE_TYPES = new Set([
  'webhookTrigger', 'manualTrigger', 'scheduleTrigger',
  'httpRequest', 'code', 'ifBranch', 'set', 'merge', 'loop',
  'wait', 'filter', 'switch', 'email', 'subWorkflow', 'respond',
  'memoryRead', 'memoryWrite', 'ai', 'aggregate', 'transform',
  'datetime', 'crypto', 'splitBatches', 'validate', 'csv',
  'htmlExtract', 'jsonPath', 'stopError', 'merge', 'database',
  'slack', 'xml', 'rss', 'deduplicate', 'sort', 'limit',
  'renameKeys', 'stickyNote', 'noOp',
  // HDV Big Five agent nodes
  'apex', 'knoll', 'dream',
]);

export interface WorkflowGuardOptions {
  maxPayloadKb?: number;
  maxNodes?: number;
  allowUnknownNodeTypes?: boolean;
}

export class WorkflowGuard {
  private readonly maxPayloadKb: number;
  private readonly maxNodes: number;
  private readonly allowUnknownNodeTypes: boolean;

  constructor(options: WorkflowGuardOptions = {}) {
    this.maxPayloadKb = options.maxPayloadKb ?? 512;
    this.maxNodes = options.maxNodes ?? 200;
    this.allowUnknownNodeTypes = options.allowUnknownNodeTypes ?? false;
  }

  validate(
    workflow: { nodes?: Array<{ id: string; type?: string; data?: Record<string, unknown> }> },
    triggerData: Record<string, unknown>,
    tenantId?: string,
  ): WorkflowValidationResult {
    const violations: string[] = [];

    // 1. Payload size
    const payloadSize = JSON.stringify(triggerData).length;
    if (payloadSize > this.maxPayloadKb * 1024) {
      violations.push(`Trigger payload ${(payloadSize / 1024).toFixed(1)} KB exceeds ${this.maxPayloadKb} KB limit`);
    }

    // 2. Node count
    const nodes = workflow.nodes ?? [];
    if (nodes.length > this.maxNodes) {
      violations.push(`Workflow has ${nodes.length} nodes; limit is ${this.maxNodes}`);
    }

    // 3. Forbidden keys in trigger data
    const forbiddenKeys = this._findForbiddenKeys(triggerData);
    if (forbiddenKeys.length > 0) {
      violations.push(`Forbidden keys in trigger data: ${forbiddenKeys.slice(0, 5).join(', ')}`);
    }

    // 4. SSRF vectors in trigger data
    const ssrfUrls = this._findSsrfUrls(triggerData);
    if (ssrfUrls.length > 0) {
      violations.push(`SSRF risk: private-range URLs in trigger data: ${ssrfUrls.slice(0, 3).join(', ')}`);
    }

    // 5. Node type allowlist
    if (!this.allowUnknownNodeTypes) {
      const unknownTypes = nodes
        .map((n) => String(n.data?.nodeType ?? n.type ?? ''))
        .filter((t) => t && !ALLOWED_NODE_TYPES.has(t));
      if (unknownTypes.length > 0) {
        violations.push(`Unknown node types: ${[...new Set(unknownTypes)].slice(0, 5).join(', ')}`);
      }
    }

    // 6. Cross-tenant check
    if (tenantId && (triggerData as Record<string, unknown>).tenantId) {
      const payloadTenant = String((triggerData as Record<string, unknown>).tenantId);
      if (payloadTenant !== tenantId) {
        violations.push(`Cross-tenant data: trigger tenantId "${payloadTenant}" ≠ auth tenantId "${tenantId}"`);
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
      knollAuditId: randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private _findForbiddenKeys(obj: unknown): string[] {
    const hits: string[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === 'object') {
        for (const key of Object.keys(v as Record<string, unknown>)) {
          if (FORBIDDEN_KEY_RE.some((p) => p.test(key))) hits.push(key);
          walk((v as Record<string, unknown>)[key]);
        }
      }
    };
    walk(obj);
    return hits;
  }

  private _findSsrfUrls(obj: unknown): string[] {
    const hits: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string' && PRIVATE_IP_RE.test(v)) hits.push(v);
      else if (v && typeof v === 'object') {
        for (const val of Object.values(v as Record<string, unknown>)) walk(val);
      }
    };
    walk(obj);
    return hits;
  }
}
