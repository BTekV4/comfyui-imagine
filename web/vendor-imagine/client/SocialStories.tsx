/**
 * The story queue: each reel runs again as a story, a day later, one a day.
 *
 * The host puts them out on its own clock, so this is a view of the calendar
 * rather than the thing that drives it — what it adds is the ability to move a
 * day, send one now, or drop one.
 */

import { messageOf } from './message-of.ts'
import { translate } from './locale-store.ts'
import { useEffect, useState } from 'react'
import { momentLabel, monthName } from './dates.ts'
import { localInputValue, pad2 } from './format.ts'
import { storyStatusLabel } from './labels.ts'
import { usePolled } from './use-visible-interval.ts'
import type { SocialStory } from './gallery-api.ts'
import { deleteSocialStory, fetchSocialStories, publishSocialStory, rescheduleSocialStory } from './gallery-api.ts'
import css from './SocialStories.module.css'

/** How often the list re-reads itself. One story goes out per day. */
const REFRESH_MS = 60_000

/**
 * A day as the note says it: `25 October`.
 * @param iso - the stored instant.
 * @returns the day and the month's name.
 */
function dayMonth(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getDate())} ${monthName(date.getMonth())}`
}

/**
 * One queued story, with the three things that can be done to it.
 * @param props - the story and what to do when it changes.
 * @returns the row.
 */
function StoryRow({ story, onChanged, onDropped }: {
  readonly story: SocialStory
  readonly onChanged: (next: SocialStory) => void
  readonly onDropped: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [moving, setMoving] = useState(false)
  const [date, setDate] = useState(() => localInputValue(story.publishAt) ?? '')
  // A reload, or a move made elsewhere, brings a new day: the closed field follows it.
  useEffect(() => { if (!moving) setDate(localInputValue(story.publishAt) ?? '') }, [story.publishAt, moving])

  const act = async (run: () => Promise<void>) => {
    setBusy(true)
    try {
      await run()
    } catch (e) {
      onChanged({ ...story, error: messageOf(e) })
    } finally {
      setBusy(false)
    }
  }

  const gone = story.status === 'published'
  return (
    <div className={css.row} data-status={story.status}>
      <div className={css.head}>
        <span className={css.status} data-status={story.status}>{storyStatusLabel(story.status)}</span>
        <span className={css.when}>{momentLabel(gone ? story.publishedAt : story.publishAt, 'dayTime')}</span>
        {story.permalink !== undefined && (
          <a className={css.link} href={story.permalink} target="_blank" rel="noopener noreferrer">{translate('imagine.onInstagram')}</a>
        )}
      </div>

      <p className={css.source}>{story.source === '' ? story.file.split('/').pop() ?? '' : story.source}</p>

      {!gone && (
        <div className={css.actions}>
          {moving
            ? (
              <>
                <input
                  className={css.date}
                  type="datetime-local"
                  value={date}
                  onChange={(e) => { setDate(e.target.value) }}
                />
                <button
                  type="button"
                  className={css.ghostBtn}
                  disabled={busy || date === ''}
                  onClick={() => {
                    void act(async () => {
                      onChanged(await rescheduleSocialStory(story.id, new Date(date).toISOString()))
                      setMoving(false)
                    })
                  }}
                >
                  {translate('imagine.move')}
                </button>
                <button type="button" className={css.ghostBtn} onClick={() => { setMoving(false) }}>{translate('imagine.storyCancel')}</button>
              </>
            )
            : (
              <>
                <button type="button" className={css.ghostBtn} onClick={() => { setMoving(true) }}>{translate('imagine.changeDay')}</button>
                <button
                  type="button"
                  className={css.ghostBtn}
                  disabled={busy}
                  onClick={() => { void act(async () => { onChanged(await publishSocialStory(story.id)) }) }}
                >
                  {busy ? translate('imagine.storyMoment') : translate('imagine.storyPublish')}
                </button>
                <button
                  type="button"
                  className={css.ghostBtn}
                  data-danger
                  disabled={busy}
                  onClick={() => { void act(async () => { await deleteSocialStory(story.id); onDropped(story.id) }) }}
                >
                  {translate('imagine.storyRemove')}
                </button>
              </>
            )}
        </div>
      )}

      {story.error !== undefined && <p className={css.error}>{story.error}</p>}
    </div>
  )
}

/**
 * The story queue.
 * @returns the list.
 */
export function SocialStories() {
  // Refreshed while the tab is in view; a hidden tab stops asking.
  const { data, loaded, update } = usePolled(fetchSocialStories, REFRESH_MS)
  const stories = data?.stories ?? []
  const from = data?.from ?? ''
  const hour = data?.hour ?? 8

  const waiting = stories.filter(s => s.status === 'scheduled')
  const done = stories.filter(s => s.status !== 'scheduled')
  const replace = (next: SocialStory) => {
    update(read => read && { ...read, stories: read.stories.map(s => (s.id === next.id ? next : s)) })
  }
  const drop = (id: string) => { update(read => read && { ...read, stories: read.stories.filter(s => s.id !== id) }) }

  return (
    <section className={css.section}>
      <div className={css.header}>
        <h3 className={css.sectionTitle}>{translate('imagine.socialStoriesCount', { count: waiting.length })}</h3>
        <span className={css.note}>
          {translate('imagine.storyDailyLabel', { hour: pad2(hour), from: from === '' ? '' : translate('imagine.storyFrom', { date: dayMonth(from) }) })}
        </span>
      </div>

      {waiting.length === 0
        ? (
          <div className={css.empty}>
            {loaded
              ? translate('imagine.storyNothing')
              : translate('imagine.storyMoment')}
          </div>
        )
        : (
          <div className={css.list}>
            {waiting.map(s => <StoryRow key={s.id} story={s} onChanged={replace} onDropped={drop} />)}
          </div>
        )}

      {done.length > 0 && (
        <>
          <h3 className={css.sectionTitle}>{translate('imagine.storiesDone', { count: done.length })}</h3>
          <div className={css.list}>
            {done.map(s => <StoryRow key={s.id} story={s} onChanged={replace} onDropped={drop} />)}
          </div>
        </>
      )}
    </section>
  )
}
