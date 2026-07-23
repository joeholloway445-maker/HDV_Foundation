# ---
# Big 5 Matrix -- Colab: Interactive Filter Tuning (Phase 2)
# ML LAB ONLY: GPU processing and persona spawning. Simulation/compute only.
# RESTRICTION: no webcam, no microphone, no physical-world I/O.
#
# Tunes the filter_director parameters (intensity / waveSpeed / shift) and re-runs the
# persona loop to see the effect on filtered persona scores.
#
# Works WITHOUT ipywidgets installed: it falls back to a plain CLI sweep. If ipywidgets IS
# available (e.g. in Colab), it renders interactive sliders instead. Either way it reads
# defaults from config/filters.json.
#
# Run as a script:  python3 colab/04_ipywidgets_tuning.py
# ---

# %%
import os
import sys

REPO_ROOT = os.path.abspath(os.getcwd())
if os.path.basename(REPO_ROOT) == "colab":
    REPO_ROOT = os.path.dirname(REPO_ROOT)
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from personamatrix import filter_director, filter_params, load_filters  # noqa: E402


def run_once(intensity: float, wave_speed: float, shift: float) -> float:
    """Run 100 personas through the filter loop with the given params; return avg score."""
    base = dict(filter_params())
    base.update(intensity=intensity, waveSpeed=wave_speed, shift=shift)
    payloads = [{"intent": "tune", "i": i} for i in range(100)]
    results = filter_director("DREAM", "DREAM-mgr-00-node-00", payloads, base)
    return sum(r.score for r in results) / len(results)


def _limits():
    limits = load_filters().get("limits", {})
    return {
        "intensity": limits.get("intensity", {"min": 0.0, "max": 1.0, "step": 0.01}),
        "waveSpeed": limits.get("waveSpeed", {"min": 0.1, "max": 5.0, "step": 0.1}),
        "shift": limits.get("shift", {"min": -1.0, "max": 1.0, "step": 0.01}),
    }


def interactive() -> bool:
    """Try to render ipywidgets sliders. Returns True if widgets were used."""
    try:
        import ipywidgets as widgets  # type: ignore
        from IPython.display import display  # type: ignore  # noqa: F401
    except Exception:
        return False

    lim = _limits()
    defaults = filter_params()

    def _run(intensity, waveSpeed, shift):
        avg = run_once(intensity, waveSpeed, shift)
        print(f"avg filtered score over 100 personas = {avg:.4f}")

    widgets.interact(
        _run,
        intensity=widgets.FloatSlider(
            min=lim["intensity"]["min"], max=lim["intensity"]["max"],
            step=lim["intensity"]["step"], value=float(defaults.get("intensity", 0.75)),
        ),
        waveSpeed=widgets.FloatSlider(
            min=lim["waveSpeed"]["min"], max=lim["waveSpeed"]["max"],
            step=lim["waveSpeed"]["step"], value=float(defaults.get("waveSpeed", 1.2)),
        ),
        shift=widgets.FloatSlider(
            min=lim["shift"]["min"], max=lim["shift"]["max"],
            step=lim["shift"]["step"], value=float(defaults.get("shift", 0.05)),
        ),
    )
    return True


def cli_sweep() -> None:
    """CLI fallback: sweep a few values of each parameter and print the effect."""
    defaults = filter_params()
    base_i = float(defaults.get("intensity", 0.75))
    base_w = float(defaults.get("waveSpeed", 1.2))
    base_s = float(defaults.get("shift", 0.05))

    print("ipywidgets not available -- running CLI parameter sweep.\n")
    print(f"baseline: intensity={base_i}, waveSpeed={base_w}, shift={base_s}")
    print(f"  baseline avg score = {run_once(base_i, base_w, base_s):.4f}\n")

    print("intensity sweep (waveSpeed/shift fixed):")
    for v in (0.25, 0.5, 0.75, 1.0):
        print(f"  intensity={v:<4} -> avg score = {run_once(v, base_w, base_s):.4f}")

    print("\nwaveSpeed sweep (intensity/shift fixed):")
    for v in (0.5, 1.2, 2.5, 4.0):
        print(f"  waveSpeed={v:<4} -> avg score = {run_once(base_i, v, base_s):.4f}")

    print("\nshift sweep (intensity/waveSpeed fixed):")
    for v in (-0.5, 0.0, 0.25, 0.75):
        print(f"  shift={v:<5} -> avg score = {run_once(base_i, base_w, v):.4f}")


def main() -> int:
    print("=" * 70)
    print("FILTER TUNING -- intensity / waveSpeed / shift")
    print("=" * 70)
    if not interactive():
        cli_sweep()
    print("\nDONE -- tuning complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
