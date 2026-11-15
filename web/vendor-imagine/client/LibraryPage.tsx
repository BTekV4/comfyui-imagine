/**
 * "Library" (2026-10-17, from Grok Imagine's Library): every file the studio
 * holds as a plain grid, grouped by when it was made, with a type tab and a
 * search. The History board shows the same files as a canvas; this is the
 * page for finding one.
 *
 * Opening a card takes the user to the file on its project's board, selected,
 * the way a chat result does.
 */
import { translate } from './locale-store.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatClock } from './format.ts'
import { ageLabel, sizeLabel } from './labels.ts'
import { Still } from './Still.tsx'
import { mediaUrlOf, thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import { kindCounts, toolLabelOf } from './imagine-filters.ts'
import { bandAround, useGrowOnTail, useScrollMeasure } from './use-scroll-band.ts'
import type { GalleryItem, MediaKind } from '../../../shared/imagine-types.ts'
import css from './LibraryPage.module.css'

type Tab = 'all' | MediaKind
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'all', label: translate('imagine.libAll') },
  { id: 'image', label: translate('imagine.libImages') },
  { id: 'video', label: translate('imagine.libVideos') },
  { id: 'audio', label: translate('imagine.libAudios') },
]

const DAY = 24 * 60 * 60 * 1000

/**
 * The date group a file falls in, newest first.
 * @param mtime - when the file was written.
 * @param today - local midnight that opened today.
 */
function groupOf(mtime: number, today: number): string {
  if (mtime >= today) return translate('imagine.libToday')
  if (mtime >= today - DAY) return translate('imagine.libYesterday')
  if (mtime >= today - 6 * DAY) return translate('imagine.libWeek')
  if (mtime >= today - 29 * DAY) return translate('imagine.libMonth')
  return translate('imagine.libEarlier')
}

/** Cards drawn per step: the inventory runs to thousands of files. */
const PAGE = 120


/** The grid's measured shape: cards per row, a row's height and the gap under it. */
interface GridShape {
  readonly columns: number
  readonly row: number
  readonly gap: number
}

/** Per date group, the first and last row worth drawing. */
type RowBands = Readonly<Record<string, readonly [number, number]>>

export interface LibraryPageProps {
  readonly items: readonly GalleryItem[]
  /** The project a file is on, by file name, when it is on one. */
  readonly projectOf: (name: string) => string | undefined
  readonly onOpen: (item: GalleryItem) => void
  readonly onUpload: (files: readonly File[]) => void
}

export function LibraryPage({ items, projectOf, onOpen, onUpload }: LibraryPageProps) {
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)
  const picker = useRef<HTMLInputElement>(null)
  const tail = useRef<HTMLDivElement>(null)
  const page = useRef<HTMLDivElement>(null)
  const now = Date.now()

  useEffect(() => { setShown(PAGE) }, [tab, query])

  const counts = useMemo(() => ({ all: items.length, ...kindCounts(items) }), [items])

  // The inventory comes newest first from the host, which is the order drawn:
  // no copy, no sort.
  const matching = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (tab === 'all' && words.length === 0) return items
    return items.filter((item) => {
      if (tab !== 'all' && item.kind !== tab) return false
      if (words.length === 0) return true
      const hay = `${item.name} ${toolLabelOf(item)} ${projectOf(item.name) ?? ''}`.toLowerCase()
      return words.every(word => hay.includes(word))
    })
  }, [items, tab, query, projectOf])

  // More cards as the end of the grid comes into view.
  useGrowOnTail(tail, shown, matching.length, () => { setShown(current => current + PAGE) }, '600px')

  // Grouped again only when the list, the page or the day changes, not on
  // every render of the page around it.
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  const groups = useMemo(() => {
    const out: { title: string; files: GalleryItem[] }[] = []
    for (const item of matching.slice(0, shown)) {
      const title = groupOf(item.mtime, today)
      const last = out[out.length - 1]
      if (last?.title === title) last.files.push(item)
      else out.push({ title, files: [item] })
    }
    return out
  }, [matching, shown, today])

  /*
   * The rows worth drawing, as Media's band does (D16, 2026-11-07): the pages
   * above add cards and never took any away, so after a long scroll thousands
   * of cards sat in the DOM. The cards are all one size (a 4:3 thumb and two
   * one-line labels), so a grid's rows are measured once and the rows out of
   * the band become one spacer each side, as tall as what they replace: the
   * page scrolls and looks the same. Quantized, so a scroll re-renders once
   * per step.
   */
  const [shape, setShape] = useState<GridShape>({ columns: 1, row: 0, gap: 0 })
  const [bands, setBands] = useState<RowBands>({})
  // Measured again whenever the drawn groups change: their tops move.
  useScrollMeasure(page, () => {
    const box = page.current
    if (box === null) return
    const grids = [...box.querySelectorAll<HTMLElement>('[data-library-grid]')]
    const first = grids[0]
    const card = box.querySelector<HTMLElement>('[data-library-card]')
    if (first === undefined || card === null) return
    const style = getComputedStyle(first)
    const next: GridShape = {
      columns: Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length),
      row: card.offsetHeight,
      gap: Number.parseFloat(style.rowGap) || 0,
    }
    setShape(current => (current.columns === next.columns && current.row === next.row && current.gap === next.gap ? current : next))
    const pitch = next.row + next.gap
    if (pitch <= 0) return
    const origin = box.getBoundingClientRect().top - box.scrollTop
    const { from, to } = bandAround(box.scrollTop, box.clientHeight)
    const found: Record<string, readonly [number, number]> = {}
    for (const grid of grids) {
      const top = grid.getBoundingClientRect().top - origin
      found[grid.dataset['libraryGrid'] ?? ''] = [Math.max(0, Math.floor((from - top) / pitch)), Math.floor((to - top) / pitch)]
    }
    setBands(current => (JSON.stringify(current) === JSON.stringify(found) ? current : found))
  }, groups, 'frame')

  return (
    <div ref={page} className={css.page}>
      <div className={css.bar}>
        <div className={css.tabs} role="tablist" aria-label={translate('imagine.libKind')}>
          {TABS.map(entry => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={css.tab}
              data-on={tab === entry.id || undefined}
              onClick={() => { setTab(entry.id) }}
            >
              {entry.label}
              <span className={css.count}>{String(counts[entry.id])}</span>
            </button>
          ))}
        </div>
        <input
          className={css.search}
          type="search"
          value={query}
          placeholder={translate('imagine.libSearch')}
          aria-label={translate('imagine.libSearch')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <button type="button" className={css.upload} onClick={() => { picker.current?.click() }}>{translate('imagine.libUpload')}</button>
        <input
          ref={picker}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          hidden
          onChange={(event) => {
            const files = [...event.target.files ?? []]
            event.target.value = ''
            if (files.length > 0) onUpload(files)
          }}
        />
      </div>

      {matching.length === 0 && (
        <p className={css.empty}>{query.trim() === '' ? translate('imagine.libEmptyKind') : translate('imagine.libEmptySearch')}</p>
      )}

      {groups.map((group) => {
        // Unmeasured yet: every card of the page is drawn, as before.
        const rows = Math.ceil(group.files.length / shape.columns)
        const [firstRow, lastRow] = shape.row > 0 ? bands[group.title] ?? [0, rows - 1] : [0, rows - 1]
        const start = Math.min(rows, firstRow)
        const end = Math.max(start, Math.min(rows, lastRow + 1))
        // A spacer stands for its rows and the gaps between them; the grid's
        // own gap supplies the one beside it.
        const spacer = (count: number): number => count * shape.row + Math.max(0, count - 1) * shape.gap
        return (
          <section key={group.title} className={css.group}>
            <h2 className={css.groupTitle}>{group.title}</h2>
            <div className={css.grid} data-library-grid={group.title}>
              {start > 0 && <div aria-hidden="true" style={{ gridColumn: '1 / -1', height: spacer(start) }} />}
              {group.files.slice(start * shape.columns, end * shape.columns).map((item) => {
                const project = projectOf(item.name)
                return (
                  <div key={item.name} className={css.card} data-library-card>
                    <button type="button" className={css.thumb} onClick={() => { onOpen(item) }} title={item.name} aria-label={translate('imagine.openNamed', { name: project === undefined ? toolLabelOf(item) : translate('imagine.label.inProject', { label: toolLabelOf(item), project }) })}>
                      {item.kind === 'audio'
                        ? <span className={css.audio} aria-hidden="true">♪</span>
                        : <Still className={css.still} lazy src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} />}
                      {item.kind === 'video' && item.duration !== undefined && <span className={css.badge}>{formatClock(item.duration)}</span>}
                    </button>
                    <div className={css.meta}>
                      <span className={css.name}>{project ?? toolLabelOf(item)}</span>
                      <span className={css.sub}>
                        {`${project === undefined ? '' : `${toolLabelOf(item)} · `}${ageLabel(item.mtime, now)} · ${sizeLabel(item.size)}`}
                      </span>
                    </div>
                    <a className={css.download} href={mediaUrlOf(item.name)} download={item.name} aria-label={translate('imagine.download')} title={translate('imagine.download')}>↓</a>
                  </div>
                )
              })}
              {end < rows && <div aria-hidden="true" style={{ gridColumn: '1 / -1', height: spacer(rows - end) }} />}
            </div>
          </section>
        )
      })}
      <div ref={tail} aria-hidden="true" />
    </div>
  )
}
