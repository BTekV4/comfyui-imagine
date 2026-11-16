/**
 * The dedicated panel one "New generation" card opens: what the workflow
 * does, which files it needs (each in its own labelled slot, uploaded or
 * picked from the gallery), what to write, the few options that matter and
 * one button that says what is still missing.
 *
 * Presentational: the page owns the state and runs the job; the panel reads
 * the staged files and calls back. Content comes from `workflow-specs.ts`.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { IconCloseOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular } from '../../shims/primitives/index.ts'
import { thumbUrlOf, THUMB_SMALL } from './gallery-api.ts'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { ImagineModelSelect } from './ImagineModelSelect.tsx'
import {
  LOOP_SECONDS, SWAP_RESOLUTIONS, VIDEO_RESOLUTIONS, videoSecondsFor,
} from './imagine-settings.ts'
import {
  IMAGE_RESOLUTIONS, IMAGINE_ASPECTS, type ImagineAspect, type ImagineResolution,
} from '../../../shared/imagine-media.ts'
import { FrameExtractor, type FrameCard } from './FrameExtractor.tsx'
import { Pills, type PillClasses } from './Pills.tsx'
import { Still } from './Still.tsx'
import { STYLE_PRESETS } from './style-catalog.ts'
import { pickUpscaleStep, upscaleChoicesOf } from './upscale-choices.ts'
import type { WorkflowSlot, WorkflowSpec } from './workflow-specs.ts'
import type { ComfyLocaleKey } from './locales.ts'
import { locale, translate } from './locale-store.ts'
import { kindsLabel } from './labels.ts'
import {
  DEFAULT_OBJECT_PLACEMENT, IMAGINE_OBJECT_MODES, type ImagineObjectMode, type ImaginePlacement, type MediaKind,
} from '../../../shared/imagine-types.ts'
import { PlacementPicker } from './PlacementPicker.tsx'
import type { ModelRoute } from '../../../shared/imagine-types.ts'
import { CoverMedia } from './cover-media.tsx'
import { DEFAULT_RELIGHT_LOOK, RELIGHT_LOOKS, relightThumbOf, type RelightLook } from '../../../shared/relight-looks.ts'
import { AudioMark } from './imagine-bits.tsx'
import { useTrackSeconds } from './use-track-seconds.ts'
import css from './WorkflowPanel.module.css'

export interface WorkflowPanelProps {
  readonly spec: WorkflowSpec
  readonly cover: string
  /**
   * The repo's clip for this action, when it has one: `CoverMedia` draws the
   * cover, with the same precedence as the card on the home page.
   */
  readonly motion?: string
  /** The cover is a file of this kind, drawn as it is (custom workflows). */
  readonly coverKind?: 'image' | 'video'
  /**
   * One more box, in the form column above the button: the LoRAs of custom
   * workflows. It used to sit below the panel, outside the columns.
   */
  readonly extra?: { readonly title: string; readonly body: ReactNode }
  readonly items: readonly GalleryItem[]
  /** Files staged for this run, by slot key. */
  readonly staged: Readonly<Record<string, GalleryItem | undefined>>
  readonly prompt: string
  readonly aspect: ImagineAspect
  readonly resolution: ImagineResolution
  /** "Recreate video": how many candidate opening frames the scan draws. */
  readonly references?: number
  /** "Object swap": what to do with the object tracked in the clip. */
  readonly objectMode?: ImagineObjectMode
  /** "Add an object": where the object appears, as fractions of the frame. */
  readonly placement?: ImaginePlacement
  /** "Light the photo": the chosen lighting look, by id. */
  readonly light?: string
  readonly seconds: number
  readonly lyrics?: string
  /** "Recreate video": whether the reference clip's soundtrack is kept. */
  readonly keepAudio?: boolean
  /** "Character swap": whether the new person mouths the clip's vocals. */
  readonly lipSync?: boolean
  readonly busy: boolean
  readonly note: string | undefined
  readonly onBack: () => void
  readonly onStage: (slot: WorkflowSlot, item: GalleryItem | undefined) => void
  readonly onUpload: (slot: WorkflowSlot, file: File) => Promise<void>
  readonly onPrompt: (value: string) => void
  readonly onAspect: (value: ImagineAspect) => void
  readonly onResolution: (value: ImagineResolution) => void
  readonly onReferences?: (value: number) => void
  readonly onObjectMode?: (value: ImagineObjectMode) => void
  readonly onPlacement?: (value: ImaginePlacement) => void
  readonly onLight?: (value: string) => void
  readonly onSeconds: (value: number) => void
  readonly onLyrics?: (value: string) => void
  readonly onKeepAudio?: (value: boolean) => void
  readonly onLipSync?: (value: boolean) => void
  readonly onModel?: (route: ModelRoute) => void
  readonly onRun: () => void
  /**
   * The controls of an uploaded card that are not built-in options: dropdowns
   * (or fields) derived from the graph's nodes.
   */
  /**
   * A control with N values: the button that queues one run for each.
   * The caller asks for confirmation (N runs are N renders).
   */
  readonly batch?: { readonly count: number; readonly label: string; readonly onRun: () => void }
  readonly controls?: readonly { readonly key: string; readonly label: string; readonly options: readonly string[] }[]
  /** The value picked for each control, by key (`<node>.<field>`). */
  readonly controlValues?: Readonly<Record<string, string>>
  readonly onControl?: (key: string, value: string) => void
  /** Upscale: the picked step (short side), and its setter. */
  readonly upscaleTo?: number | undefined
  readonly onUpscaleTo?: (short: number | undefined) => void
  /** Extract frames: a frame was saved to the gallery. */
  readonly onFrameSaved?: (item: GalleryItem) => void
  /** Extract frames: open another panel with this frame staged. */
  readonly onUseFrame?: (item: GalleryItem, card: FrameCard) => void
}

/**
 * How many candidates a scan’s pill row offers.
 *
 * Typed as plain numbers so the pill row's value (`props.references`) stays a
 * number: a literal tuple would make the row accept only the values listed.
 * A candidate costs ~20 s of drawing, so the two ends of the range matter:
 * one is ready in half a minute, twenty are minutes of drawing before the
 * second half even starts.
 */
const SCAN_CANDIDATE_CHOICES: readonly number[] = [1, 2, 4, 6, 10, 12, 20]

/**
 * The four recipes of "Object swap", in dictionary words: they are a closed
 * choice, so the panel shows all four instead of leaving the sentence to
 * guess them.
 */
const OBJECT_MODE_KEYS: Readonly<Record<ImagineObjectMode, ComfyLocaleKey>> = {
  change: 'imagine.objectModeChange',
  remove: 'imagine.objectModeRemove',
  background: 'imagine.objectModeBackground',
  add: 'imagine.objectModeAdd',
}

const ACCEPT: Record<MediaKind, string> = { image: 'image/*', video: 'video/*', audio: 'audio/*' }

/** The panel's pill rows. */
const PILLS: PillClasses = { row: css.option, label: css.optionLabel, group: css.pills, pill: css.pill }

function Slot({ slot, label, hint, item, items, onStage, onUpload }: {
  slot: WorkflowSlot
  label: string
  hint: string
  item: GalleryItem | undefined
  items: readonly GalleryItem[]
  onStage: (item: GalleryItem | undefined) => void
  onUpload: (file: File) => Promise<void>
}) {
  const input = useRef<HTMLInputElement>(null)
  const [picking, setPicking] = useState(false)
  const [loading, setLoading] = useState(false)
  const [over, setOver] = useState(false)
  const choices = useMemo(() => items
    .filter(entry => slot.kinds.includes(entry.kind))
    .slice()
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, 36), [items, slot.kinds])
  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setLoading(true)
    try { await onUpload(file) } finally { setLoading(false) }
  }
  const kinds = kindsLabel(slot.kinds)
  return (
    <div className={css.slot} data-filled={item !== undefined || undefined}>
      <div className={css.slotHead}>
        <span className={css.slotLabel}>{label}</span>
        {!slot.required && <span className={css.optional}>{translate('imagine.optional')}</span>}
      </div>
      {item === undefined
        ? (
          <div
            className={css.drop}
            data-over={over || undefined}
            onDragOver={(event) => { event.preventDefault(); setOver(true) }}
            onDragLeave={() => { setOver(false) }}
            onDrop={(event) => {
              event.preventDefault()
              setOver(false)
              void upload(event.dataTransfer.files[0])
            }}
          >
            <p className={css.dropHint}>{loading ? translate('imagine.loading') : hint}</p>
            <div className={css.dropActions}>
              <button type="button" className={css.secondary} disabled={loading} onClick={() => { input.current?.click() }}>
                <IconPlusOutlineRegular size={14} />
                <span>{translate('imagine.uploadKinds', { kinds })}</span>
              </button>
              <button type="button" className={css.secondary} disabled={choices.length === 0} onClick={() => { setPicking(current => !current) }}>
                <span>{picking ? translate('imagine.closeGallery') : translate('imagine.fromGallery')}</span>
              </button>
            </div>
            <input
              ref={input}
              type="file"
              hidden
              accept={slot.kinds.map(kind => ACCEPT[kind]).join(',')}
              onChange={(event) => {
                void upload(event.target.files?.[0])
                event.target.value = ''
              }}
            />
          </div>
        )
        : (
          <div className={css.picked}>
            {item.kind === 'audio'
              ? <AudioMark className={css.audioThumb} />
              : <Still className={css.pickedThumb} src={thumbUrlOf(item.name, THUMB_SMALL, item.mtime)} />}
            <span className={css.pickedName} title={item.name}>{item.name}</span>
            <button type="button" className={css.remove} aria-label={translate('imagine.removeNamed', { name: item.name })} onClick={() => { onStage(undefined) }}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
        )}
      {picking && item === undefined && (
        <div className={css.gallery}>
          {choices.map(entry => (
            <button
              key={entry.name}
              type="button"
              className={css.galleryItem}
              title={entry.name}
              onClick={() => { onStage(entry); setPicking(false) }}
            >
              {entry.kind === 'audio'
                ? <AudioMark className={css.audioThumb} />
                : <Still className={css.galleryThumb} src={thumbUrlOf(entry.name, THUMB_SMALL, entry.mtime)} lazy />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * What the built-in options read when the caller does not use them. They are
 * only drawn under `spec.options.includes(...)` (or a spec id), so an
 * uploaded card, which has none of them, no longer passes fifteen
 * placeholders just to satisfy the type.
 */
const NO_OPTIONS = {
  references: 10,
  objectMode: 'change' as ImagineObjectMode,
  placement: DEFAULT_OBJECT_PLACEMENT,
  light: DEFAULT_RELIGHT_LOOK.id,
  lyrics: '',
  keepAudio: false,
  lipSync: true,
  onReferences: () => undefined,
  onObjectMode: () => undefined,
  onPlacement: () => undefined,
  onLight: () => undefined,
  onLyrics: () => undefined,
  onKeepAudio: () => undefined,
  onLipSync: () => undefined,
  onModel: () => undefined,
  upscaleTo: undefined,
  onUpscaleTo: () => undefined,
  onFrameSaved: () => undefined,
  onUseFrame: () => undefined,
} satisfies Partial<WorkflowPanelProps>

export function WorkflowPanel(given: WorkflowPanelProps) {
  const props = { ...NO_OPTIONS, ...given }
  const { spec } = props
  /*
   * A track staged on a card that renders a video ("Video": its song slot) is
   * the video's length, so the length pills give way to it (2026-11-16).
   */
  const track = spec.options.includes('seconds')
    ? Object.values(props.staged).find(item => item?.kind === 'audio')
    : undefined
  const trackSeconds = useTrackSeconds(track)
  /** The panel's texts: an uploaded card brings them already written. */
  const titleText = spec.titleText ?? translate(spec.titleKey)
  const summaryText = spec.summaryText ?? translate(spec.summaryKey)
  const canTexts = spec.canTexts ?? spec.canKeys.map(key => translate(key))
  const notesTexts = spec.notesTexts ?? spec.notesKeys.map(key => translate(key))
  const actionText = spec.actionText ?? translate(spec.actionKey)
  const prompt = spec.promptText !== undefined
    ? { label: spec.promptText.label, placeholder: spec.promptText.placeholder ?? '', required: spec.promptText.required, examples: [] as readonly { key: string; text: string }[] }
    : spec.prompt === undefined
      ? undefined
      : {
        label: translate(spec.prompt.labelKey),
        placeholder: translate(spec.prompt.placeholderKey),
        required: spec.prompt.required,
        examples: spec.prompt.exampleKeys.map(key => ({ key, text: translate(key) })),
      }
  /*
   * The "Object swap" photo is required only in `change` mode: the slot is
   * optional because the other three modes do not want it, and the rule
   * belongs to the mode, not the slot.
   */
  const objectPhotoNeeded = spec.id === 'objectSwap' && props.objectMode === 'change'
    && props.staged.reference === undefined
  /*
   * A card that takes a clip or a photo: the slots of a group are alternatives,
   * so one staged file satisfies all of them, and a group with no file asks for
   * the pair once instead of naming both slots.
   */
  const eitherGroups = spec.eitherGroups ?? []
  const inEitherGroup = new Set(eitherGroups.flat())
  const eitherMissing = eitherGroups.filter(group => !group.some(key => props.staged[key] !== undefined))
  const missing = [
    ...spec.slots.filter(slot => slot.required && !inEitherGroup.has(slot.key) && props.staged[slot.key] === undefined)
      .map(slot => (slot.labelText ?? translate(slot.labelKey)).toLowerCase()),
    ...eitherMissing.map(() => translate('imagine.custom.either')),
    ...objectPhotoNeeded ? [translate('imagine.slot.objectSwap.object').toLowerCase()] : [],
    ...prompt !== undefined && prompt.required && props.prompt.trim() === '' ? [prompt.label.toLowerCase()] : [],
  ]
  const isVideo = spec.videoCanvas === true || spec.options.includes('seconds')
    || spec.options.includes('loopSeconds')
  const resolutions: readonly ImagineResolution[] = spec.swapCanvas === true ? SWAP_RESOLUTIONS : isVideo ? VIDEO_RESOLUTIONS : IMAGE_RESOLUTIONS
  const resolution = resolutions.includes(props.resolution) ? props.resolution : resolutions[resolutions.length - 1] ?? '720p'
  const seconds = spec.options.includes('loopSeconds') ? LOOP_SECONDS : videoSecondsFor(resolution)
  const canRun = missing.length === 0 && !props.busy

  return (
    <section className={css.panel} aria-label={titleText}>
      <button type="button" className={css.back} onClick={props.onBack}>{translate('imagine.allTools')}</button>
      <div className={css.layout}>
        <aside className={css.intro}>
          {/* The same cover as the home card: same function, same precedence. */}
          <CoverMedia className={css.cover} cover={props.cover} motion={props.motion} direct={props.coverKind} />
          <h2 className={css.title}>{titleText}</h2>
          <p className={css.summary}>{summaryText}</p>
          {canTexts.length > 0 && (
            <>
              <h3 className={css.subhead}>{translate('imagine.specCan')}</h3>
              <ul className={css.list}>{canTexts.map(text => <li key={text}>{text}</li>)}</ul>
            </>
          )}
          {notesTexts.length > 0 && (
            <>
              <h3 className={css.subhead}>{translate('imagine.specNotes')}</h3>
              <ul className={css.list}>{notesTexts.map(text => <li key={text}>{text}</li>)}</ul>
            </>
          )}
        </aside>

        <div className={css.form}>
          {spec.slots.length > 0 && (
            <div className={css.block}>
              <h3 className={css.blockTitle}>{spec.slots.length === 1 ? translate('imagine.whatToUpload') : translate('imagine.whatToUploadN', { count: spec.slots.length })}</h3>
              <div className={css.slots} data-count={spec.slots.length}>
                {spec.slots.map(slot => (
                  <Slot
                    key={slot.key}
                    slot={slot}
                    label={slot.labelText ?? translate(slot.labelKey)}
                    hint={slot.hintText ?? translate(slot.hintKey)}
                    item={props.staged[slot.key]}
                    items={props.items}
                    onStage={(item) => { props.onStage(slot, item) }}
                    onUpload={file => props.onUpload(slot, file)}
                  />
                ))}
              </div>
            </div>
          )}

          {prompt !== undefined && (
            <div className={css.block}>
              <label className={css.blockTitle} htmlFor={`wf-${spec.id}-prompt`}>
                {prompt.label}
                {!prompt.required && <span className={css.optional}> · {translate('imagine.optional')}</span>}
              </label>
              <textarea
                id={`wf-${spec.id}-prompt`}
                className={css.prompt}
                rows={spec.id === 'tts' ? 6 : 3}
                placeholder={prompt.placeholder}
                value={props.prompt}
                onChange={(event) => { props.onPrompt(event.target.value) }}
              />
              {prompt.examples.length > 0 && (
                <div className={css.examples}>
                  <span className={css.examplesLabel}>{translate('imagine.examplesLabel')}</span>
                  {prompt.examples.map(example => (
                    <button key={example.key} type="button" className={css.example} onClick={() => { props.onPrompt(example.text) }}>{example.text}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/*
            * "Recreate video": the soundtrack is one decision and gets one box —
            * the clip's own audio, or the one written under the new picture.
            */}
          {spec.options.includes('keepAudio') && (
            <div className={css.block}>
              <h3 className={css.blockTitle}>{translate('imagine.label.audio')}</h3>
              <label className={css.check}>
                <input
                  type="checkbox"
                  checked={props.keepAudio}
                  onChange={(event) => { props.onKeepAudio(event.target.checked) }}
                />
                <span>{translate('imagine.keepAudioHint')}</span>
              </label>
              <p className={css.dropHint}>
                {props.keepAudio
                  ? translate('imagine.keepAudioOn')
                  : translate('imagine.keepAudioOff')}
              </p>
            </div>
          )}

          {/*
            * "Character swap": Openjutsu's «No lip-sync», shown the other way
            * round. Off, H3 hears silence and is told nobody sings: for music
            * the people only move to.
            */}
          {spec.options.includes('lipSync') && (
            <div className={css.block}>
              <h3 className={css.blockTitle}>{translate('imagine.label.audio')}</h3>
              <label className={css.check}>
                <input
                  type="checkbox"
                  checked={props.lipSync}
                  onChange={(event) => { props.onLipSync(event.target.checked) }}
                />
                <span>{translate('imagine.lipSyncHint')}</span>
              </label>
              <p className={css.dropHint}>
                {props.lipSync
                  ? translate('imagine.lipSyncOn')
                  : translate('imagine.lipSyncOff')}
              </p>
            </div>
          )}

          {spec.id === 'upscale' && props.staged.source !== undefined && (() => {
            const choices = upscaleChoicesOf(props.staged.source)
            // Nothing picked yet reads as the highest step, the one the run sends.
            const picked = pickUpscaleStep(props.staged.source, props.upscaleTo, true)
            return (
              <div className={css.block}>
                <span className={css.blockTitle}>{translate('imagine.upscaleTo')}</span>
                {choices.length === 0
                  ? <p className={css.dropHint}>{translate('imagine.alreadyMaxResolution')}</p>
                  : (
                    <div className={css.pills} role="radiogroup" aria-label={translate('imagine.targetResolution')}>
                      {choices.map(choice => (
                        <button
                          key={choice.short}
                          type="button"
                          role="radio"
                          aria-checked={choice.short === picked?.short}
                          className={css.pill}
                          data-on={choice.short === picked?.short || undefined}
                          onClick={() => { props.onUpscaleTo(choice.short) }}
                        >
                          {choice.label} · {choice.size}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
            )
          })()}

          {spec.options.includes('style') && (
            <div className={css.block}>
              <span className={css.blockTitle}>{translate('imagine.style')}</span>
              <div className={css.pills}>
                {STYLE_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    type="button"
                    className={css.pill}
                    data-on={props.prompt === preset.prompt || undefined}
                    onClick={() => { props.onPrompt(preset.prompt) }}
                  >
                    {translate(preset.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {spec.options.includes('lyrics') && (
            <div className={css.block}>
              <label className={css.blockTitle} htmlFor="wf-lyrics">{translate('imagine.songLyricsLabel')}</label>
              <textarea
                id="wf-lyrics"
                className={css.prompt}
                rows={6}
                placeholder={translate('imagine.songLyricsPlaceholder')}
                value={props.lyrics}
                onChange={(event) => { props.onLyrics(event.target.value) }}
              />
            </div>
          )}

          {/*
            * "Light the photo": the looks are a visual choice, so a grid of
            * thumbnails and not a row of text pills.
            */}
          {spec.options.includes('light') && (
            <div className={css.block}>
              <h3 className={css.blockTitle}>{translate('imagine.light')}</h3>
              <div className={css.lights} role="radiogroup" aria-label={translate('imagine.light')}>
                {RELIGHT_LOOKS.map((look: RelightLook) => (
                  <button
                    key={look.id}
                    type="button"
                    role="radio"
                    aria-checked={look.id === props.light}
                    className={css.light}
                    data-on={look.id === props.light || undefined}
                    onClick={() => { props.onLight(look.id) }}
                  >
                    <img src={relightThumbOf(look)} alt="" loading="lazy" />
                    <span>{locale() === 'it' ? look.name : look.nameEn}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/*
            * "Add an object": the box is the graph's mask, so where there is
            * no box there is no object. It appears only in this mode, and
            * applies even when the run brings the photo (2026-11-06).
            */}
          {spec.id === 'objectSwap' && props.objectMode === 'add' && (
            <PlacementPicker value={props.placement} onChange={props.onPlacement} />
          )}

          {(spec.options.includes('aspect') || spec.options.includes('resolution') || spec.options.includes('seconds') || spec.options.includes('loopSeconds') || spec.options.includes('references') || spec.options.includes('objectMode') || spec.options.includes('model')) && (
            <div className={css.block}>
              <h3 className={css.blockTitle}>{translate('imagine.options')}</h3>
              {spec.options.includes('objectMode') && (
                <Pills
                  label={translate('imagine.objectMode')}
                  values={IMAGINE_OBJECT_MODES}
                  value={props.objectMode}
                  onPick={props.onObjectMode}
                  format={value => translate(OBJECT_MODE_KEYS[value])}
                  classes={PILLS}
                />
              )}
              {spec.options.includes('aspect') && (
                <Pills label={translate('imagine.detailsAspect')} values={IMAGINE_ASPECTS} value={props.aspect} onPick={props.onAspect} classes={PILLS} />
              )}
              {spec.options.includes('resolution') && (
                <Pills label={translate('imagine.resolution')} values={resolutions} value={resolution} onPick={props.onResolution} classes={PILLS} />
              )}
              {spec.options.includes('references') && (
                <Pills
                  label={translate(spec.referenceLabel ?? 'imagine.referenceCount')}
                  values={SCAN_CANDIDATE_CHOICES}
                  value={props.references}
                  onPick={props.onReferences}
                  format={value => translate('imagine.photoCount', { count: value })}
                  classes={PILLS}
                />
              )}
              {(spec.options.includes('seconds') || spec.options.includes('loopSeconds')) && track === undefined && (
                <Pills label={translate('imagine.duration')} values={seconds} value={seconds.includes(props.seconds) ? props.seconds : seconds[1] ?? seconds[0] ?? 10} onPick={props.onSeconds} format={value => `${String(value)} s`} classes={PILLS} />
              )}
              {track !== undefined && (
                <div className={css.option}>
                  <span className={css.optionLabel}>{translate('imagine.duration')}</span>
                  <span
                    className={css.trackLength}
                    data-imagine-track-length={trackSeconds ?? ''}
                    title={translate('imagine.durationFromAudioHint')}
                  >
                    {trackSeconds === undefined
                      ? translate('imagine.durationFromAudio')
                      : translate('imagine.durationFromAudioSeconds', { seconds: String(trackSeconds) })}
                  </span>
                </div>
              )}
              {spec.options.includes('model') && (
                <div className={css.option}>
                  <span className={css.optionLabel}>{translate('imagine.promptModelLabel')}</span>
                  <ImagineModelSelect label={translate('imagine.model')} onPick={props.onModel} />
                </div>
              )}
            </div>
          )}

          {props.controls !== undefined && props.controls.length > 0 && (
            <div className={css.block}>
              <h3 className={css.blockTitle}>{translate('imagine.custom.controls')}</h3>
              {props.controls.map(control => (
                <label className={css.option} key={control.key}>
                  <span className={css.optionLabel}>{control.label}</span>
                  {control.options.length > 0
                    ? (
                      <select
                        className={css.select}
                        value={props.controlValues?.[control.key] ?? ''}
                        onChange={(event) => { props.onControl?.(control.key, event.target.value) }}
                      >
                        <option value="">—</option>
                        {control.options.map(option => <option key={option} value={option}>{option}</option>)}
                      </select>
                    )
                    : (
                      <input
                        className={css.select}
                        type="text"
                        value={props.controlValues?.[control.key] ?? ''}
                        onChange={(event) => { props.onControl?.(control.key, event.target.value) }}
                      />
                    )}
                </label>
              ))}
            </div>
          )}

          {spec.id === 'frames' && props.staged.clip !== undefined && (
            <FrameExtractor clip={props.staged.clip} onSaved={props.onFrameSaved} onUse={props.onUseFrame} />
          )}

          {props.extra !== undefined && (
            <div className={css.block}>
              <h3 className={css.blockTitle}>{props.extra.title}</h3>
              {props.extra.body}
            </div>
          )}

          {spec.id !== 'frames' && <div className={css.runBar}>
            {props.batch !== undefined && (
              <button type="button" className={css.secondary} disabled={props.busy} onClick={props.batch.onRun}>
                {props.batch.label} ({props.batch.count})
              </button>
            )}
            <button type="button" className={css.run} disabled={!canRun} onClick={props.onRun}>
              <IconSparkleRegular size={16} />
              <span>{props.busy ? translate('imagine.jobRunningDots', { dots: '…' }) : actionText}</span>
            </button>
            <span className={css.runHint} role="status">
              {props.note ?? (missing.length > 0
                ? translate('imagine.missingFields', { fields: missing.join(', ') })
                : translate('imagine.readyToRun'))}
            </span>
          </div>}
        </div>
      </div>
    </section>
  )
}
