/**
 * The studio's pages and their addresses.
 *
 * Until 2026-11-03 the app lived at one address and kept the page in its
 * store: every click was invisible to the browser, so Back left the studio and
 * a page could not be linked or reloaded. Grok Imagine gives each page its own
 * path (`/imagine`, `/imagine/saved`, …); ours are in `PAGE_PATHS` below.
 * Until 2026-11-04 they were Italian, like the rest of the interface then
 * (`/tutti-i-media`, `/libreria`, `/impostazioni`, `/progetti`, …): see
 * `LEGACY`.
 *
 * Every card of the home's grid has an address of its own as well
 * (2026-11-16): `/tool/<card>` for a workflow card, `/model/<template>` for a
 * ready-made model, `/workflow/<id>` for one the user uploaded. The home is
 * still the page; the address names the panel it shows, so Back closes the
 * panel and Forward opens it again.
 *
 * The server serves the page for any path that is not a file, so a deep link
 * and a reload land on the same page the browser is showing.
 * @module imagine-routes
 */

import { templateById } from '../../../shared/imagine-templates.ts'
import type { ImagineView } from './gallery-store.ts'
import { CARD_MODE, type JobCardId } from './job-cards.ts'

/** The address of each page but a project, whose id goes in the path. */
const PAGE_PATHS: Readonly<Record<Exclude<ImagineView, 'project'>, string>> = {
  home: '/',
  media: '/media',
  library: '/library',
  social: '/instagram',
  openjutsu: '/openjutsu',
  iopaint: '/iopaint',
  settings: '/settings',
  plugins: '/plugins',
  projects: '/projects',
}

/**
 * The addresses the studio used before: `/imagine`, its home inside DSH, and
 * the Italian paths it had before 2026-11-04.
 *
 * They are still answered, so a link somebody kept (or a bookmark) opens the
 * page it named instead of a 404.
 */
const LEGACY: Readonly<Record<string, ImagineView>> = {
  '/imagine': 'home',
  '/tutti-i-media': 'media',
  '/libreria': 'library',
  '/impostazioni': 'settings',
  '/progetti': 'projects',
}

/** The page a path names, by address. */
const BY_PATH: ReadonlyMap<string, ImagineView> = new Map(
  Object.entries(PAGE_PATHS).map(([view, path]) => [path, view as ImagineView]),
)

/** The panel of the home's grid an address names. */
export type HomePanel =
  | { readonly kind: 'tool'; readonly id: JobCardId }
  | { readonly kind: 'model'; readonly id: string }
  /** An uploaded workflow: its id is checked once the host has listed them. */
  | { readonly kind: 'workflow'; readonly id: string }

/** What the address says the page is. */
export interface StudioPage {
  readonly view: ImagineView
  /** The project, for `project`. */
  readonly projectId?: string
  /** The panel the home shows, for `home`. */
  readonly panel?: HomePanel
}

/** The first segment of each panel's address. */
const PANEL_PREFIX: Readonly<Record<HomePanel['kind'], string>> = {
  tool: '/tool/',
  model: '/model/',
  workflow: '/workflow/',
}

/**
 * Whether two panels are the same one (both absent included).
 * @param a - one panel.
 * @param b - the other.
 * @returns true when they name the same card.
 */
export function samePanel(a: HomePanel | undefined, b: HomePanel | undefined): boolean {
  return a?.kind === b?.kind && a?.id === b?.id
}

/**
 * Whether a path is a panel's address, valid or not: an address of that shape
 * that names no card is tidied to the home rather than kept in the history.
 * @param pathname - `window.location.pathname`.
 * @returns true for `/tool/…`, `/model/…` and `/workflow/…`.
 */
export function isPanelPath(pathname: string): boolean {
  return Object.values(PANEL_PREFIX).some(prefix => pathname.startsWith(prefix))
}

/**
 * The address of a page.
 * @param view - the page the studio is showing.
 * @param projectId - the project, for `project`.
 * @param panel - the panel the home shows, for `home`.
 * @returns the path to put in the address bar.
 */
export function pathOf(view: ImagineView, projectId: string | undefined, panel?: HomePanel): string {
  if (view === 'home' && panel !== undefined) return `${PANEL_PREFIX[panel.kind]}${encodeURIComponent(panel.id)}`
  if (view !== 'project') return PAGE_PATHS[view]
  if (projectId === undefined || projectId === '') return '/'
  return `/project/${encodeURIComponent(projectId)}`
}

/**
 * The page a path names, or undefined when it names none.
 *
 * An unknown path (an old bookmark, a typo) is not an error: the studio opens
 * the home and the address is tidied by the caller.
 * @param pathname - `window.location.pathname`.
 * @returns the page, or undefined.
 */
export function pageOf(pathname: string): StudioPage | undefined {
  const clean = pathname.replace(/\/+$/, '') || '/'
  const legacy = LEGACY[clean]
  if (legacy !== undefined) return { view: legacy }
  if (clean.startsWith('/project/') || clean.startsWith('/progetto/')) {
    const raw = clean.startsWith('/project/') ? clean.slice('/project/'.length) : clean.slice('/progetto/'.length)
    if (raw === '' || raw.includes('/')) return undefined
    try {
      return { view: 'project', projectId: decodeURIComponent(raw) }
    } catch {
      // A malformed escape is not a project id.
      return undefined
    }
  }
  for (const [kind, prefix] of Object.entries(PANEL_PREFIX) as [HomePanel['kind'], string][]) {
    if (!clean.startsWith(prefix)) continue
    const panel = panelOf(kind, clean.slice(prefix.length))
    // A card that does not exist (an old link, a typo) opens the home.
    return panel === undefined ? { view: 'home' } : { view: 'home', panel }
  }
  const view = BY_PATH.get(clean)
  return view === undefined ? undefined : { view }
}

/**
 * The panel one segment names, when it names one.
 * @param kind - which kind of card the prefix said.
 * @param raw - the segment after the prefix, still escaped.
 * @returns the panel, or undefined for an unknown or malformed id.
 */
function panelOf(kind: HomePanel['kind'], raw: string): HomePanel | undefined {
  if (raw === '' || raw.includes('/')) return undefined
  let id: string
  try {
    id = decodeURIComponent(raw)
  } catch {
    return undefined
  }
  if (kind === 'tool') return Object.hasOwn(CARD_MODE, id) ? { kind, id: id as JobCardId } : undefined
  if (kind === 'model') return templateById(id) === undefined ? undefined : { kind, id }
  return { kind, id }
}
