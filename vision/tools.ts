/**
 * vision/tools.ts — the VISION tool library (Phase 3, expanded in Phase 4.2).
 *
 * A registry of sandboxed tools VISION can run. Every tool runs *inside* a SandboxSession
 * (start → run → stop) so execution is isolated and accountable. Tools:
 *   - code_exec     : a SAFE mock JS runner with an allowlist (never real arbitrary eval)
 *   - data_ingest   : validate structured records against a schema and summarize
 *   - system_info   : safe, read-only metadata stub
 *   - file_plan     : plan file ops without touching disk (sandbox-local in-memory FS only)
 *   - http_fetch    : allowlisted-domain HTTP STUB — no real network; returns mock responses
 *   - json_transform: safe JSON path extract/map (pure traversal, never eval)
 *
 * CONSTRAINT: VISION executes; it does NOT create artifacts outside a sandbox report.
 * `file_plan` only plans or writes to an in-memory FS — nothing is written to real disk.
 * `http_fetch` performs NO real network I/O by default — it returns deterministic mocks so
 * the sandbox stays hermetic and VISION never reaches out of its box.
 */
import type { SandboxRunResult, SandboxSession } from './sandbox.js';

export interface ToolContext {
  sandbox: SandboxSession;
}

export interface ToolResult {
  ok: boolean;
  output: Record<string, unknown>;
  exitCode: number;
  /** The raw sandbox run result, for auditing/billing. */
  run: SandboxRunResult;
}

export interface Tool {
  name: string;
  description: string;
  run(args: Record<string, unknown>, ctx: ToolContext): ToolResult;
}

// ---------------------------------------------------------------------------
// code_exec — SAFE mock runner. Tokens outside the allowlist are rejected; nothing is
// ever passed to eval/Function. Arithmetic-only expressions get a real computed answer
// via a tiny shunting-yard evaluator; anything else returns a mocked stub result.
// ---------------------------------------------------------------------------

const CODE_DENYLIST = [
  /\brequire\b/, /\bimport\b/, /\bprocess\b/, /\beval\b/, /\bFunction\b/, /\bfs\b/,
  /\bchild_process\b/, /\bglobalThis\b/, /\b__proto__\b/, /\bfetch\b/, /\bnet\b/, /\bexec\b/,
];

const codeExec: Tool = {
  name: 'code_exec',
  description: 'Sandboxed, allowlisted mock code runner (no real arbitrary eval).',
  run(args, ctx) {
    const code = typeof args.code === 'string' ? args.code : '';
    const language = typeof args.language === 'string' ? args.language : 'javascript';
    return finalize(ctx, 'code_exec', () => {
      if (!code) return { exitCode: 2, stderr: 'no code provided', output: {} };
      for (const bad of CODE_DENYLIST) {
        if (bad.test(code)) {
          return { exitCode: 126, stderr: `blocked disallowed token: ${bad.source}`, output: { blocked: true } };
        }
      }
      // Arithmetic-only expressions are safely computed; anything else is mocked.
      const arithmetic = /^[\d\s+\-*/().]+$/.test(code);
      if (arithmetic) {
        const value = safeArithmetic(code);
        if (value === undefined) return { exitCode: 1, stderr: 'invalid arithmetic expression', output: {} };
        return { exitCode: 0, stdout: String(value), output: { language, value, evaluated: true } };
      }
      return {
        exitCode: 0,
        stdout: `[mock] ${language} snippet accepted (${code.length} chars)`,
        output: { language, evaluated: false, note: 'non-arithmetic code is mock-run only' },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// data_ingest — validate records against an optional schema; summarize.
// ---------------------------------------------------------------------------

const dataIngest: Tool = {
  name: 'data_ingest',
  description: 'Accept structured records, validate against a schema, return a summary.',
  run(args, ctx) {
    const records = Array.isArray(args.records) ? (args.records as unknown[]) : [];
    const schema = isRecord(args.schema) ? (args.schema as Record<string, string>) : undefined;
    return finalize(ctx, 'data_ingest', () => {
      let valid = 0;
      const errors: string[] = [];
      const fieldCounts: Record<string, number> = {};
      records.forEach((rec, i) => {
        if (!isRecord(rec)) {
          errors.push(`record ${i}: not an object`);
          return;
        }
        for (const key of Object.keys(rec)) fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
        if (schema) {
          const problems = validateAgainstSchema(rec, schema);
          if (problems.length) {
            errors.push(`record ${i}: ${problems.join('; ')}`);
            return;
          }
        }
        valid += 1;
      });
      return {
        exitCode: errors.length && valid === 0 ? 1 : 0,
        stdout: `ingested ${records.length} records (${valid} valid)`,
        output: {
          total: records.length,
          valid,
          invalid: records.length - valid,
          fieldCounts,
          errors: errors.slice(0, 20),
        },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// system_info — safe, read-only metadata stub (no sensitive host details).
// ---------------------------------------------------------------------------

const systemInfo: Tool = {
  name: 'system_info',
  description: 'Return safe, read-only sandbox metadata.',
  run(_args, ctx) {
    return finalize(ctx, 'system_info', () => ({
      exitCode: 0,
      stdout: `sandbox ${ctx.sandbox.kind} ${ctx.sandbox.id}`,
      output: {
        sandboxKind: ctx.sandbox.kind,
        sessionId: ctx.sandbox.id,
        limits: ctx.sandbox.limits,
        // Conceptual, non-sensitive values only — never real host secrets.
        runtime: 'big5-matrix-sandbox-stub',
        readOnly: true,
      },
    }));
  },
};

// ---------------------------------------------------------------------------
// file_plan — plan file ops without writing to real disk. Optionally applies writes to a
// sandbox-local in-memory FS so downstream steps can "read" them, but nothing hits disk.
// ---------------------------------------------------------------------------

interface FileOp {
  op: 'write' | 'mkdir' | 'delete';
  path: string;
  contents?: string;
}

const filePlan: Tool = {
  name: 'file_plan',
  description: 'Plan file operations without writing to real disk (memory FS only).',
  run(args, ctx) {
    const ops = Array.isArray(args.operations) ? (args.operations as unknown[]) : [];
    const apply = args.apply === true;
    return finalize(ctx, 'file_plan', () => {
      const memfs: Record<string, string | null> = {};
      const plan: string[] = [];
      for (const raw of ops) {
        if (!isRecord(raw) || typeof raw.op !== 'string' || typeof raw.path !== 'string') {
          plan.push('skip: malformed operation');
          continue;
        }
        const fop = raw as unknown as FileOp;
        plan.push(`${fop.op.toUpperCase()} ${fop.path}${fop.contents ? ` (${fop.contents.length}b)` : ''}`);
        if (apply) {
          // Sandbox-local, in-memory only. Never a real filesystem write.
          if (fop.op === 'write') memfs[fop.path] = fop.contents ?? '';
          else if (fop.op === 'mkdir') memfs[fop.path] = null;
          else if (fop.op === 'delete') delete memfs[fop.path];
        }
      }
      return {
        exitCode: 0,
        stdout: `planned ${plan.length} file operations (${apply ? 'applied to memory FS' : 'plan only'})`,
        output: { plan, applied: apply, memfsKeys: Object.keys(memfs) },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// http_fetch — allowlisted-domain HTTP STUB. NO real network is performed by default;
// requests to allowlisted hosts return deterministic mock responses, and anything off the
// allowlist (or a non-http(s) scheme) is blocked. This keeps the sandbox hermetic.
// ---------------------------------------------------------------------------

/** Domains VISION's http_fetch may "reach". Never a real socket — mocks only. */
export const DEFAULT_HTTP_ALLOWLIST: readonly string[] = [
  'api.example.com',
  'data.example.org',
  'status.example.net',
  'localhost',
];

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

const httpFetch: Tool = {
  name: 'http_fetch',
  description: 'Allowlisted-domain HTTP stub (no real network; deterministic mock responses).',
  run(args, ctx) {
    const url = typeof args.url === 'string' ? args.url : '';
    const method = (typeof args.method === 'string' ? args.method : 'GET').toUpperCase();
    // Callers may widen the allowlist per-call, but never beyond a stub — no real I/O ever.
    const extra = Array.isArray(args.allow) ? (args.allow as unknown[]).filter((d): d is string => typeof d === 'string') : [];
    const allowlist = new Set<string>([...DEFAULT_HTTP_ALLOWLIST, ...extra]);
    return finalize(ctx, 'http_fetch', () => {
      if (!url) return { exitCode: 2, stderr: 'no url provided', output: {} };
      if (!HTTP_METHODS.has(method)) {
        return { exitCode: 2, stderr: `unsupported method "${method}"`, output: {} };
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { exitCode: 22, stderr: `invalid url: ${url}`, output: {} };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { exitCode: 126, stderr: `blocked scheme "${parsed.protocol}"`, output: { blocked: true, reason: 'scheme' } };
      }
      if (!allowlist.has(parsed.hostname)) {
        return {
          exitCode: 126,
          stderr: `blocked host "${parsed.hostname}" (not in allowlist)`,
          output: { blocked: true, reason: 'host', host: parsed.hostname, allowlist: Array.from(allowlist) },
        };
      }
      // Deterministic mock response. No socket is opened.
      const mock = mockHttpResponse(parsed, method);
      return {
        exitCode: 0,
        stdout: `[mock] ${method} ${parsed.href} -> ${mock.status}`,
        output: { mock: true, request: { url: parsed.href, method, host: parsed.hostname }, response: mock },
      };
    });
  },
};

function mockHttpResponse(url: URL, method: string): { status: number; headers: Record<string, string>; body: Record<string, unknown> } {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-mock': 'true' },
    body: {
      ok: true,
      mock: true,
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      note: 'stubbed response — VISION performs no real network I/O',
    },
  };
}

// ---------------------------------------------------------------------------
// json_transform — safe JSON path extract/map. Pure traversal over supplied data; no eval,
// no prototype access. Supports single-path extraction and per-element projection over arrays.
// ---------------------------------------------------------------------------

const jsonTransform: Tool = {
  name: 'json_transform',
  description: 'Safe JSON path extract/map (pure traversal, never eval).',
  run(args, ctx) {
    const data = 'data' in args ? args.data : undefined;
    const path = typeof args.path === 'string' ? args.path : undefined;
    const select = isRecord(args.select) ? (args.select as Record<string, unknown>) : undefined;
    return finalize(ctx, 'json_transform', () => {
      if (data === undefined) return { exitCode: 2, stderr: 'no data provided', output: {} };
      if (!path && !select) return { exitCode: 2, stderr: 'provide "path" or "select"', output: {} };

      // Map mode: project each element of an array through a { outName: path } spec.
      if (select) {
        const source = path !== undefined ? getByPath(data, path) : data;
        if (!Array.isArray(source)) {
          return { exitCode: 1, stderr: 'select requires the target to be an array', output: {} };
        }
        const specs = Object.entries(select).filter((e): e is [string, string] => typeof e[1] === 'string');
        const values = source.map((el) => {
          const row: Record<string, unknown> = {};
          for (const [out, p] of specs) row[out] = getByPath(el, p);
          return row;
        });
        return {
          exitCode: 0,
          stdout: `mapped ${values.length} elements across ${specs.length} fields`,
          output: { mode: 'map', count: values.length, values },
        };
      }

      // Extract mode: pull a single value at the given path.
      const value = getByPath(data, path as string);
      return {
        exitCode: value === undefined ? 1 : 0,
        stdout: value === undefined ? `path "${path}" not found` : `extracted "${path}"`,
        output: { mode: 'extract', path, found: value !== undefined, value: value ?? null },
      };
    });
  },
};

/**
 * Resolve a dot/bracket path (e.g. "a.b[0].c") over plain data. Traversal-only: never
 * touches the prototype chain and rejects the __proto__/constructor/prototype keys.
 */
function getByPath(data: unknown, path: string): unknown {
  const segments = parsePath(path);
  let cur: unknown = data;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') return undefined;
      if (!isRecord(cur)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

function parsePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  // Split on dots, then peel bracketed indices: "a.b[0][1].c" -> a, b, 0, 1, c
  for (const part of path.split('.')) {
    if (part === '') continue;
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) {
      out.push(part);
      continue;
    }
    if (m[1]) out.push(m[1]);
    const idx = m[2].match(/\d+/g);
    if (idx) for (const n of idx) out.push(parseInt(n, 10));
  }
  return out;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = DEFAULT_TOOLS) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  run(name: string, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`ToolRegistry: unknown tool "${name}" (available: ${this.list().join(', ')})`);
    }
    return tool.run(args, ctx);
  }
}

export const DEFAULT_TOOLS: readonly Tool[] = [codeExec, dataIngest, systemInfo, filePlan, httpFetch, jsonTransform];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Run a tool body inside the sandbox lifecycle and normalize the result. */
function finalize(
  ctx: ToolContext,
  label: string,
  body: () => { exitCode: number; stdout?: string; stderr?: string; output?: Record<string, unknown> },
): ToolResult {
  const run = ctx.sandbox.run(label, body);
  return { ok: run.exitCode === 0, output: run.output, exitCode: run.exitCode, run };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateAgainstSchema(rec: Record<string, unknown>, schema: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [field, type] of Object.entries(schema)) {
    if (!(field in rec)) {
      problems.push(`missing "${field}"`);
      continue;
    }
    const actual = Array.isArray(rec[field]) ? 'array' : typeof rec[field];
    if (actual !== type) problems.push(`"${field}" expected ${type}, got ${actual}`);
  }
  return problems;
}

/** Tiny shunting-yard arithmetic evaluator for the allowlisted code_exec path. */
function safeArithmetic(expr: string): number | undefined {
  const tokens = expr.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
  if (!tokens) return undefined;
  const output: (number | string)[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
  for (const tok of tokens) {
    if (/^\d/.test(tok)) {
      output.push(parseFloat(tok));
    } else if (tok === '(') {
      ops.push(tok);
    } else if (tok === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') output.push(ops.pop() as string);
      if (ops.pop() !== '(') return undefined;
    } else {
      while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[tok]) {
        output.push(ops.pop() as string);
      }
      ops.push(tok);
    }
  }
  while (ops.length) {
    const op = ops.pop() as string;
    if (op === '(') return undefined;
    output.push(op);
  }
  const stack: number[] = [];
  for (const tok of output) {
    if (typeof tok === 'number') {
      stack.push(tok);
    } else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) return undefined;
      if (tok === '+') stack.push(a + b);
      else if (tok === '-') stack.push(a - b);
      else if (tok === '*') stack.push(a * b);
      else if (tok === '/') stack.push(b === 0 ? NaN : a / b);
    }
  }
  const result = stack.pop();
  return result !== undefined && Number.isFinite(result) ? result : undefined;
}
