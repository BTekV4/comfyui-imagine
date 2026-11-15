/**
 * The studio's address, both ways: the page the path names, and the file the
 * viewer shows (`?file=`). Split out of ImaginePage.tsx (2026-11-07).
 *
 * Opening the page follows the address; every change of page writes it, so
 * Back and Forward work and a page can be linked or reloaded.
 * @module use-address-sync
 */

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import type { ImagineView } from './gallery-store.ts'
import { pageOf, pathOf, type StudioPage } from './imagine-routes.ts'
import type { ImaginePageProps } from './props.ts'

/** What the address follows and drives. */
export interface AddressSyncContext {
  readonly actions: ImaginePageProps['actions']
  readonly view: ImagineView
  readonly projectId: string | undefined
  /** The inventory: the file the address names is looked up in it. */
  readonly items: readonly GalleryItem[]
  /** The file open in the viewer. */
  readonly selected: GalleryItem | undefined
  readonly setSelected: Dispatch<SetStateAction<GalleryItem | undefined>>
  /**
   * Pages the studio cannot show right now (Instagram without its plugin): an
   * address naming one opens the home, and the address is replaced rather
   * than kept in the history.
   */
  readonly unavailable?: ReadonlySet<ImagineView>
}

/**
 * Whether the store shows the page an address names.
 * @param page - the page the address names.
 * @param view - the page the store shows.
 * @param projectId - the project the store has open.
 * @returns true when they are the same page.
 */
function showsPage(page: StudioPage, view: ImagineView, projectId: string | undefined): boolean {
  return page.view === view && (page.view !== 'project' || page.projectId === projectId)
}

export function useAddressSync(
  { actions, view, projectId, items, selected, setSelected, unavailable }: AddressSyncContext,
): void {
  /*
   * Every page has its own address (2026-11-03): on load the address wins,
   * and from then on every change of page writes it, so the browser's Back
   * and Forward work and a page can be linked or reloaded.
   */
  /*
   * The page the address named on load, until the store shows it.
   *
   * The store starts on the page it last saved, and the routing effect below
   * only asks for the address's page: until that lands, writing the path
   * would push the stale page's address (`/`) over the deep link — and under
   * StrictMode the remount then read `/` and stayed home. So the first
   * application is authoritative: nothing is written until the store shows
   * the address's page, or has moved off the page it started on (a project
   * that no longer exists lands elsewhere, and that is then the page).
   */
  const pendingPage = useRef<StudioPage | undefined>(undefined)
  const startedOn = useRef<{ readonly view: ImagineView; readonly projectId: string | undefined }>()
  if (startedOn.current === undefined) {
    startedOn.current = { view, projectId }
    const addressed = pageOf(window.location.pathname)
    if (addressed !== undefined && (addressed.view !== 'project' || addressed.projectId !== undefined)) {
      pendingPage.current = addressed
    }
  }
  const unavailableRef = useRef(unavailable)
  unavailableRef.current = unavailable
  const go = (page: StudioPage | undefined): void => {
    if (page === undefined) return
    if (page.view === 'project') {
      if (page.projectId !== undefined) actions.openProject(page.projectId)
      return
    }
    if (unavailableRef.current?.has(page.view) === true) {
      // The home is shown instead, and the address says so at once: there is
      // nothing to wait for, and Back must not land here again.
      if (pendingPage.current === page) pendingPage.current = undefined
      window.history.replaceState({ view: 'home' }, '', pathOf('home', undefined))
      actions.go('home')
      return
    }
    actions.go(page.view)
  }
  const routedRef = useRef(false)
  useEffect(() => {
    // The page parsed on the first render, not the address now: a remount
    // must not read back an address this hook may have written meanwhile.
    go(pendingPage.current)
    routedRef.current = true
  }, [actions])
  /*
   * The page shown is the address's: when it changes its path is written, and
   * Back returns to the previous one without a reload.
   */
  useEffect(() => {
    if (!routedRef.current) return
    const pending = pendingPage.current
    if (pending !== undefined) {
      const moved = startedOn.current?.view !== view || startedOn.current.projectId !== projectId
      if (!showsPage(pending, view, projectId) && !moved) return
      pendingPage.current = undefined
    }
    const path = pathOf(view, projectId)
    if (window.location.pathname === path) return
    // An address naming a page that cannot be shown is replaced, so Back does
    // not land on it again.
    const left = pageOf(window.location.pathname)
    if (left !== undefined && unavailableRef.current?.has(left.view) === true) window.history.replaceState({ view, projectId }, '', path)
    else window.history.pushState({ view, projectId }, '', path)
  }, [view, projectId])
  /*
   * A page that becomes unavailable while shown (the plugin list arrived)
   * gives way to the home.
   */
  useEffect(() => {
    if (view !== 'project' && unavailable?.has(view) === true) actions.go('home')
  }, [view, unavailable, actions])
  useEffect(() => {
    const onPop = (): void => { go(pageOf(window.location.pathname)) }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop) }
  }, [actions])
  /*
   * The file opened full size lives in the address (`?file=<name>`), like
   * Grok's `/imagine/post/<id>` (2026-11-07): reloading the page reopens it
   * instead of going back to the canvas, and "Back" closes it. Opening it adds
   * a history entry; moving to another file from the strip replaces it.
   */
  const fileFromAddress = (): string | undefined => new URLSearchParams(window.location.search).get('file') ?? undefined
  const pendingFile = useRef<string | undefined>(fileFromAddress())
  useEffect(() => {
    const wanted = pendingFile.current
    if (wanted === undefined || items.length === 0) return
    const found = items.find(item => item.name === wanted)
    pendingFile.current = undefined
    if (found !== undefined) setSelected(found)
  }, [items])
  const openedFile = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (pendingFile.current !== undefined) return
    const url = new URL(window.location.href)
    const shown = url.searchParams.get('file') ?? undefined
    const name = selected?.name
    if (shown === name) { openedFile.current = name; return }
    if (name === undefined) url.searchParams.delete('file')
    else url.searchParams.set('file', name)
    const next = `${url.pathname}${url.search}${url.hash}`
    if (openedFile.current === undefined && name !== undefined) window.history.pushState(window.history.state, '', next)
    else window.history.replaceState(window.history.state, '', next)
    openedFile.current = name
  }, [selected])
  useEffect(() => {
    const onPop = (): void => {
      const wanted = fileFromAddress()
      openedFile.current = wanted
      if (wanted === undefined) { setSelected(undefined); return }
      const found = itemsRef.current.find(item => item.name === wanted)
      if (found !== undefined) setSelected(found)
    }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop) }
  }, [])
  const itemsRef = useRef(items)
  itemsRef.current = items
}
