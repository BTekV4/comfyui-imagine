/**
 * The History as a list: one row per file, with the name, the action it came
 * from, when it was written and how big it is.
 *
 * The board answers "what does my work look like"; a list answers "what did I
 * make on Tuesday", which is the question a filter leaves behind. Opening a row
 * is the same gesture as opening a tile, so the viewer's own filmstrip walks
 * the filtered set in the order the list is showing.
 * @module HistoryList
 */

import { Still } from './Still.tsx'
import { THUMB_SMALL, thumbUrlOf } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { HISTORY_ORIGIN_KEYS, originOf } from './imagine-filters.ts'
import { HISTORY_PAGE } from './imagine-projects.ts'
import { dateStamp } from './dates.ts'
import { sizeLabel } from './labels.ts'
import css from './HistoryList.module.css'
import { translate } from './locale-store.ts'

/** What the list needs to draw itself. */
export interface HistoryListProps {
  /** The files to draw, already filtered, ordered and paged. */
  readonly items: readonly GalleryItem[]
  /** Open one file in the viewer. */
  readonly onOpen: (item: GalleryItem) => void
  /** Files the filter kept but the page has not shown, when there are any. */
  readonly more: number
  /** Show the next page. */
  readonly onMore: () => void
}

/**
 * Render the History's rows.
 * @param props - the files, the opener and the paging.
 * @returns the list.
 */
export function HistoryList({ items, onOpen, more, onMore }: HistoryListProps) {
  return (
    <div className={css.list}>
      {items.map(item => (
        <button
          key={item.name}
          type="button"
          className={css.row}
          data-history-row={item.name}
          onClick={() => { onOpen(item) }}
        >
          <span className={css.thumb}>
            {item.kind === 'audio'
              ? <span className={css.audioThumb} aria-hidden="true">♪</span>
              : <Still src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} lazy />}
          </span>
          <span className={css.name}>{item.name}</span>
          <span className={css.origin}>{translate(HISTORY_ORIGIN_KEYS[originOf(item.tool)])}</span>
          <span className={css.meta}>{dateStamp(item.mtime)}</span>
          <span className={css.meta}>{sizeLabel(item.size)}</span>
        </button>
      ))}
      {more > 0 && (
        <button
          type="button"
          className={css.more}
          onClick={onMore}
        >
          {translate('imagine.historyMore', {
            count: String(Math.min(more, HISTORY_PAGE)),
            total: String(more),
          })}
        </button>
      )}
    </div>
  )
}
