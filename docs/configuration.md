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

## Running from a read-only program folder

A service has its program and its data in one tree: `config.yaml` sits beside
`dist/`, the graphs and the media. The desktop app cannot: the AppImage is
mounted read-only and replaced whole on every update, so the program lives in
the image and the data in the user's folder. Three variables say so, and every
installation that does not set them boots exactly as before.

| Variable | What it says |
|---|---|
| `IMAGINE_PROGRAM_DIR` | The read-only folder holding `dist/`, `locales/`, `plugins/`, `workflows/`, `persona/` and `config.example.yaml`. A **relative** `webDir`, workflow `path:`/`pathHigh:` and persona `path:` are read from here instead of from the config's folder; an absolute one is taken as written, and `custom:<id>` still means a personal workflow in the data folder. |
| `IMAGINE_PORT` / `IMAGINE_HOST` | The free loopback port the app reserved for its window (`127.0.0.1`), instead of `port:`/`host:` from the config. A desktop window is not a server on the LAN. |
| `IMAGINE_PARENT_PID` | The window's process. The studio stops within two seconds of it disappearing, however it went: closing the window has its own path, a logout or a kill is caught here. |

The data side is the usual pair: `IMAGINE_CONFIG` (the file to read) and
`IMAGINE_HOME` (where media, projects, plugins, language packs, `host-settings.json`
and the login files go). The app sets `IMAGINE_HOME` to its data folder's
`data/`, so a `config.yaml` written there keeps landing everything in the same
place — `outputDir: ./data/outputs`, `passwordFile: ./data/password.json`.
Its own data folder is `IMAGINE_DATA` when set, else the folder Electron gives
an app (`~/.config/Imagine` on Linux, `%APPDATA%\Imagine` on Windows), else
`~/.local/share/imagine/app` when that is where the previous AppImage kept
everything.

### The graphs inside a read-only program

A graph `config.yaml` names under the program (`./workflows/…`) is read from the
program until somebody changes it. The first edit from **Settings → Workflow**
— a value, a LoRA, anything that used to write the file — copies that one file
to `<data>/workflows/<the same relative path>` (so
`<data>/workflows/workflows/<file>.json`) and writes the copy; from then on the
copy is what the studio loads, update or not. The workflow's card says so and
offers **Restore default**, which deletes the copy (and the `.bak-…` files kept
beside it) and loads the program's graph again without a restart — the only way
back to that graph's updates.

A path outside the program (an absolute path to a graph kept elsewhere, a
`custom:<id>`) is not copied: it is read and written where it is, as in every
other installation.
