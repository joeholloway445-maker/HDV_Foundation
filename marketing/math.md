# HDV Foundation — The Headline Math (verifiable)

> Every number on [`marketing/index.html`](./index.html) is computed here, and by
> [`comparison.ts`](./comparison.ts). Run `npx tsx marketing/comparison.ts` to reproduce it.
> The rule that keeps the moat intact: **capacity is a topology fact; cost efficiency is a
> labeled worked example; neither is a claim about trained weights or benchmark IQ.**

---

## 1. The 14.3-quadrillion headline (conceptual capacity)

The matrix is a fixed topology. When **all five legs fire** at full capacity:

```
TOTAL_NODES          = 20,480          (5 Big AI × 4,096 nodes each)
PERSONAS_PER_NODE    = 100
MODEL_PARAMS         = 7,000,000,000   (a conceptual 7B per persona)

capacity = 20,480 × 100 × 7,000,000,000
         = 1.4336 × 10^16
         ≈ 14.3 quadrillion parameters
```

This is **addressable persona-capacity the topology can express** — not a single trained
14.3-quadrillion-weight file you can download. The honest, economical realization is **shared
base weights + cheap per-persona deltas** (LoRA / prompt profiles), and **only active personas
ever cost GPU**. See the honesty footnote in [`docs/MOAT.md`](../docs/MOAT.md) §2.

---

## 2. Capacity ratio vs a frontier-class model

The "N× the frontier" line is a ratio of **addressable parameters**, i.e. how much more
capacity the matrix can express than a single monolith — **not** a benchmark of intelligence.

### Primary, accurate comparison — vs a ~5-trillion-parameter frontier class

```
14.3 quadrillion  = 1.4336 × 10^16
5 trillion        = 5      × 10^12

ratio = 1.4336e16 / 5e12 = 2,867.2×
```

> **Primary headline figure: ≈ 2,867× the parameter capacity of a ~5T frontier class
> (e.g. reported Claude-scale) — when all five legs fire.**

### Secondary, scoped comparison — vs a ~1.158-trillion class

The founder's **12,380×** is mathematically correct **only** against a ~1.158T model:

```
1.4336e16 / 1.158e12 ≈ 12,380×
1.4336e16 / 1.16e12  ≈ 12,359×   (rounding the base to 1.16T)
```

Use 12,380× **only** when the comparison class is explicitly stated as ~1.16T. Against the 5T
frontier class the honest number is **2,867×**. Do not present 12,380× as "vs frontier/Claude."

| Compared against | Parameters | Ratio | Use |
|------------------|-----------:|------:|-----|
| **5T frontier class** (primary) | 5.00 × 10¹² | **2,867×** | Headline, always safe |
| ~1.158T class (secondary) | 1.158 × 10¹² | **12,380×** | Only if the ~1.16T class is named |

---

## 3. Cost efficiency — a transparent worked example (no magic number)

We do **not** publish a bare "119 million×". The efficiency multiple is derived from a formula
with labeled assumptions, so anyone can change a knob and recompute.

### The model

Compare, over one billing period (≈ one month = **730 hours**):

- **Always-on baseline** — a frontier endpoint you reserve **24/7**:
  ```
  cost_on = hoursInPeriod × onDemandRatePerHour
  ```
- **HDV ephemeral** — you pay only for the GPU-hours a persona is **actually live** (idle-cheap
  Colab Pro+ / Hostinger GPUs, billed only while active):
  ```
  cost_hdv = activeGpuHours × ephemeralRatePerHour
  ```

### The multiple factors into two labeled levers

```
E = cost_on / cost_hdv
  = (hoursInPeriod × onDemandRatePerHour) / (activeGpuHours × ephemeralRatePerHour)
  = (1 / utilization) × (onDemandRatePerHour / ephemeralRatePerHour)

where  utilization = activeGpuHours / hoursInPeriod
```

- **Utilization lever `(1 / u)`** — always-on pays for *every* hour; HDV pays for *active* hours.
- **Rate lever `(R_on / R_eph)`** — a reserved frontier GPU-hour vs a cheap ephemeral one.

Large multiples are the honest consequence of **low utilization × cheap idle-billed GPUs.**
Nothing is hidden; every input is a knob.

### Worked scenarios (all computed by `comparison.ts`)

| Scenario | Utilization | Always-on | HDV | Efficiency | Levers |
|----------|------------:|----------:|----:|-----------:|--------|
| Conservative | 20% | $5,840/mo | $292/mo | **20×** | 5× util · 4× rate |
| Moderate | 5% | $17,520/mo | $43.80/mo | **400×** | 20× util · 20× rate |
| Aggressive | 0.5% | $65,700/mo | $2.19/mo | **30,000×** | 200× util · 150× rate |

**Assumptions, labeled per scenario:**

- Conservative: `730 h`, `146` active GPU-h (20%), `$8/h` reserved GPU, `$2/h` ephemeral.
- Moderate: `730 h`, `36.5` active GPU-h (5%), `$24/h` reserved node, `$1.20/h` Colab-class.
- Aggressive: `730 h`, `3.65` active GPU-h (0.5%), `$90/h` reserved 5T-class endpoint, `$0.60/h` spot/Colab T4.

> **What this proves:** for bursty, heterogeneous workloads, an idle-cheap ephemeral fleet is
> tens-to-thousands of times cheaper than renting an always-on monolith. The exact multiple
> depends entirely on **your** utilization and GPU rates — which is why we ship the formula, not
> a single trophy number. Real, measured `$/intent` lands after the design-partner cost
> benchmark (see [`docs/ROADMAP.md`](../docs/ROADMAP.md) 6.3, which turns the ledger's
> `cost_usd` from a constant into measured GPU-seconds × `$/s`).

---

## 4. What we bill (the meter that makes idle-cheap real)

The APEX ledger meters **active-param-seconds (APS)** — the number that makes "only active
personas cost compute" auditable:

```
1 APS = active_parameters × 1 second of real compute
active_parameters = live_personas × MODEL_PARAMS   (7B today)
```

Idle personas ⇒ ~0 APS. The 14.3Q sits dormant at ~zero compute. See
[`billing/pricing.ts`](../billing/pricing.ts) and [`nodes/parameters.ts`](../nodes/parameters.ts)
— both compute these figures; this doc only narrates them.

---

## 5. Do / Don't (for anyone quoting these numbers)

**DO**
- "≈14.3-quadrillion **conceptual capacity** — topology × 7B — when all five legs fire."
- "≈**2,867×** the parameter capacity of a ~5T frontier class."
- "Cost efficiency scales with low utilization — **20× to 30,000×** in worked examples, formula shown."

**DON'T**
- ❌ "We trained 14.3 quadrillion weights." (It's topology × 7B, not a trained file.)
- ❌ "12,380× the frontier / Claude." (12,380× is only vs ~1.16T; vs 5T it's 2,867×.)
- ❌ "119,000,000× cheaper." (No formula, no labels — forbidden. Show the worked example.)
- ❌ "Smarter than GPT/Claude." (Capacity ≠ benchmark intelligence.)
