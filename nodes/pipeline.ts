/**
 * nodes/pipeline.ts — ephemeral persona role-chain (Phase 2).
 *
 * A concurrent-ish pipeline pattern implemented as *persona roles inside one Big AI's
 * nodes* — NOT as new Big agents. The classic chain is Researcher → Writer → Critic:
 * each stage spawns a short-lived persona, executes its single job, and terminates.
 *
 * ARCHITECTURE NOTE: this runs entirely *under one* Big AI (e.g. DREAM personas, or
 * VISION personas). It never lets one Big agent call another. When a task must cross
 * agents (e.g. DREAM output feeding VISION), that hop MUST still go through APEX — the
 * pipeline itself only orchestrates personas within a single owner's node matrix.
 */
import type { AgentRole } from '../config/routing_schema.js';
import { executePersona, spawnPersona, terminatePersona } from './persona.js';

export type PipelineRole = 'researcher' | 'writer' | 'critic';

export interface PipelineStageResult {
  role: PipelineRole;
  personaId: string;
  score: number;
  output: Record<string, unknown>;
}

export interface PipelineResult {
  owner: AgentRole;
  task: string;
  stages: PipelineStageResult[];
  /** Critic's final score for the chain (0..1). */
  finalScore: number;
  personaCount: number;
}

const CHAIN: readonly PipelineRole[] = ['researcher', 'writer', 'critic'];

/**
 * Run the researcher → writer → critic chain for a task using ephemeral personas from
 * `owner`'s node matrix. Each stage receives the prior stage's output, mirroring a real
 * multi-agent pipeline but strictly inside one Big AI (no peer-agent calls).
 */
export function runPersonaPipeline(
  owner: AgentRole,
  task: string,
  data: Record<string, unknown> = {},
  nodeIdStr = `${owner}-mgr-00-node-00`,
): PipelineResult {
  const stages: PipelineStageResult[] = [];
  let prior: Record<string, unknown> = { task, ...data };

  for (const role of CHAIN) {
    const persona = spawnPersona(owner, nodeIdStr);
    const exec = executePersona(persona, { role, ...prior });
    terminatePersona(persona);

    const output = buildStageOutput(role, task, exec.score, prior);
    stages.push({ role, personaId: persona.id, score: exec.score, output });
    // Feed this stage's output forward to the next role in the chain.
    prior = { task, upstream: output };
  }

  const critic = stages[stages.length - 1];
  return {
    owner,
    task,
    stages,
    finalScore: critic.score,
    personaCount: stages.length,
  };
}

function buildStageOutput(
  role: PipelineRole,
  task: string,
  score: number,
  prior: Record<string, unknown>,
): Record<string, unknown> {
  switch (role) {
    case 'researcher':
      return { findings: `researched context for "${task}"`, relevance: score };
    case 'writer':
      return { draft: `draft addressing "${task}"`, basis: prior, quality: score };
    case 'critic':
      return { verdict: score >= 0.5 ? 'accept' : 'revise', critique: `reviewed "${task}"`, rating: score };
    default:
      return {};
  }
}
