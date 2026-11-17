/**
 * The board's tiles: a file, and a job still making one. Split out of
 * ImaginePage.tsx on 2026-10-20.
 */

import { translate } from './locale-store.ts'
import { Fragment, memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { IconSendOutlineRegular, Tooltip } from '../../shims/primitives/index.ts'
import type { CanvasRect } from '../../../shared/imagine-projects.ts'
import { mediaUrlOf, shotNumberOf, thumbUrlOf, THUMB_TILE } from './gallery-api.ts'
import type { GalleryItem, ImagineJobView as ImagineJob } from '../../../shared/imagine-types.ts'
import { formatClock } from './format.ts'
import { AudioMark, GeneratingLabel, qualityLabelOf } from './imagine-bits.tsx'
import { joinStage, Percent, ProgressBar, stageLineOf, useJobProgress } from './job-progress.tsx'
import { MediaActionIcon, mediaActions, type MediaActionKind } from './media-actions.tsx'
import { claimAudioFocus, useAudioFocus, useMediaTransport } from './media-playback.ts'
import { PlayToggle, SeekBar } from './transport-bar.tsx'
import { Still } from './Still.tsx'
import css from './Tile.module.css'

/** A corner of a tile, where a resize starts. */
export type TileCorner = 'nw' | 'ne' | 'sw' | 'se'

/**
 * A job still running, in the place its file will take. Its progress is read
 * from `job-progress`, so a moving percentage redraws this tile alone.
 */
export const PendingTile = memo(function PendingTile({
  rect, job, picked, dragging, onPress, onStop,
}: {
  rect: CanvasRect
  job: ImagineJob
  picked: boolean
  dragging: boolean
  onPress: (id: string, event: { clientX: number; clientY: number; preventDefault(): void }) => void
  onStop: (id: string) => void
}) {
  const progress = useJobProgress(job.id)?.progress
  const { percent, stage, eta } = stageLineOf(progress)
  return (
    <article
      className={`${css.tile}${picked ? ` ${css.picked}` : ''}${dragging ? ` ${css.dragging}` : ''}`}
      data-imagine-job={job.status}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDown={(event) => { onPress(job.id, event) }}
    >
      <div className={`${css.frame} ${css.pending}`}>
        {progress?.preview !== undefined && (
          <img className={css.pendingPreview} src={progress.preview} alt="" draggable={false} />
        )}
        <span className={css.pendingLabel}>
          {/*
            * The percentage is its own word. It used to sit against the
            * animated ellipsis, so the label read "Generating38%"
            * and jumped a character wider four times a second.
            *
            * A restart says so in place of the running label: the job is
            * alive but nothing is being sampled, and minutes of an unmoving
            * percentage otherwise read as a hang. The notice stays on the
            * job for good as a record, so the label yields as soon as the
            * retry reports progress.
            */}
          {job.notice === 'separating-voice' && progress === undefined
            ? translate('imagine.noticeSeparatingVoice')
            : job.notice === 'comfy-restart' && progress === undefined
              ? translate('imagine.noticeComfyRestart')
            : job.storyIndex !== undefined && job.storyCount !== undefined
              ? translate('imagine.storyClip', { n: String(job.storyIndex + 1), total: String(job.storyCount) })
              : job.status === 'queued' ? translate('imagine.jobQueued') : <GeneratingLabel />}
          <Percent value={percent} />
        </span>
        {(stage !== undefined || eta !== undefined) && percent !== undefined && (
          <span className={css.pendingStage}>{joinStage(stage, eta)}</span>
        )}
        {progress?.maxSteps !== undefined && progress.maxSteps > 0 && <ProgressBar value={percent} />}
        {/*
          * The tile keeps showing what the user typed, but a clip is sent to
          * the sampler as the prompt the vision pass wrote from the still —
          * hovering shows that one, so a result nobody expected can be read
          * back to the text that actually produced it.
          */}
        <span className={css.pendingPrompt} title={job.writtenPrompt ?? job.prompt}>{job.prompt}</span>
        <button
          type="button"
          className={css.pendingStop}
          data-imagine-tools
          aria-label={translate('imagine.stop')}
          onPointerDown={(event) => { event.stopPropagation() }}
          onClick={() => { onStop(job.id) }}
        >
          {translate('imagine.stop')}
        </button>
      </div>
    </article>
  )
})

/** One icon of the tile's selection bar, its name on hover. */
function ToolIcon({ label, onClick, disabled, danger, children }: {
  label: string
  onClick: (event: ReactMouseEvent<HTMLElement>) => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip label={label} side="top" delayMs={250} portal>
      <button type="button" className={css.iconTool} aria-label={label} data-danger={danger || undefined} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  )
}

/**
 * Progress drawn over the file an upscale is replacing.
 *
 * SeedVR2 sends no preview frames, only ComfyUI progress events, so there is
 * nothing to show but the percentage — and it reads better over the image
 * being enlarged than over the empty frame a placeholder tile would be.
 */
function UpscaleProgress({ job }: { job: ImagineJob }) {
  const { percent, eta } = stageLineOf(useJobProgress(job.id)?.progress)
  return (
    <div className={css.upscaling}>
      <span className={css.upscalingLabel}>
        {job.status === 'queued' ? translate('imagine.jobQueued') : <GeneratingLabel />}
        <Percent value={percent} />
        {eta !== undefined && <span className={css.upscalingEta}>{` · ${eta}`}</span>}
      </span>
      <ProgressBar value={percent} />
    </div>
  )
}

/** What a tile tells the page; every handler takes the file, so one function serves every tile. */
export interface TileHandlers {
  onPress: (id: string, event: {
    clientX: number
    clientY: number
    shiftKey?: boolean
    metaKey?: boolean
    ctrlKey?: boolean
    preventDefault(): void
  }) => void
  /** Run one of the file's actions; `anchor` is where a card or menu opens. */
  onAction: (kind: MediaActionKind, item: GalleryItem, anchor?: DOMRect) => void
  /** Send a line about this file to the project chat (the mini prompt). */
  onAsk: (item: GalleryItem, text: string) => void
  /** Open the right-click menu at the pointer. */
  onMenu: (item: GalleryItem, event: ReactMouseEvent<HTMLElement>) => void
  /** Start resizing the tile from one of its corners. */
  onResize: (id: string, corner: TileCorner, event: ReactPointerEvent<HTMLElement>) => void
}

/**
 * One file on the board.
 *
 * Memoized, with handlers that take the file instead of closing over it: a
 * pan, a drag frame or a poll tick used to re-render every tile on the board
 * with twenty fresh closures each (2026-10-20).
 */
export const Tile = memo(function Tile({
  rect, item, zoom = 1, sharp, busy, picked, dragging, showTools, upscaling, suspended,
  onPress, onAction, onAsk, onMenu, onResize,
}: TileHandlers & {
  rect: CanvasRect
  item: GalleryItem
  /**
   * The board's zoom. Only the tile with its tools open needs it (handles and
   * bar stay a constant size on screen); passing it to every tile re-renders
   * the whole board on each zoom step, which `sharp` avoids.
   */
  zoom?: number
  /** Whether the tile is shown wider than its 640px cut, as the board measures it. */
  sharp: boolean
  busy: boolean
  picked: boolean
  dragging: boolean
  showTools: boolean
  /** The upscale replacing this file, while it runs. */
  upscaling?: ImagineJob | undefined
  /** Something else is playing on top of the board: this tile keeps quiet. */
  suspended?: boolean
}) {
  const articleRef = useRef<HTMLElement>(null)
  const video = item.kind === 'video'
  const audio = item.kind === 'audio'
  // A clip on the board plays alongside the others, heard only when it has
  // the audio (claimAudioFocus); a track still stops everything else.
  const transport = useMediaTransport(item.duration, !video)
  const { playing, currentTime, duration } = transport
  const mediaRef = transport.ref
  const heard = useAudioFocus(item.name)
  const [userMuted, setUserMuted] = useState(false)
  const muted = userMuted || !heard
  // What the button shows: while it plays, whether it is heard; paused, the
  // user's own choice (Grok's `$ ? D : L`).
  const shownMuted = playing ? muted : userMuted
  const quality = qualityLabelOf(item)
  /*
   * A clip tile is its still until the pointer comes by, as Grok's
   * (deferLoad): every tile used to hold a <video preload="metadata">, and a
   * board of 45 clips opened 45 media players and 45 range requests at once.
   * The length comes with the inventory meanwhile.
   */
  const [armed, setArmed] = useState(false)
  // React sets `muted` only when the element is created: kept in step here.
  useEffect(() => {
    if (mediaRef.current !== null) mediaRef.current.muted = muted
  }, [muted, armed])
  // A seek made on the still is applied once the player has the metadata.
  const pendingSeekRef = useRef<number | undefined>(undefined)
  // Play pressed before the player was there: start as soon as it can.
  const startRef = useRef(false)

  const togglePlay = (): void => {
    if (video && mediaRef.current?.paused !== false) claimAudioFocus(item.name)
    if (video && !armed) {
      startRef.current = true
      setArmed(true)
      return
    }
    transport.toggle()
  }
  const toggleMute = (): void => {
    if (shownMuted) {
      if (playing) claimAudioFocus(item.name)
      setUserMuted(false)
    } else {
      setUserMuted(true)
    }
  }
  /** Move the clip to where the seek bar was pressed. */
  const seekAt = (bar: HTMLElement, clientX: number): void => {
    const box = bar.getBoundingClientRect()
    const total = duration ?? 0
    if (box.width <= 0 || total <= 0) return
    transport.seek(Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * total)
  }
  const shot = shotNumberOf(item.name)
  // The board draws the 640px cut until the tile is shown wider than that on
  // screen, then the original. Latched: zooming back out keeps the sharp copy
  // the browser already has instead of swapping the picture under the user.
  const sharpRef = useRef(false)
  if (sharp) sharpRef.current = true
  const tileStillSrc = sharpRef.current
    ? `${mediaUrlOf(item.name)}?v=${String(item.mtime)}`
    : thumbUrlOf(item.name, THUMB_TILE, item.mtime)
  // Pausing is enough: the tile does not resume when the viewer closes, so a
  // board of clips does not all start up again at once.
  useEffect(() => {
    if (suspended === true) mediaRef.current?.pause()
  }, [suspended])

  return (
    <article
      ref={articleRef}
      className={`${css.tile}${picked ? ` ${css.picked}` : ''}${dragging ? ` ${css.dragging}` : ''}`}
      data-imagine-card={item.name}
      data-kind={item.kind}
      role="button"
      tabIndex={0}
      aria-label={item.name}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDown={(event) => { onPress(item.name, event) }}
      onPointerEnter={video ? () => { setArmed(true) } : undefined}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(item, event)
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        onAction('open', item)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onAction('open', item)
        }
      }}
    >
      <div className={css.frame}>
        {/*
          * Which shot of its music video this is, read off the file name, so
          * a shot can be told apart on the board and asked for by number.
          */}
        {shot !== undefined && (
          <span className={css.shotBadge} data-imagine-shot={`${String(shot.n)}/${String(shot.total)}`}>
            {translate('imagine.storyClip', { n: String(shot.n), total: String(shot.total) })}
          </span>
        )}
        <div className={css.mediaHit}>
          {video && !armed && <Still className={css.media} src={thumbUrlOf(item.name, THUMB_TILE, item.mtime)} lazy />}
          {video && armed
            ? (
              <video
                ref={mediaRef as RefObject<HTMLVideoElement>}
                className={css.media}
                src={mediaUrlOf(item.name)}
                poster={thumbUrlOf(item.name, THUMB_TILE, item.mtime)}
                playsInline
                // As Grok's canvas: a clip played on the board starts again
                // at the end until it is paused (asked 2026-11-15).
                loop
                muted={muted}
                preload="metadata"
                {...transport.events}
                onLoadedMetadata={(event) => {
                  transport.events.onLoadedMetadata(event)
                  if (pendingSeekRef.current !== undefined) event.currentTarget.currentTime = pendingSeekRef.current
                  pendingSeekRef.current = undefined
                }}
                onCanPlay={(event) => {
                  if (!startRef.current) return
                  startRef.current = false
                  void event.currentTarget.play()
                }}
              />
            )
            : audio
              ? (
                <div className={css.audioPad}>
                  <AudioMark className={css.audioMark} />
                  <audio
                    ref={mediaRef}
                    src={mediaUrlOf(item.name)}
                    // The inventory usually knows the length: then nothing is
                    // fetched until the track is played.
                    preload={item.duration === undefined ? 'metadata' : 'none'}
                    {...transport.events}
                  />
                </div>
              )
              : !video && <Still className={css.media} src={tileStillSrc} lazy />}
          {/* Grok's resolution chip: top left, gone while the clip plays. */}
          {quality !== undefined && <span className={css.resBadge} data-hidden={playing || undefined}>{quality}</span>}
          {upscaling !== undefined && <UpscaleProgress job={upscaling} />}
          {video && !armed && (
            // Before the pointer comes by, the poster and a play mark only.
            <span className={css.posterPlay} aria-hidden="true"><PlayGlyph /></span>
          )}
          {video && armed && (
            <>
              {/*
                * Grok's clip controls, always there once the clip is loaded:
                * play, the clock, and the sound on the far side, over a
                * shade at the foot of the picture. The pointer is kept from
                * the tile so a press here is not a drag.
                */}
              <div
                className={css.clipBar}
                onPointerDown={(event) => { event.stopPropagation() }}
                onClick={(event) => { event.stopPropagation() }}
                onDoubleClick={(event) => { event.stopPropagation() }}
              >
                <button type="button" className={css.clipButton} aria-label={playing ? translate('imagine.pause') : translate('imagine.play')} onClick={togglePlay}>
                  {playing ? <PauseGlyph /> : <PlayGlyph />}
                </button>
                <span className={css.clipClock}>{`${formatClock(currentTime)} / ${duration !== undefined && duration > 0 ? formatClock(duration) : '--:--'}`}</span>
                <span className={css.clipSpacer} />
                <button type="button" className={css.clipButton} aria-label={shownMuted ? translate('imagine.unmute') : translate('imagine.mute')} onClick={toggleMute}>
                  {shownMuted ? <MutedGlyph /> : <SoundGlyph />}
                </button>
              </div>
              <div
                className={css.clipSeek}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  seekAt(event.currentTarget, event.clientX)
                }}
                onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seekAt(event.currentTarget, event.clientX) }}
                onClick={(event) => { event.stopPropagation() }}
                onDoubleClick={(event) => { event.stopPropagation() }}
              >
                <div className={css.clipTrack}>
                  <div className={css.clipFill} style={{ width: `${String(duration !== undefined && duration > 0 ? Math.min(100, currentTime / duration * 100) : 0)}%` }} />
                </div>
              </div>
            </>
          )}
          {audio && (
            /*
             * A track gets its transport: play, a seek bar and the clock. The
             * pointer is kept from the tile so scrubbing does not start a drag
             * or a selection.
             */
            <div
              className={css.reelBar}
              onPointerDown={(event) => { event.stopPropagation() }}
              onClick={(event) => { event.stopPropagation() }}
            >
              <PlayToggle transport={transport} onToggle={togglePlay} className={css.reelPlay} size={14} />
              <SeekBar transport={transport} className={css.reelSeek} />
              <span>{`${formatClock(currentTime)} / ${formatClock(duration ?? 0)}`}</span>
            </div>
          )}
        </div>
      </div>
      {showTools && (
        <>
          {(['nw', 'ne', 'sw', 'se'] as const).map(corner => (
            <span
              key={corner}
              className={css.handle}
              data-c={corner}
              // Constant on screen when zoomed out, as Grok's --atlas-inv-zoom.
              style={{ transform: `scale(${String(Math.max(1, 1 / zoom))})` }}
              onPointerDown={(event) => { onResize(item.name, corner, event) }}
            />
          ))}
          <div className={css.toolbarFloat} style={{ transform: `scale(${1 / zoom})`, transformOrigin: 'top left' }}>
            {/*
             * One row of icons with their names on hover, as Grok Imagine has
             * (asked 2026-10-17): the labelled chips wrapped to three rows.
             * A clip gets clip tools, a still gets still tools.
             */}
            <div className={css.iconBar}>
              {mediaActions(item, 'tile', { busy }).map(action => (action.kind === 'download'
                ? (
                  <Fragment key={action.kind}>
                    <span className={css.iconSep} aria-hidden="true" />
                    <Tooltip label={action.label} side="top" delayMs={250} portal>
                      <a className={css.iconTool} href={mediaUrlOf(item.name)} download={item.name} aria-label={action.label}>
                        <MediaActionIcon kind={action.kind} />
                      </a>
                    </Tooltip>
                  </Fragment>
                )
                : (
                  <ToolIcon
                    key={action.kind}
                    label={action.label}
                    danger={action.danger}
                    disabled={action.disabled}
                    onClick={(event) => {
                      // The card goes beside the picture it describes, not the button.
                      const anchor = action.kind === 'details' ? articleRef.current ?? event.currentTarget : event.currentTarget
                      onAction(action.kind, item, anchor.getBoundingClientRect())
                    }}
                  >
                    <MediaActionIcon kind={action.kind} />
                  </ToolIcon>
                )))}
            </div>
            {/*
             * Ask about this file right where it is: the line goes to the
             * project chat with the file staged, as Grok's mini prompt does.
             */}
            {item.kind !== 'audio' && (
              <form
                className={css.askBar}
                onSubmit={(event) => {
                  event.preventDefault()
                  const field = event.currentTarget.elements.namedItem('ask')
                  if (!(field instanceof HTMLInputElement) || field.value.trim() === '') return
                  onAsk(item, field.value.trim())
                  field.value = ''
                }}
                onPointerDown={(event) => { event.stopPropagation() }}
                // The tile is a button: Space and Enter bubbling up from here
                // opened the preview and ate the spaces of the line.
                onKeyDown={(event) => { event.stopPropagation() }}
                onKeyUp={(event) => { event.stopPropagation() }}
              >
                <input name="ask" className={css.askInput} placeholder={translate('imagine.askChange')} autoComplete="off" />
                <button type="submit" className={css.askSend} aria-label={translate('imagine.send')} disabled={busy}>
                  <IconSendOutlineRegular size={14} />
                </button>
              </form>
            )}
          </div>
        </>
      )}
    </article>
  )
})

/* Grok's clip glyphs: filled play and pause, a speaker with and without sound. */
const PlayGlyph = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ marginLeft: 2 }}><path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8Z" /></svg>
const PauseGlyph = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1.2" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" /></svg>
const SoundGlyph = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>
const MutedGlyph = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" /><path d="m16 9 6 6M22 9l-6 6" /></svg>
