# Configuration

Everything deployment-specific lives in `config.yaml` — no address, path or
model name is compiled into the code, and every path in it is read relative to
the file itself.

| Key | What it is |
|---|---|
| `providers` / `models` | One entry per OpenAI-shaped endpoint and the models it serves. `vision: true` marks the ones that can read a frame. |
| `comfy.baseURL` | Where ComfyUI listens. |
| `toolComfy.workflows` | One entry per action: the graph file, the output extension, and the ids of the nodes carrying the prompt, seed, canvas or input image. An entry you leave out disables that action. |
| `toolComfy.persona.path` | Who the prompts describe. See below. |
| `toolComfy.tts` | The speech endpoint for the `speak` action. |

## The persona

Every prompt that has to show a person starts with the same paragraph, and that
paragraph is data: a JSON file named by `toolComfy.persona.path`.

```json
{
  "identity": "The subject, a person standing alone in the photograph, photographed from the front in natural light.",
  "hair": ""
}
```

- `identity` — the paragraph prepended to every draw.
- `hair` — a colour to pin in the text, when the source frame keeps winning.
  Empty leaves the text alone.

A deployment without a persona file boots and works: it draws a neutral,
undescribed person.
