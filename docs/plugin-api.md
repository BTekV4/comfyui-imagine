# Plugin API

## Five minutes

**What you need.** Node 22+ and this repository (a plugin is compiled with
`npm run build:plugins`, which uses the esbuild the studio already depends on).
Nothing else: no package to install, no service to run.

**The three files.** A plugin is a folder with a manifest, a module, and a
settings file the host writes:

```
plugins/my-plugin/
  manifest.json     what it is, and which fields the settings page draws
  src/index.ts      the module: `export default function setup(ctx)`
  README.md         for the next person
```

`src/index.ts` is compiled into `index.mjs` — the file the host actually loads —
by `npm run build:plugins` (plain `.mjs` works too: copy `plugins/telegram`, which
is hand-written).

**The cycle.**

```sh
npm run build:plugins                 # src/index.ts → index.mjs
mkdir -p <data>/plugins/my-plugin     # <data> is the studio's data folder
cp plugins/my-plugin/{manifest.json,index.mjs} <data>/plugins/my-plugin/
systemctl restart imagine             # or: POST /comfy-plugins/my-plugin/refresh
```

Open **Impostazioni → Studio → Plugin**: the fields the manifest declares are
there, with a Save button, the status line, and a button per action. Then to
remove it:

```sh
rm -rf <data>/plugins/my-plugin
systemctl restart imagine
```

Nothing else changes when a plugin is not installed: no route, no section, no
timer. Deleting the folder deletes the plugin's settings with it.

**Start from one that works.** `plugins/example-webhook/` forwards the studio's
notices to an address: three fields, one action, ~120 commented lines. Copy the
folder, change the `id` in the manifest, and you have a plugin.

**Security.** A plugin runs **inside the studio's process, with its
privileges**: it can read the config, the tokens and the whole filesystem, and it
can send anything anywhere. The context gives it no `fs`, but that is a
convention, not a fence. Install plugins you trust; check a new one before you
put it in `<data>/plugins/`.

## What a plugin can do

| It wants to… | It declares / returns | Where |
|---|---|---|
| get values from the settings page | `settings[]` in the manifest (`text`, `password`, `toggle`, `select`) and `ctx.config()` | [manifest.json](#manifestjson), [Settings](#settings-and-configjson) |
| know whether it is OK right now | `status()` → `{ ok, summary?, detail?, lines? }` | [status](#status) |
| offer a button that does something | `actions[]` in the manifest, and a route under `/plugin/<id>/` | [actions](#routes) |
| answer HTTP | `routes: [{ path, kind, handler }]`, or `ctx.registerRoute` | [routes](#routes) |
| run something every 30 seconds | `tick(now)` | [tick](#tick) |
| be told when the studio has news | `ctx.onNotify(handler)` | [The context](#ctx) |
| say something to the owner | `ctx.notify(text)` (the same bus) | [The context](#ctx) |
| talk to the model / to ComfyUI / to the gallery | `ctx.llm`, `ctx.model()`, `ctx.comfy`, `ctx.mediaDir` | [The context](#ctx) |
| keep a file of its own | `ctx.dataPath(name)`, its folder | [The context](#ctx) |
| write in the reader's language | `res.language` on a route; a setting of its own for what runs alone | [Languages](#languages) |

## A plugin is a folder with a manifest and an ES module

A plugin is a folder with a manifest and an ES module. The host loads it at
startup, hands it a small context, and gives its HTTP routes back under
`/plugin/<id>/`. Everything else in the studio works exactly the same whether
one plugin is installed or none.

There is no plugin marketplace and no sandbox. A plugin is code you install on
purpose, running inside the studio's own process.

```
<data>/plugins/<id>/
  manifest.json      what it is, and which settings it has
  index.mjs          the module: `export default function setup(ctx)`
  config.json        written by the host when the settings page saves (0600)
```

`<data>` is the studio's data folder — `$IMAGINE_HOME` (default `~/.imagine`). The folder may not exist: that is an installation
with no plugins, and nothing appears anywhere.

## manifest.json

```json
{
  "id": "webhook",
  "name": "Webhook",
  "version": "1.0.0",
  "api": 1,
  "description": { "en": "Sends every finished job to an address of yours.",
                   "it": "Manda ogni lavoro finito a un indirizzo tuo." },
  "entry": "index.mjs",
  "settings": [
    { "key": "url", "kind": "text",
      "label": { "en": "Address", "it": "Indirizzo" },
      "placeholder": "https://…",
      "help": { "en": "Where the notices go.", "it": "Dove arrivano gli avvisi." } },
    { "key": "secret", "kind": "password", "label": { "en": "Secret", "it": "Segreto" } },
    { "key": "enabled", "kind": "toggle", "label": { "en": "Enabled", "it": "Attivo" }, "default": false },
    { "key": "mode", "kind": "select", "label": { "en": "Mode", "it": "Modo" },
      "options": [ { "value": "summary", "label": { "en": "Summary", "it": "Sommario" } } ] }
  ]
}
```

| field | required | notes |
|---|---|---|
| `id` | yes | lowercase letters, digits and dashes, up to 64; **must equal the folder name** |
| `name` | no | defaults to `id` |
| `version` | yes | any non-empty string; the page shows it |
| `api` | yes | integer; must be `1` (see [Versioning](#versioning)) |
| `description` | no | `{ "en": …, "it": … }`; English only is fine and stands in for both |
| `icon` | no | a short glyph for the card: an emoji (`"📷"`) or one or two characters; without it the card draws a puzzle |
| `entry` | yes | a **file name** inside the plugin folder: no slashes, no `..`, not absolute |
| `settings` | no | the fields the settings page draws; see below |

A manifest that does not pass is listed in the panel with its error and is not
loaded. Nothing crashes, and the other plugins load anyway.

### `settings`

Each entry becomes one control. `key` is what the plugin reads out of
`ctx.config()`; it must be unique and contain no dots.

| `kind` | stored as | drawn as |
|---|---|---|
| `text` | string | single-line text field |
| `password` | string | password field; **the value is never sent back to the page** (only `isSet`) |
| `toggle` | boolean | checkbox |
| `select` | string | dropdown from `options` (`[{ "value": …, "label": { "en": …, "it": … } }]`) |

`default` is optional. A select nobody has filled in starts on its first option;
a toggle on `false`; the others on the empty string.

## The module

```js
export default function setup(ctx) {
  return {
    routes: [ { path: '/plugin/webhook/eventi', kind: 'exact', handler: (req, res) => { … } } ],
    tick: (now) => { /* every 30 seconds */ },
    status: () => ({ ok: true, summary: 'ready' }),
  }
}
```

`setup` may be `async`, and every part of the return value is optional.

### `ctx`

| field | type | what it is |
|---|---|---|
| `api` | `number` | `1` — check it if you want to refuse an unknown host |
| `id` | `string` | the plugin's id (its folder name) |
| `dir` | `string` | the plugin's own folder, for files it ships with |
| `dataPath(name)` | `(string) => string` | a path inside the plugin folder; a path that escapes it throws |
| `config()` | `() => Record<string, string \| boolean>` | **the current values — call it where you use them** |
| `llm` | `StreamCapable` | the studio's chat/vision client |
| `comfy` | `ComfyUi` | the studio's ComfyUI client |
| `mediaDir` | `string` | the folder the gallery serves |
| `log(line)` | `(string) => void` | one line in the host log, prefixed with `[plugin:<id>]` |
| `registerRoute(route)` | `(PluginRoute) => () => void` | add a route later; returns a remover; the path must sit under `/plugin/<id>/` or `/apps/<id>` |
| `notify(text, extra?)` | `(string, { photoPath?, photoUrl? }) => Promise<void>` | one notice to the owner (Telegram when configured); `extra` may carry one picture, a local file or a public address, shown by the listeners that can; never throws |

`config()` returns the values **as they are now**. The page can save new ones
while the plugin is running, and the next call sees them without a reload — so
read it where the value is used, not once at `setup`:

```js
// wrong: frozen at startup
const { url } = ctx.config()
setInterval(() => fetch(url), 60_000)

// right: the value as it is now
setInterval(() => fetch(ctx.config().url), 60_000)
```

**There is no `fs` and there are no secrets in the context** — but see
[Security](#security): this is a contract, not a fence.

### `routes`

```js
{ path: '/plugin/<id>/something', kind: 'exact' | 'prefix', handler: (req, res) => … }
```

`handler` is a Node `(IncomingMessage, ServerResponse) => void | Promise<void>`.
`kind` defaults to `exact`; `prefix` also matches everything under the path. The
loader **refuses** a path that does not start with `/plugin/<id>/` (or sit
under `/apps/<id>`, see below): a plugin cannot take over the host's own
routes, and a refused route fails the whole `setup` (the plugin is listed with
the reason and none of its routes stay).

**A web app of its own.** A plugin may also mount routes at `/apps/<id>` and
under it — the place for a separate web app the plugin passes through, behind
the studio's login, when the app is built for that path.
`server/src/app-proxy.ts` (`createAppProxyRoute`) does the pass, streaming both
ways; `plugins/openjutsu` and `plugins/iopaint` use it, and the page shows
their app in the rail while the plugin is installed and on.

A route registered from `setup` or through `ctx.registerRoute` is removed when
the plugin is reloaded and when the process stops.

### `tick`

Called every 30 seconds by **one timer for the whole host**, only when at least
one plugin exports it. A tick that throws is logged and does not stop the other
plugins' ticks. A tick at 30 seconds is not a scheduler: it is a nudge.

The host does not wait for an async tick to settle before calling the next one:
a tick that can run longer than 30 seconds keeps its own "still running" flag
and returns at once while it is set (the Instagram plugin does this around its
publish and comment passes).

### `status`

Asked when the plugins page loads (and after a save or a reload). It must answer
within **2 seconds** — past that the page shows "the status did not answer" and
the plugin is not called again until the next load. Return
`{ ok, summary?, detail?, lines? }`.

Every text may be a single string, or `{ "en": …, "it": … }` — write both if the
page has to read properly in both languages:

```js
status: () => ({
  ok: true,
  summary: { en: 'connected to 8059…309', it: 'collegato a 8059…309' },
  lines: [
    { text: { en: 'publishing on', it: 'pubblicazione attiva' }, tone: 'ok' },
    { text: 'one language is fine too' },
  ],
})
```

`lines` are drawn under the name in the detail page; `tone` colours the dot
(`ok`, `warn`, `bad`, `muted`).

## Languages

The studio speaks Italian and English, and a plugin's texts should follow. What
the host gives for that:

- **The manifest and the status** are bilingual by data: every `label`, `help`,
  `description`, `summary`, `detail` and status line can be `{ "en": …, "it": … }`,
  and the panel picks the language in force.
- **A route** gets the page's language on the response: `res.language` is the code
  the page sent with `x-app-language` (`it`, `en`, `pt-BR`), or `undefined` when it
  sent none. Italian with no code or with `it`, English for any other: that is
  the host's own rule, because English is the base and the only other language
  the server's texts are written in.
- **What runs on its own** — `tick`, a notice to the owner, a record written by a
  background pass — has no request, and so no language. The host has no studio-wide
  language setting to hand over (the language is a choice of each page), so a
  plugin that writes such texts declares a `select` of its own, as the Instagram
  plugin does with `language` (Italian by default), and reads it with `ctx.config()`.

How to write the texts:

- **A `.mjs` plugin** keeps a small `{ it, en }` table and picks the entry with
  `res.language` (`plugins/telegram/index.mjs`, `TEXTS`).
- **A TypeScript plugin** can use the host's table: `message(key, args)` from
  `server/src/messages.ts`, whose entries carry both sentences. The bundle has its
  *own copy* of that module (see [A plugin written in TypeScript](#a-plugin-written-in-typescript)),
  and with it its own current language: set it with `withLanguage(res.language, …)`
  around the route's dispatch, and with `withLanguage(<your setting>, …)` around the
  tick. `plugins/instagram/src/index.ts` does both, and its keys are the `social.*`
  entries of the table (the table and its test keep every key bilingual).
- **A text that is read back** (a retry deciding on the recorded error, say) may
  have been written in either language: match both. The Instagram plugin's
  `carries(text, key)` (`src/context.ts`) looks for the opening words of a table
  sentence in Italian and in English.

## Settings and `config.json`

The settings page draws the fields from the manifest and saves them through the
host: `POST /comfy-plugins/<id>/settings` with `{ "values": { … } }`.

- The body is a **merge**: keys you leave out keep their value. That is what
  makes it safe to edit one field without wiping the others, and it is why an
  empty password field means "leave it alone", not "erase it".
- Values are checked against the manifest: an unknown `key`, a toggle that is
  not a boolean, a select value outside its options, a text that is not a string
  or is longer than 4096 characters → `400` with the reason, and nothing is
  written.
- The write is atomic (temp file + rename), the file is `0600`, and the previous
  one is kept as `config.json.bak-<timestamp>` (the five newest are kept).
- Unknown keys already in the file are preserved but not shown or validated.

`GET /comfy-plugins` is the panel's read: every plugin with `id`, `name`,
`version`, `api`, `description`, `compatible`, `loaded`, `error`, `settings`
(with `value`, and `isSet` instead of the value for passwords) and `status`.

## Versioning

`PLUGIN_API_VERSION` is `1`. A manifest with another `api` is **listed as
incompatible and not loaded**: a plugin written for a newer host must not be
half-run. When the contract changes incompatibly, the number goes up; when it
grows additively (a new field in `ctx`), it stays.

## What happens when a plugin is broken

| what breaks | what you see | what the studio does |
|---|---|---|
| `manifest.json` missing or invalid | the entry, with the reason | keeps serving; nothing registered |
| `api` is not 1 | `compatible: false` | not loaded |
| the module throws on import | the entry, with `import failed: …` | other plugins load |
| `setup` throws | the entry, with `setup threw: …` | routes registered before the throw are removed |
| a route is outside `/plugin/<id>/` | `setup threw: route … is outside …` | nothing registered |
| `tick` throws | a line in the log | other ticks go on |
| `status` throws or is slow | `ok: false` with the reason | the page still loads |
| `config.json` holds a value that no longer validates | the default is used | the next save rewrites it |

A **Reload** button in the panel re-reads the manifest and re-imports the module
(dev loop). It is not a hot reload of running state: the plugin's own timers and
caches die with the old module.

## A plugin written in TypeScript

A plugin can be plain `.mjs` (the Telegram one is) or TypeScript: keep the source
in `src/` and `npm run build:plugins` bundles `src/index.ts` into the plugin's
`index.mjs`. `npm run build` runs it after the server build; a folder without
`src/` is left alone.

```sh
plugins/webhook/
  manifest.json
  src/index.ts      ← the source
  index.mjs         ← built, and what the host loads
```

```ts
// plugins/webhook/src/index.ts
import type { PluginContext, PluginSetup } from '../../../server/src/plugins.ts'
import { sendJson } from '../../../server/src/route-kit.ts'

export default function setup(ctx: PluginContext): PluginSetup {
  return {
    routes: [{
      path: '/plugin/webhook/eventi',
      handler: (_req, res) => { sendJson(res, 200, { ok: true }) },
    }],
    status: () => ({ ok: true, summary: 'up' }),
  }
}
```

**The bundle inlines what the plugin imports.** esbuild follows the relative
imports into the host — `server/src/route-kit.ts`, `server/vendor/tool-comfy/…`,
`shared/*` — and copies them into `index.mjs`; only `node:` builtins stay
external. That is deliberate: the host exports a small context, not an API
surface, so a plugin that needs a helper takes a copy of it instead of asking the
host for more. Two consequences worth knowing:

- a copy of a host module **does not share its module state**: anything the host
  sets at startup (a model choice kept in a variable, say) is empty in the
  plugin's copy — read it from the context instead (`ctx.model()`, `ctx.config()`);
- the plugin bundle is committed, so it is part of what a `git grep` for secrets
  sees: build the string at run time, do not leave a prefix as one literal (the
  bundler folds `'a' + 'b'` into one string).

## On the page

**Impostazioni → Studio** no longer holds the plugins: they have a page of their
own, **Plugin** in the rail. It reads one directory and one file:

- `<data>/plugins/<id>/` — what is installed. Each card has a switch: switched
  off, a plugin is listed and **not loaded** (no routes, no tick, no notices);
- `<data>/plugins-state.json` — which ones are switched off (`{ "disabled": [ … ] }`).
  Outside the plugin's folder on purpose: removing a plugin does not lose the
  choice to keep it off next time;
- `<repo>/plugins/<id>/` — what the repository ships and the data folder does
  not have yet. Those appear under **Available**, and their **Install** button
  copies `manifest.json` and the entry into `<data>/plugins/<id>/`.

Everything in the folder whose manifest does not load — an invalid manifest,
another `api`, an import or a `setup` that throws — appears under **Problems**
with the reason, and nothing is registered.

**Remove** never deletes: it moves the folder to `<data>/plugins-rimossi/<id>-<timestamp>`.

## Installing, updating, removing

There is no installer: the folder is the installation.

```sh
# install (or update) — the host picks it up at the next start
mkdir -p <data>/plugins/webhook
cp manifest.json index.mjs <data>/plugins/webhook/

# remove — the routes and the settings section disappear at the next start
rm -rf <data>/plugins/webhook
```

```sh
systemctl restart imagine            # the reference deployment's unit
curl -s http://127.0.0.1:3090/comfy-plugins | python3 -m json.tool
```

The plugin's own data (`ctx.dataPath(…)`) lives in its folder, so removing the
folder removes the data too. The settings survive a reload but not a deletion.

## Security

A plugin runs **in the studio's process, with its privileges**: it can read the
config, the tokens and the whole filesystem. The context gives it no `fs`, but
that is a convention for tidy plugins, not a sandbox — nothing stops a module
from importing `node:fs` directly.

So: install plugins you trust, at least as much as the studio itself. What the
host does promise is that a plugin cannot take over the host's routes (the
`/plugin/<id>/` prefix is enforced) and that its failures stay contained.

Passwords are stored in `config.json` as plain text with `0600` — the same way
the studio keeps its own tokens. Do not log them, and do not put them in a URL.

## A minimal plugin

```js
// <data>/plugins/hello/manifest.json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "api": 1,
  "entry": "index.mjs",
  "settings": [
    { "key": "who", "kind": "text",
      "label": { "en": "Who to greet", "it": "Chi salutare" },
      "default": "world" }
  ]
}
```

```js
// <data>/plugins/hello/index.mjs
export default function setup(ctx) {
  ctx.log('hello is up')
  return {
    routes: [
      {
        path: '/plugin/hello/greet',
        handler: (_req, res) => {
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ hello: String(ctx.config().who) }))
        },
      },
    ],
    tick: () => { ctx.log('tick') },
    status: () => ({ ok: true, summary: `greets ${String(ctx.config().who)}` }),
  }
}
```

Then `curl http://127.0.0.1:3090/plugin/hello/greet` answers
`{"hello":"world"}`, and changing the field in Impostazioni → Studio → Plugin
changes it without a restart.
