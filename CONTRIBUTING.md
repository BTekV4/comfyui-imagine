# Contributing to Imagine

Thanks for helping. Imagine is a working studio more than a framework, so the
most useful contributions are the ones you hit while using it: a bug, a rough
edge on the page, a graph for another model family, a language pack, a plugin.

## Getting it running

You need what the [README](README.md#requirements) lists: Node 24+, git, ffmpeg,
a ComfyUI you can reach and an OpenAI-compatible endpoint.

```sh
git clone https://github.com/BTekV4/comfyui-imagine.git
cd comfyui-imagine
npm install
cp config.example.yaml config.yaml   # ComfyUI address, model endpoint
npm run build && node dist/server.mjs
```

While working on the page, `npx vite web` serves it with hot reload on
`http://localhost:5190` and forwards the API to a server on port 3090.

## Before a pull request

```sh
npm run typecheck   # server, page and tests
npm test            # the whole suite, no ComfyUI needed
npm run build       # what users will run
```

All three must pass. A fix comes with a test that fails without it whenever
that is possible; the suite is plain `node:test`, one file per area in `test/`.

## How the code is written

- **English** everywhere in the repository: code, comments, docs, commit
  messages. The page's texts go through the dictionary
  (`web/vendor-imagine/client/locales.ts`); other languages are packs in
  `locales/` (see [docs/language-packs.md](docs/language-packs.md)). The server's
  own sentences are in `server/src/messages.ts`, in English and Italian.
- **Comments say why**, not what: the reason a line is there, what went wrong
  before it, with a date when it is a fix. They are the project's memory.
- **No machine-specific values in code**: addresses, paths and model names live
  in `config.yaml`, and the graphs in `workflows/` are examples to adapt.
- **Features that not everyone needs are plugins** (`plugins/`, contract in
  [docs/plugin-api.md](docs/plugin-api.md)): the base studio stays small.
- TypeScript is strict; keep `npm run typecheck` clean rather than casting.

## Where things are

| Path | What |
|---|---|
| `server/src/` | the host: HTTP routes, login, settings, plugins, static files |
| `server/vendor/tool-comfy/` | the studio: jobs, graphs, the chat, the gallery |
| `web/vendor-imagine/client/` | the page (React) |
| `shared/` | types and helpers both sides use |
| `plugins/` | Instagram, Telegram, Openjutsu, IOPaint, and an example to copy |
| `workflows/` | the ComfyUI graphs, in API format |
| `comfyui-nodes/comfyui-imagine/` | the ComfyUI pack: the studio's nodes and the setup that installs what a graph needs (`manifest.json`) |
| `mcp/` | an MCP server that drives the studio from an agent |

## Reporting a bug

Open an issue with what you did, what you expected, what happened, and the
lines from the server log around it (`journalctl -u imagine` with the systemd
unit). Leave out tokens, keys and anything personal in your media.
