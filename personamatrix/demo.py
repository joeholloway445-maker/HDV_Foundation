"""demo.py -- verify the core persona loop and ledger tracking.

Run from anywhere:
    python3 personamatrix/demo.py
or as a module:
    python3 -m personamatrix.demo

Exercises: filter_director spawn->execute->terminate over a batch, and APEX ledger
billing (SUCCESS + BLOCKED), then asserts the invariants hold.
"""
from __future__ import annotations

import os
import sys

# Allow running as a plain script (python3 personamatrix/demo.py) by ensuring the repo
# root is importable, so `import personamatrix` resolves.
_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from personamatrix import (  # noqa: E402
    ApexLedger,
    PersonaState,
    filter_director,
    load_matrix,
    spawn,
    execute,
    terminate,
)


def main() -> int:
    print("=" * 70)
    print("PERSONAMATRIX DEMO -- persona loop + APEX billing ledger")
    print("=" * 70)

    topo = load_matrix()["topology"]
    print(
        f"Topology: {topo['managersPerAgent']} managers x {topo['nodesPerManager']} nodes "
        f"= {topo['nodesPerAgent']}/agent, total {topo['totalNodes']} nodes, "
        f"{topo['personasPerNode']} personas/node, model {topo['modelSize']}"
    )

    # 1) Single persona lifecycle.
    print("\n[1] Single persona lifecycle (spawn -> execute -> terminate)")
    p = spawn(owner="DREAM", node_id="DREAM-mgr-00-node-00")
    assert p.state == PersonaState.SPAWNED, "persona must start SPAWNED"
    ex = execute(p, {"intent": "simulate weather"})
    assert p.state == PersonaState.EXECUTING, "persona must be EXECUTING after execute()"
    terminate(p)
    assert p.state == PersonaState.TERMINATED, "persona must be TERMINATED"
    print(f"    persona {p.id[:24]}... score={ex.score} state={p.state.value}")

    # Terminated personas cannot execute again.
    try:
        execute(p, {"intent": "should fail"})
        raise AssertionError("executing a terminated persona must raise")
    except RuntimeError:
        print("    verified: terminated persona cannot execute again")

    # 2) filter_director batch loop.
    print("\n[2] filter_director batch (100 personas at a node)")
    payloads = [{"intent": "branch", "i": i} for i in range(100)]
    results = filter_director(owner="DREAM", node_id="DREAM-mgr-00-node-00", payloads=payloads)
    assert len(results) == 100, "filter_director must return one result per payload"
    avg = sum(r.score for r in results) / len(results)
    print(f"    ran {len(results)} ephemeral personas; avg filtered score={avg:.4f}")

    # 3) Ledger billing.
    print("\n[3] APEX ledger billing")
    ledger = ApexLedger()
    ledger.request(
        packet_id="pkt-demo-1",
        source="APEX",
        destination="DREAM",
        personas=len(results),
        model_seconds=2.5,
        status="SUCCESS",
    )
    ledger.log_request(
        packet_id="pkt-demo-2",
        source="DREAM",
        destination="VISION",
        status="BLOCKED",
        cost_usd=0.0,
        knoll_signature="knoll_deny:NO_DIRECT_DREAM_VISION",
    )
    total = ledger.total_cost()
    assert ledger.count_by_status("SUCCESS") == 1, "expected 1 SUCCESS row"
    assert ledger.count_by_status("BLOCKED") == 1, "expected 1 BLOCKED row"
    assert total > 0.0, "successful execution must cost > 0"
    print(f"    SUCCESS rows: {ledger.count_by_status('SUCCESS')}  "
          f"BLOCKED rows: {ledger.count_by_status('BLOCKED')}")
    print(f"    total billed: ${total:.6f} USD")

    print("\n" + "=" * 70)
    print("RESULT: PASS -- persona loop and ledger verified.")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
