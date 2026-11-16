# Workflows

`workflows/` holds the graphs in ComfyUI's API format — the same JSON you get
from "Save (API format)". `config.example.yaml` wires them to the actions,
with the node ids that match the shipped files (each Pika clip graph carries a
fast and a quality recipe: the entry's `highInputs` lists the inputs the
quality one writes over the graph; a second graph as `pathHigh` also works).
[workflows/README.md](workflows/README.md) lists every file, the
config key it serves and what it does. They are examples from one machine: the
model and LoRA names in them are the ones installed there, so adapt them to
your ComfyUI. Change a graph, change the model, or write your own, then update
the pins.

There is no LoRA switching by keyword anywhere: a graph is static, and what
varies at run time is only what the pins address.
