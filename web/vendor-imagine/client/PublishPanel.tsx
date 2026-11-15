/**
 * Instagram publish panel: appears when the user clicks "Publish" on a
 * gallery tile. Shows caption, hashtags, post type selector, and publish button.
 */

import { messageOf } from './message-of.ts'
import { translate } from './locale-store.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SocialPost, SocialPostInput } from './gallery-api.ts'
import type { PostType } from '../../../shared/social-types.ts'
import type { GalleryItem, ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import {
  fetchSocialPost,
  createSocialPost,
  deleteSocialPost,
  getCaptionPreview,
  mediaUrlOf,
  thumbUrlOf,
  THUMB_SMALL,
  THUMB_TILE,
  publishSocialPost,
  updateSocialPost,
} from './gallery-api.ts'
import { momentLabel } from './dates.ts'
import { formatClock, localInputValue } from './format.ts'
import { postStatusLabel } from './labels.ts'
import { SocialComments } from './SocialComments.tsx'
import { Still } from './Still.tsx'
import { Segmented } from './Pills.tsx'
import type { ComfyLocaleKey } from './locales.ts'
import { useElapsedSeconds, useVisibleInterval } from './use-visible-interval.ts'
import css from './PublishPanel.module.css'

/** Props for the PublishPanel component. */
export interface PublishPanelProps {
  /** Single gallery item to publish. */
  readonly item?: GalleryItem
  /** Multiple items for carousel publishing (mutually exclusive with item). */
  readonly items?: readonly GalleryItem[]
  /** Jobs list for prompt metadata lookup. */
  readonly jobs?: readonly ImagineJob[]
  /** An existing queued post to edit, instead of composing a new one. */
  readonly post?: SocialPost
  /** Called when the panel should close. */
  readonly onClose: () => void
  /** Called after the queue changed, so the rail can reload. */
  readonly onChanged?: () => void
}

/** When the post should go out. */
type ScheduleMode = 'now' | 'later' | 'draft'
const SCHEDULE_MODES: readonly ScheduleMode[] = ['now', 'later', 'draft']
const SCHEDULE_MODE_KEYS: Readonly<Record<ScheduleMode, ComfyLocaleKey>> = {
  now: 'imagine.pubWhenNow',
  later: 'imagine.pubWhenDate',
  draft: 'imagine.pubWhenDraft',
}
const POST_TYPES: readonly PostType[] = ['photo', 'reel']

/** Seconds as "45s" or "2:05", for the publish button's clock. */
function clockOf(seconds: number): string {
  return seconds < 60 ? `${String(seconds)}s` : formatClock(seconds)
}

/**
 * Instagram publish panel for one or more gallery items.
 * Renders caption editor, hashtag editor, post type selector, and publish button.
 * When items is provided (carousel), all images are published as a carousel post.
 */
export function PublishPanel({ item, items, jobs, post, onClose, onChanged }: PublishPanelProps) {
  const editing = post !== undefined
  const names = useMemo(() => post?.files ?? items?.map(i => i.name) ?? (item === undefined ? [] : [item.name]), [post, items, item])
  const isCarousel = names.length > 1
  const singleItem = item ?? items?.[0]
  const carouselCount = names.length

  // Find the job that produced this file to get the prompt metadata
  const jobPrompt = (() => {
    if (!singleItem || !jobs) return undefined
    for (const job of jobs) {
      if (job.files?.some(f => f.name === singleItem.name)) return job.prompt
    }
    return undefined
  })()

  const [postType, setPostType] = useState<PostType>(
    post?.kind === 'reel' ? 'reel' : post !== undefined ? 'photo' : singleItem?.kind === 'video' ? 'reel' : 'photo',
  )
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(
    post === undefined ? 'now' : post.scheduledAt === undefined ? 'draft' : 'later',
  )
  const [scheduleDate, setScheduleDate] = useState(() => {
    const stored = localInputValue(post?.scheduledAt)
    if (stored !== undefined) return stored
    // Default: tomorrow at 18:00, in the viewer's own zone.
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(18, 0, 0, 0)
    return localInputValue(d.toISOString()) ?? ''
  })
  const [caption, setCaption] = useState(post?.caption ?? '')
  const [hashtags, setHashtags] = useState(post?.hashtags ?? '')
  const [publishing, setPublishing] = useState(false)
  // The post being sent and the step it is on: a carousel takes minutes, and
  // "One moment…" for all of them read as stuck.
  const [sendingId, setSendingId] = useState<string | undefined>(undefined)
  const [step, setStep] = useState<string | undefined>(undefined)
  const sendClock = useElapsedSeconds(sendingId !== undefined)
  const [result, setResult] = useState<SocialPost | { error: string } | null>(null)
  // An existing post already has its words: only a new one is written now.
  const [previewLoading, setPreviewLoading] = useState(!editing)
  // The vision pass runs on a shared backend and takes anywhere from 7s to a
  // minute; a panel frozen that long reads as broken without a clock on it.
  const waited = useElapsedSeconds(previewLoading)
  const [unsafe, setUnsafe] = useState(false)
  // Instagram's own "Created with AI" label, set on the container at publish
  // time. On by default: everything Imagine makes is generated, and the
  // account's editorial policy asks for the label when it is available.
  const [aiLabel, setAiLabel] = useState(post?.aiLabel !== false)
  // Words typed by hand are the user's: switching Feed/Reel asks the model
  // again only while caption and hashtags are still its own.
  const touched = useRef(false)

  // Load caption preview on mount — pass filename + prompt for metadata lookup
  useEffect(() => {
    if (editing || touched.current) return
    let cancelled = false
    setPreviewLoading(true)

    const filename = singleItem?.name
    const opts: { theme?: string; filename?: string; prompt?: string } = {}
    if (filename !== undefined) opts.filename = filename
    if (jobPrompt !== undefined) opts.prompt = jobPrompt
    getCaptionPreview(postType, Object.keys(opts).length > 0 ? opts : undefined)
      .then((preview) => {
        if (cancelled) return
        if (preview.ok) {
          setCaption(preview.caption)
          setHashtags(preview.hashtags)
          setUnsafe(preview.unsafe === true)
        }
        setPreviewLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setPreviewLoading(false)
      })

    return () => { cancelled = true }
  }, [editing, postType, singleItem?.name, jobPrompt])

  // Everything the panel writes goes through the queue: composing creates a
  // post, editing patches it, and publishing is a separate step on a post that
  // already exists — so a send that fails leaves something to retry.
  const save = useCallback(async (publishNow: boolean) => {
    if (publishing) return
    setPublishing(true)
    setResult(null)
    const scheduledAt = scheduleMode === 'later' && scheduleDate !== ''
      ? new Date(scheduleDate).toISOString()
      : null
    try {
      const fields: SocialPostInput = {
        kind: isCarousel ? 'carousel' : postType,
        files: names,
        caption,
        hashtags,
        aiLabel,
        scheduledAt,
      }
      const stored = editing
        ? await updateSocialPost(post.id, fields)
        : await createSocialPost(fields)
      if (publishNow) setSendingId(stored.id)
      setResult(publishNow ? await publishSocialPost(stored.id) : stored)
      onChanged?.()
    } catch (e) {
      setResult({ error: messageOf(e) })
    } finally {
      setPublishing(false)
      setSendingId(undefined)
      setStep(undefined)
    }
  }, [publishing, editing, post, names, postType, isCarousel, caption, hashtags, aiLabel, scheduleMode, scheduleDate, onChanged])

  /*
   * While a post goes out, read its step from the queue every two seconds (a
   * hidden tab skips the ticks and reads at once on coming back). Only that
   * post is read, not the whole queue.
   */
  const readStep = (): void => {
    const id = sendingId
    if (id === undefined) return
    fetchSocialPost(id)
      .then((entry) => { if (entry.progress !== undefined) setStep(entry.progress) })
      .catch(() => undefined)
  }
  useVisibleInterval(readStep, sendingId === undefined ? null : 2000)
  useEffect(() => { readStep() }, [sendingId])

  const remove = useCallback(async () => {
    if (post === undefined || publishing) return
    if (!globalThis.confirm(translate('imagine.pubConfirmDelete'))) return
    setPublishing(true)
    try {
      await deleteSocialPost(post.id)
      onChanged?.()
      onClose()
    } catch (e) {
      setResult({ error: messageOf(e) })
      setPublishing(false)
    }
  }, [post, publishing, onChanged, onClose])

  const single = names.length === 1 ? names[0] : undefined
  // A still picked as a reel is still a picture: only a clip gets a player.
  const thumbnailIsClip = singleItem !== undefined ? singleItem.kind === 'video' : /\.(mp4|webm|mov)$/i.test(names[0] ?? '')
  // The editorial policy allows five: three or four fixed plus the dynamic ones.
  const hashtagCount = hashtags.split(/\s+/).filter(tag => tag.startsWith('#')).length

  return (
    <div className={css.panel}>
      {/* Header */}
      <div className={css.header}>
        <div className={css.headings}>
          <span className={css.title}>{translate('imagine.publishToInstagram')}</span>
          <span className={css.subtitle}>
            {editing ? `${postStatusLabel(post.status)} · ` : ''}
            {isCarousel
              ? translate('imagine.pubCarousel', { count: carouselCount })
              : postType === 'reel' ? translate('imagine.pubReel') : translate('imagine.pubFeed')}
          </span>
        </div>
        <button className={css.closeBtn} onClick={onClose} aria-label={translate('imagine.closeShort')}>
          ✕
        </button>
      </div>

      {/* Thumbnail(s), drawn from the names so an edited post shows its media
          even though the gallery items are not to hand */}
      {isCarousel ? (
        <div className={css.carouselThumbs}>
          {names.slice(0, 5).map(name => (
            <img key={name} src={thumbUrlOf(name, THUMB_SMALL)} alt={name} className={css.carouselThumb} loading="lazy" />
          ))}
          {names.length > 5 && (
            <span className={css.carouselMore}>+{String(names.length - 5)}</span>
          )}
        </div>
      ) : single !== undefined && (
        <div className={css.thumbnailWrap}>
          {/* A still is drawn from its 640 px cut, not the 4-5 MB original:
              the preview is 190 px tall. */}
          {postType === 'reel' && thumbnailIsClip
            ? <video className={css.thumbnail} src={mediaUrlOf(single)} muted playsInline preload="metadata" />
            : <Still src={thumbUrlOf(single, THUMB_TILE)} alt={single} className={css.thumbnail} lazy />}
        </div>
      )}

      {/* The two binary choices, side by side */}
      <div className={css.row}>
        <div className={css.field}>
          <label className={css.label}>{translate('imagine.pubType')}</label>
          <Segmented
            label={translate('imagine.pubType')}
            values={POST_TYPES}
            value={postType}
            onPick={setPostType}
            format={entry => translate(entry === 'photo' ? 'imagine.pubTypePhoto' : 'imagine.pubTypeReel')}
            group={css.typeSelector}
            pill={css.typeBtn}
            disabled={publishing}
          />
        </div>

        <div className={css.field}>
          <label className={css.label}>{translate('imagine.pubWhen')}</label>
          <Segmented
            label={translate('imagine.pubWhen')}
            values={SCHEDULE_MODES}
            value={scheduleMode}
            onPick={setScheduleMode}
            format={entry => translate(SCHEDULE_MODE_KEYS[entry])}
            group={`${css.typeSelector} ${css.three}`}
            pill={css.typeBtn}
            disabled={publishing}
          />
        </div>
      </div>

      {/* DateTime picker (only when scheduling) */}
      {scheduleMode === 'later' && (
        <div className={css.field}>
          <label className={css.label}>{translate('imagine.pubDateTime')}</label>
          <input
            type="datetime-local"
            className={css.input}
            value={scheduleDate}
            onChange={(e) => { setScheduleDate(e.target.value) }}
            disabled={publishing}
          />
        </div>
      )}

      {/* What the vision pass flagged. It warns rather than blocks: the call
          belongs to whoever is publishing, not to the model. */}
      {unsafe && (
        <div className={css.warning}>
          {translate('imagine.visionWarning')}
        </div>
      )}

      {/* Caption */}
      <div className={css.field}>
        <label className={css.label}>
          <span>{translate('imagine.pubCaption')}</span>
          {previewLoading
            ? <span className={css.analyzing}>{translate('imagine.pubAnalyzing', { seconds: waited })}</span>
            : <span className={css.hint}>{String(caption.length)}/2200</span>}
        </label>
        <textarea
          className={css.textarea}
          value={caption}
          onChange={(e) => { touched.current = true; setCaption(e.target.value) }}
          placeholder={previewLoading ? translate('imagine.pubAnalyzingHint') : translate('imagine.pubCaptionPlaceholder')}
          rows={3}
          disabled={publishing || previewLoading}
        />
      </div>

      {/* Hashtags */}
      <div className={css.field}>
        <label className={css.label}>
          <span>{translate('imagine.pubHashtags')}</span>
          {!previewLoading && <span className={css.hint}>{String(hashtagCount)}/5</span>}
        </label>
        <textarea
          className={`${css.textarea} ${css.tags}`}
          value={hashtags}
          onChange={(e) => { touched.current = true; setHashtags(e.target.value) }}
          placeholder={translate('imagine.pubHashtagPlaceholder')}
          rows={2}
          disabled={publishing || previewLoading}
        />
      </div>

      {/* Instagram's own label, not a hashtag: it costs nothing from the five
          the policy allows */}
      <button
        type="button"
        className={css.aiToggle}
        data-on={aiLabel || undefined}
        onClick={() => { setAiLabel(on => !on) }}
        disabled={publishing}
      >
        <span className={css.aiBox} aria-hidden="true">{aiLabel ? '✓' : ''}</span>
        <span>{translate('imagine.pubAiLabel')}</span>
      </button>

      {/* What came back: the stored post, or why nothing was stored */}
      {result !== null && ('error' in result && typeof result.error === 'string' && !('status' in result)
        ? <div className={css.error}>❌ {result.error}</div>
        : 'status' in result && (
          <div className={result.status === 'error' ? css.error : css.success}>
            {result.status === 'published' && <>{translate('imagine.pubPublished')}</>}
            {result.status === 'scheduled' && <>{translate('imagine.pubQueued', { moment: momentLabel(result.scheduledAt, 'dayTime') })}</>}
            {result.status === 'draft' && <>{translate('imagine.pubSavedDraft')}</>}
            {result.status === 'error' && <>❌ {result.error ?? translate('imagine.pubUnknownError')}</>}
            {result.instagramUrl !== undefined && (
              <a href={result.instagramUrl} target="_blank" rel="noopener noreferrer" className={css.link}>
                {translate('imagine.pubSeeOnInstagram')}
              </a>
            )}
          </div>
        ))}

      {/* Actions */}
      <button
        className={css.publishBtn}
        onClick={() => { void save(scheduleMode === 'now') }}
        disabled={publishing || previewLoading || caption.trim() === ''}
      >
        {publishing
          ? sendingId === undefined
            ? translate('imagine.pubMoment')
            : `⏳ ${step ?? translate('imagine.pubStarting')}… · ${clockOf(sendClock)}`
          : scheduleMode === 'now'
            ? translate('imagine.publishNow')
            : scheduleMode === 'later'
              ? translate('imagine.pubSchedule', { moment: momentLabel(scheduleDate, 'dayTime') })
              : editing ? translate('imagine.pubSaveDraft') : translate('imagine.pubSaveAsDraft')}
      </button>

      {/* A queued post can also be sent by hand, or dropped */}
      {editing && (
        <div className={css.editActions}>
          {scheduleMode !== 'now' && (
            <button
              className={css.ghostBtn}
              onClick={() => { void save(true) }}
              disabled={publishing || caption.trim() === ''}
            >
              {translate('imagine.publishNow')}
            </button>
          )}
          <button className={css.ghostBtn} data-danger onClick={() => { void remove() }} disabled={publishing}>
            {translate('imagine.trash')}
          </button>
        </div>
      )}

      {/* Once a post is out it has comments of its own. Matched on the
          permalink, which the post carries and every comment records, so
          nothing has to relate the two. */}
      {post?.instagramUrl !== undefined && <SocialComments permalink={post.instagramUrl} inline />}
    </div>
  )
}
