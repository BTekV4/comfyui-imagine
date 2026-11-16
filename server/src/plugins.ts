/**
 * External plugins: a folder, a manifest and a module the host loads at boot.
 *
 * An installation that has no plugins behaves exactly as before — no route, no
 * section in the settings page, no timer — because everything here is created
 * from what is on disk. A folder under `<data>/plugins/<id>/` with a
 * `manifest.json` and an `entry` module becomes a plugin; deleting the folder
 * removes it at the next restart.
 *
 * The contract is deliberately small: a module exports a default `setup(ctx)`
 * and may return routes, a tick and a status. The host owns the timer (one for
 * every plugin), the route table and the config file; the plugin gets a context
 * with the studio's clients and a `config()` **function** — the values are read
 * at every call, so a save on the settings page reaches the next use without
 * reloading the module.
 *
 * A plugin is code running in this process, with this process's privileges:
 * the context is a contract, not a sandbox, and `docs/plugin-api.md` says so.
 * What the host does guarantee is that a broken plugin stays contained: an
 * import that throws, a `setup` that throws and a `tick` that throws are
 * recorded (or logged) and the other plugins — and the server — go on.
 * @module plugins
 */
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJsonFile, serialized, writeFileAtomic } from '../vendor/atomic-write/index.ts'
import type { ComfyUi } from '../vendor/comfyui/index.ts'
import type { StreamCapable, VisionCapable } from '../vendor/tool-comfy/imagine-models.ts'
import type { ModelRoute } from '../../shared/imagine-types.ts'
import type {
  PluginAction,
  PluginActionField,
  PluginAvailableView,
  PluginOption,
  PluginSettingKind,
  PluginSettingView,
  PluginStatusLineView,
  PluginStatusView,
  PluginText,
  PluginTone,
  PluginValue,
  PluginView,
} from '../../shared/plugin-types.ts'
import { message } from './messages.ts'
import { within, type NotifyExtra, type NotifyHandler } from './notify-bus.ts'
import { HttpError, notAllowed, readObject, restOf, sendJson } from './route-kit.ts'
import { fileStamp, setAside } from './set-aside.ts'
import type { Handler, WebRoute } from './host.ts'

/**
 * The version of this contract. A manifest naming another one is listed as
 * incompatible and not loaded: a plugin written for a newer host must not be
 * half-run.
 */
export const PLUGIN_API_VERSION = 1

/** How often the host ticks the plugins that ask for it. */
const TICK_MS = 30_000

/** How long a `status()` may take before the panel is told it did not answer. */
const STATUS_TIMEOUT_MS = 2_000

/** How many config copies to keep beside a plugin's config file. */
const KEPT_BACKUPS = 5

/** The longest a text or password setting may be, in characters. */
const MAX_VALUE_LENGTH = 4096

/** One field of a plugin's settings. */
export interface PluginSettingSpec {
  readonly key: string
  readonly kind: PluginSettingKind
  readonly label: PluginText
  readonly help?: PluginText
  readonly placeholder?: string
  readonly default?: string | boolean
  readonly options?: readonly PluginOption[]
}

/** What `manifest.json` says. */
export interface PluginManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly api: number
  readonly description?: PluginText
  /** A file name — `.mjs`: a plugin is an ES module. */
  readonly entry: string
  /** A short glyph for the card (an emoji, or a character or two). */
  readonly icon: string | null
  readonly settings: readonly PluginSettingSpec[]
  readonly actions: readonly PluginAction[]
}

/** The plugin's settings as they are now. */
export type PluginValues = Readonly<Record<string, PluginValue>>

/** One route a plugin registers; the path must sit under `/plugin/<id>/` (or `/apps/<id>`). */
export interface PluginRoute {
  readonly path: string
  readonly kind?: 'exact' | 'prefix'
  readonly handler: Handler
}

/**
 * One line about how the plugin is doing, for the panel.
 *
 * `summary` is the one line that fits beside the name; `lines` is for what does
 * not: the accounts, the tokens, whether the scheduler is on. A tone per line
 * lets the panel colour them without knowing what they mean.
 *
 * The texts are the plugin's own, and a plugin is code that runs everywhere:
 * each one may be written as a single string (one language) or as
 * `{ en, it }`, which the panel picks with the language in force.
 */
export interface PluginStatus {
  readonly ok: boolean
  readonly summary?: string | PluginText
  readonly detail?: string | PluginText
  readonly lines?: readonly PluginStatusLine[]
}

/** One of a plugin's status lines. */
export interface PluginStatusLine {
  readonly text: string | PluginText
  readonly tone?: PluginTone
}

/** What the host hands a plugin's `setup`. */
export interface PluginContext {
  /** {@link PLUGIN_API_VERSION}, so a module can refuse to run. */
  readonly api: number
  /** The folder name, which is the plugin's id. */
  readonly id: string
  /** The plugin's own folder, for the files it brings with it. */
  readonly dir: string
  /**
   * A path inside the plugin's folder.
   * @param name - a file name, relative to the plugin's folder.
   * @returns the absolute path.
   */
  dataPath(name: string): string
  /**
   * The settings as they are now. Call it where the value is used: the host
   * updates it on every save, so a plugin that reads it once at `setup` would
   * keep the values of that moment.
   */
  config(): PluginValues
  readonly llm: StreamCapable
  /** The vision client: the one a pass that has to look at a file uses. */
  readonly auxiliary: VisionCapable
  readonly comfy: ComfyUi
  /**
   * The model the studio's page names (one for every pass since 2026-10-31).
   * Read it where you use it, like `config()`: changing the model on the page
   * reaches the next call.
   */
  model(): ModelRoute
  /**
   * Register a cleanup, run when the plugin is reloaded or the host stops —
   * the counterpart of `ImagineHost.effect`, without handing over the host.
   * @param setup - runs now and returns what to call at the end.
   */
  effect(setup: () => (() => void) | void): void
  /** The folder the gallery serves. */
  readonly mediaDir: string
  /** One line in the host's log, prefixed with the plugin id. */
  log(message: string): void
  /**
   * Register a route under `/plugin/<id>/`, or `/apps/<id>` for a web app the
   * plugin passes through. A path outside them is refused, so a plugin cannot
   * take over the host's own routes.
   * @returns a function that removes the route.
   */
  registerRoute(route: PluginRoute): () => void
  /**
   * One notice to the owner: every plugin that subscribed hears it. Never throws.
   * `extra` may carry a picture (a local file or a public address); a listener
   * that cannot show it sends the text alone.
   */
  notify(text: string, extra?: NotifyExtra): Promise<void>
  /**
   * Subscribe to the host's notices (the publisher's alerts, and any plugin's).
   * Your own notices do not come back to you.
   * @param handler - what to do with one notice.
   * @returns the function that removes the subscription; it goes when the
   *   plugin is reloaded, exactly like its routes.
   */
  onNotify(handler: NotifyHandler): () => void
}

/** What `setup` may return; all of it optional. */
export interface PluginSetup {
  readonly routes?: readonly PluginRoute[]
  /** Called every 30 s; a tick that throws is logged and does not stop the others. */
  readonly tick?: (now: Date) => void | Promise<void>
  /** Asked when the panel loads; must be quick (2 s budget). */
  readonly status?: () => PluginStatus | Promise<PluginStatus>
}

/** The shape of a plugin module's default export. */
export type PluginSetupFunction = (ctx: PluginContext) => PluginSetup | void | Promise<PluginSetup | void>

/** What `createPlugins` needs from the host. */
export interface PluginsOptions {
  /** `<data>/plugins`; it may not exist. */
  readonly dir: string
  /**
   * Where the plugins the repository ships live (`plugins/`): the ones the page
   * offers to install. Absent leaves the «Available» group empty.
   */
  readonly repoDir?: string
  /**
   * `<data>/plugins-state.json`: which plugins are switched off. Outside the
   * plugin's own folder, so removing a plugin does not lose the choice to keep
   * it off next time.
   */
  readonly stateFile?: string
  readonly host: {
    readonly comfy: ComfyUi
    readonly llm: StreamCapable
    readonly auxiliary: VisionCapable
    /** The model the page names, read per call. */
    readonly model: () => ModelRoute
    readonly mediaDir: string
    /** The notice bus: `from` is the plugin sending, skipped among the listeners. */
    readonly notify: (text: string, from?: string, extra?: NotifyExtra) => Promise<void>
    readonly onNotify: (handler: NotifyHandler, owner?: string) => () => void
    readonly register: (route: WebRoute) => () => void
  }
  readonly tickMs?: number
  readonly statusTimeoutMs?: number
}

/** The plugins system, as `main.ts` uses it. */
export interface Plugins {
  /** Every plugin on disk, loaded or not. */
  list(): Promise<PluginView[]>
  /**
   * Merge a few settings and write them: `0600`, atomic, with a dated copy.
   * @param id - the plugin.
   * @param values - the settings to change; unknown keys are refused.
   * @returns the path of the copy, or null when there was no file to copy.
   */
  saveSettings(id: string, values: unknown): Promise<{ backup: string | null }>
  /** Re-read one plugin's manifest and module (development). */
  refresh(id: string): Promise<void>
  /** Re-read every installed plugin's manifest and module. */
  reloadAll(): Promise<void>
  /**
   * Bring the installed plugins up to the repository's copies (manifest and
   * entry, with a dated backup), as every start does; for `scripts/deploy.sh`.
   * @param options.tag - who asks, written in the backups' names.
   * @param options.reload - reload the updated plugins that are loaded; false
   *   when a restart follows and will load them anyway.
   * @returns the ids updated, those reloaded, those the repository ships
   *   with a manifest that does not hold up (left as installed), and the
   *   backups' suffix.
   */
  updateFromRepo(options: { tag: PluginUpdateTag; reload: boolean }): Promise<{
    updated: string[]; reloaded: string[]; invalid: string[]; backupSuffix: string
  }>
  /**
   * Switch a plugin on or off, and remember it in the state file.
   * @param id - the plugin.
   * @param enabled - whether it should be loaded.
   * @returns the view as it is afterwards.
   */
  setEnabled(id: string, enabled: boolean): Promise<PluginView>
  /**
   * Copy one of the repository's plugins into the data folder and load it.
   * @param id - the id, which must be one the repository ships.
   * @returns the view as it is afterwards.
   */
  install(id: string): Promise<PluginView>
  /**
   * Move an installed plugin's folder out of the way — never delete it.
   * @param id - the plugin.
   * @returns where the folder went.
   */
  remove(id: string): Promise<{ movedTo: string }>
  /** The repository's plugins that are not installed. */
  available(): Promise<PluginAvailableView[]>
  /** Load everything and start the timer if something asked for a tick. */
  start(): Promise<void>
  /** Remove every route and stop the timer. */
  dispose(): void
}

/** One plugin's state, as loaded. */
interface PluginRecord {
  readonly id: string
  manifest: PluginManifest | null
  compatible: boolean
  /** Switched on by the page; a disabled plugin is listed and not loaded. */
  enabled: boolean
  loaded: boolean
  error: string | null
  setup: PluginSetup | null
  /** The values as they are now; updated on save, so `config()` is live. */
  values: Record<string, PluginValue>
  /** Removes the routes this plugin registered. */
  disposers: (() => void)[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is PluginText =>
  isObject(value) && typeof value['en'] === 'string' && typeof value['it'] === 'string'

/**
 * A text a manifest or a plugin's status wrote, as both languages: `{ en, it }`
 * as it is, `{ en }` with the English standing in for the Italian, a non-empty
 * string for both.
 * @param value - what the plugin had.
 * @returns both languages, or undefined when there is no text.
 */
function textPair(value: unknown): PluginText | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : { en: value, it: value }
  if (isText(value)) return { en: value.en, it: value.it }
  if (isObject(value) && typeof value['en'] === 'string') return { en: value['en'], it: value['en'] }
  return undefined
}

/**
 * A manifest's text, with a fallback when the manifest said nothing.
 * @param value - what the manifest had.
 * @param fallback - the text to use when the manifest said nothing.
 * @returns both languages, always.
 */
function textOf(value: unknown, fallback: string): PluginText {
  return textPair(value) ?? { en: fallback, it: fallback }
}

/** Whether a string is a plugin id: lowercase letters, digits and dashes. */
function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[a-z0-9][a-z0-9-]*$/.test(value)
}

/**
 * Read and check a manifest.
 *
 * A manifest is checked field by field, and the first thing wrong is what the
 * panel says: a plugin that does not load must leave a reason, not a mystery.
 * @param raw - the parsed `manifest.json`.
 * @param folder - the folder name, which the manifest id must repeat.
 * @returns the manifest, or the reason it is not one.
 */
function readManifest(raw: unknown, folder: string): { manifest: PluginManifest } | { error: string } {
  if (!isObject(raw)) return { error: 'manifest.json: not a JSON object' }
  const id = raw['id']
  if (!isPluginId(id)) return { error: 'manifest.json: "id" must be lowercase letters, digits and dashes' }
  if (id !== folder) return { error: `manifest.json: "id" is "${id}" but the folder is "${folder}"` }
  if (typeof raw['api'] !== 'number' || !Number.isInteger(raw['api'])) return { error: 'manifest.json: "api" must be a number' }
  const entry = raw['entry']
  if (typeof entry !== 'string' || entry === '' || isAbsolute(entry) || entry.includes('..') || entry.includes('/') || entry.includes(sep)) {
    return { error: 'manifest.json: "entry" must be a file name inside the plugin folder' }
  }
  const version = raw['version']
  if (typeof version !== 'string' || version === '') return { error: 'manifest.json: "version" is needed' }
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
  const actions: PluginAction[] = []
  if (raw['actions'] !== undefined) {
    if (!Array.isArray(raw['actions'])) return { error: 'manifest.json: "actions" must be a list' }
    const seenActions = new Set<string>()
    for (const item of raw['actions']) {
      if (!isObject(item)) return { error: 'manifest.json: every action must be an object' }
      const key = item['key']
      if (typeof key !== 'string' || key === '') return { error: 'manifest.json: an action needs a "key"' }
      if (seenActions.has(key)) return { error: `manifest.json: action "${key}" is declared twice` }
      seenActions.add(key)
      const path = item['path']
      if (typeof path !== 'string' || !path.startsWith(`/plugin/${id}/`)) {
        return { error: `manifest.json: action "${key}" must call a path under /plugin/${id}/` }
      }
      const method = item['method'] === undefined ? 'POST' : item['method']
      if (method !== 'POST' && method !== 'GET') {
        return { error: `manifest.json: action "${key}" has an unknown method` }
      }
      const fields: PluginActionField[] = []
      if (item['fields'] !== undefined) {
        if (method === 'GET') return { error: `manifest.json: action "${key}" is a GET and cannot have fields` }
        if (!Array.isArray(item['fields'])) return { error: `manifest.json: action "${key}" has fields that are not a list` }
        for (const field of item['fields']) {
          if (!isObject(field) || typeof field['key'] !== 'string' || field['key'] === '') {
            return { error: `manifest.json: action "${key}" has a field without a key` }
          }
          if (field['kind'] !== 'text' && field['kind'] !== 'password') {
            return { error: `manifest.json: action "${key}" field "${field['key']}" has an unknown kind` }
          }
          fields.push({
            key: field['key'],
            kind: field['kind'],
            label: textOf(field['label'], field['key']),
            ...typeof field['placeholder'] === 'string' ? { placeholder: field['placeholder'] } : {},
          })
        }
      }
      actions.push({
        key,
        label: textOf(item['label'], key),
        method,
        path,
        ...fields.length === 0 ? {} : { fields },
      })
    }
  }
  const settings: PluginSettingSpec[] = []
  if (raw['settings'] !== undefined) {
    if (!Array.isArray(raw['settings'])) return { error: 'manifest.json: "settings" must be a list' }
    const seen = new Set<string>()
    for (const item of raw['settings']) {
      if (!isObject(item)) return { error: 'manifest.json: every setting must be an object' }
      const key = item['key']
      if (typeof key !== 'string' || key === '' || key.includes('.')) return { error: 'manifest.json: a setting needs a "key" without dots' }
      if (seen.has(key)) return { error: `manifest.json: setting "${key}" is declared twice` }
      seen.add(key)
      const kind = item['kind']
      if (kind !== 'text' && kind !== 'password' && kind !== 'toggle' && kind !== 'select') {
        return { error: `manifest.json: setting "${key}" has an unknown kind` }
      }
      const options: PluginOption[] = []
      if (kind === 'select') {
        if (!Array.isArray(item['options']) || item['options'].length === 0) return { error: `manifest.json: setting "${key}" needs options` }
        for (const option of item['options']) {
          if (!isObject(option) || typeof option['value'] !== 'string') return { error: `manifest.json: setting "${key}" has an option without a value` }
          options.push({ value: option['value'], label: textOf(option['label'], option['value']) })
        }
      }
      settings.push({
        key,
        kind,
        label: textOf(item['label'], key),
        ...item['help'] === undefined ? {} : { help: textOf(item['help'], '') },
        ...typeof item['placeholder'] === 'string' ? { placeholder: item['placeholder'] } : {},
        ...item['default'] === undefined ? {} : { default: item['default'] as string | boolean },
        ...kind === 'select' ? { options } : {},
      })
    }
  }
  return {
    manifest: {
      id,
      name,
      version,
      api: raw['api'],
      ...raw['description'] === undefined ? {} : { description: textOf(raw['description'], '') },
      entry,
      // A short string: an emoji or one or two characters. Longer is not an icon.
      icon: typeof raw['icon'] === 'string' && raw['icon'].trim() !== '' ? Array.from(raw['icon'].trim()).slice(0, 4).join('') : null,
      settings,
      actions,
    },
  }
}

/** The default of a setting, or undefined when it has none. */
function defaultOf(spec: PluginSettingSpec): PluginValue | undefined {
  if (spec.default === undefined) return undefined
  if (spec.kind === 'toggle') return typeof spec.default === 'boolean' ? spec.default : undefined
  return typeof spec.default === 'string' ? spec.default : undefined
}

/**
 * The value of a setting nobody has filled in yet.
 *
 * A select starts on its first option: an empty string would be a value no
 * option has, and the page would show a blank choice that cannot be saved back.
 */
function emptyOf(spec: PluginSettingSpec): PluginValue {
  if (spec.kind === 'toggle') return false
  if (spec.kind === 'select') return spec.options?.[0]?.value ?? ''
  return ''
}

/** One value checked against its setting; throws an `Error` with a readable reason. */
function checkValue(spec: PluginSettingSpec, value: unknown): PluginValue {
  if (spec.kind === 'toggle') {
    if (typeof value !== 'boolean') throw new Error(message('plugin.badToggle', { key: spec.key }))
    return value
  }
  if (typeof value !== 'string') throw new Error(message('plugin.badText', { key: spec.key }))
  if (value.length > MAX_VALUE_LENGTH) throw new Error(message('plugin.tooLong', { key: spec.key, max: MAX_VALUE_LENGTH }))
  if (spec.kind === 'select') {
    const allowed = (spec.options ?? []).map(option => option.value)
    if (!allowed.includes(value)) throw new Error(message('plugin.badSelect', { key: spec.key, values: allowed.join(', ') }))
  }
  return value
}

/** A plugin's config file. */
const configPathOf = (dir: string, id: string): string => join(dir, id, 'config.json')

/** Drop all but the newest {@link KEPT_BACKUPS} copies of one config file, best effort. */
async function pruneBackups(file: string): Promise<void> {
  const name = basename(file)
  const dir = dirname(file)
  try {
    const names = (await readdir(dir)).filter(entry => entry.startsWith(`${name}.bak-`)).sort()
    for (const old of names.slice(0, Math.max(0, names.length - KEPT_BACKUPS))) {
      await unlink(join(dir, old)).catch(() => undefined)
    }
  } catch {
    // Leaving the copies where they are costs disk, not correctness.
  }
}

/**
 * The plugin folders under a directory, sorted.
 * @param dir - `<data>/plugins` or the repository's `plugins/`.
 * @returns the folder names; an empty list when the directory is not there.
 */
async function readFolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort()
  } catch {
    return []
  }
}

/**
 * A plugin the repository ships, read from its folder.
 * @param repoDir - the repository's `plugins/`.
 * @param id - the id the client asked for.
 * @returns its folder and manifest, or undefined when the repository has no
 *   such plugin (or it is not a valid one: the id is a folder name here).
 */
async function availableSource(repoDir: string, id: string): Promise<{ dir: string; manifest: PluginManifest } | undefined> {
  if (!isPluginId(id)) return undefined
  const dir = join(repoDir, id)
  const read = readManifest(await readJsonFile(join(dir, 'manifest.json')), id)
  if ('error' in read) return undefined
  const entry = join(dir, read.manifest.entry)
  if (!await stat(entry).then(info => info.isFile(), () => false)) return undefined
  return { dir, manifest: read.manifest }
}

/**
 * The repository's plugins that are not installed.
 * @param repoDir - the repository's `plugins/`.
 * @param installed - the ids already in the data folder.
 * @returns one entry per installable plugin, by id.
 */
async function availableIn(repoDir: string, installed: ReadonlySet<string>): Promise<PluginAvailableView[]> {
  const found: PluginAvailableView[] = []
  for (const folder of await readFolders(repoDir)) {
    if (installed.has(folder)) continue
    const source = await availableSource(repoDir, folder)
    if (source === undefined) continue
    found.push({
      id: source.manifest.id,
      name: source.manifest.name,
      version: source.manifest.version,
      api: source.manifest.api,
      ...source.manifest.description === undefined ? {} : { description: source.manifest.description },
      icon: source.manifest.icon,
      compatible: source.manifest.api === PLUGIN_API_VERSION,
    })
  }
  return found
}

/**
 * Who replaced an installed plugin's files, written in the backup's name
 * (`.bak-<time>-<tag>`): the server at start, or `scripts/deploy.sh`.
 */
export type PluginUpdateTag = 'update' | 'deploy'

/**
 * Bring one installed plugin up to the repository's copy.
 *
 * Installing copies `manifest.json` and the entry into `<data>/plugins/<id>/`,
 * so after a `git pull` and a build the installed copy was the old one until
 * somebody pressed Install again — nothing told a new user to (2026-11-15).
 * The two files are compared with the repository's and the ones that changed
 * are replaced atomically (a plugin loading meanwhile never reads half a
 * file), keeping the old file beside it (`.bak-<stamp>-<tag>`). `config.json`
 * and the plugin's other files are never touched. A plugin the repository
 * does not ship, or ships unbuilt, is left as it is.
 *
 * The only copy of this logic: `scripts/deploy.sh` asks the running server
 * for it (`POST /comfy-plugins/update`) instead of copying files itself, as it
 * did until 2026-11-15 with a shell version that had already drifted.
 * @param dir - `<data>/plugins`.
 * @param repoDir - the repository's `plugins/`.
 * @param id - the installed plugin's folder.
 * @param stamp - the time written in the backups' names, one per run.
 * @param tag - who is updating.
 * @returns `updated` when a file was replaced, `unchanged`, `invalid` when the
 *   repository has the plugin with a manifest that does not hold up (no valid
 *   or no built entry), `absent` when it does not ship it.
 */
async function updateOneFromRepo(
  dir: string, repoDir: string, id: string, stamp: string, tag: PluginUpdateTag,
): Promise<'updated' | 'unchanged' | 'invalid' | 'absent'> {
  const source = await availableSource(repoDir, id)
  if (source === undefined) {
    const shipped = await stat(join(repoDir, id, 'manifest.json')).then(info => info.isFile(), () => false)
    return shipped ? 'invalid' : 'absent'
  }
  let changed = false
  for (const name of ['manifest.json', source.manifest.entry]) {
    const fresh = await readFile(join(source.dir, name)).catch(() => undefined)
    if (fresh === undefined) continue
    const target = join(dir, id, name)
    const old = await readFile(target).catch(() => undefined)
    if (old !== undefined && old.equals(fresh)) continue
    if (old !== undefined) await copyFile(target, `${target}.bak-${stamp}-${tag}`)
    await writeFileAtomic(target, fresh, { mode: 0o644 })
    changed = true
  }
  if (changed) console.log(`[plugin:${id}] updated from the repository's copy (${tag})`)
  return changed ? 'updated' : 'unchanged'
}

/**
 * Create the plugins system.
 *
 * Nothing is read until {@link Plugins.start}, so constructing it from
 * `main.ts` costs nothing and an installation with no folder has an empty list.
 * @param options - the folder, the host half the plugins may use, the timings.
 * @returns the system.
 */
export async function createPlugins(options: PluginsOptions): Promise<Plugins> {
  const tickMs = options.tickMs ?? TICK_MS
  const statusTimeoutMs = options.statusTimeoutMs ?? STATUS_TIMEOUT_MS
  const records = new Map<string, PluginRecord>()
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  /*
   * The on/off switches live in `<data>/plugins-state.json`, not in the
   * plugin's folder: uninstalling must not take away the choice of keeping it
   * off, and a plugin's folder is its own.
   */
  const disabled = new Set<string>()
  const stateFile = options.stateFile
  const readState = async (): Promise<void> => {
    disabled.clear()
    if (stateFile === undefined) return
    const raw = await readJsonFile(stateFile)
    const list = isObject(raw) && Array.isArray(raw['disabled']) ? raw['disabled'] : []
    for (const id of list) if (isPluginId(id)) disabled.add(id)
  }
  const writeState = async (): Promise<void> => {
    if (stateFile === undefined) return
    await writeFileAtomic(stateFile, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`, { mode: 0o644 })
  }
  const isEnabled = (id: string): boolean => !disabled.has(id)

  /** The values a plugin has now: what is on disk, checked, plus the defaults. */
  const valuesOf = async (manifest: PluginManifest): Promise<Record<string, PluginValue>> => {
    const stored = await readJsonFile(configPathOf(options.dir, manifest.id))
    const raw = isObject(stored) ? stored : {}
    const values: Record<string, PluginValue> = {}
    for (const spec of manifest.settings) {
      const value = raw[spec.key]
      try {
        values[spec.key] = value === undefined ? defaultOf(spec) ?? emptyOf(spec) : checkValue(spec, value)
      } catch {
        // A saved value that no longer passes the check is not shown: it counts
        // as the default, and the next write puts it back in line.
        values[spec.key] = defaultOf(spec) ?? emptyOf(spec)
      }
    }
    return values
  }

  /** The context one plugin is set up with. */
  const contextOf = (record: PluginRecord, disposers: (() => void)[]): PluginContext => {
    const manifest = record.manifest as PluginManifest
    const prefix = `/plugin/${manifest.id}/`
    /*
     * `/apps/<id>` too (2026-11-15): a plugin that passes a web app through
     * (Openjutsu, IOPaint) mounts it there, because the app is built for that
     * path and moving it would mean rebuilding the app. Still its own
     * namespace: no plugin can take another's, or the host's.
     */
    const appMount = `/apps/${manifest.id}`
    const register = (route: PluginRoute): (() => void) => {
      const path = route.path
      if (typeof path !== 'string' || !(path.startsWith(prefix) || path === appMount || path.startsWith(`${appMount}/`))) {
        throw new Error(`route "${String(path)}" is outside ${prefix} and ${appMount}`)
      }
      if (route.kind !== undefined && route.kind !== 'exact' && route.kind !== 'prefix') {
        throw new Error(`route "${path}" has an unknown kind`)
      }
      if (typeof route.handler !== 'function') throw new Error(`route "${path}" has no handler`)
      const dispose = options.host.register({ kind: route.kind ?? 'exact', path, handler: route.handler })
      disposers.push(dispose)
      return dispose
    }
    const dir = join(options.dir, manifest.id)
    return {
      api: PLUGIN_API_VERSION,
      id: manifest.id,
      dir,
      dataPath(name: string) {
        const target = resolve(dir, name)
        if (target !== resolve(dir) && !target.startsWith(`${resolve(dir)}${sep}`)) {
          throw new Error(`dataPath("${name}") escapes the plugin folder`)
        }
        return target
      },
      // Live: the record's values are replaced on every save.
      config: () => record.values,
      llm: options.host.llm,
      auxiliary: options.host.auxiliary,
      comfy: options.host.comfy,
      model: () => options.host.model(),
      effect: (setup) => {
        const dispose = setup()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      mediaDir: options.host.mediaDir,
      log: (line: string) => { console.log(`[plugin:${manifest.id}] ${line}`) },
      registerRoute: register,
      notify: (text: string, extra?: NotifyExtra) => options.host.notify(text, manifest.id, extra),
      onNotify: (handler: NotifyHandler) => {
        const dispose = options.host.onNotify(handler, manifest.id)
        disposers.push(dispose)
        return dispose
      },
    }
  }

  /**
   * Load one folder.
   *
   * Every failure is written on the record and nothing is thrown: a broken
   * plugin is a line in the panel, not a server that does not boot.
   * @param folder - the folder name, which must match the manifest id.
   */
  const loadOne = async (folder: string): Promise<PluginRecord> => {
    const record: PluginRecord = {
      id: folder,
      manifest: null,
      compatible: false,
      enabled: isEnabled(folder),
      loaded: false,
      error: null,
      setup: null,
      values: {},
      disposers: [],
    }
    const dir = join(options.dir, folder)
    const read = readManifest(await readJsonFile(join(dir, 'manifest.json')), folder)
    if ('error' in read) {
      record.error = read.error
      console.warn(`[plugin:${folder}] ${read.error}`)
      return record
    }
    record.manifest = read.manifest
    if (read.manifest.api !== PLUGIN_API_VERSION) {
      console.warn(`[plugin:${folder}] manifest speaks API ${String(read.manifest.api)}, this host speaks ${String(PLUGIN_API_VERSION)}: not loaded`)
      return record
    }
    record.compatible = true
    if (!record.enabled) {
      // Switched off from the page: it is listed (name, description, fields)
      // and not loaded — no routes, no tick, no bus subscriptions.
      record.values = await valuesOf(read.manifest)
      return record
    }
    const entry = join(dir, read.manifest.entry)
    if (!await stat(entry).then(info => info.isFile(), () => false)) {
      record.error = `entry "${read.manifest.entry}" is not a file in the plugin folder`
      console.warn(`[plugin:${folder}] ${record.error}`)
      return record
    }
    let module: { default?: unknown }
    try {
      // The query makes every load a fresh module: without it `refresh` would
      // get the cached one and an edit would seem to do nothing.
      module = await import(`${pathToFileURL(entry).href}?v=${String(Date.now())}`) as { default?: unknown }
    } catch (error: unknown) {
      record.error = `import failed: ${error instanceof Error ? error.message : String(error)}`
      console.warn(`[plugin:${folder}] ${record.error}`)
      return record
    }
    if (typeof module.default !== 'function') {
      record.error = 'the module has no default export function'
      console.warn(`[plugin:${folder}] ${record.error}`)
      return record
    }
    const disposers: (() => void)[] = []
    record.values = await valuesOf(read.manifest)
    const ctx = contextOf(record, disposers)
    try {
      const setup = (module.default as PluginSetupFunction)(ctx)
      const result = setup instanceof Promise ? await setup : setup
      if (result !== undefined && result !== null && !isObject(result)) {
        throw new Error('setup returned neither undefined nor an object')
      }
      const setupResult = (result ?? {}) as PluginSetup
      for (const route of setupResult.routes ?? []) ctx.registerRoute(route)
      record.setup = setupResult
      record.loaded = true
      record.disposers = disposers
      return record
    } catch (error: unknown) {
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch { /* half-registered routes still go */ }
      }
      record.error = `setup threw: ${error instanceof Error ? error.message : String(error)}`
      console.warn(`[plugin:${folder}] ${record.error}`)
      return record
    }
  }

  /** One timer for every plugin that asked for a tick. */
  const syncTimer = (): void => {
    if (disposed) return
    const ticking = [...records.values()].some(record => record.loaded && typeof record.setup?.tick === 'function')
    if (!ticking) {
      if (timer !== undefined) { clearInterval(timer); timer = undefined }
      return
    }
    if (timer !== undefined) return
    // One unref'd timer: a tick with nothing to do must not keep the process up.
    // The records are read at every tick, not captured here: a `refresh`
    // replaces the record, and a captured list would keep ticking the old one —
    // which has no setup any more, so the plugin would go quiet until restart.
    timer = setInterval(() => {
      const nowDate = new Date()
      for (const record of records.values()) {
        if (!record.loaded || typeof record.setup?.tick !== 'function') continue
        try {
          void Promise.resolve(record.setup.tick(nowDate)).catch((error: unknown) => {
            console.warn(`[plugin:${record.id}] tick failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        } catch (error: unknown) {
          console.warn(`[plugin:${record.id}] tick failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }, tickMs)
    timer.unref()
  }

  /** Drop one plugin: routes first, so a refresh cannot leave two of them. */
  const unload = (record: PluginRecord): void => {
    for (const dispose of record.disposers.splice(0).reverse()) {
      try { dispose() } catch { /* already gone */ }
    }
    record.setup = null
    record.loaded = false
  }

  /** The view of one plugin, status included. */
  const viewOf = async (record: PluginRecord): Promise<PluginView> => {
    const manifest = record.manifest
    const settings: PluginSettingView[] = (manifest?.settings ?? []).map((spec) => ({
      key: spec.key,
      kind: spec.kind,
      label: spec.label,
      ...spec.help === undefined ? {} : { help: spec.help },
      ...spec.placeholder === undefined ? {} : { placeholder: spec.placeholder },
      ...spec.options === undefined ? {} : { options: spec.options },
      ...spec.kind === 'password'
        ? { value: null, isSet: typeof record.values[spec.key] === 'string' && record.values[spec.key] !== '' }
        : { value: record.values[spec.key] ?? emptyOf(spec) },
    }))
    let status: PluginStatusView | null = null
    if (record.loaded && typeof record.setup?.status === 'function') {
      try {
        const answer = await within(record.setup.status(), statusTimeoutMs)
        if (answer === undefined) {
          const why = message('plugin.statusTimeout', { seconds: Math.round(statusTimeoutMs / 1000) })
          status = { ok: false, detail: { en: why, it: why } }
        } else if (!isObject(answer)) {
          status = { ok: false, detail: { en: 'status() did not return an object', it: 'status() did not return an object' } }
        } else {
          const lines: PluginStatusLineView[] = Array.isArray(answer.lines)
            ? answer.lines
              .map((line): PluginStatusLineView | undefined => {
                if (!isObject(line)) return undefined
                const text = textPair(line['text'])
                if (text === undefined) return undefined
                const tone = line['tone']
                return {
                  text,
                  ...tone === 'ok' || tone === 'warn' || tone === 'bad' || tone === 'muted' ? { tone } : {},
                }
              })
              .filter((line): line is PluginStatusLineView => line !== undefined)
              .slice(0, 12)
            : []
          const summary = textPair(answer.summary)
          const detail = textPair(answer.detail)
          status = {
            ok: answer.ok === true,
            ...summary === undefined ? {} : { summary },
            ...detail === undefined ? {} : { detail },
            ...lines.length === 0 ? {} : { lines },
          }
        }
      } catch (error: unknown) {
        const why = error instanceof Error ? error.message : String(error)
        status = { ok: false, detail: { en: why, it: why } }
      }
    }
    const manifestFile = join(options.dir, record.id, 'manifest.json')
    return {
      id: record.id,
      name: manifest?.name ?? record.id,
      version: manifest?.version ?? '',
      api: manifest?.api ?? 0,
      ...manifest?.description === undefined ? {} : { description: manifest.description },
      icon: manifest?.icon ?? null,
      compatible: record.compatible,
      installed: true,
      enabled: record.enabled,
      loaded: record.loaded,
      error: record.error,
      installedAt: await stat(manifestFile).then(info => info.mtime.toISOString(), () => null),
      dir: join(options.dir, record.id),
      settings,
      actions: manifest?.actions ?? [],
      status,
    }
  }

  /** Load (or reload) one folder and put it in the map; the caller holds its queue. */
  const reloadNow = async (id: string): Promise<PluginRecord> => {
    const previous = records.get(id)
    if (previous !== undefined) unload(previous)
    const record = await loadOne(id)
    records.set(id, record)
    syncTimer()
    return record
  }

  /*
   * One queue per plugin for everything that loads, unloads or writes it: two
   * Installs from a double click, or a save beside a reload, would otherwise
   * both load the module — the second without unloading the first, which kept
   * its routes and its `onNotify` (Telegram would send every notice twice).
   * The calls below never queue from inside a queued one.
   */
  const queued = <T>(id: string, work: () => Promise<T>): Promise<T> => serialized(join(options.dir, id), work)

  return {
    async start() {
      if (disposed) return
      await readState()
      if (options.repoDir !== undefined) {
        const stamp = fileStamp()
        for (const id of await readFolders(options.dir)) await updateOneFromRepo(options.dir, options.repoDir, id, stamp, 'update')
      }
      // A folder that is not there means an installation with no plugins.
      const folders = await readFolders(options.dir)
      for (const folder of folders) {
        const record = await loadOne(folder)
        records.set(record.id, record)
      }
      syncTimer()
    },
    async list() {
      // In parallel: each status has its own 2 s budget, and in a row they added up.
      const sorted = [...records.values()].sort((a, b) => a.id.localeCompare(b.id))
      return await Promise.all(sorted.map(viewOf))
    },
    saveSettings: (id, values) => queued(id, async () => {
      const record = records.get(id)
      if (record === undefined) throw new Error(message('plugin.unknown', { id }))
      const manifest = record.manifest
      if (manifest === null) throw new Error(message('plugin.notLoaded', { id, reason: record.error ?? '' }))
      if (!isObject(values)) throw new Error(message('plugin.valuesObject'))
      const specs = new Map(manifest.settings.map(spec => [spec.key, spec]))
      const next: Record<string, PluginValue> = {}
      for (const [key, value] of Object.entries(values)) {
        const spec = specs.get(key)
        if (spec === undefined) throw new Error(message('plugin.unknownKey', { plugin: id, key }))
        next[key] = checkValue(spec, value)
      }
      const file = configPathOf(options.dir, id)
      const exists = await stat(file).then(info => info.isFile(), () => false)
      /*
       * A file that is not JSON any more is not a reason to refuse every save
       * (it answered 400 on each one): its values already counted as the
       * defaults (`valuesOf`), it is kept as the dated copy below, and the
       * write puts a readable file back.
       */
      const stored = exists ? await readJsonFile(file, `[plugin:${id}] config`) : undefined
      const merged: Record<string, unknown> = { ...isObject(stored) ? stored : {}, ...next }
      // The random suffix keeps two saves in the same millisecond from making
      // two copies with the same name: the second would erase the first, and
      // the count of copies to keep would drop by itself.
      const backup = exists ? `${file}.bak-${fileStamp()}-${randomBytes(2).toString('hex')}` : null
      if (backup !== null) await copyFile(file, backup)
      // writeFileAtomic creates the folder itself.
      await writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
      if (backup !== null) await pruneBackups(file)
      record.values = { ...record.values, ...next }
      return { backup }
    }),
    refresh: id => queued(id, async () => {
      if (!records.has(id)) throw new Error(message('plugin.unknown', { id }))
      await reloadNow(id)
    }),
    async updateFromRepo({ tag, reload }) {
      const stamp = fileStamp()
      const updated: string[] = []
      const reloaded: string[] = []
      const invalid: string[] = []
      const backupSuffix = `.bak-${stamp}-${tag}`
      if (options.repoDir === undefined) return { updated, reloaded, invalid, backupSuffix }
      const repoDir = options.repoDir
      for (const id of await readFolders(options.dir)) {
        // In the plugin's queue: a refresh or an install of the same plugin
        // must not read its files while they are being replaced.
        await queued(id, async () => {
          const outcome = await updateOneFromRepo(options.dir, repoDir, id, stamp, tag)
          if (outcome === 'invalid') invalid.push(id)
          if (outcome !== 'updated') return
          updated.push(id)
          if (reload && records.has(id)) {
            await reloadNow(id)
            reloaded.push(id)
          }
        })
      }
      return { updated, reloaded, invalid, backupSuffix }
    },
    async reloadAll() {
      // Re-read the disk, not just the modules: a plugin copied by hand
      // appears, one whose folder is gone leaves the list.
      const folders = await readFolders(options.dir)
      for (const id of [...records.keys()]) {
        if (folders.includes(id)) continue
        unload(records.get(id) as PluginRecord)
        records.delete(id)
      }
      for (const folder of folders) await queued(folder, () => reloadNow(folder))
      syncTimer()
    },
    setEnabled: (id, enabled) => queued(id, async () => {
      if (!records.has(id)) throw new Error(message('plugin.unknown', { id }))
      if (enabled) disabled.delete(id)
      else disabled.add(id)
      await writeState()
      return await viewOf(await reloadNow(id))
    }),
    install: id => queued(id, async () => {
      // The id must be one of the repo's plugins: no paths from the client.
      const source = options.repoDir === undefined ? undefined : await availableSource(options.repoDir, id)
      if (source === undefined) throw new Error(message('plugin.notInRepo', { id }))
      if (source.manifest.api !== PLUGIN_API_VERSION) {
        throw new Error(message('plugin.incompatible', { id, api: source.manifest.api, expected: PLUGIN_API_VERSION }))
      }
      const folder = join(options.dir, id)
      await mkdir(folder, { recursive: true })
      await copyFile(join(source.dir, 'manifest.json'), join(folder, 'manifest.json'))
      await copyFile(join(source.dir, source.manifest.entry), join(folder, source.manifest.entry))
      // Already installed (a second click, or Install over an old copy): the
      // loaded module goes first, routes and subscriptions with it.
      return await viewOf(await reloadNow(id))
    }),
    remove: id => queued(id, async () => {
      const record = records.get(id)
      if (record === undefined) throw new Error(message('plugin.unknown', { id }))
      unload(record)
      records.delete(id)
      syncTimer()
      // Never delete: the folder goes to `<data>/plugins-rimossi/<id>-<date>`.
      const movedTo = await setAside(join(options.dir, id), join(dirname(options.dir), 'plugins-rimossi'), id)
      if (disabled.delete(id)) await writeState()
      return { movedTo }
    }),
    async available() {
      if (options.repoDir === undefined) return []
      return await availableIn(options.repoDir, new Set(records.keys()))
    },
    dispose() {
      disposed = true
      if (timer !== undefined) { clearInterval(timer); timer = undefined }
      for (const record of records.values()) unload(record)
    },
  }
}

/**
 * One command of the `/comfy-plugins` routes: a POST that answers
 * `{ ok: true, ...what it returns }`.
 */
type PluginCommand = (req: IncomingMessage, id: string) => Promise<Record<string, unknown>>

/**
 * The `/comfy-plugins` routes, as one prefix: the list, the commands on the
 * whole list (`reload`, `install`, `update`) and those on one plugin
 * (`<id>/enabled|remove|settings|refresh`).
 *
 * One prefix route and not three, because the host's table matches a prefix
 * against the path itself and everything under it — three entries would be
 * three chances to leave one out. The commands are a table, with one answer
 * for a failure: the status an `HttpError` carries (a body past the limit is
 * a 413, not a 400), else 400 — or 500 for the reload and the update, which
 * fail on the disk rather than on their input.
 * @param plugins - the loaded system.
 * @returns the route to register on the host.
 */
export function createPluginsRoute(plugins: Plugins): WebRoute {
  // Maps, not objects: a path segment such as `constructor` must not find a
  // method of Object.prototype.
  const LIST = new Map<string, { readonly run: PluginCommand; readonly failure: number }>(Object.entries({
    // Re-read all the manifests and modules: the page's «Reload» button.
    reload: { run: async () => { await plugins.reloadAll(); return {} }, failure: 500 },
    // Copy the repository's manifest and entry over the installed ones: scripts/deploy.sh.
    update: {
      run: async (req) => {
        const body = await readObject<{ tag?: unknown; reload?: unknown }>(req, 16 * 1024)
        return await plugins.updateFromRepo({ tag: body.tag === 'deploy' ? 'deploy' : 'update', reload: body.reload !== false })
      },
      failure: 500,
    },
    install: {
      run: async (req) => {
        const body = await readObject<{ id?: unknown }>(req, 64 * 1024)
        if (typeof body.id !== 'string') throw new Error(message('plugin.notInRepo', { id: String(body.id) }))
        return { plugin: await plugins.install(body.id) }
      },
      failure: 400,
    },
  } satisfies Record<string, { readonly run: PluginCommand; readonly failure: number }>))
  const ONE = new Map<string, PluginCommand>(Object.entries({
    enabled: async (req, id) => {
      const body = await readObject<{ enabled?: unknown }>(req, 16 * 1024)
      if (typeof body.enabled !== 'boolean') throw new Error(message('plugin.badToggle', { key: 'enabled' }))
      return { plugin: await plugins.setEnabled(id, body.enabled) }
    },
    remove: async (_req, id) => ({ movedTo: (await plugins.remove(id)).movedTo }),
    settings: async (req, id) => {
      const body = await readObject<{ values?: unknown }>(req, 64 * 1024)
      return { backup: (await plugins.saveSettings(id, body.values)).backup }
    },
    refresh: async (_req, id) => { await plugins.refresh(id); return {} },
  } satisfies Record<string, PluginCommand>))
  return {
    kind: 'prefix',
    path: '/comfy-plugins',
    handler: async (req, res) => {
      const rest = restOf(req, res, '/comfy-plugins')
      if (rest === undefined) return
      if (rest === '') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          notAllowed(res, 'GET')
          return
        }
        // In a single read: the page draws the three lists together. The two
        // halves side by side: the list can take the 2 s status budget.
        const [list, available] = await Promise.all([plugins.list(), plugins.available()])
        sendJson(res, 200, { plugins: list, available })
        return
      }
      const [id = '', action = ''] = rest.split('/')
      const one = ONE.get(action)
      // A list command has no second segment: `/comfy-plugins/update/refresh`
      // is the refresh of a plugin called "update", not the update.
      const command = (action === '' ? LIST.get(id) : undefined) ?? (one === undefined ? undefined : { run: one, failure: 400 })
      if (command === undefined) {
        sendJson(res, 404, { error: message('route.unknown', { method: req.method ?? '', path: `/comfy-plugins/${rest}` }) })
        return
      }
      if (req.method !== 'POST') {
        notAllowed(res, 'POST')
        return
      }
      try {
        sendJson(res, 200, { ok: true, ...await command.run(req, id) })
      } catch (error: unknown) {
        const status = error instanceof HttpError ? error.status : command.failure
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
