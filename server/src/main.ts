/**
 * The Imagine host.
 *
 * Runs the studio's server half (`vendor/tool-comfy`, the ComfyUI client in
 * `vendor/comfyui`) with its context (`host.ts`): an OpenAI-compatible LLM
 * client, the ComfyUI client, a route table, the notice bus and a password
 * login. It loads the external plugins (`plugins.ts`) and the language packs
 * (`locales.ts`), and serves the studio's web build (`static.ts`).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ComfyUi } from '../vendor/comfyui/index.ts'
import { dataPath } from '../vendor/home-paths/index.ts'
import { createAddAudioRoute, createMergeRoute, createTrimRoute } from './clips.ts'
import { createCropRoute, createDuplicateRoute } from './stills.ts'
import { createSegmentsRoutes } from './segments-route.ts'
import { createLikesRoute } from './likes.ts'
import { createTagsRoute } from './tags.ts'
import { warmThumbnails } from './thumb-warmer.ts'
import { createDetailsRoute } from './details.ts'
import { createFrameRoute } from './frames.ts'
import { createMediaSearchRoute } from './media-search.ts'
import * as toolComfy from '../vendor/tool-comfy/index.ts'
import { setImagineModels } from '../vendor/tool-comfy/imagine-models.ts'
import { AGENT_LIMITS_DEFAULT, type AgentChatMode } from '../../shared/agent-chat.ts'
import { COVER_MAX_BYTES } from '../../shared/cover-kinds.ts'
import { createAuth } from './auth.ts'
import { applySecurityHeaders, stateChangeAllowed } from './security.ts'
import { absoluteFrom, anchoredToolComfy, programAsset } from './config-paths.ts'
import { listenHost, listenPort, listensBeyondLoopback, programDirFrom } from './boot-env.ts'
import { parentPidFrom, watchParent } from './parent-watch.ts'
import { coverIndex, coverKeyOf, coversDir, storeCover } from './covers.ts'
import { createLlm, type ProviderConfig } from './llm.ts'
import { createPlugins, createPluginsRoute } from './plugins.ts'
import { message, withLanguage } from './messages.ts'
import { allowOnly, HttpError, languageOf, methods, readBody, readObject, restOf, sendJson } from './route-kit.ts'
import { createLocalePacks, createLocalePacksRoutes } from './locales.ts'
import { createHostSettings } from './settings.ts'
import { createAccessBanner, forgetDismissalWhenLoginMoves } from './access-banner.ts'
import { createAccessRoutes } from './access-routes.ts'
import { liveSetupStatus } from './setup-status.ts'
import { ensureConfig } from './first-run.ts'
import { configureComfySetup } from '../vendor/tool-comfy/comfy-setup.ts'
import { serveStatic } from './static.ts'
import { createNotifyBus } from './notify-bus.ts'
import type { ImagineHost, WebRoute } from './host.ts'
import type { ModelEntry, ModelRoute } from '../../shared/imagine-types.ts'
import { THINKING_DEFAULT } from '../../shared/host-settings.ts'
import type { HostSettingsValues } from '../../shared/host-settings.ts'

interface HostConfig {
  readonly port?: number
  readonly host?: string
  readonly webDir: string
  readonly passwordFile: string
  readonly secretFile: string
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly models: readonly ModelEntry[]
  readonly defaultModel: ModelRoute
  readonly comfy: Record<string, unknown>
  readonly toolComfy: Record<string, unknown>
  readonly settingsFile?: string
  /** The base language, `en` (default) or `it`: see `baseLanguage()` in messages.ts. */
  readonly language?: string
  /** Proxies whose X-Forwarded-For the login brake believes; NPM by default. */
  readonly trustedProxies?: readonly string[]
}

/* The studio's own version, stamped by the build (`__IMAGINE_VERSION__`). */
const studioVersion: string | undefined = __IMAGINE_VERSION__ === '' ? undefined : __IMAGINE_VERSION__

const configPath = process.env.IMAGINE_CONFIG ?? 'config.yaml'
/*
 * The desktop app boots the studio from a read-only program folder (the
 * AppImage's mount, a Windows installer's folder) with the data in the user's
 * own: `boot-env.ts` reads the two overrides it passes, and they fall back to
 * `config.yaml` when absent. Everything below that names a path decides
 * between the program's files and the user's with them.
 */
const programDir = programDirFrom()
/*
 * A first run has no config.yaml, and the portable packages cannot ask the
 * questions `install.sh` asks (Windows has no bash): the studio writes one
 * from the example beside it, and the page's first-run card asks for the rest
 * — a ComfyUI address that does not answer, no model, no ffmpeg. In a packaged
 * app the example is in the program folder, not beside the config.
 */
const examplePath = join(dirname(configPath), 'config.example.yaml')
const shippedExample = programDir === undefined || existsSync(examplePath) ? examplePath : join(programDir, 'config.example.yaml')
const firstRun = ensureConfig(configPath, shippedExample)
if (firstRun.created) {
  console.log(`[imagine] first run: ${firstRun.path} written${firstRun.from === undefined ? '' : ` from ${firstRun.from}`}`)
}
const raw = parseYaml(readFileSync(configPath, 'utf8')) as HostConfig
/*
 * The example that ships with this installation, read for two things: the
 * defaults of the included graphs (a `config.yaml` copied before the reference
 * pins existed keeps editing), and the keys it has that the live file does not
 * (the log and the settings page say so). A missing or broken example is not a
 * reason to stop the studio: the live config is still what it says.
 */
const exampleWorkflows = ((): Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined => {
  if (!existsSync(shippedExample)) return undefined
  try {
    const example = parseYaml(readFileSync(shippedExample, 'utf8')) as HostConfig
    if (example.toolComfy === undefined) return undefined
    const block = anchoredToolComfy(shippedExample, example.toolComfy, programDir)
    const workflows = block['workflows']
    return typeof workflows === 'object' && workflows !== null
      ? workflows as Readonly<Record<string, Readonly<Record<string, unknown>>>>
      : undefined
  } catch (error: unknown) {
    console.warn(`[imagine] config.example.yaml not read: ${String(error)}`)
    return undefined
  }
})()

/*
 * The base language (`language:` in config.yaml, English when absent): what
 * the server and the plugins write in when nothing declares a language. An
 * IMAGINE_LANGUAGE already in the environment wins over the file.
 */
if (process.env['IMAGINE_LANGUAGE'] === undefined && typeof raw.language === 'string' && raw.language.trim() !== '') {
  process.env['IMAGINE_LANGUAGE'] = raw.language.trim()
}

/*
 * Every path in the file is read relative to the file itself, not to the
 * process's working directory. Started from anywhere but the app's own folder,
 * `node dist/server.mjs` used to die on the first graph with a bare ENOENT.
 * `config-paths.ts` owns that rule, and the exception for `custom:<id>`.
 */
const absolute = (value: string): string => absoluteFrom(configPath, value)

const config: HostConfig = {
  ...raw,
  // The page is the program's; the login files and the media are the user's.
  webDir: programAsset(programDir, configPath, raw.webDir),
  passwordFile: absolute(raw.passwordFile),
  secretFile: absolute(raw.secretFile),
  ...raw.settingsFile === undefined ? {} : { settingsFile: absolute(raw.settingsFile) },
  toolComfy: anchoredToolComfy(configPath, raw.toolComfy, programDir),
}

/*
 * A fresh install has no data directory yet, and the writer that stores the
 * password and the cookie secret does not create one: the first run died with
 * ENOENT before it could serve anything.
 */
for (const file of [config.secretFile, config.passwordFile]) mkdirSync(dirname(file), { recursive: true })

/* ------------------------------------------------------------------ context */

const routes: WebRoute[] = []
const disposers: (() => void)[] = []

/*
 * The provider the settings page edits: the one serving the default model, or
 * the first configured when they disagree. The page reaches it under the
 * virtual name below, whose address and key the page itself owns.
 */
const gateway = config.providers[config.defaultModel.provider] ?? Object.values(config.providers)[0]
const GATEWAY_PROVIDER = 'gateway'
const settings = await createHostSettings({
  file: config.settingsFile ?? dataPath('host-settings.json'),
  passwordFile: config.passwordFile,
  envKey: gateway?.apiKeyEnv === undefined ? undefined : process.env[gateway.apiKeyEnv],
  base: {
    gatewayURL: gateway?.baseURL ?? 'http://127.0.0.1:11434/v1',
    apiKey: '',
    models: config.models,
    defaultModel: config.defaultModel,
    /*
     * How much the model thinks: applies to every text and vision pass. The
     * default is `low` — a low level is already four times faster than
     * "say nothing", and `off` stays one click away in Settings → Models.
     */
    thinking: THINKING_DEFAULT,
    resumeSweep: process.env.IMAGINE_RESUME_SWEEP === '1',

    requireLogin: false,
    hfToken: '',
    autoSetup: false,
    agentChat: 'auto',
    agentMaxSteps: AGENT_LIMITS_DEFAULT.maxSteps,
    agentMaxJobs: AGENT_LIMITS_DEFAULT.maxJobs,
    agentWaitSeconds: AGENT_LIMITS_DEFAULT.waitSeconds,
    agentTurnSeconds: AGENT_LIMITS_DEFAULT.turnSeconds,
  },
})

// ComfyUI's setup (comfyui-imagine) reads the keys and the switch when a run needs them.
configureComfySetup(() => {
  const { hfToken, autoSetup } = settings.current()
  return { hfToken, autoSetup }
})
const now = (): HostSettingsValues => settings.current()

/* The address the studio listens on: the warning about an open, non-loopback
 * studio and the desktop app's loopback-only window both read it — and the
 * agent's eraser tool calls the plugin route over loopback. */
const listenOn = { port: listenPort(config.port), host: listenHost(config.host) }

/*
 * The warning about an open studio can be hidden for the whole studio: one
 * file beside the other records, read from every device.
 */
const accessBanner = await createAccessBanner(dataPath('access-banner.json'))
/*
 * A dismissal never outlives a boot with the login on: the studio was closed
 * in between, and the warning must be back when it opens again.
 */
if (now().requireLogin) await accessBanner.show()

/** Providers as the LLM client sees them, with the gateway fields from the settings. */
const providers = (): Readonly<Record<string, ProviderConfig>> => {
  const current = now()
  return {
    ...config.providers,
    [GATEWAY_PROVIDER]: {
      ...gateway,
      baseURL: current.gatewayURL,
      ...current.apiKey === '' ? {} : { apiKey: current.apiKey },
    },
  }
}
// The eyes are the chat model: since 2026-10-31 the page names only one.
// The thinking level is read on every request: a save from the page applies
// from the next pass, without restarting the process.
const { llm, auxiliary, listModels, thinkingLevels, modelCapabilities } = createLlm(providers, () => now().defaultModel, () => now().thinking)
const comfy = new ComfyUi(ComfyUi.Config(config.comfy))
// Without this the progress socket's reconnect loop outlives the server.
disposers.push(() => { comfy.dispose() })

/*
 * The notice bus: whoever wants to notify calls `ctx.notify`, whoever wants
 * to receive notices subscribes with `ctx.onNotify` (plugins) or
 * `notices.onNotify`. No hard-wired notifier goes through here any more:
 * Telegram is a plugin, and without the plugin `notify` has no listeners and
 * resolves doing nothing.
 */
const notices = createNotifyBus()

const ctx: ImagineHost = {
  comfy,
  llm,
  auxiliary,
  notify: text => notices.notify(text),
  effect(setup) {
    const dispose = setup()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  webServer: {
    register(route) {
      routes.push(route)
      routes.sort(byPrefixLength)
      // Removing twice must not take another route: indexOf is -1 then, and
      // splice(-1, 1) drops the last entry of the table.
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  },
}
/*
 * The media directory as the plugin resolved it at boot: the settings page's
 * override first, then `config.yaml`, then the default. The host routes used
 * only `config.yaml`, so a folder moved from the page would have left trim,
 * likes, tags and the rest on the old one.
 */
const { outputDir } = toolComfy.apply(ctx, toolComfy.Config(config.toolComfy), {
  // Read when the sweep would run, so the settings page's switch counts.
  resumeSweep: () => now().resumeSweep,
  exampleWorkflows,
  agent: {
    mode: (): AgentChatMode => now().agentChat,
    limits: () => ({
      maxSteps: now().agentMaxSteps,
      maxJobs: now().agentMaxJobs,
      waitSeconds: now().agentWaitSeconds,
      turnSeconds: now().agentTurnSeconds,
    }),
    capabilities: route => modelCapabilities(route),
    selfURL: `http://127.0.0.1:${String(listenOn.port)}`,
  },
})

/*
 * A fresh installation has no media folder, and nothing creates it before the
 * first job writes there: the first render died with ENOENT on a folder the
 * example configuration only named. Created at boot, then; a folder that
 * cannot be created is left to the first-run card, which reports it in the
 * page instead of stopping the studio from starting.
 */
try {
  mkdirSync(outputDir, { recursive: true })
} catch {
  // `/setup-status` says which folder and why.
}
/*
 * After apply, which records the plugin config's models: the page's choice
 * wins. One model for every pass since 2026-10-31 — the page no longer names
 * the eyes, so the vision passes read with the chat model too.
 */
const applyModels = (): void => { setImagineModels({ text: now().defaultModel, vision: now().defaultModel }) }
applyModels()
/*
 * The language packs: installed in `<data>/locales`, installable from the
 * repository's `locales/` — beside the bundle, or where IMAGINE_LOCALES_SRC
 * says when the app is installed outside the source tree.
 */
const localePacks = await createLocalePacks({
  dir: dataPath('locales'),
  srcDir: process.env.IMAGINE_LOCALES_SRC?.trim() || join(programDir ?? join(dirname(fileURLToPath(import.meta.url)), '..'), 'locales'),
})

/*
 * The external plugins: `<data>/plugins/<id>/`. There is nothing to do when
 * the folder is missing — no route, no timer, no section on the page — so an
 * install without plugins behaves as before.
 */
const plugins = await createPlugins({
  dir: dataPath('plugins'),
  // The plugins the repo ships, for the «Available» group and the Install
  // button: beside the bundle (`dist/../plugins`), or where IMAGINE_PLUGINS_SRC
  // says when the app is installed outside the source tree.
  repoDir: process.env.IMAGINE_PLUGINS_SRC?.trim() || join(programDir ?? join(dirname(fileURLToPath(import.meta.url)), '..'), 'plugins'),
  stateFile: dataPath('plugins-state.json'),
  host: {
    comfy,
    llm,
    auxiliary,
    model: () => now().defaultModel,
    mediaDir: outputDir,
    notify: (text, from, extra) => notices.notify(text, from, extra),
    onNotify: (handler, owner) => notices.onNotify(handler, owner),
    register: route => ctx.webServer.register(route),
  },
})
disposers.push(() => { plugins.dispose() })
await plugins.start()

/* ------------------------------------------------------------- host routes */


/**
 * Receive an action's cover and put it where the file service finds it before
 * the repo's one.
 *
 * The body is the file's bytes, not a form: the client sends what it read from
 * disk, so there is nothing to parse. The TYPE is decided by the content
 * (magic bytes), not by the declared extension: since 4-11-2026 a cover can be
 * a short video, and an `.mp4` must land on disk as `covers/<key>.mp4` — not
 * as a `.webp` that no browser plays.
 *
 * The old file with the same key goes away before the write: a key has a
 * single cover, and a video replaces the image (or vice versa) instead of
 * leaving two files competing for the name.
 * @param req - `POST /comfy-cover/<key>` with the file in the body.
 * @param res - 200 with extension and type, 400 if it is neither image nor
 *   video, 413 if it is over the cap.
 */
async function coverUploadRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!allowOnly(req, res, 'POST')) return
  const rest = restOf(req, res, '/comfy-cover')
  if (rest === undefined) return
  const key = coverKeyOf(rest)
  if (key === undefined) {
    sendJson(res, 400, { error: message('cover.invalidKey') })
    return
  }
  /*
   * The cap is checked while the bytes arrive, and reading goes on past it
   * (`readBody`): stopping the iteration destroys the socket, and the browser
   * reads "Failed to fetch" instead of the reason.
   */
  let body: Buffer
  try {
    body = await readBody(req, COVER_MAX_BYTES)
  } catch (error: unknown) {
    if (!(error instanceof HttpError) || error.status !== 413) throw error
    const max = String(COVER_MAX_BYTES / (1024 * 1024))
    sendJson(res, 413, { error: message('cover.tooLarge', { max }) })
    return
  }
  const stored = await storeCover(coversDir(), key, body)
  if (!stored.ok) {
    sendJson(res, stored.status, { error: stored.error })
    return
  }
  sendJson(res, 200, {
    ok: true,
    key,
    ext: stored.type.ext,
    kind: stored.type.kind,
    mime: stored.type.mime,
    bytes: stored.bytes,
  })
}


const exposedToNetwork = listensBeyondLoopback(listenOn.host)

const auth = createAuth({
  passwordFile: config.passwordFile,
  secretFile: config.secretFile,
  required: () => now().requireLogin,
  trustedProxies: config.trustedProxies,
})

const own: WebRoute[] = [
  { kind: 'exact', path: '/login', handler: (req, res) => auth.handleLogin(req, res) },
  { kind: 'exact', path: '/logout', handler: (req, res) => { auth.handleLogout(req, res) } },
  {
    kind: 'exact',
    path: '/api/models',
    handler: (_req, res) => { sendJson(res, 200, { models: now().models, default: now().defaultModel }) },
  },
  {
    kind: 'exact',
    path: '/api/host-settings',
    handler: methods({
      GET: (_req, res) => { sendJson(res, 200, settings.view()) },
      POST: async (req, res) => {
        const patch = await readObject<Parameters<typeof settings.save>[0]>(req)
        const loginWas = now().requireLogin
        try {
          const view = await settings.save(patch)
          /*
           * The login switch ended the situation in which the warning was
           * hidden (or started one): its dismissal is forgotten, and the
           * strip is back on every device the next time the studio is open.
           */
          await forgetDismissalWhenLoginMoves(accessBanner, loginWas, view.requireLogin)
            .catch((error: unknown) => { console.warn('[imagine] access-banner:', error) })
          applyModels()
          // A password change bumped the session generation: this browser gets
          // a cookie for the new one, every other browser gets a 401.
          await auth.renew(req, res)
          sendJson(res, 200, view)
        } catch (error: unknown) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  },
  {
    // The gateway's own list, so the page can offer what OmniRoute serves today.
    kind: 'exact',
    path: '/api/host-settings/catalog',
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, { ids: await listModels(GATEWAY_PROVIDER) })
      } catch (error: unknown) {
        sendJson(res, 502, { error: message('gateway.unreachable', { reason: error instanceof Error ? error.message : String(error) }) })
      }
    },
  },
  {
    /*
     * systemd's Restart=always, or the desktop app's own supervisor, brings the
     * process back; the reply goes out first.
     *
     * The stop is `shutdown()` and not a signal to ourselves: on Windows
     * `process.kill(pid, 'SIGTERM')` is `TerminateProcess`, which runs no
     * handler — the disposers, the port close and the job cancellations would
     * all be skipped, and the page would see a studio that vanished. Calling
     * the same graceful stop the signal runs on POSIX works everywhere.
     */
    kind: 'exact',
    path: '/api/restart',
    handler: methods({
      POST: (_req, res) => {
        sendJson(res, 200, { ok: true })
        setTimeout(shutdown, 300)
      },
    }),
  },
  { kind: 'exact', path: '/api/health', handler: (_req, res) => { sendJson(res, 200, { ok: true }) } },
  /*
   * What the page needs to warn the owner: a studio listening beyond loopback
   * with no password is open to the network. The desktop app is always on
   * 127.0.0.1, so it never sees the warning; `/api/access` itself needs no
   * login, or the page could not draw it before the form. With it come the two
   * routes that hide the warning for the whole studio and bring it back.
   */
  ...createAccessRoutes({
    banner: accessBanner,
    listenHost: listenOn.host,
    exposed: exposedToNetwork,
    loginRequired: () => now().requireLogin,
    passwordSet: () => settings.view().passwordSet,
  }),
  { kind: 'exact', path: '/api/trim', handler: createTrimRoute(outputDir) },
  { kind: 'exact', path: '/api/merge', handler: createMergeRoute(outputDir) },
  { kind: 'exact', path: '/api/add-audio', handler: createAddAudioRoute(outputDir) },
  { kind: 'exact', path: '/api/likes', handler: createLikesRoute(dataPath('comfy', 'likes.json'), outputDir) },
  { kind: 'exact', path: '/api/tags', handler: createTagsRoute(dataPath('comfy', 'tags.json'), outputDir) },
  { kind: 'exact', path: '/api/crop-copy', handler: createCropRoute(outputDir) },
  ...createSegmentsRoutes(ctx, outputDir),
  /*
   * Openjutsu and IOPaint (pages of the rail, and IOPaint's «Remove object»)
   * are plugins since 2026-11-15: plugins/openjutsu and plugins/iopaint mount
   * their app under /apps/<id> and IOPaint answers /plugin/iopaint/erase.
   */
  { kind: 'exact', path: '/api/duplicate', handler: createDuplicateRoute(outputDir) },
  { kind: 'exact', path: '/api/file-details', handler: createDetailsRoute(outputDir) },
  { kind: 'exact', path: '/api/media-search', handler: createMediaSearchRoute(outputDir) },
  /*
   * The language packs: JSON files in <data>/locales/<code>.json.
   *
   * Served from here and not bundled into the interface, because a pack is
   * added without recompiling: drop the file, reload the page, and it appears
   * in the language picker.
   */
  ...createLocalePacksRoutes(localePacks),

  /*
   * The cover the user chose for an action. The file goes to
   * `<data>/covers/<key>.<extension>` and from there the file service prefers
   * it to the repo's one: replacing a cover needs no commit. The list tells the
   * client whether to draw `<img>` or `<video>`, so it does not try the video
   * in vain on every card.
   */
  { kind: 'prefix', path: '/comfy-cover', handler: coverUploadRoute },
  {
    kind: 'exact',
    path: '/comfy-cover-info',
    handler: async (_req, res) => {
      sendJson(res, 200, { covers: await coverIndex(coversDir()) })
    },
  },
  /*
   * What a first run is missing: ComfyUI, ffmpeg, a model, a writable output
   * folder, this Node. The page draws one row per check, and each row says
   * the command that fixes it — before this it was a chat that did not answer.
   */
  {
    kind: 'exact',
    path: '/setup-status',
    handler: async (_req, res) => {
      const current = now()
      sendJson(res, 200, await liveSetupStatus({
        ...studioVersion === undefined ? {} : { version: studioVersion },
        comfy,
        comfyURL: comfy.composedConnection.baseURL,
        ...current.defaultModel === undefined ? {} : { model: current.defaultModel },
        providers: Object.keys(config.providers),
        outputDir,
      }))
    },
  },
  { kind: 'exact', path: '/api/extract-frame', handler: createFrameRoute(outputDir) },
  /*
   * The thinking levels the gateway declares for the model in force: the page
   * reads them from here instead of keeping its own list, so a new tier shows
   * up by itself. If the gateway does not answer, `fromGateway: false` is
   * returned and the page shows the fallback.
   */
  {
    kind: 'exact',
    path: '/api/thinking-levels',
    handler: async (_req, res) => {
      const route = now().defaultModel
      try {
        const levels = [...await thinkingLevels(route)]
        sendJson(res, 200, { model: route, levels, fromGateway: levels.length > 0 })
      } catch (error: unknown) {
        sendJson(res, 200, {
          model: route,
          levels: [],
          fromGateway: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  },
  /* The lists, the settings and the reload of the installed plugins. */
  createPluginsRoute(plugins),
]

/** Longest prefix first, so the most specific route wins without sorting per request. */
function byPrefixLength(a: WebRoute, b: WebRoute): number {
  return b.path.length - a.path.length
}
own.sort(byPrefixLength)

function match(table: readonly WebRoute[], path: string): WebRoute | undefined {
  const exact = table.find(route => route.kind === 'exact' && route.path === path)
  if (exact !== undefined) return exact
  return table.find(route => route.kind === 'prefix' && (path === route.path || path.startsWith(`${route.path}/`)))
}

/** Route one request; may throw, synchronously or not: the listener catches both. */
async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  applySecurityHeaders(res, path)
  /*
   * A state-changing request from a browser is accepted only from the studio's
   * own origin. Requests with no origin at all are not browsers (curl, the MCP
   * server, a plugin's webhook, the desktop window's loopback page) and pass.
   */
  if (!stateChangeAllowed(req)) {
    sendJson(res, 403, { error: message('security.crossSite') })
    return
  }
  if (path !== '/api/health' && !(await auth.guard(req, res, path))) return
  const route = match(own, path) ?? match(routes, path)
  if (route !== undefined) return route.handler(req, res)
  // An API path nobody serves is a 404, not the page: a GET of a mistyped or
  // removed route answered `index.html` with a 200 until 2026-10-25.
  const api = path === '/api' || path.startsWith('/api/')
  if (!api && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(config.webDir, req, res, path)
  sendJson(res, 404, { error: message('route.unknown', { method: req.method ?? '', path }) })
}

const server = createServer((req, res) => {
  let path = req.url ?? '/'
  // The page's language, for the messages the server composes (messages.ts).
  const language = languageOf(req)
  ;(res as ServerResponse & { language?: string }).language = language
  // Inside the promise: a handler that throws synchronously (a bad
  // `%`-escape in decodeURIComponent, say) is answered like any other failure
  // instead of escaping the listener as an uncaught exception.
  Promise.resolve().then(() => withLanguage(language, () => {
    path = new URL(req.url ?? '/', 'http://x').pathname
    return handle(req, res, path)
  })).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : error instanceof URIError || error instanceof TypeError && /Invalid URL/.test(error.message) ? 400 : 500
    if (status === 500) console.error(`[imagine] ${req.method ?? ''} ${path}:`, error)
    if (!res.headersSent) sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
    else res.end()
  })
})

server.requestTimeout = 0
/*
 * The desktop app reserves a free loopback port for its window and says so in
 * the environment: a studio started beside a service on 3090 (or behind the
 * app) must not collide with it.
 */
server.listen(listenOn.port, listenOn.host, () => {
  warmThumbnails(outputDir)
  console.log(`[imagine] listening on http://${listenOn.host}:${String(listenOn.port)}`)
})

const shutdown = (): void => {
  for (const dispose of disposers.splice(0).reverse()) {
    try { dispose() } catch { /* already closing */ }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

/*
 * Started by the desktop app (`IMAGINE_PARENT_PID`), the studio stops when the
 * window that owns it is gone, however it went: closing it is handled above,
 * a logout or a kill is not — on Linux the app's own process exits without
 * running its handlers, so the child is the one that has to notice.
 */
const parentPid = parentPidFrom()
if (parentPid !== undefined) watchParent(parentPid, shutdown)
/*
 * Windows has no SIGTERM to receive, and a console Ctrl+Break is the signal a
 * person or a launcher can still send: handled here so the disposers and the
 * thumbnail cuts stop the same way they do on POSIX.
 */
if (process.platform === 'win32') process.on('SIGBREAK', shutdown)
