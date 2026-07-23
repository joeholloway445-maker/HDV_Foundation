# HDV Foundation — Headline Math (founder-corrected)

> Reproduce every number: `npx tsx marketing/comparison.ts`

---

## Topology (fixed)

```
20,480 nodes × 100 personas = 2,048,000 personas
capacity = personas × MODEL_PARAMS
```

Swap the persona weight class (7B / 13B / 30B) and capacity scales linearly.

---

## Capacity table (all five legs firing)

| Persona model | Capacity | vs **5T** class | vs **~1.158T** class |
|---------------|----------|----------------:|---------------------:|
| **7B** (default) | **~14.3 quadrillion** | **≈ 2,867×** | **≈ 12,380×** |
| **13B** | ~26.6 quadrillion | ≈ 5,325× | ≈ 22,990× |
| **30B** | ~61.4 quadrillion | ≈ 12,288× | ≈ 53,057× |

- Use **12,380×** when comparing 7B matrix capacity to a **~1.16T** class.
- Use **2,867×** when comparing 7B matrix capacity to a **5T** frontier class.
- Both are real; name the comparison class so nobody can dunk on the math.

Capacity = topology × persona model size. It is **not** a single trained 14.3Q weight file.

---

## Consumer price (corrected)

| Line item | Monthly |
|-----------|--------:|
| Google Colab | **$9.99** |
| HDV subscription add-on | **~$5.00** |
| **Total to user** | **≈ $14.99** |

(BYOK path can be **$0** HDV platform fee — user pays only their provider.)

---

## The ~119,000,000× cost-efficiency claim (labeled)

This is a **capital-efficiency** story, not “Claude Pro is $1.8B/month.”

```
Frontier CapEx pool (public ~$100B-by-2030 class) = $100,000,000,000
HDV consumer seat                               = ~$14.99 / month

E = CapEx / (seat × months)
```

Solve for months where E ≈ **119,000,000**:

```
months ≈ 100e9 / (14.99 × 119e6) ≈ 56 months ≈ 4.7 years
```

**Approved phrasing:**  
*“Frontier labs talk $100B CapEx by 2030. HDV users can ride Colab at $9.99 + $5 HDV ≈ $15/mo. Against that CapEx pool, that’s on the order of **119 million×** capital-efficiency over ~4.7 years of seats.”*

Do **not** say “we’re 119M× cheaper than a Claude subscription” without the CapEx framing — that’s a different claim.

Seat-vs-seat (e.g. $20 frontier seat ÷ $15 HDV) is only ~**1.3×** on sticker price; the explosive multiple is CapEx-vs-seat + idle-cheap GPUs.

---

## One-liners

1. *“14.3 quadrillion matrix capacity at 7B — ~12,380× a ~1.16T class / ~2,867× a 5T class — when all five legs fire.”*
2. *“Crank personas to 13B (~26.6Q) or 30B (~61.4Q) — same topology, bigger legs.”*
3. *“$9.99 Colab + $5 HDV ≈ $15/mo vs $100B-class CapEx → ~119M× capital-efficiency story.”*
