/**
 * The composer's "+": one place to pick what to send with the next line.
 *
 * Before this, the "+" opened the system file dialog and nothing else: a
 * picture the studio had just made, or one the user uploaded yesterday, had to
 * be found on the board, staged with a click there, or dragged in. The panel
 * shows the two lists the studio already has — the gallery (newest first) and
 * what came in through the upload route — filters them with the search the
 * Media page already asks (`/api/media-search`), and stages a click at a time
 * into the same composer the rest of the page stages into: the removable
 * thumbnails above the text field are that staging, not a second one.
 *
 * Nothing here is a new archive: "Creations" is the gallery minus the uploads,
 * "Uploads" is the uploads, and the ceiling is the chat's own
 * (`MAX_STAGED_FILES`), since one written line is one run per staged file.
 * @module MediaPicker
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { IconCross, IconSearchOutlineRegular } from '../../shims/primitives/index.ts'
import { translate } from './locale-store.ts'
import { searchMedia, THUMB_SMALL, thumbUrlOf } from './gallery-api.ts'
import { Still } from './Still.tsx'
import { AudioMark } from './imagine-bits.tsx'
import { moreShown, pageSlice, pickerTabs, PICKER_PAGE, type PickerTabs } from './media-picker-model.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import css from './MediaPicker.module.css'

/** The two tabs, in the order the panel lists them. */
const TABS = [
  { id: 'creations', label: 'imagine.pickerCreations' },
  { id: 'uploads', label: 'imagine.uploads' },
] as const

/** One tab's name. */
type PickerTab = typeof TABS[number]['id']

/** How long the search box waits before asking the host. */
const SEARCH_PAUSE_MS = 220

export interface MediaPickerProps {
  /** The whole inventory, newest first, as the page already holds it. */
  readonly gallery: readonly GalleryItem[]
  /** What the composer holds right now: the removable thumbnails above the field. */
  readonly staged: readonly GalleryItem[]
  /** The staging's ceiling: the chat's own. */
  readonly limit: number
  /** Add one file to the staging, or take it out. */
  readonly onToggle: (item: GalleryItem) => void
  /** Upload files from the disk, or dropped on the panel. */
  readonly onUpload: (files: readonly File[]) => void
  /** Close the panel: the staging stays as it is. */
  readonly onClose: () => void
  /**
   * Where the panel stands, measured by the composer: the width of the viewport
   * on a phone (undefined, and the stylesheet draws the sheet), or the
   * coordinates of the room beside the composer on a desktop.
   */
  readonly style?: CSSProperties | undefined
  /**
   * The composer the panel belongs to. A press there is not "outside": the
   * strip of removable thumbnails is the same staging as this grid, and taking
   * one out must not shut the panel on the way back to pick another.
   */
  readonly owner?: () => Element | null
}

/**
 * The media panel: two lists on the left, the thumbnails on the right.
 * @param props - the gallery, the staging and the actions.
 * @returns the panel, to be placed by the composer beside its "+".
 */
export function MediaPicker({ gallery, staged, limit, onToggle, onUpload, onClose, style, owner }: MediaPickerProps) {
  const [tab, setTab] = useState<PickerTab>('creations')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ReadonlySet<string> | undefined>(undefined)
  const [searching, setSearching] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [shown, setShown] = useState(PICKER_PAGE)
  const box = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const belongsTo = useRef(owner)
  belongsTo.current = owner

  /*
   * Escape closes the panel and goes no further: the page answers the same key
   * by clearing the board's selection, and a panel over the canvas is not a
   * reason to lose it. Capture, as the dialogs do.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      // The first Escape empties a filled search box; the next one leaves.
      const field = search.current
      if (field !== null && document.activeElement === field && field.value !== '') {
        setQuery('')
        return
      }
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    search.current?.focus()
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [])
  // A press anywhere else closes it, as every other popup of the studio does —
  // except inside the composer it belongs to (see `owner`).
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      const node = box.current
      if (node === null) return
      const target = event.target as Node
      if (node.contains(target)) return
      if (belongsTo.current?.()?.contains(target) === true) return
      close.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('pointerdown', onDown, true) }
  }, [])

  /*
   * The search is the Media page's own: the server keeps an index of the words
   * a file was made with and of what a vision pass saw in it, because the file
   * names are opaque. One pause between typing and asking, so a word is not
   * sent once per key.
   */
  useEffect(() => {
    const asked = query.trim()
    if (asked === '') {
      setHits(undefined)
      setSearching(false)
      return
    }
    setSearching(true)
    let live = true
    const timer = setTimeout(() => {
      searchMedia(asked).then((answer) => {
        if (!live) return
        setHits(new Set(answer?.names ?? []))
        setSearching(false)
      }, () => {
        if (!live) return
        setHits(new Set())
        setSearching(false)
      })
    }, SEARCH_PAUSE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [query])

  const lists: PickerTabs = pickerTabs(gallery)
  const listed = (tab === 'creations' ? lists.creations : lists.uploads)
    .filter(item => hits === undefined || hits.has(item.name))
  // A page of tiles at a time: a gallery of thousands is not thousands of
  // nodes to lay out before the first one is seen.
  const drawn = pageSlice(listed, shown)
  const more = listed.length - drawn.length
  const stagedNames = new Set(staged.map(item => item.name))
  const full = staged.length >= limit
  const attached = `${String(staged.length)}/${String(limit)}`

  const take = (files: readonly File[]): void => {
    if (files.length > 0) onUpload(files)
  }
  // Another list starts from its first page: the scroll is the list's own.
  useEffect(() => { setShown(PICKER_PAGE) }, [tab, hits])

  /*
   * Into `document.body`, not where the composer sits: a project's chat column
   * is a stacking context of its own (`z-index: 3`, and a backdrop filter), so
   * a panel drawn inside it came out under the board and could not be clicked.
   * A portal leaves the column behind, and the composer hands it the
   * coordinates of the room it measured.
   */
  return createPortal(
    <div
      ref={box}
      className={css.picker}
      role="dialog"
      aria-label={translate('imagine.pickerTitle')}
      style={style}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDropping(true)
      }}
      onDragLeave={(event) => {
        // Leaving for a child is not leaving the panel.
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setDropping(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDropping(false)
        take(Array.from(event.dataTransfer.files))
      }}
      data-dropping={dropping || undefined}
    >
      <div className={css.head}>
        <span className={css.title}>{translate('imagine.pickerTitle')}</span>
        <span className={css.counter} data-full={full || undefined}>{attached}</span>
        <button type="button" className={css.close} aria-label={translate('imagine.closeShort')} onClick={onClose}>×</button>
      </div>
      <div className={css.body}>
        <div className={css.rail} role="tablist" aria-label={translate('imagine.pickerTitle')}>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={css.tab}
              data-on={tab === entry.id || undefined}
              onClick={() => { setTab(entry.id) }}
            >
              <span className={css.tabLabel}>{translate(entry.label)}</span>
              <span className={css.tabCount}>{String(entry.id === 'creations' ? lists.creations.length : lists.uploads.length)}</span>
            </button>
          ))}
          <span className={css.railFoot}>
            {/*
              * "Draw" is not here on purpose: the studio's mask painter erases
              * a zone of a photo (IOPaint), and nothing turns a sketch into a
              * picture, so a button that promised it would be a door onto a
              * wall. Upload is the one action this panel can really do.
              */}
            <button type="button" className={css.upload} onClick={() => { picker.current?.click() }}>
              {translate('imagine.pickerUpload')}
            </button>
            <input
              ref={picker}
              className={css.hiddenFile}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.mov,audio/mpeg,audio/wav,audio/flac,audio/ogg,audio/mp4"
              multiple
              onChange={(event) => {
                const files = [...event.target.files ?? []]
                event.target.value = ''
                take(files)
              }}
            />
          </span>
        </div>
        <div className={css.pane}>
          <div className={css.search} data-busy={searching || undefined}>
            <IconSearchOutlineRegular size={16} />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder={translate('imagine.pickerSearch')}
              aria-label={translate('imagine.pickerSearch')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
            {query !== '' && (
              <button type="button" className={css.searchClear} aria-label={translate('imagine.mediaSearchClear')} onClick={() => { setQuery('') }}>
                <IconCross />
              </button>
            )}
          </div>
          <div
            className={css.grid}
            data-picker-grid
            onScroll={(event) => {
              const node = event.currentTarget
              if (node.scrollHeight - node.scrollTop - node.clientHeight > 240) return
              setShown(current => moreShown(current, listed.length))
            }}
          >
            {drawn.map(item => (
              <PickerTile
                key={item.name}
                item={item}
                attached={stagedNames.has(item.name)}
                onPick={() => { onToggle(item) }}
              />
            ))}
            {more > 0 && (
              <button
                type="button"
                className={css.more}
                data-picker-more
                onClick={() => { setShown(current => moreShown(current, listed.length)) }}
              >
                {translate('imagine.showMore', { count: more })}
              </button>
            )}
            {listed.length === 0 && (
              <p className={css.empty}>
                {query.trim() !== ''
                  ? translate('imagine.libEmptySearch')
                  : translate(tab === 'creations' ? 'imagine.pickerEmptyCreations' : 'imagine.pickerEmptyUploads')}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className={css.foot}>
        <span className={css.hint}>
          {full ? translate('imagine.pickerFull', { max: String(limit) }) : translate('imagine.pickerHint')}
        </span>
        <button type="button" className={css.done} onClick={onClose}>{translate('imagine.pickerDone')}</button>
      </div>
      {dropping && <span className={css.dropNote}>{translate('imagine.dropHere')}</span>}
    </div>,
    document.body,
  )
}

/**
 * One file of the grid: a thumbnail, and whether the composer holds it.
 *
 * A click stages it or takes it out at once (the removable thumbnails above
 * the text field are the same list), so there is no second "add" step and the
 * panel can stay open for a selection of several.
 */
function PickerTile({ item, attached, onPick }: { item: GalleryItem; attached: boolean; onPick: () => void }) {
  const label = translate(attached ? 'imagine.removeNamed' : 'imagine.pickerAttach', { name: item.name })
  return (
    <button
      type="button"
      className={css.tile}
      data-on={attached || undefined}
      aria-pressed={attached}
      aria-label={label}
      title={label}
      onClick={onPick}
    >
      {item.kind === 'audio'
        ? <AudioMark className={css.audio} />
        : <Still className={css.thumb} src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} lazy />}
      {item.kind === 'video' && <span className={css.videoMark} aria-hidden="true">▶</span>}
      {attached && <span className={css.checkMark} aria-hidden="true">✓</span>}
    </button>
  )
}
