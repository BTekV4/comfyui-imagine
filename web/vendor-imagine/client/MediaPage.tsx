/**
 * "All media", the studio's History, as Grok Imagine's /imagine/saved
 * (read off its page 2026-10-17): every file in a full-bleed masonry with no
 * frame around it, newest first. On top: back, the "All" and "Liked"
 * chips, and on the right "View" (Flat or Grouped, Full or Compact) and
 * "Select". Selecting turns the bar into "Clear selection" (Grok's
 * "✕ 1 Selected"), "Add to tag", "Download", "Delete". The composer floats
 * at the bottom. On a phone the pills past "All" are icons only, so the bar
 * fits the screen.
 *
 * Tags (Grok, 2026-10-18): the "…" pill holds "New tag", a dialog with
 * "Tag name", Cancel and Create; a tag is a chip after "Liked".
 * "Add to tag" lists "Liked", the tags and "New tag". Renaming and
 * deleting a tag, and taking files out of one, are ours: Grok's account had
 * no tag to show how.
 *
 * Opening a file shows it in the viewer, the way Grok opens the post.
 *
 * A clip in the grid plays itself while it crosses the screen (2026-11-03),
 * as Grok's saved page does: the still is the poster, the player mounts on
 * the first sighting and pauses off screen. "View" → "Clips" holds them
 * still, and so does `prefers-reduced-motion`.
 */
import { translate } from './locale-store.ts'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal.tsx'
import {
  IconBack, IconBin, IconCheck, IconCross, IconDotGrid, IconDots, IconDownloadRound, IconFolderCloseRegular, IconPlayFilled, IconPointer,
  IconSearchOutlineRegular, IconSquares, IconTag, IconTagOff,
} from '../../shims/primitives/index.ts'
import { IconHeart } from './canvas-icons.tsx'
import { LiveClip } from './LiveClip.tsx'
import { Still } from './Still.tsx'
import { changeTags as postTags, fetchTags, mediaUrlOf, searchMedia, thumbUrlOf, THUMB_SMALL, THUMB_TILE } from './gallery-api.ts'
import { prefersReducedMotion } from './imagine-bits.tsx'
import { itemRatio } from './imagine-settings.ts'
import type { GalleryItem, MediaTag } from '../../../shared/imagine-types.ts'
import { useDismiss } from './use-dismiss.ts'
import { bandAround, useGrowOnTail, useScrollMeasure } from './use-scroll-band.ts'
import css from './MediaPage.module.css'

type Density = 'full' | 'compact'
/** Whether the clips in the grid play themselves, or stand as stills. */
type Clips = 'play' | 'still'

const PREFS = 'imagine.media.view'
function readPrefs(): { density: Density; clips: Clips } {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(PREFS) ?? '{}') as { density?: unknown; clips?: unknown }
    return {
      density: raw.density === 'compact' ? 'compact' : 'full',
      clips: raw.clips === 'still' ? 'still' : 'play',
    }
  } catch {
    return { density: 'full', clips: 'play' }
  }
}

/** Cards drawn per step: the inventory runs to thousands of files. */
const PAGE = 40


type Dialog = { readonly kind: 'create'; readonly names: readonly string[] } | { readonly kind: 'rename'; readonly id: string }

export interface MediaPageProps {
  readonly items: readonly GalleryItem[]
  readonly liked: ReadonlySet<string>
  /** The heart on several files, from "Add to tag" → "Liked". */
  readonly onLike: (names: readonly string[], liked: boolean) => void
  readonly onBack: () => void
  /**
   * A clicked file: the project that holds it opens (or the viewer, for a file
   * that is in no project: the page decides).
   */
  readonly onOpen: (item: GalleryItem) => void
  /**
   * The full-screen viewer. A single click goes to the project, so the viewer
   * opens on double click: the click waits a moment to let the double click
   * arrive (the viewer was the single click's behaviour until 2026-11-04,
   * when the user asked for the project instead).
   */
  readonly onOpenViewer: (item: GalleryItem, list: readonly GalleryItem[]) => void
  readonly onCreateVideo: (item: GalleryItem) => void
  readonly onDownload: (items: readonly GalleryItem[]) => void
  readonly onDelete: (items: readonly GalleryItem[]) => void
  /**
   * Something is over the grid (a file opened in the viewer): the clips in it
   * hold still instead of playing behind the viewer.
   */
  readonly suspended?: boolean | undefined
  readonly composer: ReactNode
}

export function MediaPage({ items, liked, onLike, onBack, onOpen, onOpenViewer, onCreateVideo, onDownload, onDelete, suspended, composer }: MediaPageProps) {
  /** 'all', 'liked', or a tag's id. */
  const [tab, setTab] = useState<string>('all')
  const [prefs, setPrefs] = useState(readPrefs)
  const [menu, setMenu] = useState<'view' | 'tags' | 'add'>()
  const [tags, setTags] = useState<readonly MediaTag[]>([])
  const [dialog, setDialog] = useState<Dialog>()
  const [draft, setDraft] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [chosen, setChosen] = useState<readonly string[]>([])
  const [shown, setShown] = useState(PAGE)
  const [width, setWidth] = useState(0)
  /** What is in the search box. */
  const [query, setQuery] = useState('')
  /** The files the index found for the current search; undefined = no search. */
  const [hits, setHits] = useState<ReadonlySet<string>>()
  /** How many the index found, even beyond the names the answer carries. */
  const [found, setFound] = useState(0)
  const [searching, setSearching] = useState(false)
  const grid = useRef<HTMLDivElement>(null)
  /** The pending single click: a double click cancels it and opens the viewer. */
  const openTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)
  /*
   * The clip you hear (2026-11-11): a click on the tile turns its sound on,
   * another turns it off, and clicking a different one silences the first —
   * one clip at a time, like a radio. A double click opens the file in its
   * project.
   */
  const [heard, setHeard] = useState<string | undefined>(undefined)
  useEffect(() => () => {
    if (openTimer.current !== undefined) globalThis.clearTimeout(openTimer.current)
  }, [])
  const tail = useRef<HTMLDivElement>(null)
  const menuBox = useRef<HTMLDivElement>(null)
  const viewMenu = menu === 'view'
  // A clip in the grid plays itself, unless the reader chose "Still" or keeps
  // motion down: then the grid is the wall of stills it always was.
  const clipsPlay = prefs.clips === 'play' && !prefersReducedMotion()

  const setPref = (next: Partial<typeof prefs>): void => {
    const merged = { ...prefs, ...next }
    setPrefs(merged)
    try { globalThis.localStorage?.setItem(PREFS, JSON.stringify(merged)) } catch { /* the choice just is not remembered */ }
  }

  useEffect(() => {
    const node = grid.current
    if (node === null) return
    const measure = (): void => { setWidth(node.clientWidth) }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(node)
    return () => { watch.disconnect() }
  }, [])
  useDismiss(menuBox, () => { setMenu(undefined) }, menu !== undefined)
  useEffect(() => { setShown(PAGE) }, [tab, hits])
  useEffect(() => {
    fetchTags().then(setTags, () => undefined)
  }, [])
  /*
   * The search looks at the files' words — the prompt they were made with and
   * what vision saw in them — because the names are UUIDs and cannot be
   * searched. The index is the server's: the box asks it, with a pause so as
   * not to ask on every key, and the drawing filters by the names returned.
   */
  useEffect(() => {
    const asked = query.trim()
    if (asked === '') {
      setHits(undefined)
      setFound(0)
      setSearching(false)
      return
    }
    setSearching(true)
    let live = true
    const timer = setTimeout(() => {
      searchMedia(asked).then((answer) => {
        if (!live) return
        setHits(new Set(answer?.names ?? []))
        setFound(answer?.total ?? 0)
        setSearching(false)
      }, () => {
        if (!live) return
        setHits(new Set())
        setFound(0)
        setSearching(false)
      })
    }, 220)
    return () => { live = false; clearTimeout(timer) }
  }, [query])

  const activeTag = tags.find(tag => tag.id === tab)
  // A tag deleted, or gone on another device, leaves the page on "All".
  useEffect(() => { if (tab !== 'all' && tab !== 'liked' && activeTag === undefined && tags.length > 0) setTab('all') }, [tab, activeTag, tags.length])

  // Newest first, as the host sends the inventory: no copy, no sort.
  const listed = useMemo(() => {
    const inTag = activeTag === undefined ? undefined : new Set(activeTag.names)
    return items.filter(item => item.kind !== 'audio'
      && (hits === undefined || hits.has(item.name))
      && (tab === 'all' || (tab === 'liked' ? liked.has(item.name) : inTag?.has(item.name) === true)))
  }, [items, tab, liked, activeTag, hits])

  // One file, one cell: no grouping (asked 2026-11-07), so the listed files
  // are the cells.

  // More cells as the end comes into view.
  useGrowOnTail(tail, shown, listed.length, () => { setShown(current => current + PAGE) }, '800px')

  /*
   * Masonry in reading order: each cell goes to the shortest column, as
   * Grok's grid does, so the newest are along the top row.
   */
  const columns = Math.max(2, prefs.density === 'compact' ? Math.round(width / 200) : Math.round(width / 300))
  const gap = 2
  const colWidth = width > 0 ? (width - gap * (columns - 1)) / columns : 0
  // Laid out again only when the cells, the page or the width change, not on
  // every keystroke in the tag dialog or every menu opened.
  const stacks = useMemo((): GalleryItem[][] => {
    const out: GalleryItem[][] = Array.from({ length: columns }, () => [])
    const heights = Array.from({ length: columns }, () => 0)
    for (const cell of listed.slice(0, shown)) {
      const known = itemRatio(cell)
      const ratio = known === undefined ? 16 / 9 : Math.min(2.4, Math.max(0.4, known))
      let target = 0
      for (let index = 1; index < columns; index += 1) if ((heights[index] ?? 0) < (heights[target] ?? 0)) target = index
      out[target]?.push(cell)
      heights[target] = (heights[target] ?? 0) + colWidth * ratio + gap
    }
    return out
  }, [listed, shown, columns, colWidth])

  /*
   * Where each cell of each column sits, at the height it is drawn: the cell's
   * own aspect (the stacking above clamps it, the cell does not), 9:16 when
   * the file has no size. Measured in grid pixels from the grid's top.
   */
  const placed = useMemo(() => stacks.map((stack) => {
    const tops: number[] = []
    const heights: number[] = []
    let y = 0
    for (const cell of stack) {
      const known = itemRatio(cell)
      const height = colWidth * (known ?? 16 / 9)
      tops.push(y)
      heights.push(height)
      y += height + gap
    }
    return { tops, heights, total: Math.max(0, y - gap) }
  }), [stacks, colWidth])

  /*
   * The band of the grid worth drawing: the screen and a margin around it.
   * The pages above add cells and never took any away, so after a long scroll
   * thousands of pictures sat in the DOM; the cells out of the band are now
   * one spacer per column, as tall as what they replace, so the page scrolls
   * and looks the same. Quantized, so scrolling re-renders once per step.
   */
  const page = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState({ from: -Infinity, to: Infinity })
  useScrollMeasure(page, () => {
    const box = page.current
    const node = grid.current
    if (box === null || node === null) return
    const { from, to } = bandAround(box.scrollTop - node.offsetTop, box.clientHeight)
    setBand(current => (current.from === from && current.to === to ? current : { from, to }))
  }, undefined, 'now')

  const toggle =(name: string): void => {
    setSelecting(true)
    setChosen(current => (current.includes(name) ? current.filter(entry => entry !== name) : [...current, name]))
  }
  const chosenSet = useMemo(() => new Set(chosen), [chosen])
  const chosenItems = listed.filter(item => chosenSet.has(item.name))
  const endSelection = (): void => { setSelecting(false); setChosen([]) }

  const changeTags = (body: Record<string, unknown>): Promise<string | undefined> => postTags(body).then((answer) => {
    if (Array.isArray(answer.tags)) setTags(answer.tags)
    return answer.id
  }, () => undefined)
  const openDialog = (next: Dialog): void => {
    setMenu(undefined)
    setDraft(next.kind === 'rename' ? tags.find(tag => tag.id === next.id)?.name ?? '' : '')
    setDialog(next)
  }
  const submitDialog = (): void => {
    const name = draft.trim()
    if (dialog === undefined || name === '') return
    if (dialog.kind === 'rename') {
      void changeTags({ action: 'rename', id: dialog.id, name })
    } else {
      const fromSelection = dialog.names.length > 0
      void changeTags({ action: 'create', name, names: dialog.names }).then((id) => { if (id !== undefined && !fromSelection) setTab(id) })
      if (fromSelection) endSelection()
    }
    setDialog(undefined)
  }
  const addTo = (target: string): void => {
    const names = chosenItems.map(item => item.name)
    setMenu(undefined)
    if (target === 'liked') onLike(names, true)
    else void changeTags({ action: 'add', id: target, names })
    endSelection()
  }
  const takeOut = (): void => {
    const names = chosenItems.map(item => item.name)
    if (tab === 'liked') onLike(names, false)
    else if (activeTag !== undefined) void changeTags({ action: 'remove', id: activeTag.id, names })
    endSelection()
  }
  const deleteTag = (tag: MediaTag): void => {
    setMenu(undefined)
    if (!globalThis.confirm(translate('imagine.mediaDeleteTag', { name: tag.name }))) return
    setTab('all')
    void changeTags({ action: 'delete', id: tag.id })
  }

  return (
    <div ref={page} className={css.page}>
      <div className={css.bar}>
        <button type="button" className={css.round} aria-label={translate('imagine.mediaBack')} onClick={selecting ? endSelection : onBack}>
          <IconBack />
        </button>
        {selecting
          ? (
            <>
              <button type="button" className={css.chip} aria-label={translate('imagine.mediaClearSelection')} title={translate('imagine.mediaClearSelection')} onClick={endSelection}>
                <IconCross />
                {chosen.length === 0
                  ? translate('imagine.mediaClearSelection')
                  : translate(chosen.length === 1 ? 'imagine.mediaSelectedOne' : 'imagine.mediaSelectedMany', { count: chosen.length })}
              </button>
              <span className={css.spacer} />
              {tab !== 'all' && (
                <button type="button" className={css.chip} data-compact title={translate('imagine.mediaRemoveFromTag')} disabled={chosen.length === 0} onClick={takeOut}>
                  <IconTagOff />
                  <span className={css.label}>{translate('imagine.mediaRemoveFromTag')}</span>
                </button>
              )}
              <div className={css.menuBox} ref={menu === 'add' ? menuBox : undefined}>
                <button type="button" className={css.chip} data-compact title={translate('imagine.mediaAddToTag')} aria-expanded={menu === 'add'} disabled={chosen.length === 0} onClick={() => { setMenu(open => (open === 'add' ? undefined : 'add')) }}>
                  <IconTag />
                  <span className={css.label}>{translate('imagine.mediaAddToTag')}</span>
                </button>
                {menu === 'add' && (
                  <div className={css.menu} role="menu">
                    <button type="button" role="menuitem" className={css.menuItem} onClick={() => { addTo('liked') }}>
                      <span className={css.menuLabel}>{translate('imagine.mediaLiked')}</span>
                    </button>
                    {tags.map(tag => (
                      <button key={tag.id} type="button" role="menuitem" className={css.menuItem} onClick={() => { addTo(tag.id) }}>
                        <span className={css.menuLabel}>{tag.name}</span>
                      </button>
                    ))}
                    <span className={css.menuSep} />
                    <button type="button" role="menuitem" className={css.menuItem} onClick={() => { openDialog({ kind: 'create', names: chosenItems.map(item => item.name) }) }}>
                      <IconTag />
                      <span className={css.menuLabel}>{translate('imagine.mediaNewTag')}</span>
                    </button>
                  </div>
                )}
              </div>
              <button type="button" className={css.chip} data-compact title={translate('imagine.download')} disabled={chosen.length === 0} onClick={() => { onDownload(chosenItems) }}>
                <IconDownloadRound />
                <span className={css.label}>{translate('imagine.download')}</span>
              </button>
              <button type="button" className={css.chip} data-compact data-danger title={translate('imagine.mediaDelete')} disabled={chosen.length === 0} onClick={() => { onDelete(chosenItems); endSelection() }}>
                <IconBin />
                <span className={css.label}>{translate('imagine.mediaDelete')}</span>
              </button>
            </>
          )
          : (
            <>
              <button type="button" className={css.chip} data-on={tab === 'all' || undefined} onClick={() => { setTab('all') }}>
                <IconDotGrid />
                {translate('imagine.mediaAll')}
              </button>
              <button type="button" className={css.chip} data-compact title={translate('imagine.mediaLiked')} data-on={tab === 'liked' || undefined} onClick={() => { setTab('liked') }}>
                <IconHeart />
                <span className={css.label}>{translate('imagine.mediaLiked')}</span>
              </button>
              {tags.length > 0 && (
                <div className={css.tags}>
                  {tags.map(tag => (
                    <button key={tag.id} type="button" className={css.chip} data-on={tab === tag.id || undefined} onClick={() => { setTab(tag.id) }}>
                      <IconTag />
                      {tag.name}
                    </button>
                  ))}
                </div>
              )}
              <div className={css.menuBox} ref={menu === 'tags' ? menuBox : undefined}>
                <button type="button" className={css.round} aria-label={translate('imagine.mediaMoreTags')} aria-expanded={menu === 'tags'} onClick={() => { setMenu(open => (open === 'tags' ? undefined : 'tags')) }}>
                  <IconDots />
                </button>
                {menu === 'tags' && (
                  <div className={css.menu} data-start role="menu">
                    {tags.map(tag => (
                      <button key={tag.id} type="button" role="menuitemradio" aria-checked={tab === tag.id} className={css.menuItem} onClick={() => { setTab(tag.id); setMenu(undefined) }}>
                        <IconTag />
                        <span className={css.menuLabel}>{tag.name}</span>
                        {tab === tag.id && <IconCheck />}
                      </button>
                    ))}
                    {tags.length > 0 && <span className={css.menuSep} />}
                    <button type="button" role="menuitem" className={css.menuItem} onClick={() => { openDialog({ kind: 'create', names: [] }) }}>
                      <IconTag />
                      <span className={css.menuLabel}>{translate('imagine.mediaNewTag')}</span>
                    </button>
                    {activeTag !== undefined && (
                      <>
                        <button type="button" role="menuitem" className={css.menuItem} onClick={() => { openDialog({ kind: 'rename', id: activeTag.id }) }}>
                          <span className={css.menuLabel}>{translate('imagine.mediaRenameTagNamed', { name: activeTag.name })}</span>
                        </button>
                        <button type="button" role="menuitem" className={css.menuItem} data-danger onClick={() => { deleteTag(activeTag) }}>
                          <span className={css.menuLabel}>{translate('imagine.mediaDeleteTagNamed', { name: activeTag.name })}</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <span className={css.spacer} />
              <div className={css.search} data-busy={searching || undefined}>
                <IconSearchOutlineRegular size={16} />
                <input
                  type="search"
                  className={css.searchInput}
                  value={query}
                  placeholder={translate('imagine.mediaSearchPlaceholder')}
                  title={translate('imagine.mediaSearchTitle')}
                  aria-label={translate('imagine.mediaSearchPlaceholder')}
                  onChange={(event) => { setQuery(event.currentTarget.value) }}
                  onKeyDown={(event) => { if (event.key === 'Escape') { setQuery(''); event.currentTarget.blur() } }}
                />
                {query.trim() !== '' && !searching && (
                  <span className={css.searchCount} aria-label={translate('imagine.mediaFilesFound', { count: found })}>{found}</span>
                )}
                {query !== '' && (
                  <button type="button" className={css.searchClear} aria-label={translate('imagine.mediaSearchClear')} onClick={() => { setQuery('') }}>
                    <IconCross />
                  </button>
                )}
              </div>
              <div className={css.menuBox} ref={viewMenu ? menuBox : undefined}>
                <button type="button" className={css.chip} data-compact title={translate('imagine.mediaView')} aria-expanded={viewMenu} onClick={() => { setMenu(open => (open === 'view' ? undefined : 'view')) }}>
                  <IconSquares />
                  <span className={css.label}>{translate('imagine.mediaView')}</span>
                </button>
                {viewMenu && (
                  <div className={css.menu} role="menu">
                    <span className={css.menuHead}>{translate('imagine.mediaView')}</span>
                    {([['full', 'imagine.mediaFull'], ['compact', 'imagine.mediaCompact']] as const).map(([id, labelKey]) => (
                      <button key={id} type="button" role="menuitemradio" aria-checked={prefs.density === id} className={css.menuItem} onClick={() => { setPref({ density: id }) }}>
                        <span className={css.menuLabel}>{translate(labelKey)}</span>
                        {prefs.density === id && <IconCheck />}
                      </button>
                    ))}
                    {/*
                      * The clips in the grid start on their own, as on Grok;
                      * "Still" leaves them as frames (as does the system asking
                      * for reduced motion).
                      */}
                    <span className={css.menuHead}>{translate('imagine.mediaClips')}</span>
                    {([['play', 'imagine.mediaPlaying'], ['still', 'imagine.mediaStill']] as const).map(([id, labelKey]) => (
                      <button key={id} type="button" role="menuitemradio" aria-checked={prefs.clips === id} className={css.menuItem} onClick={() => { setPref({ clips: id }) }}>
                        <span className={css.menuLabel}>{translate(labelKey)}</span>
                        {prefs.clips === id && <IconCheck />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button type="button" className={css.chip} data-compact title={translate('imagine.mediaSelect')} onClick={() => { setSelecting(true) }}>
                <IconPointer />
                <span className={css.label}>{translate('imagine.mediaSelect')}</span>
              </button>
            </>
          )}
      </div>

      <div ref={grid} className={css.grid}>
        {listed.length === 0 && (
          <p className={css.empty}>
            {query.trim() !== ''
              ? translate('imagine.mediaEmptyQuery', { query: query.trim() })
              : tab === 'liked'
                ? translate('imagine.mediaEmptyLiked')
                : tab === 'all' ? translate('imagine.mediaEmptyAll') : translate('imagine.mediaEmptyTag')}
          </p>
        )}
        {stacks.map((stack, index) => {
          const { tops, heights, total } = placed[index] ?? { tops: [], heights: [], total: 0 }
          // The first and last cell that reach into the band.
          let start = 0
          while (start < stack.length && (tops[start] ?? 0) + (heights[start] ?? 0) < band.from) start += 1
          let end = start - 1
          while (end + 1 < stack.length && (tops[end + 1] ?? 0) <= band.to) end += 1
          // A spacer stands for the cells it replaces and the seams between
          // them; the column's own gap supplies the seam next to it. `end` is
          // the last cell drawn or, with none drawn, the last one the spacer
          // above stands for.
          const above = start < stack.length ? (tops[start] ?? 0) - gap : total
          const below = end < 0 ? total : total - (tops[end] ?? 0) - (heights[end] ?? 0) - gap
          return (
            <div key={index} className={css.column} style={{ width: colWidth }}>
              {start > 0 && <div aria-hidden="true" style={{ height: above }} />}
              {stack.slice(start, end + 1).map((item) => {
                const known = itemRatio(item)
                const ratio = known === undefined ? '9 / 16' : `1 / ${String(known)}`
                const on = chosenSet.has(item.name)
                const thumb = thumbUrlOf(item.name, prefs.density === 'compact' ? THUMB_SMALL : THUMB_TILE, item.mtime)
                const badge = (
                  <span className={css.badge} aria-hidden="true"><IconPlayFilled /></span>
                )
                return (
                  <div key={item.name} className={css.cell} data-picked={on || undefined} data-selecting={selecting || undefined} style={{ aspectRatio: ratio }}>
                    <button
                      type="button"
                      className={css.open}
                      aria-label={translate('imagine.openItem', { name: item.name })}
                      onClick={() => {
                        if (selecting) { toggle(item.name); return }
                        /*
                         * A click opens nothing any more: on a clip it turns
                         * the sound on and off, on a photo it does nothing and
                         * waits for the double click. The delay gives the
                         * double click time to arrive: without it, a double
                         * click started the sound and stopped it at once.
                         */
                        if (item.kind !== 'video') return
                        if (openTimer.current !== undefined) globalThis.clearTimeout(openTimer.current)
                        openTimer.current = globalThis.setTimeout(() => {
                          openTimer.current = undefined
                          setHeard(current => (current === item.name ? undefined : item.name))
                        }, 220)
                      }}
                      onDoubleClick={() => {
                        if (openTimer.current !== undefined) {
                          globalThis.clearTimeout(openTimer.current)
                          openTimer.current = undefined
                        }
                        // A double click opens the media large (2026-11-11).
                        onOpenViewer(item, listed)
                      }}
                    >
                      {item.kind === 'video'
                        ? (
                          <LiveClip
                            className={css.media}
                            src={`${mediaUrlOf(item.name)}?v=${String(item.mtime)}`}
                            poster={thumb}
                            live={clipsPlay}
                            suspended={suspended}
                            badge={badge}
                            sound={heard === item.name}
                          />
                        )
                        : <Still className={css.media} lazy src={thumb} />}
                    </button>
                    <button type="button" className={css.pick} data-on={on || undefined} aria-label={on ? translate('imagine.mediaDeselect') : translate('imagine.mediaSelect')} onClick={() => { toggle(item.name) }}>
                      {on && <IconCheck />}
                    </button>
                    {liked.has(item.name) && <span className={css.likedMark} aria-label={translate('imagine.mediaLikedMark')}><IconHeart color="currentColor" /></span>}
                    {/*
                      * A click turns the sound on, a double click opens it
                      * large: the tile's project opens from here, top right
                      * (asked for on 2026-11-11).
                      */}
                    {!selecting && (
                      <button
                        type="button"
                        className={css.openProject}
                        aria-label={translate('imagine.openProjectTile', { name: item.name })}
                        title={translate('imagine.openProjectTile', { name: item.name })}
                        onClick={(event) => { event.stopPropagation(); onOpen(item) }}
                      >
                        <IconFolderCloseRegular size={14} />
                      </button>
                    )}
                    {item.kind !== 'video' && !selecting && (
                      <button type="button" className={css.makeVideo} aria-label={translate('imagine.createVideo')} title={translate('imagine.createVideo')} onClick={() => { onCreateVideo(item) }}>
                        <IconPlayFilled />
                      </button>
                    )}
                  </div>
                )
              })}
              {end < stack.length - 1 && <div aria-hidden="true" style={{ height: below }} />}
            </div>
          )
        })}
      </div>
      <div ref={tail} aria-hidden="true" className={css.tail} />
      <div className={css.composer}>{composer}</div>
      {/* The tag dialog is the studio's Modal: one Escape, taken before the page's own. */}
      {dialog !== undefined && (
        <Modal title={dialog.kind === 'rename' ? translate('imagine.mediaRenameTag') : translate('imagine.mediaNewTag')} className={css.dialog} onClose={() => { setDialog(undefined) }}>
          <form onSubmit={(event) => { event.preventDefault(); submitDialog() }}>
            <input
              className={css.field}
              placeholder={translate('imagine.mediaTagName')}
              aria-label={translate('imagine.mediaTagName')}
              maxLength={60}
              autoFocus
              value={draft}
              onChange={(event) => { setDraft(event.target.value) }}
            />
            <div className={css.dialogActions}>
              <button type="button" className={css.ghost} onClick={() => { setDialog(undefined) }}>{translate('imagine.mediaCancel')}</button>
              <button type="submit" className={css.primary} disabled={draft.trim() === ''}>{dialog.kind === 'rename' ? translate('imagine.save') : translate('imagine.create')}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
