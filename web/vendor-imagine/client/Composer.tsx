/**
 * The studio's composer. Split out of ImaginePage.tsx on 2026-10-20.
 *
 * Since 2026-10-25 it holds nothing of its own: the fields are in the page's
 * composer store (`composer-store.ts`) and `ComposerBox` reads them there, so
 * a key typed here draws the composer and nothing else.
 *
 * The home composer offers the two plain kinds, Image and Video. The look,
 * the style, the soundtrack switch of "Recreate video" and "All poses" used
 * to have blocks here too, reachable only through a mode left behind by a
 * card's panel; the panel has them, and closing it now puts the composer back
 * on Image. The lyrics stay: an audio file dropped on the home is what puts
 * the composer on Music.
 */

import type { ComfyLocaleKey } from './locales.ts'
import { translate } from './locale-store.ts'
import { memo, useEffect, useRef, useState } from 'react'
import {
  IconCheck, IconDots, IconPlusOutlineRegular, IconSendOutlineRegular,
} from '../../shims/primitives/index.ts'
import { thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import type { GalleryItem, ImagineQuality, ImagineSpeed, ModelRoute } from '../../../shared/imagine-types.ts'
import {
  VIDEO_RESOLUTIONS, clampResolution, clampSeconds, clipSecondsFor, type ImagineMode,
} from './imagine-settings.ts'
import {
  IMAGE_RESOLUTIONS, aspectFor, aspectName, aspectsFor, type ImagineAspect, type ImagineResolution,
} from '../../../shared/imagine-media.ts'
import { useComposer, type ComposerStore } from './composer-store.ts'
import { ImagineModelSelect } from './ImagineModelSelect.tsx'
import { Pills, Segmented, type PillClasses } from './Pills.tsx'
import { Still } from './Still.tsx'
import { useDismiss } from './use-dismiss.ts'
import { useEvent } from './use-event.ts'
import { AudioMark } from './imagine-bits.tsx'
import shared from './imagine-shared.module.css'
import css from './Composer.module.css'

/** Tallest the prompt field grows before it scrolls; matches `.prompt`. */
const PROMPT_MAX_HEIGHT = 120

/**
 * The modes behind the composer's "…", in the order the home's cards list
 * them: each has a card of its own, and until 2026-11-03 the only way in was
 * pressing that card.
 */
const MORE_MODES: readonly ImagineMode[] = ['loop', 'look', 'style', 'music', 'speak', 'recreate', 'regenerate']

/** The prompt box with its mode seats, staged files and options. */
function Composer({
  prompt, mode, aspect, resolution, seconds, lyrics,
  sources, note, busy, docked, quality, speed,
  onPrompt, onModel, onMode, onAspect, onResolution, onSeconds, onLyrics, onQuality, onSpeed,
  onClearSource, onDropSource, onUpload, onSubmit,
}: {
  prompt: string
  mode: ImagineMode
  aspect: ImagineAspect
  resolution: ImagineResolution
  seconds: number
  lyrics: string
  sources: readonly GalleryItem[]
  note: string | undefined
  busy: boolean
  docked: boolean
  /** "Quality", for the photos. */
  quality: ImagineQuality
  /** "Speed", for the clips. */
  speed: ImagineSpeed
  onPrompt: (value: string) => void
  onModel: (route: ModelRoute) => void
  onMode: (mode: ImagineMode) => void
  onAspect: (value: ImagineAspect) => void
  onResolution: (value: ImagineResolution) => void
  onSeconds: (value: number) => void
  onLyrics: (value: string) => void
  onQuality: (value: ImagineQuality) => void
  onSpeed: (value: ImagineSpeed) => void
  onClearSource: () => void
  onDropSource: (name: string) => void
  onUpload: (files: FileList | readonly File[]) => void
  onSubmit: () => void
}) {
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const moreBox = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState<'modes' | undefined>(undefined)
  useDismiss(moreBox, () => { setMore(undefined) }, more !== undefined)
  // A one-row textarea keeps its initial height for good unless something
  // measures the content: the CSS max-height alone never applies, and the
  // field stays a single line however much is typed into it.
  useEffect(() => {
    const node = promptRef.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${String(Math.min(node.scrollHeight, PROMPT_MAX_HEIGHT))}px`
  }, [prompt, mode])
  return (
    <form
      className={docked ? `${css.composer} ${css.docked}` : css.composer}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        const files = Array.from(event.dataTransfer.files)
        if (files.length > 0) onUpload(files)
      }}
    >
      <input
        className={css.hiddenFile}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.mov,audio/mpeg,audio/wav,audio/flac,audio/ogg,audio/mp4"
        multiple
        onChange={(event) => {
          const files = event.target.files
          if (files !== null && files.length > 0) onUpload(files)
          event.target.value = ''
        }}
      />
      {sources.length > 0 && (
        <div className={css.sourceBar} data-imagine-source={sources[0]?.name}>
          {/*
            * One thumbnail per staged file, each with its own remove: a
            * selection of ten stills is refined here, and the only control
            * used to be "drop them all". The strip scrolls rather than
            * growing the composer, which is 360px wide when docked.
            */}
          <div className={css.sourceStrip}>
            {sources.map(item => (
              <span key={item.name} className={css.sourceChip} data-imagine-staged={item.name}>
                {item.kind === 'audio'
                  ? <AudioMark className={shared.audioThumb} />
                  : <Still className={css.sourceThumb} src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} />}
                {/*
                  * Every chip carries its own remove, the single one included:
                  * a photo staged for one question stayed in the composer with
                  * only the bar's text button to take it out, which reads as a
                  * file the studio would not let go of.
                  */}
                <button
                  type="button"
                  className={css.sourceDrop}
                  aria-label={translate('imagine.dropSource', { name: item.name })}
                  title={translate('imagine.dropSource', { name: item.name })}
                  onClick={() => { onDropSource(item.name) }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <span className={css.sourceHint}>{stagedHint(mode, sources)}</span>
          <button type="button" className={css.textButton} onClick={onClearSource}>
            {translate(sources.length === 1 ? 'imagine.clearSource' : 'imagine.clearSources')}
          </button>
        </div>
      )}
      {note !== undefined && <p className={css.composerNote} role="alert">{note}</p>}
      <textarea
        ref={promptRef}
        className={css.prompt}
        value={prompt}
        rows={1}
        placeholder={docked ? translate('imagine.chatPrompt') : translate('imagine.prompt')}
        onChange={(event) => { onPrompt(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
      {/*
        * MiniMax Music 3 takes the sung words separately from the prompt that
        * describes the music. The host has always forwarded `lyrics`; the
        * composer sent an empty string, so half the workflow was unreachable.
        */}
      {mode === 'music' && !docked && (
        <textarea
          className={`${css.prompt} ${css.lyrics}`}
          value={lyrics}
          rows={2}
          placeholder={translate('imagine.lyricsHint')}
          aria-label={translate('imagine.lyrics')}
          onChange={(event) => { onLyrics(event.target.value) }}
        />
      )}
      {/*
        * A project's chat has no generation controls (since 2026-11-04): the
        * written sentence carries them — "a 10-second vertical video" — and
        * the reading decides them. The attachment and send buttons stay, as
        * they choose nothing: they only say what to send and when. The home
        * keeps the controls, because there the composer does not read the
        * sentence: a card is pressed and what the buttons say is run.
        */}
      <div className={css.toolbar}>
        <div className={css.toolbarRow}>
          <button
            type="button"
            className={`${shared.iconBtn} ${css.upload}`}
            aria-label={translate('imagine.upload')}
            onClick={(event) => {
              const form = (event.currentTarget.closest('form'))
              const input = form?.querySelector('input[type="file"]')
              if (input instanceof HTMLInputElement) input.click()
            }}
          >
            <IconPlusOutlineRegular size={16} />
          </button>
          {/*
            * What decides WHAT to generate lives only on the home: here the
            * sentence decides. Attachment and send stay outside the block,
            * because they choose nothing.
            */}
          {!docked && (
            <>
              <div className={css.seg} aria-label={translate('imagine.filter')}>
                {/*
                  * As on Grok (2026-11-03): in the mode group only the chosen one
              * carries its name, the others stay as their icon. Before, both
              * were wide and the pill looked like a list.
              */}
            <button
              type="button"
              aria-label={translate('imagine.modeImage')}
              title={translate('imagine.modeImage')}
              data-on={mode === 'image' || undefined}
              onClick={() => { onMode('image') }}
            >
              <ImageModeIcon />
              {mode === 'image' && translate('imagine.modeImage')}
            </button>
            <button
              type="button"
              aria-label={translate('imagine.modeVideo')}
              title={translate('imagine.modeVideo')}
              data-on={mode === 'video' || undefined}
              onClick={() => { onMode('video') }}
            >
              <VideoModeIcon />
              {mode === 'video' && translate('imagine.modeVideo')}
            </button>
            {/*
              * Grok's "…": the home's other cards have a mode of their own
              * (Background, Look, Style, Music, the two swaps, Recreate,
              * Regenerate), and until now the only way in was opening their card.
              */}
            <div className={css.segMore} ref={moreBox}>
              <button
                type="button"
                className={css.segDots}
                aria-label={translate('imagine.moreModes')}
                title={translate('imagine.moreModes')}
                aria-expanded={more !== undefined}
                onClick={() => { setMore(current => (current === undefined ? 'modes' : undefined)) }}
              >
                <IconDots />
              </button>
              {more === 'modes' && (
                <div className={css.modeMenu} role="menu">
                  {MORE_MODES.map(entry => (
                    <button
                      key={entry}
                      type="button"
                      role="menuitem"
                      className={css.modeItem}
                      data-on={mode === entry || undefined}
                      onClick={() => { setMore(undefined); onMode(entry) }}
                    >
                      {modeLabel(entry)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {mode !== 'image' && mode !== 'video' && (
            <button type="button" className={css.aspectBtn} title={translate('imagine.backToImage')} onClick={() => { onMode('image') }}>
              {`${modeLabel(mode)} ×`}
            </button>
          )}
          {/*
            * The recipe, like Grok's double pill. "Speed" is the graph as it
            * is: Krea 2 at 8 steps, the clips with the Pika Turbo recipe at 4.
            * "Quality" raises the graph's steps for photos (Krea 2 at 16); for
            * clips it picks the entry's SECOND graph (`pathHigh`: official
            * Pika at 6 steps) — on distilled weights extra steps buy no
            * detail (measured 2026-11-05), so the high recipe is another
            * graph, not another number. The two hints must be realigned when
            * config.yaml changes. One choice for both settings: `quality` for
            * photos, `speed` for videos, so a request cannot carry two
            * different recipes.
            */}
          <div className={css.seg} aria-label={translate('imagine.recipe')}>
            <button
              type="button"
              data-on={quality === 'standard' && speed === 'fast' || undefined}
              onClick={() => { onQuality('standard'); onSpeed('fast'); }}
              title={translate('imagine.recipeSpeedHint')}
            >
              {translate('imagine.speed')}
            </button>
            <button
              type="button"
              data-on={quality === 'high' || speed === 'slow' || undefined}
              onClick={() => { onQuality('high'); onSpeed('slow'); }}
              title={translate('imagine.recipeQualityHint')}
            >
              {translate('imagine.quality')}
            </button>
          </div>
          {/*
            * On Grok the row changes with the mode (2026-11-03): in Video the
            * recipe stays (we want it for the 12 steps) and resolution and
            * length appear beside it as pill groups, not hidden in a panel.
            */}
          {mode === 'video' && (
            <>
              {/* `resolution` is already clamped for the mode by ComposerBox. */}
              <Segmented
                label={translate('imagine.resolution')}
                values={VIDEO_RESOLUTIONS}
                value={resolution}
                onPick={onResolution}
                group={css.seg}
                pill={undefined}
              />
              <Segmented
                label={translate('imagine.duration')}
                values={clipSecondsFor(resolution)}
                value={seconds}
                onPick={onSeconds}
                format={entry => `${String(entry)} s`}
                group={css.seg}
                pill={undefined}
              />
            </>
          )}
              {(mode === 'image' || mode === 'video') && (
                <ComposerOptions
                  mode={mode}
                  aspect={aspect}
                  quality={quality}
                  resolution={resolution}
                  onAspect={onAspect}
                  onResolution={onResolution}
                  onModel={onModel}
                />
              )}
            </>
          )}
          {/*
            * Docked, a staged file on its own is not a request: the sentence is
            * what says what to do with it.
            */}
          <button
            type="submit"
            className={css.send}
            disabled={busy || (prompt.trim().length === 0 && sources.length === 0 && (docked || mode !== 'look'))}
            aria-label={translate('imagine.send')}
          >
            <IconSendOutlineRegular size={16} />
          </button>
        </div>
      </div>
    </form>
  )
}

/** What the page decides when the composer is used; the fields themselves go to the store. */
export interface ComposerBoxProps {
  readonly store: ComposerStore
  readonly busy: boolean
  readonly docked: boolean
  /** Switch the mode: the page carries the fields only that mode has. */
  readonly onMode: (mode: ImagineMode) => void
  readonly onUpload: (files: FileList | readonly File[]) => void
  readonly onSubmit: () => void
}

/**
 * The composer, reading its fields from the page's composer store.
 *
 * Memoized on handlers the page keeps stable: the docked composer rides in
 * the chat column and the home one in the hero, and neither redraws with the
 * page.
 */
export const ComposerBox = memo(function ComposerBox({ store, busy, docked, onMode, onUpload, onSubmit }: ComposerBoxProps) {
  const prompt = useComposer(store, state => state.prompt)
  const mode = useComposer(store, state => state.mode)
  const aspect = useComposer(store, state => state.aspect)
  const resolution = useComposer(store, state => state.resolution)
  const seconds = useComposer(store, state => state.seconds)
  const lyrics = useComposer(store, state => state.lyrics)
  const quality = useComposer(store, state => state.quality)
  const speed = useComposer(store, state => state.speed)
  const sources = useComposer(store, state => state.sources)
  const note = useComposer(store, state => state.note)
  const onPrompt = useEvent((value: string) => { store.set({ prompt: value }) })
  // Stable: the model select reloads its list whenever this changes.
  const onModel = useEvent((route: ModelRoute) => { store.set({ chatModel: route }) })
  const onAspect = useEvent((value: ImagineAspect) => { store.set({ aspect: value }) })
  // Leaving 480p takes its 15s rung with it.
  const onResolution = useEvent((value: ImagineResolution) => {
    store.set(state => ({ resolution: value, seconds: clampSeconds(state.mode, value, state.seconds) }))
  })
  const onSeconds = useEvent((value: number) => { store.set({ seconds: value }) })
  const onLyrics = useEvent((value: string) => { store.set({ lyrics: value }) })
  const onQuality = useEvent((value: ImagineQuality) => { store.set({ quality: value }) })
  const onSpeed = useEvent((value: ImagineSpeed) => { store.set({ speed: value }) })
  const onClearSource = useEvent(() => { store.set({ sources: [] }) })
  const onDropSource = useEvent((name: string) => {
    store.set(state => ({ sources: state.sources.filter(entry => entry.name !== name) }))
  })
  return (
    <Composer
      prompt={prompt}
      mode={mode}
      aspect={aspect}
      resolution={clampResolution(mode, resolution)}
      seconds={seconds}
      lyrics={lyrics}
      quality={quality}
      speed={speed}
      sources={sources}
      note={note}
      busy={busy}
      docked={docked}
      onPrompt={onPrompt}
      onModel={onModel}
      onMode={onMode}
      onAspect={onAspect}
      onResolution={onResolution}
      onSeconds={onSeconds}
      onLyrics={onLyrics}
      onQuality={onQuality}
      onSpeed={onSpeed}
      onClearSource={onClearSource}
      onDropSource={onDropSource}
      onUpload={onUpload}
      onSubmit={onSubmit}
    />
  )
})

/**
 * A composer mode's name, for the chip a mode other than the two plain kinds
 * leaves on the home composer.
 */
function modeLabel(mode: ImagineMode): string {
  if (mode === 'loop') return translate('imagine.modeLoop')
  if (mode === 'music') return translate('imagine.modeMusic')
  if (mode === 'look') return translate('imagine.look')
  if (mode === 'style') return translate('imagine.style')
  if (mode === 'speak') return translate('imagine.makeSpeech')
  if (mode === 'recreate') return translate('imagine.recreateVideo')
  if (mode === 'regenerate') return translate('imagine.regenerateDetail')
  return translate('imagine.modeImage')
}

/**
 * The home composer's one options seat: a chip that reads back what is set
 * ("9:16 · 1080p", "9:16 · 720p · 10 s") and opens the choices — format,
 * resolution, length for a video, the model. Grok Imagine keeps these behind
 * one control too; they were four buttons of their own.
 */
function ComposerOptions({ mode, aspect, quality, resolution, onAspect, onResolution, onModel }: {
  mode: 'image' | 'video'
  aspect: ImagineAspect
  /** The recipe: "Quality" offers more ratios, as on Grok. */
  quality: ImagineQuality
  resolution: ImagineResolution
  onAspect: (value: ImagineAspect) => void
  onResolution: (value: ImagineResolution) => void
  onModel: (route: ModelRoute) => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, () => { setOpen(false) }, open)
  // Already clamped for the mode by ComposerBox: no second clamp here.
  const shown = resolution
  // The ratio this surface really offers, not the one the store keeps from
  // another mode or another recipe.
  const shownAspect = aspectFor(aspect, mode, quality)
  /*
   * In Video the size and the length sit in the row (as on Grok): the chip is
   * only the ratio, and the panel holds the ratio and the model.
   */
  const summary = mode === 'video' ? shownAspect : `${shownAspect} · ${shown}`
  const classes: PillClasses = { row: css.optRow, label: css.optLabel, group: css.optPills, pill: css.optPill }
  return (
    <div className={css.optWrap} ref={box}>
      <button type="button" className={css.aspectBtn} aria-expanded={open} aria-label={translate('imagine.settings.title')} onClick={() => { setOpen(current => !current) }}>
        {/* The shape of the ratio the chip names, not the stored one. */}
        <RatioMark aspect={shownAspect} />
        {summary}
      </button>
      {open && (
        <div className={css.optPanel} role="dialog" aria-label={translate('imagine.options')}>
          {/*
            * The ratios as Grok writes them (2026-11-03): the small rectangle
            * with the shape, the ratio, and beside it the everyday name —
            * "Poster", "Photo print", "Story"… The quality model offers more
            * than the fast one, and video five: the list is the surface's,
            * not a single one for the whole studio.
            */}
          <div className={css.optRow}>
            <span className={css.optLabel}>{translate('imagine.aspect')}</span>
            <div role="radiogroup" aria-label={translate('imagine.aspect')}>
              {aspectsFor(mode, quality).map(entry => {
                const nameKey = aspectName(entry, mode, quality)
                const name = nameKey === undefined ? undefined : translate(nameKey as ComfyLocaleKey)
                const on = entry === shownAspect
                return (
                  <button
                    key={entry}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={name === undefined ? entry : `${entry} ${name}`}
                    data-on={on || undefined}
                    className={css.aspectItem}
                    onClick={() => { onAspect(entry) }}
                  >
                    <RatioMark aspect={entry} />
                    <span className={css.aspectRatio}>{entry}</span>
                    <span className={css.aspectName}>{name ?? ''}</span>
                    {on && <IconCheck />}
                  </button>
                )
              })}
            </div>
          </div>
          {mode === 'image' && <Pills label={translate('imagine.resolution')} values={IMAGE_RESOLUTIONS} value={shown} onPick={onResolution} classes={classes} />}
          <div className={css.optRow}>
            <span className={css.optLabel}>{translate('imagine.model')}</span>
            <ImagineModelSelect label={translate('imagine.model')} onPick={onModel} />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The ratio as Grok draws it beside the size: a small rectangle of the right
 * shape, tall for 9:16 and wide for 16:9. It replaces the fixed little square
 * the pills had before 2026-11-03.
 */
function RatioMark({ aspect }: { aspect: ImagineAspect }) {
  const parts = aspect.split(':').map(Number)
  const w = parts[0] ?? 1
  const h = parts[1] ?? 1
  const side = 14
  const scale = 13 / Math.max(w, h)
  const width = Math.max(4, Math.round(w * scale))
  const height = Math.max(4, Math.round(h * scale))
  return (
    <svg width={side} height={side} viewBox={`0 0 ${String(side)} ${String(side)}`} aria-hidden="true">
      <rect
        x={(side - width) / 2}
        y={(side - height) / 2}
        width={width}
        height={height}
        rx={1.6}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
      />
    </svg>
  )
}

function ImageModeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.6" y="2.4" width="12.8" height="11.2" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.4 11.4 5.4 8.2a1 1 0 0 1 1.5 0l1.3 1.4 2-2.2a1 1 0 0 1 1.5.1L13.6 10.6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="5.3" cy="5.6" r="1.1" fill="currentColor" />
    </svg>
  )
}

function VideoModeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="3.6" width="8.8" height="8.8" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.6 6.4 14.2 4.6v6.8l-3.6-1.8V6.4Z" fill="currentColor" />
    </svg>
  )
}

/**
 * What the composer says under its staged files: what the run will do with
 * them, in the mode it is in.
 * @param mode - the composer mode.
 * @param sources - the staged files.
 * @returns the caption.
 */
function stagedHint(
  mode: ImagineMode,
  sources: readonly GalleryItem[],
): string {
  if (mode === 'regenerate' && sources.length === 1) return translate('imagine.regenerateHint')
  if (sources.length === 1) return translate('imagine.sourceHint')
  const stills = sources.filter(item => item.kind === 'image').length
  if (mode === 'video' && stills === sources.length) {
    return translate('imagine.sourceHintMany', { count: String(sources.length) })
  }
  return translate('imagine.sourceHintFiles', { count: String(sources.length) })
}
