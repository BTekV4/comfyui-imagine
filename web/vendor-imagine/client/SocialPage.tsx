/**
 * The publication page: a month calendar of what is going out, with the drafts
 * and the failures beside it.
 *
 * The queue publishes on the host's clock, so this page is a view of state
 * that changes without anyone touching it — the caller reloads on a timer and
 * hands the list down.
 *
 * Redrawn on 2026-11-13 because it read as a wall of clipped captions: the
 * month now shows each post as its picture and its hour, a click on a day
 * opens that day's list beside the month (the only place a caption is read in
 * full), and the week is seven columns of posts instead of 24 hour rows that
 * were empty but for a pile of forty chips in one cell.
 */

import { translate } from './locale-store.ts'
import { useMemo, useState, type KeyboardEvent } from 'react'
import type { SocialPost } from './gallery-api.ts'
import { thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import { WEEKDAYS, monthName, weekdayOf } from './dates.ts'
import { clockStamp } from './format.ts'
import { InstagramMark } from './instagram-mark.tsx'
import { postStatusLabel } from './labels.ts'
import { Still } from './Still.tsx'
import { Segmented } from './Pills.tsx'
import type { ComfyLocaleKey } from './locales.ts'
import { SocialComments } from './SocialComments.tsx'
import { SocialStories } from './SocialStories.tsx'
import css from './SocialPage.module.css'

/** Props for the publication page. */
export interface SocialPageProps {
  /** The queue, newest first. */
  readonly posts: readonly SocialPost[]
  /** Open one post in the editor. */
  readonly onOpen: (post: SocialPost) => void
}

/** How many posts one day of the month lists before it says how many more. */
const DAY_ROWS = 4

/** How many posts one column of the week lists before it says how many more. */
const WEEK_ROWS = 6

/**
 * The day a post belongs to: when it is going out, or when it went.
 * @param post - the queued post.
 * @returns the instant, or undefined for a draft with no date.
 */
function dayOf(post: SocialPost): Date | undefined {
  const iso = post.status === 'published' ? post.publishedAt ?? post.scheduledAt : post.scheduledAt
  if (iso === undefined) return undefined
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** A stable key for one calendar day, in the viewer's own zone. */
function dayKey(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1)}-${String(date.getDate())}`
}

/** Midnight of the day holding a date. */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * The dated posts, bucketed by day and sorted by the clock inside each day.
 * @param posts - the queue.
 * @returns the buckets; a post with no date is in none.
 */
function groupByDay(posts: readonly SocialPost[]): Map<string, SocialPost[]> {
  const map = new Map<string, SocialPost[]>()
  for (const post of posts) {
    const when = dayOf(post)
    if (when === undefined) continue
    const key = dayKey(when)
    const bucket = map.get(key)
    if (bucket === undefined) map.set(key, [post])
    else bucket.push(post)
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => (dayOf(a)?.getTime() ?? 0) - (dayOf(b)?.getTime() ?? 0))
  }
  return map
}

/**
 * Build the six-week grid a month is drawn on.
 * @param month - any instant inside the month to draw.
 * @returns 42 days, starting on the Monday on or before the first.
 */
function monthGrid(month: Date): readonly Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  // getDay is Sunday-first; shift so Monday is 0.
  const lead = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead)
  const days = Array.from({ length: 42 }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  // A sixth row made only of next month's days is dead space: drop it.
  const sixth = days[35]
  return sixth !== undefined && sixth.getMonth() !== first.getMonth() ? days.slice(0, 35) : days
}

/**
 * The seven days of the week holding a date, Monday first.
 * @param inside - any instant inside the week to draw.
 * @returns the seven days.
 */
function weekDays(inside: Date): readonly Date[] {
  const back = (inside.getDay() + 6) % 7
  const monday = new Date(inside.getFullYear(), inside.getMonth(), inside.getDate() - back)
  return Array.from({ length: 7 }, (_, i) =>
    new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))
}

/** How many attempts the publisher makes before it gives up and notifies. */
const MAX_ATTEMPTS = 3

/**
 * What to say under a failed post about the attempt still to come.
 *
 * A transient failure — an upload the watchdog killed, a 5xx from Meta — goes
 * back in line by itself, and this is the only place that says so. Without it
 * the row reads the same whether the publisher is coming back in five minutes
 * or has already given up, which is the difference between waiting and doing
 * something about it.
 * @param post - the failed post.
 * @returns the note, or undefined when no attempt is scheduled.
 */
function retryNote(post: SocialPost): string | undefined {
  if (post.nextAttemptAt === undefined) return undefined
  const at = new Date(post.nextAttemptAt)
  if (Number.isNaN(at.getTime())) return undefined
  const attempt = (post.attempts ?? 0) + 1
  const minutes = Math.round((at.getTime() - Date.now()) / 60000)
  // A date already past means the next tick takes it: saying "in -2 minutes"
  // would be worse than saying nothing about the clock.
  const when = minutes > 0 ? translate('imagine.retryIn', { count: minutes }) : translate('imagine.retryNextCheck')
  return translate('imagine.retryAttempt', { when, attempt, max: MAX_ATTEMPTS })
}

/** The first line of a caption, or the placeholder for none. */
function headline(post: SocialPost): string {
  return post.caption.split('\n')[0]?.trim() || translate('imagine.noCaption')
}

/** What kind of post it is, in a word: reel, photo, or how many photos. */
function kindLabel(post: SocialPost): string {
  if (post.kind === 'reel') return translate('imagine.socialKindReel')
  if (post.files.length > 1) return translate('imagine.photoCount', { count: post.files.length })
  return translate('imagine.socialKindPhoto')
}

/** A post's day and hour in words, for a row that does not sit on its date. */
function dayAndTime(when: Date): string {
  return `${String(when.getDate())} ${monthName(when.getMonth(), true)} · ${clockStamp(when.getTime())}`
}

/**
 * The thumbnail of a post with its state on the frame, so the state reads
 * even where there is no room for a word.
 * @param props - the post and the size class the caller wants.
 * @returns the picture, or an empty bed for a post with no file.
 */
function Thumb({ post, className }: { post: SocialPost; className: string | undefined }) {
  const first = post.files[0]
  return (
    <span className={`${css.thumb ?? ''} ${className ?? ''}`} data-status={post.status}>
      {first !== undefined && <Still className={css.thumbImg} lazy src={thumbUrlOf(first, THUMB_SMALL)} />}
      {post.kind === 'reel' && <span className={css.reelMark} aria-hidden="true">▶</span>}
    </span>
  )
}

/**
 * One post as a full row: picture, hour, state, kind and the caption on two
 * lines. The day list, the week and the lists below all use it.
 * @param props - the post, what a click does, and whether to say the date.
 * @returns the row.
 */
function PostCard({ post, onOpen, showDate, compact }: {
  post: SocialPost
  onOpen: (post: SocialPost) => void
  showDate?: boolean
  compact?: boolean
}) {
  const when = dayOf(post)
  return (
    <button
      type="button"
      className={css.card}
      data-status={post.status}
      data-compact={compact === true || undefined}
      onClick={() => { onOpen(post) }}
      title={post.error ?? post.caption}
    >
      <Thumb post={post} className={css.cardThumb} />
      <span className={css.cardText}>
        <span className={css.cardTop}>
          {when !== undefined && (
            <strong className={css.cardTime}>
              {showDate === true ? dayAndTime(when) : clockStamp(when.getTime())}
            </strong>
          )}
          <span className={css.badge} data-status={post.status}>{postStatusLabel(post.status)}</span>
        </span>
        <span className={css.cardCaption}>{headline(post)}</span>
        <span className={css.cardMeta}>
          {kindLabel(post)}
          {post.status === 'publishing' && post.progress !== undefined ? ` · ${post.progress}` : ''}
        </span>
      </span>
    </button>
  )
}

/**
 * One count of the queue, dotted in that state's colour. It doubles as the
 * legend of the colours the calendar uses.
 * @param props - the state, the count, and how it reads in the singular and plural.
 * @returns the pill, or nothing when the count is zero.
 */
function Pill({ kind, n, one, many }: { kind: string; n: number; one: string; many: string }) {
  if (n === 0) return null
  return (
    <span className={css.pill} data-status={kind}>
      <span className={css.pillDot} aria-hidden="true" />
      <strong>{String(n)}</strong>
      <span>{n === 1 ? one : many}</span>
    </span>
  )
}

/**
 * The counts of a list of posts by state.
 * @param props - the posts.
 * @returns the pills.
 */
function Counts({ posts }: { posts: readonly SocialPost[] }) {
  const count = (status: SocialPost['status']) => posts.filter(p => p.status === status).length
  return (
    <>
      <Pill kind="scheduled" n={count('scheduled')} one={translate('imagine.socialPillScheduled')} many={translate('imagine.socialPillScheduled')} />
      <Pill kind="publishing" n={count('publishing')} one={translate('imagine.postStatusPublishing')} many={translate('imagine.postStatusPublishing')} />
      <Pill kind="draft" n={count('draft')} one={translate('imagine.socialPillDraft')} many={translate('imagine.socialPillDrafts')} />
      <Pill kind="published" n={count('published')} one={translate('imagine.socialPillPublished')} many={translate('imagine.socialPillPublishedMany')} />
      <Pill kind="error" n={count('error')} one={translate('imagine.socialPillError')} many={translate('imagine.socialPillErrors')} />
    </>
  )
}

/** The page's three views. */
const SOCIAL_TABS = ['calendar', 'stories', 'comments'] as const
type SocialTab = typeof SOCIAL_TABS[number]
const SOCIAL_TAB_KEYS: Readonly<Record<SocialTab, ComfyLocaleKey>> = {
  calendar: 'imagine.socialCalendar',
  stories: 'imagine.socialStories',
  comments: 'imagine.socialComments',
}

/** The calendar's two spans. */
const CALENDAR_MODES = ['month', 'week'] as const

/**
 * The publication page: month calendar plus the lists that have no date.
 * @param props - the queue and the editor callback.
 * @returns the page.
 */
export function SocialPage({ posts, onOpen }: SocialPageProps) {
  const [cursor, setCursor] = useState(() => new Date())
  // The day whose posts are listed beside the month.
  const [picked, setPicked] = useState(() => startOfDay(new Date()))
  const [mode, setMode] = useState<'month' | 'week'>('month')
  // The comments are their own view, not a section below the grid: as a
  // section they ran to seventeen cards and the calendar was off screen
  // before the first of them.
  const [tab, setTab] = useState<SocialTab>('calendar')
  // Which post's comments are on screen, when the comments were reached by
  // clicking one rather than by the tab.
  // Spread into SocialComments rather than passed as undefined: the two props
  // travel together, and under exactOptionalPropertyTypes an explicit
  // undefined is not the same as an absent prop.
  const [focus, setFocus] = useState<string | undefined>(undefined)

  /**
   * What a click on a post in the calendar does.
   *
   * A post that has gone out cannot be scheduled or re-captioned any more, so
   * the publish panel has nothing left to offer it: the live thing about a
   * published post is what people wrote under it. One with no permalink is the
   * exception — there is no thread to show, so it still opens the panel, which
   * at least lets it be dropped from the queue.
   */
  const open = (post: SocialPost) => {
    if (post.status === 'published' && post.instagramUrl !== undefined) {
      setFocus(post.instagramUrl)
      setTab('comments')
      return
    }
    onOpen(post)
  }

  const byDay = useMemo(() => groupByDay(posts), [posts])

  const drafts = posts.filter(p => p.status === 'draft')
  const failed = posts.filter(p => p.status === 'error')
  const days = useMemo(() => monthGrid(cursor), [cursor])
  const week = useMemo(() => weekDays(cursor), [cursor])
  const todayKey = dayKey(new Date())
  // Keyed on today's date, so a page left open past midnight moves with it.
  const startOfToday = useMemo(() => startOfDay(new Date()).getTime(), [todayKey])
  const month = cursor.getMonth()
  const pickedKey = dayKey(picked)
  const pickedPosts = byDay.get(pickedKey) ?? []
  // The month's own counts: the pills say what this page shows, not the whole history.
  const monthPosts = useMemo(
    () => posts.filter((p) => {
      const when = dayOf(p)
      return when !== undefined && when.getMonth() === month && when.getFullYear() === cursor.getFullYear()
    }),
    [posts, month, cursor],
  )

  /** Show a day: the list beside the month, and the month it is in. */
  const pick = (day: Date) => {
    setPicked(startOfDay(day))
    setCursor(day)
  }

  // One step means a month or a week, whichever is on screen. Moving the
  // month moves the listed day to its first, or to today in today's month.
  const step = (direction: number) => {
    if (mode === 'week') {
      setCursor(c => new Date(c.getFullYear(), c.getMonth(), c.getDate() + direction * 7))
      return
    }
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1)
    const now = new Date()
    const inMonth = now.getMonth() === next.getMonth() && now.getFullYear() === next.getFullYear()
    setCursor(next)
    setPicked(startOfDay(inMonth ? now : next))
  }

  const first = week[0]
  const last = week[6]
  const spanLabel = mode === 'month' || first === undefined || last === undefined
    ? `${monthName(month)} ${String(cursor.getFullYear())}`
    : first.getMonth() === last.getMonth()
      ? `${String(first.getDate())}–${String(last.getDate())} ${monthName(first.getMonth())}`
      : `${String(first.getDate())} ${monthName(first.getMonth(), true)} – ${String(last.getDate())} ${monthName(last.getMonth(), true)}`

  /** Enter or space on a day cell picks it, like a click. */
  const pickByKey = (event: KeyboardEvent, day: Date) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    pick(day)
  }

  const dayPanel = (
    <aside className={css.dayPanel} aria-live="polite">
      <div className={css.dayPanelHead}>
        <span className={css.dayPanelWeekday}>{weekdayOf(picked)}</span>
        <span className={css.dayPanelDate}>
          {`${String(picked.getDate())} ${monthName(picked.getMonth())}`}
        </span>
        {pickedKey === todayKey && <span className={css.todayTag}>{translate('imagine.socialToday')}</span>}
      </div>
      {pickedPosts.length > 0 && <div className={css.pills}><Counts posts={pickedPosts} /></div>}
      {pickedPosts.length === 0
        ? <div className={css.dayEmpty}>{translate('imagine.socialDayEmpty')}</div>
        : (
          <div className={css.dayList}>
            {pickedPosts.map(post => <PostCard key={post.id} post={post} onOpen={open} />)}
          </div>
        )}
    </aside>
  )

  return (
    <div className={css.page}>
      <div className={css.header}>
        <span className={css.title}>
          <InstagramMark size={20} />
          <span>{translate('imagine.socialTitle')}</span>
        </span>
        <Segmented
          label={translate('imagine.socialTitle')}
          values={SOCIAL_TABS}
          value={tab}
          onPick={(next) => {
            // The tab itself shows every thread; only a click on a post narrows it.
            if (next === 'comments') setFocus(undefined)
            setTab(next)
          }}
          format={entry => translate(SOCIAL_TAB_KEYS[entry])}
          group={css.tabs}
          pill={css.tab}
        />
      </div>

      {tab === 'stories' ? <SocialStories /> : tab === 'comments' ? (
        <SocialComments
          {...(focus === undefined ? {} : { permalink: focus, onClearFilter: () => { setFocus(undefined) } })}
        />
      ) : (
        <>
          <div className={css.toolbar}>
            <div className={css.monthNav}>
              <button
                type="button"
                className={css.navBtn}
                aria-label={mode === 'month' ? translate('imagine.socialPrevMonth') : translate('imagine.socialPrevWeek')}
                onClick={() => { step(-1) }}
              >
                ‹
              </button>
              <span className={css.monthName}>{spanLabel}</span>
              <button
                type="button"
                className={css.navBtn}
                aria-label={mode === 'month' ? translate('imagine.socialNextMonth') : translate('imagine.socialNextWeek')}
                onClick={() => { step(1) }}
              >
                ›
              </button>
              <button type="button" className={css.todayBtn} onClick={() => { pick(new Date()) }}>
                {translate('imagine.socialToday')}
              </button>
            </div>
            {/* What this month holds, by state. The dot carries the same colour
            the calendar uses, so the counts are also its legend. */}
            <div className={css.pills}>
              <Counts posts={mode === 'month' ? monthPosts : week.flatMap(day => byDay.get(dayKey(day)) ?? [])} />
            </div>
            <Segmented
              label={translate('imagine.socialTitle')}
              values={CALENDAR_MODES}
              value={mode}
              onPick={(next) => {
                // The week opens on the listed day, the month on the day's month.
                setCursor(picked)
                setMode(next)
              }}
              format={entry => translate(entry === 'month' ? 'imagine.socialMonth' : 'imagine.socialWeek')}
              group={css.modeSwitch}
              pill={css.modeBtn}
            />
          </div>

          {mode === 'month' ? (
            <div className={css.monthLayout}>
              <div className={css.board}>
                <div className={css.weekHead}>
                  {WEEKDAYS.map(day => <span key={day} className={css.weekName}>{day}</span>)}
                </div>
                <div className={css.grid}>
                  {days.map((day) => {
                    const key = dayKey(day)
                    const entries = byDay.get(key) ?? []
                    // One row less when a "+N" line has to fit under them.
                    const shown = entries.length > DAY_ROWS ? entries.slice(0, DAY_ROWS - 1) : entries
                    const hidden = entries.length - shown.length
                    return (
                      <div
                        key={key}
                        role="button"
                        tabIndex={0}
                        aria-pressed={key === pickedKey}
                        aria-label={`${weekdayOf(day)} ${String(day.getDate())} ${monthName(day.getMonth())}`}
                        className={css.day}
                        data-outside={day.getMonth() !== month || undefined}
                        data-today={key === todayKey || undefined}
                        data-picked={key === pickedKey || undefined}
                        data-weekend={day.getDay() === 0 || day.getDay() === 6 || undefined}
                        data-past={day.getTime() < startOfToday || undefined}
                        onClick={() => { pick(day) }}
                        onKeyDown={(event) => { pickByKey(event, day) }}
                      >
                        <span className={css.dayNum}>{String(day.getDate())}</span>
                        {/* On a phone the rows give way to a dot per post. */}
                        {entries.length > 0 && (
                          <span className={css.dots} aria-hidden="true">
                            {entries.slice(0, 4).map(post => <span key={post.id} className={css.dot} data-status={post.status} />)}
                          </span>
                        )}
                        {shown.map(post => (
                          <span key={post.id} className={css.row} data-status={post.status} title={headline(post)}>
                            <Thumb post={post} className={css.rowThumb} />
                            <span className={css.rowTime}>{clockStamp(dayOf(post)?.getTime() ?? 0)}</span>
                          </span>
                        ))}
                        {hidden > 0 && (
                          <span className={css.more}>
                            {translate('imagine.social.moreOthers', { count: hidden })}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
              {dayPanel}
            </div>
          ) : (
            <div className={css.weekBoard}>
              {week.map((day) => {
                const key = dayKey(day)
                const entries = byDay.get(key) ?? []
                const shown = entries.length > WEEK_ROWS ? entries.slice(0, WEEK_ROWS - 1) : entries
                const hidden = entries.length - shown.length
                return (
                  <section
                    key={key}
                    className={css.weekCol}
                    data-today={key === todayKey || undefined}
                    data-past={day.getTime() < startOfToday || undefined}
                    data-empty={entries.length === 0 || undefined}
                  >
                    <button
                      type="button"
                      className={css.weekColHead}
                      onClick={() => { pick(day); setMode('month') }}
                    >
                      <span>{weekdayOf(day)}</span>
                      <strong>{String(day.getDate())}</strong>
                      {entries.length > 0 && <span className={css.weekColCount}>{String(entries.length)}</span>}
                    </button>
                    <div className={css.weekColList}>
                      {entries.length === 0 && <span className={css.weekColEmpty}>—</span>}
                      {shown.map(post => <PostCard key={post.id} post={post} onOpen={open} compact />)}
                      {hidden > 0 && (
                        <button
                          type="button"
                          className={css.moreBtn}
                          onClick={() => { pick(day); setMode('month') }}
                        >
                          {translate('imagine.social.moreOthers', { count: hidden })}
                        </button>
                      )}
                    </div>
                  </section>
                )
              })}
            </div>
          )}

          {failed.length > 0 && (
            <section className={css.section}>
              <h3 className={css.sectionTitle}>{translate('imagine.pubFailed', { count: failed.length })}</h3>
              <div className={css.list}>
                {failed.map((post) => {
                  const retry = retryNote(post)
                  return (
                    <div key={post.id} className={css.failedRow}>
                      <PostCard post={post} onOpen={open} showDate />
                      <span className={css.failedWhy}>{post.error ?? translate('imagine.pubUnknownError')}</span>
                      {retry !== undefined && <span className={css.failedRetry}>{retry}</span>}
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          <section className={css.section}>
            <h3 className={css.sectionTitle}>{translate('imagine.socialDrafts', { count: drafts.length })}</h3>
            {drafts.length === 0
              ? (
                <div className={css.empty}>
                  <InstagramMark size={18} />
                  <span>
                    {posts.length === 0
                      ? translate('imagine.pubEmptyQueue')
                      : translate('imagine.socialNoDraft')}
                  </span>
                </div>
              )
              : (
                <div className={css.list}>
                  {drafts.map(post => <PostCard key={post.id} post={post} onOpen={open} />)}
                </div>
              )}
          </section>
        </>
      )}
    </div>
  )
}
