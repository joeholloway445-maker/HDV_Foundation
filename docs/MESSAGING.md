# HDV Foundation — Messaging (approved lines & forbidden overclaims)

> The one-page copy contract. If a sentence isn't here or derivable from here, run it against
> the rules before it ships. The strategy: **lead hard with 14.3 quadrillion, keep one honest
> footnote, never let a number become a lie.** Numbers are computed in
> [`../marketing/comparison.ts`](../marketing/comparison.ts) and narrated in
> [`../marketing/math.md`](../marketing/math.md). Companion strategy: [`MOAT.md`](./MOAT.md) §2,
> [`GTM.md`](./GTM.md) §1/§6.

---

## The verified numbers (single source of truth)

| Figure | Value | How | Use |
|--------|------:|-----|-----|
| Conceptual capacity | **1.4336 × 10¹⁶** (~14.3 quadrillion) | `20,480 × 100 × 7B` | The headline. Always "capacity … when all five legs fire." |
| Capacity ratio (PRIMARY) | **≈2,867×** | `1.4336e16 / 5e12` | Default "N× the frontier" line. Always safe. |
| Capacity ratio (secondary) | **≈12,380×** | `1.4336e16 / 1.158e12` | **Only** when the ~1.16T class is explicitly named. |
| Cost efficiency | **20×–30,000×** (worked) | `(1/utilization) × (R_on/R_eph)` | Only with the formula + labeled assumptions on screen. |

---

## ✅ APPROVED LINES (use freely)

**Headline / hero**
- "14.3 quadrillion — when all five legs fire."
- "14.3-quadrillion parameters of addressable capacity — `20,480 nodes × 100 personas × 7B`."
- "≈2,867× the parameter capacity of a ~5-trillion-parameter frontier class — when all five legs fire."
- "A governed matrix where only active personas cost compute."

**Ratio, framed correctly**
- "2,867× the **parameter capacity** of a ~5T class — a topology ratio, not a benchmark of intelligence."
- "12,380× **against a ~1.16-trillion class**" (only with the class named).

**Cost / efficiency**
- "Idle-cheap by construction — only active personas cost compute."
- "20× to 30,000× cheaper in worked scenarios, driven by low utilization × cheap ephemeral GPUs — formula shown."
- "You pay for what lights up: active-param-seconds, read straight from the APEX ledger."
- "Ephemeral Colab / Hostinger GPUs, billed only while a persona is live."

**Governance (the product)**
- "Routed by APEX, gated by KNOLL, billed by the ledger, auditable by design."
- "Enforced, not advised — HOPE can't execute, VISION can't govern, DREAM and VISION can't talk."
- "Prove what your agents *can't* do — in code and an audit log, not a policy PDF."

**The honest footnote (attach near any capacity claim — keep it, don't bury it)**
- "Conceptual capacity = topology × 7B, not a single trained 14.3-quadrillion-weight file."

---

## ❌ FORBIDDEN OVERCLAIMS (never ship)

- ❌ "We trained 14.3 quadrillion weights." / "14.3Q trained parameters." / "a 14.3Q model."
- ❌ "12,380× the frontier." / "12,380× Claude / GPT." *(That ratio is only vs ~1.16T.)*
- ❌ "2,867× smarter" / "12,380× more powerful." *(Capacity ≠ intelligence.)*
- ❌ Any bare cost multiple with no formula: "119,000,000× cheaper", "millions of times cheaper."
- ❌ "Smarter than / beats GPT / Claude / Gemini." *(We win on the layer around the model.)*
- ❌ "Fully autonomous." *(Autonomy is inside enforced constraints.)*
- ❌ "Download the 14.3Q model." / "our 14.3Q weights." *(No such file exists.)*
- ❌ Dropping the honest footnote to make the headline punchier. *(The footnote is what makes it credible.)*

---

## Two-line rules of thumb

1. **If an engineer could ask "show me the weights" and be right — the line is broken.** Add the
   topology × 7B footnote or rephrase to "capacity."
2. **Every big number must be reproducible** by `npx tsx marketing/comparison.ts`. If it isn't in
   that file (or [`math.md`](../marketing/math.md)), it doesn't ship.
