/**
 * dream/scenario_bank.ts — seeded scenario templates DREAM can specialize (Phase 4.2).
 *
 * A small, optional library of parameterized scenario "seeds". Given a context, DREAM can
 * SPECIALIZE a seed into a concrete intent (plus priors and a suggested simulation shape)
 * and hand that to the {@link SimulationEngine}. It is a convenience for producing focused,
 * repeatable speculative simulations — nothing here governs or executes.
 *
 * CONSTRAINTS: pure data + string templating. Dependency-free; imports no peer agent. The
 * priors it emits are *hints* for the simulation, never routing/policy decisions.
 */

export interface ScenarioPriors {
  /** 0..1 prior likelihood/severity of things going wrong. */
  risk: number;
  /** 0..1 prior value if it goes right. */
  reward: number;
  /** 0..1 prior achievability. */
  feasibility: number;
}

export interface ScenarioTemplate {
  id: string;
  title: string;
  tags: string[];
  /** Intent string with `{placeholder}` slots filled from a context at specialize-time. */
  intentTemplate: string;
  /** Default fill values for placeholders (used when the context omits them). */
  defaults?: Record<string, string>;
  /** Prior biases for the simulation (hints only). */
  priors: ScenarioPriors;
  /** Suggested simulation shape for this seed. */
  suggested: { breadth: number; depth: number };
}

export interface SpecializedScenario {
  templateId: string;
  title: string;
  tags: string[];
  /** The concrete, placeholder-filled intent to simulate. */
  intent: string;
  priors: ScenarioPriors;
  suggested: { breadth: number; depth: number };
  /** The context actually applied (defaults merged with the caller's context). */
  context: Record<string, string>;
}

/** The built-in seeds. Kept generic so DREAM can specialize them per request. */
export const DEFAULT_SCENARIOS: ScenarioTemplate[] = [
  {
    id: 'surge-response',
    title: 'Traffic / demand surge response',
    tags: ['ops', 'scaling', 'reactive'],
    intentTemplate: 'simulate surge-response outcomes for {subject} under {load} load',
    defaults: { subject: 'the service', load: 'peak' },
    priors: { risk: 0.55, reward: 0.6, feasibility: 0.5 },
    suggested: { breadth: 4, depth: 3 },
  },
  {
    id: 'product-launch',
    title: 'Product / feature launch',
    tags: ['product', 'growth', 'proactive'],
    intentTemplate: 'simulate outcomes for launching {subject} to {audience}',
    defaults: { subject: 'the new feature', audience: 'all users' },
    priors: { risk: 0.5, reward: 0.7, feasibility: 0.55 },
    suggested: { breadth: 3, depth: 2 },
  },
  {
    id: 'incident-postmortem',
    title: 'Incident mitigation / postmortem',
    tags: ['ops', 'reliability', 'reactive'],
    intentTemplate: 'simulate mitigations for a {severity} incident affecting {subject}',
    defaults: { severity: 'moderate', subject: 'the platform' },
    priors: { risk: 0.7, reward: 0.5, feasibility: 0.45 },
    suggested: { breadth: 4, depth: 3 },
  },
  {
    id: 'capacity-planning',
    title: 'Capacity / cost planning',
    tags: ['ops', 'cost', 'planning'],
    intentTemplate: 'simulate capacity plans for {subject} over the next {horizon}',
    defaults: { subject: 'the fleet', horizon: 'quarter' },
    priors: { risk: 0.4, reward: 0.55, feasibility: 0.6 },
    suggested: { breadth: 3, depth: 2 },
  },
  {
    id: 'idle-exploration',
    title: 'Idle-time speculative exploration',
    tags: ['speculative', 'background', 'proactive'],
    intentTemplate: 'speculatively explore improvement outcomes for {subject}',
    defaults: { subject: 'the current workload' },
    priors: { risk: 0.35, reward: 0.5, feasibility: 0.6 },
    suggested: { breadth: 2, depth: 1 },
  },
];

export class ScenarioBank {
  private readonly templates = new Map<string, ScenarioTemplate>();

  /** By default the bank is seeded with {@link DEFAULT_SCENARIOS}; pass `false` for empty. */
  constructor(seed: boolean | ScenarioTemplate[] = true) {
    const initial = seed === true ? DEFAULT_SCENARIOS : seed === false ? [] : seed;
    for (const t of initial) this.register(t);
  }

  /** Register (or replace) a scenario template. */
  register(template: ScenarioTemplate): void {
    this.templates.set(template.id, template);
  }

  /** Look up a template by id (or undefined). */
  get(id: string): ScenarioTemplate | undefined {
    return this.templates.get(id);
  }

  /** Whether a template id is known. */
  has(id: string): boolean {
    return this.templates.has(id);
  }

  /** All templates, in registration order. */
  list(): ScenarioTemplate[] {
    return [...this.templates.values()];
  }

  /** Templates carrying a given tag. */
  byTag(tag: string): ScenarioTemplate[] {
    return this.list().filter((t) => t.tags.includes(tag));
  }

  /**
   * Specialize a template into a concrete scenario. Placeholders are filled from `context`,
   * falling back to the template's `defaults`, then to the bare placeholder name. Throws if
   * the template id is unknown.
   */
  specialize(id: string, context: Record<string, unknown> = {}): SpecializedScenario {
    const template = this.templates.get(id);
    if (!template) throw new Error(`ScenarioBank.specialize: unknown scenario "${id}"`);

    const applied: Record<string, string> = { ...(template.defaults ?? {}) };
    for (const [k, v] of Object.entries(context)) {
      if (v !== undefined && v !== null) applied[k] = String(v);
    }

    const intent = template.intentTemplate.replace(/\{(\w+)\}/g, (_match, key: string) => {
      return applied[key] ?? key;
    });

    return {
      templateId: template.id,
      title: template.title,
      tags: [...template.tags],
      intent,
      priors: { ...template.priors },
      suggested: { ...template.suggested },
      context: applied,
    };
  }
}
