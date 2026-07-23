# 02 - Parameter Tuning (Colab)

**ML LAB ONLY.** GPU processing and persona spawning. No webcam, no microphone, no
physical-world I/O. Simulation and compute only.

This notebook tunes the `filter_director` parameters in [`config/filters.json`](../config/filters.json)
interactively with `ipywidgets`, then re-runs the persona loop to see the effect on
filtered persona scores.

## Parameters (from `config/filters.json`)

| Param        | Meaning                                             | Range        |
|--------------|-----------------------------------------------------|--------------|
| `intensity`  | Amplitude of the persona filter transform           | 0.0 – 1.0    |
| `waveSpeed`  | Frequency of the damped wave applied per persona    | 0.1 – 5.0    |
| `shift`      | Phase shift of the wave                              | -1.0 – 1.0   |
| `resonance`  | Cross-persona reinforcement factor                  | 0.0 – 1.0    |
| `decay`      | Damping applied across persona sub-steps            | 0.0 – 1.0    |
| `spawnJitter`| Randomization applied at spawn time                 | 0.0 – 1.0    |

## Interactive tuning cell

```python
import json, os, sys
REPO_ROOT = os.path.dirname(os.getcwd()) if os.path.basename(os.getcwd()) == "colab" else os.getcwd()
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import ipywidgets as widgets   # pip install ipywidgets (Colab has it preinstalled)
from IPython.display import display
from personamatrix import filter_director

def run(intensity, waveSpeed, shift, resonance, decay, spawnJitter):
    filters = dict(intensity=intensity, waveSpeed=waveSpeed, shift=shift,
                   resonance=resonance, decay=decay, spawnJitter=spawnJitter)
    payloads = [{"intent": "tune", "i": i} for i in range(100)]
    results = filter_director("DREAM", "DREAM-mgr-00-node-00", payloads, filters)
    avg = sum(r.score for r in results) / len(results)
    print(f"avg filtered score over 100 personas = {avg:.4f}")

widgets.interact(
    run,
    intensity=widgets.FloatSlider(min=0.0, max=1.0, step=0.01, value=0.75),
    waveSpeed=widgets.FloatSlider(min=0.1, max=5.0, step=0.1, value=1.2),
    shift=widgets.FloatSlider(min=-1.0, max=1.0, step=0.01, value=0.05),
    resonance=widgets.FloatSlider(min=0.0, max=1.0, step=0.01, value=0.5),
    decay=widgets.FloatSlider(min=0.0, max=1.0, step=0.01, value=0.9),
    spawnJitter=widgets.FloatSlider(min=0.0, max=1.0, step=0.01, value=0.1),
)
```

## Persisting tuned values

When you find a good configuration, write it back to `config/filters.json` so both the
Python persona loop and the TypeScript backbone pick it up:

```python
import json, os
path = os.path.join(REPO_ROOT, "config", "filters.json")
cfg = json.load(open(path))
cfg["filters"].update(dict(intensity=0.8, waveSpeed=1.5, shift=0.0,
                           resonance=0.6, decay=0.85, spawnJitter=0.05))
json.dump(cfg, open(path, "w"), indent=2)
print("Saved tuned filters to", path)
```

> Note: the `limits` block in `filters.json` documents the min/max/step used above so the
> widget ranges and the on-disk contract never drift apart.
