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
 * The server serves the page for any path that is not a file, so a deep link
 * and a reload land on the same page the browser is showing.
 * @module imagine-routes
 */

import type { ImagineView } from './gallery-store.ts'

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

/** What the address says the page is. */
export interface StudioPage {
  readonly view: ImagineView
  /** The project, for `project`. */
  readonly projectId?: string
}

/**
 * The address of a page.
 * @param view - the page the studio is showing.
 * @param projectId - the project, for `project`.
 * @returns the path to put in the address bar.
 */
export function pathOf(view: ImagineView, projectId: string | undefined): string {
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
  const view = BY_PATH.get(clean)
  return view === undefined ? undefined : { view }
}
