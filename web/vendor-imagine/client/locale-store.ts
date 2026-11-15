/**
 * The studio's language: the one dictionary compiled in, the packs it finds on
 * disk, and how the page hears about a change.
 *
 * English is compiled (`locales.ts`) and is the base: every other language is a
 * flat JSON of the same keys, installed at runtime, that appears in the
 * selector without a rebuild. A key a pack leaves out reads English — which is
 * what lets somebody translate a piece at a time and still use the studio — and
 * a language whose pack is taken away falls back to English instead of staying
 * in a language that is no longer there.
 * @module client/locale-store
 */

import { useSyncExternalStore } from 'react'
import { en, type ComfyLocaleKey } from './locales.ts'
import { resolveText } from './locale-resolve.ts'
import { LOCALE_NAMES } from '../../../shared/locale-names.ts'
import { request } from './http.ts'

/** The languages compiled into this build: English, and nothing else. */
const BUILT_IN = [
  { id: 'en', label: 'English' },
] as const

/** A language the page can use: built in, or a pack found on disk. */
export interface AvailableLocale {
  readonly id: string
  readonly label: string
}

const STORAGE_KEY = 'imagine.locale'
const EVENT = 'imagine:locale'

/**
 * The dictionaries compiled in this build.
 *
 * English is the source: a language pack that leaves a key out reads English.
 * It is the language the studio is written in, and the one a translator starts
 * from.
 */
const BUILT_IN_DICTS: Readonly<Record<string, Partial<Record<ComfyLocaleKey, string>>>> = { en }

/** The packs read so far, by code. */
const packs: Record<string, Record<string, string>> = {}
/** The codes the host reported, in the order it listed them. */
let packCodes: readonly string[] = []
/** The language asked for and not found: the page says so instead of hiding it. */
let fellBackFrom: string | undefined

/** The cookie's name: the same choice, readable by the server. */
const COOKIE = 'imagine_locale'
/**
 * The language the page is SHOWN in, which is not always the one chosen (a
 * chosen pack that is not installed falls back to English, and with no choice
 * at all the page still shows one). Pages the server writes itself inside the
 * studio — the "app does not answer" page in a plugin's frame — read it to
 * speak the same language as the studio around them (2026-11-15: an English
 * studio showed that page in Italian). A session cookie: it is rewritten at
 * every load.
 */
const SHOWN_COOKIE = 'imagine_shown_locale'
/** A year, like the one the studio used to keep. */
const COOKIE_DAYS = 365

/** The language codes written right to left. */
const RTL = new Set(['ar', 'fa', 'he', 'ur'])

/**
 * The language the page was asked for, in the order the address, the cookie
 * and the storage give it; undefined when this browser never chose one.
 *
 * `?lang=de` wins: a link carries the language, and a translator can send one.
 * Then the cookie, which the server can read as well; then what this browser
 * chose last time. With none of them the browser's own languages decide, once
 * the installed packs are known (`loadPacks`): until 2026-11-15 the answer was
 * a fixed Italian, so a German visitor of an installation with the Italian
 * pack saw the studio in Italian.
 */
function read(): string | undefined {
  const fromQuery = new URLSearchParams(location.search).get('lang')
  if (fromQuery !== null && /^[a-z]{2}(-[A-Z]{2})?$/.test(fromQuery)) return fromQuery
  try {
    const cookie = document.cookie.split('; ').find(entry => entry.startsWith(`${COOKIE}=`))
    const value = cookie?.slice(COOKIE.length + 1)
    if (typeof value === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(value)) return value
  } catch {
    // A document without cookies is no reason not to start.
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (typeof stored === 'string' && stored !== '') return stored
  } catch {
    // The same for the storage.
  }
  return undefined
}

/**
 * The browser's languages, as two-letter codes, most wanted first.
 * @returns the codes, without repeats.
 */
function browserLanguages(): string[] {
  try {
    const listed = navigator.languages.length > 0 ? navigator.languages : [navigator.language]
    return [...new Set(listed.map(code => code.slice(0, 2).toLowerCase()).filter(code => /^[a-z]{2}$/.test(code)))]
  } catch {
    return []
  }
}

/**
 * Tell the document which language it is in, and which way it reads.
 *
 * The `<html lang>` is what a browser uses to hyphenate and to pick a voice for
 * the reader, and `dir` is what makes an Arabic or Persian pack readable at
 * all: without it the layout keeps its left margin and the text runs backwards.
 */
function applyDocumentLanguage(code: string): void {
  const root = document.documentElement
  root.lang = code
  try {
    document.cookie = `${SHOWN_COOKIE}=${code}; Path=/; SameSite=Lax`
  } catch {
    // Without it the server's own pages fall back to the chosen language.
  }
  root.dir = RTL.has(code.slice(0, 2)) ? 'rtl' : 'ltr'
  /*
   * `?lang=` is updated only when it was already there: whoever arrives
   * without it does not find it added to the address, and whoever came with a
   * translated link keeps it when changing language.
   */
  const url = new URL(location.href)
  if (url.searchParams.has('lang') && url.searchParams.get('lang') !== code) {
    url.searchParams.set('lang', code)
    history.replaceState(history.state, '', url)
  }
}

/** Write the choice where the server can read it too. */
function store(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {
    // It stays in memory.
  }
  try {
    document.cookie = `${COOKIE}=${code}; Max-Age=${String(COOKIE_DAYS * 24 * 60 * 60)}; Path=/; SameSite=Lax`
  } catch {
    // Without the cookie the server does not know, but the page does.
  }
}

/** The language this browser chose, if it ever did; the browser decides otherwise. */
const chosen = read()
let current: string = chosen ?? 'en'
applyDocumentLanguage(current)

/**
 * The languages the selector offers: English, always, then the installed packs
 * with the name the language calls itself.
 * @returns the languages, in a stable order.
 */
export function availableLocales(): readonly AvailableLocale[] {
  return [
    ...BUILT_IN,
    ...packCodes.map(code => ({ id: code, label: LOCALE_NAMES[code] ?? code.toUpperCase() })),
  ]
}

/**
 * Re-render on the fallback, and read it.
 * @returns the language that was asked for and is not available.
 */
export function useLocaleFallback(): string | undefined {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener(EVENT, notify)
      return () => { window.removeEventListener(EVENT, notify) }
    },
    () => fellBackFrom,
    () => undefined,
  )
}

/** The language in force now. */
export function locale(): string {
  return current
}

/**
 * The language to announce to the host on every call.
 *
 * The studio translates the words it draws itself; this is how the host can
 * answer in the same language for the words it sends (a job's notice, a
 * workflow label) without guessing from the browser.
 * @returns the language code in force.
 */
export function languageHeader(): string {
  return current
}

/**
 * Read one pack from the host, once.
 * @param code - the pack's code, e.g. `de`.
 * @returns the dictionary, or undefined when the host has no such pack.
 */
async function packOf(code: string): Promise<Record<string, string> | undefined> {
  if (packs[code] !== undefined) return packs[code]
  try {
    const response = await request(`/comfy-locales/${encodeURIComponent(code)}`, 'GET')
    if (!response.ok) return undefined
    const body = await response.json() as { data?: unknown }
    if (typeof body.data !== 'object' || body.data === null) return undefined
    const data = Object.fromEntries(Object.entries(body.data as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string')) as Record<string, string>
    packs[code] = data
    return data
  } catch {
    return undefined
  }
}

/**
 * Ask the host which packs it has, and read the one in force.
 *
 * Called once when the page mounts: a pack added to the folder shows up at the
 * next reload, which is the same moment a dropped file would be noticed.
 */
export async function loadPacks(): Promise<void> {
  try {
    const response = await request('/comfy-locales', 'GET')
    if (response.ok) {
      const body = await response.json() as { locales?: readonly { code?: unknown }[] }
      packCodes = (body.locales ?? [])
        .map(entry => entry.code)
        .filter((code): code is string => typeof code === 'string')
    }
  } catch {
    // No packs: the compiled languages remain.
  }
  if (chosen === undefined) {
    /*
     * Never chosen: the first of the browser's languages this installation
     * has (English is always there), else English. Not written down as a
     * choice, so a pack installed later can still be picked up.
     */
    const have = new Set(['en', ...packCodes])
    const wanted = browserLanguages().find(code => have.has(code)) ?? 'en'
    if (wanted !== 'en' && await packOf(wanted) !== undefined) {
      current = wanted
      applyDocumentLanguage(wanted)
    }
    window.dispatchEvent(new Event(EVENT))
    return
  }
  if (BUILT_IN_DICTS[current] !== undefined) {
    window.dispatchEvent(new Event(EVENT))
    return
  }
  const pack = await packOf(current)
  /*
   * The chosen language is gone (pack removed, or never installed): the page
   * switches to English and says so. The choice stays written where it was —
   * cookie and storage — so reinstalling the pack brings the language back.
   */
  if (pack === undefined) {
    fellBackFrom = current
    current = 'en'
    applyDocumentLanguage('en')
    window.dispatchEvent(new Event(EVENT))
    return
  }
  window.dispatchEvent(new Event(EVENT))
}

/**
 * Choose a language and tell the page.
 * @param next - the language to use from now on.
 */
export function setLocale(next: string): void {
  if (next === current) return
  fellBackFrom = undefined
  current = next
  store(next)
  applyDocumentLanguage(next)
  window.dispatchEvent(new Event(EVENT))
  if (BUILT_IN_DICTS[next] === undefined) {
    void packOf(next).then(() => { window.dispatchEvent(new Event(EVENT)) }, () => undefined)
  }
}

/**
 * Re-render a component when the language changes.
 * @returns the language in force.
 */
export function useLocale(): string {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener(EVENT, notify)
      return () => { window.removeEventListener(EVENT, notify) }
    },
    () => current,
    () => 'en',
  )
}

/** Fill the `{placeholders}` of a text. */
function fill(text: string, params?: Record<string, string | number>): string {
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (params[name] === undefined ? whole : String(params[name])))
}

/**
 * The studio's translator: the text of a key in the language in force, with
 * its `{placeholders}` filled.
 *
 * The pack is loaded before the page is imported (`web/src/main.tsx`) and
 * choosing another language reloads the page, so a component that calls this
 * while it renders always reads the language in force.
 * @param key - the message key.
 * @param params - the placeholders.
 * @returns the text.
 */
export function translate(key: ComfyLocaleKey, params?: Record<string, string | number>): string {
  return fill(text(key), params)
}

/**
 * The dictionary entry for a key: the pack of the chosen language, then
 * English, then the key itself.
 * @param key - the message key.
 * @returns the text, placeholders still in.
 */
export function text(key: ComfyLocaleKey): string {
  return resolveText(key, { pack: packs[current], english: en })
}

