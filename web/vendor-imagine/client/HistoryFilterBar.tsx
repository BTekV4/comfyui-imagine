/**
 * The History's filter bar: how far back, which kinds, which actions, in what
 * order, and on the board or in a list.
 *
 * The seats are the store's own state, so the bar reads what it draws and
 * hands back a whole filter set: no seat keeps a copy of its own.
 */

import { useRef, useState } from 'react'
import {
  HISTORY_KINDS, HISTORY_KIND_KEYS, HISTORY_ORDERS, HISTORY_ORDER_KEYS, HISTORY_ORIGINS,
  HISTORY_ORIGIN_KEYS, HISTORY_PERIODS, HISTORY_PERIOD_KEYS,
  historyNarrowed, type HistoryFilters, type HistoryView,
} from './imagine-filters.ts'
import type { MediaKind } from '../../../shared/imagine-types.ts'
import { Segmented } from './Pills.tsx'
import { useDismiss } from './use-dismiss.ts'
import css from './HistoryFilterBar.module.css'
import { translate } from './locale-store.ts'

/** The board's two layouts, in the order the switch shows them. */
const HISTORY_VIEWS: readonly HistoryView[] = ['grid', 'list']

/** Which of the bar's two menus is open, or none. */
type OpenMenu = 'origin' | 'order' | undefined

/** What the bar needs to draw itself. */
export interface HistoryFilterBarProps {
  /** The seats in force. */
  readonly filters: HistoryFilters
  /** Files each kind seat would keep, the kind filter itself left out. */
  readonly counts: Readonly<Record<MediaKind, number>>
  /** Files the board holds before any filter. */
  readonly total: number
  /** Files the board draws with the seats in force. */
  readonly shown: number
  /** Take a whole new filter set. */
  readonly onChange: (next: HistoryFilters) => void
}

/**
 * Render the History's filter bar.
 * @param props - the seats in force, the counts and the writer.
 * @returns the bar.
 */
export function HistoryFilterBar({ filters, counts, total, shown, onChange }: HistoryFilterBarProps) {
  const [menu, setMenu] = useState<OpenMenu>(undefined)
  const bar = useRef<HTMLDivElement>(null)
  // An open menu closes on a press outside the bar or on Escape.
  useDismiss(bar, () => { setMenu(undefined) }, menu !== undefined)
  const all = counts.image + counts.video + counts.audio
  /** Add or drop one value from one of the two multi-seat lists. */
  const toggle = <T,>(list: readonly T[], value: T): readonly T[] =>
    list.includes(value) ? list.filter(entry => entry !== value) : [...list, value]
  const originLabel = filters.origins.length === 1
    ? translate(HISTORY_ORIGIN_KEYS[filters.origins[0] ?? 'other'])
    : translate('imagine.filterOrigin')

  return (
    <div ref={bar} className={css.bar} data-imagine-tools>
      {/* Single choices: the shared radio group, as on the other pages. */}
      <Segmented
        label={translate('imagine.filterPeriod')}
        values={HISTORY_PERIODS}
        value={filters.period}
        onPick={(period) => { onChange({ ...filters, period }) }}
        format={period => translate(HISTORY_PERIOD_KEYS[period])}
        group={css.seat}
        pill={css.chip}
      />

      <div className={css.seat} role="group" aria-label={translate('imagine.filterKind')}>
        <button
          type="button"
          className={css.chip}
          data-on={filters.kinds.length === 0 || undefined}
          aria-pressed={filters.kinds.length === 0}
          onClick={() => { onChange({ ...filters, kinds: [] }) }}
        >
          {translate('imagine.all', { count: String(all) })}
        </button>
        {HISTORY_KINDS.map(kind => (
          <button
            key={kind}
            type="button"
            className={css.chip}
            data-on={filters.kinds.includes(kind) || undefined}
            aria-pressed={filters.kinds.includes(kind)}
            onClick={() => { onChange({ ...filters, kinds: toggle(filters.kinds, kind) }) }}
          >
            {translate(HISTORY_KIND_KEYS[kind], { count: String(counts[kind]) })}
          </button>
        ))}
      </div>

      <div className={css.seat}>
        <div className={css.menuSeat}>
          <button
            type="button"
            className={css.chip}
            data-on={filters.origins.length > 0 || undefined}
            aria-haspopup="menu"
            aria-expanded={menu === 'origin'}
            onClick={() => { setMenu(current => current === 'origin' ? undefined : 'origin') }}
          >
            {originLabel}
            {filters.origins.length > 1 && <span className={css.badge}>{String(filters.origins.length)}</span>}
          </button>
          {menu === 'origin' && (
            <div className={css.menu} role="menu" aria-label={translate('imagine.filterOrigin')}>
              {HISTORY_ORIGINS.map(origin => (
                <button
                  key={origin}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={filters.origins.includes(origin)}
                  data-on={filters.origins.includes(origin) || undefined}
                  onClick={() => { onChange({ ...filters, origins: toggle(filters.origins, origin) }) }}
                >
                  <span className={css.mark} aria-hidden="true">{filters.origins.includes(origin) ? '✓' : ''}</span>
                  {translate(HISTORY_ORIGIN_KEYS[origin])}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={css.menuSeat}>
          <button
            type="button"
            className={css.chip}
            data-on={filters.order !== 'recent' || undefined}
            aria-haspopup="menu"
            aria-expanded={menu === 'order'}
            onClick={() => { setMenu(current => current === 'order' ? undefined : 'order') }}
          >
            {translate(HISTORY_ORDER_KEYS[filters.order])}
          </button>
          {menu === 'order' && (
            <div className={css.menu} role="menu" aria-label={translate('imagine.filterOrder')}>
              {HISTORY_ORDERS.map(order => (
                <button
                  key={order}
                  type="button"
                  role="menuitemradio"
                  aria-checked={filters.order === order}
                  data-on={filters.order === order || undefined}
                  onClick={() => {
                    onChange({ ...filters, order })
                    setMenu(undefined)
                  }}
                >
                  <span className={css.mark} aria-hidden="true">{filters.order === order ? '✓' : ''}</span>
                  {translate(HISTORY_ORDER_KEYS[order])}
                </button>
              ))}
            </div>
          )}
        </div>

        <Segmented
          label={translate('imagine.filterView')}
          values={HISTORY_VIEWS}
          value={filters.view}
          onPick={(view) => { onChange({ ...filters, view }) }}
          format={view => translate(view === 'grid' ? 'imagine.viewGrid' : 'imagine.viewList')}
          group={css.seat}
          pill={css.chip}
        />
      </div>

      <span className={css.count} data-history-count={String(shown)}>
        {translate('imagine.filterCount', { shown: String(shown), total: String(total) })}
      </span>
      {historyNarrowed(filters) && (
        <button
          type="button"
          className={css.clear}
          onClick={() => { onChange({ ...filters, period: 'all', kinds: [], origins: [] }) }}
        >
          {translate('imagine.filterClear')}
        </button>
      )}
    </div>
  )
}
