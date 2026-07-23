# BIG 5 MATRIX — ARCHITECTURE

Mermaid diagrams for the core flows. See [`GAME_PLAN.md`](./GAME_PLAN.md) for the narrative
and [`../.cursorrules`](../.cursorrules) for the binding constitution.

---

## 1. Packet flow: SOURCE → APEX → KNOLL → DEST

Every inter-agent exchange is a `RoutingPacket` minted by APEX, gated by KNOLL, and only
then delivered. A deny drops the packet and writes a `BLOCKED` ledger + audit row.

```mermaid
flowchart LR
    SRC([SOURCE agent]) -->|RoutingPacket| APEX{APEX router}
    APEX -->|intercept before every route| KNOLL{{KNOLL gate}}
    KNOLL -->|isAllowed = true| DEST([DESTINATION agent])
    KNOLL -->|isAllowed = false| DROP[/dropped/]
    DEST -.->|result via APEX only| APEX
    APEX -->|SUCCESS / cost_usd| LEDGER[(APEX ledger)]
    KNOLL -->|ALLOWED / BLOCKED| AUDIT[(SecurityAudit)]
    DROP -->|BLOCKED / cost 0| LEDGER

    classDef gate fill:#ffe8e8,stroke:#c0392b,color:#000;
    classDef router fill:#e8f0ff,stroke:#2c5aa0,color:#000;
    class KNOLL gate;
    class APEX router;
```

**Forbidden edge (always BLOCKED):**

```mermaid
flowchart LR
    DREAM([DREAM]) -. NO_DIRECT_DREAM_VISION .-x VISION([VISION])
    VISION -. NO_DIRECT_DREAM_VISION .-x DREAM
```

---

## 2. Always-on vs ephemeral

```mermaid
flowchart TB
    subgraph AO["Always-on standby (3/5)"]
        HOPE[HOPE — interface / voice]
        KNOLL[KNOLL — security gate]
        APEX[APEX — master router]
    end
    subgraph EPH["Ephemeral — spun up on demand, self-terminate (2/5)"]
        DREAM[DREAM — simulation]
        VISION[VISION — sandboxed action]
    end

    HOPE -->|submit intent| APEX
    APEX -->|after KNOLL| DREAM
    APEX -->|after KNOLL| VISION
    DREAM -->|result via APEX| APEX
    VISION -->|result via APEX| APEX
    APEX -->|result| HOPE
    APEX -.calls.-> KNOLL

    classDef eph fill:#fff6e0,stroke:#b8860b,color:#000;
    classDef ao fill:#e8f7ee,stroke:#2e7d32,color:#000;
    class DREAM,VISION eph;
    class HOPE,KNOLL,APEX ao;
```

Ephemeral DREAM/VISION also back **horizontal Colab workers**: claim a slice → run a persona
batch → report a payload for APEX re-ingestion → self-terminate.

---

## 3. Node matrix hierarchy

Each Big AI owns an identical 4,096-node matrix; personas are ephemeral leaves.

```mermaid
flowchart TD
    FLEET["Big 5 fleet — 20,480 nodes · 2,048,000 personas · ~1.4336e16 params"]
    FLEET --> A1[HOPE matrix]
    FLEET --> A2[DREAM matrix]
    FLEET --> A3[VISION matrix]
    FLEET --> A4[KNOLL matrix]
    FLEET --> A5[APEX matrix]

    A2 --> M["64 SubManagers / agent"]
    M --> N["64 Nodes / manager  → 4,096 nodes / agent"]
    N --> P["100 personas / node (ephemeral)"]
    P --> MODEL["each persona ≈ 7B model → 7,000,000,000 params"]

    classDef fleet fill:#eef,stroke:#334,color:#000;
    class FLEET fleet;
```

```
20,480 nodes × 100 personas × 7B params = 1.4336e16  (~14.3 quadrillion)
```

---

## 4. HOPE voice loop (HTTP gateway → APEX → back to voice)

The Phase 4 gateway gives HOPE a forward-facing HTTP presence. It is a composition root: it
wires DREAM/VISION as injected handlers and never addresses them directly.

```mermaid
sequenceDiagram
    actor Client
    participant GW as HOPE Gateway (node:http)
    participant HOPE as HOPE interpreter/voice
    participant APEX as APEX router
    participant KNOLL as KNOLL gate
    participant DV as DREAM / VISION (ephemeral)

    Client->>GW: POST /v1/intent { utterance }
    GW->>HOPE: interpret + document
    alt confidence below threshold
        HOPE-->>GW: clarificationNeeded (held, no dispatch)
        GW-->>Client: 200 { dispatched:false, voice: clarify }
    else confident
        HOPE->>APEX: submit (HOPE → APEX)
        APEX->>KNOLL: intercept(packet)
        KNOLL-->>APEX: isAllowed
        APEX->>DV: forward (after KNOLL)
        DV-->>APEX: result (via APEX only)
        APEX-->>HOPE: result → HOPE sink
        HOPE-->>GW: voice.status(result)
        GW-->>Client: 200 { dispatched:true, routingStatus, voice }
    end
```

**Read-only endpoints** (`/v1/health`, `/v1/ledger`, `/v1/audit`, `/v1/matrix/stats`) are
projections over the always-on core state; they never route or mutate anything.

---

## 5. Async intake via the task queue (Phase 4)

```mermaid
flowchart LR
    HOPE([HOPE]) -->|intake / publish| Q[[Kafka-like TaskQueue<br/>partitioned by AgentRole]]
    Q -->|consumer group drains| C{{APEX queue consumer}}
    C -->|dispatch — same KNOLL gate| APEX{APEX + KNOLL}
    APEX -->|forward after KNOLL| DV([DREAM / VISION])
    C -->|ack / nack| Q

    classDef q fill:#f3e8ff,stroke:#6b21a8,color:#000;
    class Q q;
```

The queue is **pure transport**. Draining calls the same `dispatch` path, so async intake is
gated by KNOLL identically to the synchronous path — the queue never bypasses APEX.
