/**
 * The language packs: which are installed, which the repository ships, and the
 * two commands that add and remove them.
 *
 * Since 6/11/2026 English is the **compiled** language: it lives in
 * `web/vendor-imagine/client/locales.ts`, is always available and is not a
 * pack, so it cannot be removed. Every other language is a flat JSON of keys
 * and texts — the same shape as the English dictionary — and lives in two places:
 *
 * - `<data>/locales/<code>.json`: what is **installed**, read by the client
 *   with `GET /comfy-locales/<code>`;
 * - `locales/<code>.json` in the repository: the **source** the page offers
 *   for installation (copied next to the installed program on deploy, like the
 *   plugins).
 *
 * Only the host side is here: read, list, copy, move. Choosing the language
 * and falling back to English happen in the client.
 */
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { message } from './messages.ts'
import { LANGUAGE_CODE, notAllowed, readObject, restOf, sendJson } from './route-kit.ts'
import { fileStamp, setAside } from './set-aside.ts'
import { localeName } from '../../shared/locale-names.ts'
import type { LocalePackView } from '../../shared/plugin-types.ts'
import type { WebRoute } from './host.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** An accepted language code: `it`, `pt-BR`, no paths (the one pattern the request readers use too). */
const CODE = LANGUAGE_CODE

/** The base language: compiled, always present, not removable. */
const BASE_LOCALE = 'en'

/** The language packs, as `main.ts` uses them. */
export interface LocalePacks {
  /** The installed codes, in order. */
  installed(): Promise<string[]>
  /** The installed pack, with its keys. */
  read(code: string): Promise<{ code: string; data: Record<string, string> }>
  /** The repository's packs, with installed or not and how many keys. */
  available(): Promise<LocalePackView[]>
  /** Copy a pack from the repository to `<data>/locales/`. */
  install(code: string): Promise<LocalePackView>
  /** Move an installed pack to `<data>/locales-rimossi/`, without deleting it. */
  remove(code: string): Promise<{ movedTo: string }>
}

/** A code that does not hold up: the caller says so with 400. */
function checkCode(code: string): string {
  if (!CODE.test(code)) throw new LocaleError(400, message('locale.invalidCode'))
  return code
}

/** A refusal with its status, for the routes. */
export class LocaleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Read a pack file and check its shape: a flat object of keys and texts, no
 * nesting, no numbers.
 * @param file - the pack file.
 * @returns the pack's keys and texts.
 */
async function readPackFile(file: string): Promise<Record<string, string>> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch (error: unknown) {
    throw new LocaleError(400, message('locale.packMissing', { code: basename(file, '.json'), reason: error instanceof Error ? error.message : String(error) }))
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LocaleError(400, message('locale.packObject', { file: basename(file) }))
  }
  const data: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new LocaleError(400, message('locale.packObject', { file: basename(file) }))
    data[key] = value
  }
  if (Object.keys(data).length === 0) throw new LocaleError(400, message('locale.packEmpty', { file: basename(file) }))
  return data
}

/** The `.json` files of a folder, in order, skipping names that are not codes. */
async function packsIn(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir)
    return names
      .filter(name => name.endsWith('.json') && CODE.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5))
      .sort()
  } catch {
    // A missing folder means no packs, not an error.
    return []
  }
}

/**
 * Create the packs system.
 * @param options.dir - `<data>/locales`, where the installed packs are.
 * @param options.srcDir - `locales/` in the repository, where the installable ones are.
 * @returns the packs, as the routes use them.
 */
export async function createLocalePacks(options: {
  readonly dir: string
  readonly srcDir?: string
}): Promise<LocalePacks> {
  const srcDir = options.srcDir

  /** A file exists and is a file. */
  const isFile = async (file: string): Promise<boolean> => stat(file).then(info => info.isFile(), () => false)

  /*
   * The parsed packs, by path, with the file's mtime and size when read. Every
   * page load fetches the active pack, and the list of the available ones
   * parsed every source and every installed pack in full only to count keys:
   * now a pack is parsed again only when its file changed. A file that does
   * not parse is not kept, so its error is read fresh each time.
   */
  const parsed = new Map<string, { readonly version: string; readonly data: Record<string, string> }>()

  /**
   * A pack file, parsed and checked, from the cache when the file is unchanged.
   * @param file - the pack file.
   * @param info - its `stat`, when the caller has it already.
   * @returns the pack's keys and texts.
   * @throws {LocaleError} 400 as {@link readPackFile} does, when the file is missing too.
   */
  const pack = async (file: string, info?: { mtimeMs: number; size: number }): Promise<Record<string, string>> => {
    let seen = info
    if (seen === undefined) {
      try {
        seen = await stat(file)
      } catch (error: unknown) {
        parsed.delete(file)
        throw new LocaleError(400, message('locale.packMissing', { code: basename(file, '.json'), reason: error instanceof Error ? error.message : String(error) }))
      }
    }
    const version = `${String(seen.mtimeMs)}/${String(seen.size)}`
    const known = parsed.get(file)
    if (known?.version === version) return known.data
    parsed.delete(file)
    const data = await readPackFile(file)
    parsed.set(file, { version, data })
    return data
  }

  /** A pack's key count, as the page compares them. */
  const keysIn = async (file: string): Promise<number> => Object.keys(await pack(file)).length

  /**
   * A pack as the page reads it, counting the keys; undefined when the
   * repository has no readable source for it.
   *
   * Two counts: `covers` is the source (what a fresh copy would cover) and
   * `installedCovers` is the installed pack, when there is one. The page shows
   * the second and uses the first as the total: it is the yardstick that tells
   * whether the client is reading an old pack.
   *
   * A broken source file is not offered: better not to see it than to install
   * it and break the page. A broken installed file is not hidden like a broken
   * source — the user has it on disk and the page must be able to update it —
   * so its keys count as 0.
   */
  const viewOf = async (code: string): Promise<LocalePackView | undefined> => {
    if (srcDir === undefined) return undefined
    let covers: number
    try {
      covers = await keysIn(join(srcDir, `${code}.json`))
    } catch {
      return undefined
    }
    const installedFile = join(options.dir, `${code}.json`)
    if (!await isFile(installedFile)) return { code, name: localeName(code), installed: false, covers }
    const installedCovers = await keysIn(installedFile).catch(() => 0)
    return { code, name: localeName(code), installed: true, covers, installedCovers, behind: installedCovers < covers }
  }

  return {
    async installed() {
      return await packsIn(options.dir)
    },
    async read(code) {
      const wanted = checkCode(code)
      const file = join(options.dir, `${wanted}.json`)
      // One stat: whether the pack is there, and whether the cached copy still holds.
      const info = await stat(file).catch(() => undefined)
      if (info?.isFile() !== true) {
        throw new LocaleError(404, message('locale.packMissing', { code: wanted, reason: 'ENOENT' }))
      }
      return { code: wanted, data: await pack(file, info) }
    },
    async available() {
      if (srcDir === undefined) return []
      const codes = (await packsIn(srcDir)).filter(code => code !== BASE_LOCALE)
      const views = await Promise.all(codes.map(viewOf))
      return views.filter((view): view is LocalePackView => view !== undefined)
    },
    /*
     * Copy the source to `<data>/locales`: this is the install and, on a pack
     * already installed, the UPDATE (6/11/2026: an old pack counted as complete
     * and there was no way to bring it back in line from the page). The pack
     * being replaced is not lost: it goes to `<data>/locales-indietro/`, beside
     * the removed packs — a hand-edited translation is rare, but saving it
     * costs one file.
     */
    async install(code) {
      const wanted = checkCode(code)
      if (wanted === BASE_LOCALE) throw new LocaleError(400, message('locale.baseLanguage'))
      if (srcDir === undefined) throw new LocaleError(400, message('locale.notAvailable', { code: wanted }))
      const source = join(srcDir, `${wanted}.json`)
      if (!await isFile(source)) throw new LocaleError(404, message('locale.notAvailable', { code: wanted }))
      // The keys are checked before copying: a broken pack must not reach
      // `<data>`.
      await pack(source)
      await mkdir(options.dir, { recursive: true })
      const installed = join(options.dir, `${wanted}.json`)
      if (await isFile(installed)) {
        const folder = join(dirname(options.dir), 'locales-indietro')
        await mkdir(folder, { recursive: true })
        await copyFile(installed, join(folder, `${wanted}-${fileStamp()}.json`))
      }
      await copyFile(source, installed)
      const view = await viewOf(wanted)
      // The source was read just above: only a file changed in between lands here.
      if (view === undefined) throw new LocaleError(500, message('locale.notAvailable', { code: wanted }))
      return view
    },
    async remove(code) {
      const wanted = checkCode(code)
      if (wanted === BASE_LOCALE) throw new LocaleError(400, message('locale.baseLanguage'))
      const file = join(options.dir, `${wanted}.json`)
      if (!await isFile(file)) throw new LocaleError(404, message('locale.notInstalled', { code: wanted }))
      return { movedTo: await setAside(file, join(dirname(options.dir), 'locales-rimossi'), wanted, '.json') }
    },
  }
}

/**
 * The `/comfy-locales` routes: the prefix with the list, one pack and the two
 * commands, and the sibling `/comfy-locales-available` — the page asks for the
 * ones the repository ships under its own address, beside the prefix, like the
 * plugins' own routes.
 * @param packs - the packs system.
 * @returns the routes to register on the host.
 */
export function createLocalePacksRoutes(packs: LocalePacks): readonly WebRoute[] {
  /** The same answers, for an exact route. */
  const available = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      sendJson(res, 200, { packs: await packs.available() })
    } catch (error: unknown) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return [
    createLocalePacksRoute(packs),
    { kind: 'exact', path: '/comfy-locales-available', handler: available },
  ]
}

/**
 * The `/comfy-locales` prefix: the installed list, one pack's contents and the
 * two commands. The packs the repository ships are `/comfy-locales-available`
 * (until 2026-11-14 also `/comfy-locales/available`, which the page never asked).
 * @param packs - the packs system.
 * @returns the route to register on the host.
 */
function createLocalePacksRoute(packs: LocalePacks): WebRoute {
  const answer = async (run: () => Promise<unknown>, res: ServerResponse, status = 200): Promise<void> => {
    try {
      sendJson(res, status, await run() as Record<string, unknown>)
    } catch (error: unknown) {
      const code = error instanceof LocaleError ? error.status : 500
      sendJson(res, code, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    kind: 'prefix',
    path: '/comfy-locales',
    async handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const read = req.method === 'GET' || req.method === 'HEAD'
      const post = req.method === 'POST'
      const rest = restOf(req, res, '/comfy-locales')
      if (rest === undefined) return
      if (rest === '') {
        if (!read) { notAllowed(res, 'GET, HEAD'); return }
        await answer(async () => ({ locales: (await packs.installed()).map(code => ({ code })) }), res)
        return
      }
      if (rest === 'install' || rest === 'remove') {
        if (!post) { notAllowed(res, 'POST'); return }
        let body: { code?: unknown }
        try {
          body = await readObject<{ code?: unknown }>(req, 16 * 1024)
        } catch (error: unknown) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (typeof body.code !== 'string') {
          sendJson(res, 400, { error: message('locale.invalidCode') })
          return
        }
        const code = body.code
        await answer(async () => rest === 'install'
          ? { ok: true, pack: await packs.install(code) }
          : { ok: true, ...await packs.remove(code) }, res)
        return
      }
      if (!read) { notAllowed(res, 'GET, HEAD'); return }
      await answer(async () => await packs.read(rest), res)
    },
  }
}
