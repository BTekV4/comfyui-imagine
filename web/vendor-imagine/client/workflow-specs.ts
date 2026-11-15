/**
 * What each "New generation" workflow needs and can do, in the user's
 * words — the content of its dedicated panel (asked 2026-10-17: on Grok
 * Imagine every workflow opens a dedicated panel explaining what to upload).
 *
 * Pure data: the panel draws it, the page runs it. A slot names the kinds of
 * file it accepts; `options` lists the only controls that matter for the run.
 */

import type { MediaKind } from '../../../shared/imagine-types.ts'
import type { ComfyLocaleKey } from './locales.ts'

export interface WorkflowSlot {
  /** Stable key, also the role the staged file plays. */
  readonly key: string
  /** The slot's label and hint, as dictionary keys. */
  readonly labelKey: ComfyLocaleKey
  readonly hintKey: ComfyLocaleKey
  /**
   * Label and hint already written, for uploaded cards: their text comes from
   * the graph and the card's dictionary, not from a fixed key. When present
   * they win over the key.
   */
  readonly labelText?: string
  readonly hintText?: string
  /** The kinds of file the slot accepts. */
  readonly kinds: readonly MediaKind[]
  readonly required: boolean
}

export type WorkflowOption = 'aspect' | 'resolution' | 'seconds' | 'loopSeconds' | 'style' | 'lyrics' | 'model'
  /** "Recreate video": keep the reference clip's own soundtrack. */
  | 'keepAudio'
  /**
   * "Recreate video": how many candidate opening frames the scan draws.
   *
   * Not to be confused with `count`, which the cards use for a batch of runs.
   */
  | 'references'
  /**
   * "Object swap": what to do with the object tracked in the clip — change it,
   * remove it, change the background around it, or add a new one.
   */
  | 'objectMode'
  /**
   * "Light the photo": one of the 17 lighting looks, picked from a grid of
   * thumbnails. The look IS the prompt, so the panel has no text field.
   */
  | 'light'

export interface WorkflowSpec {
  readonly id: string
  /**
   * The card's title and one-line summary, as locale keys: the panel says what
   * the card says, in the language the page is in. The keys are the ones the
   * cards already use, so a new panel does not need a new translation.
   */
  readonly titleKey: ComfyLocaleKey
  readonly summaryKey: ComfyLocaleKey
  /**
   * What the user can do with it, and the limits worth knowing, as locale
   * keys: the panel's prose is translated like everything else, and a language
   * pack can reach it.
   */
  readonly canKeys: readonly ComfyLocaleKey[]
  readonly notesKeys: readonly ComfyLocaleKey[]
  readonly slots: readonly WorkflowSlot[]
  /**
   * Groups of file slots of which one is enough (an uploaded card that takes a
   * clip or a photo). The panel asks for one of the group, not for all of
   * them: without this both read as required and the card cannot run.
   */
  readonly eitherGroups?: readonly (readonly string[])[]
  /** The text field: absent when the run needs no words. */
  readonly prompt?: { readonly labelKey: ComfyLocaleKey; readonly placeholderKey: ComfyLocaleKey; readonly required: boolean; readonly exampleKeys: readonly ComfyLocaleKey[] }
  readonly options: readonly WorkflowOption[]
  /** Title and description already written (uploaded cards): they win over the keys. */
  readonly titleText?: string
  readonly summaryText?: string
  /** "What you can do" and notes already written (uploaded cards). */
  readonly canTexts?: readonly string[]
  readonly notesTexts?: readonly string[]
  /** The prompt as text already written (uploaded cards). */
  readonly promptText?: { readonly label: string; readonly placeholder?: string; readonly required: boolean }
  /** What the count of candidates is called on this card. */
  readonly referenceLabel?: ComfyLocaleKey
  /**
   * Whether the resolution step is a clip's (480p / 720p).
   *
   * The panel used to infer it from `seconds`, `loopSeconds` or `speed`;
   * "Recreate video" has none of those and its length comes from the clip, yet it
   * renders a clip and must not offer 1080p/1440p.
   */
  readonly videoCanvas?: boolean
  /** Text on the run button, as a locale key. */
  readonly actionKey: ComfyLocaleKey
  /** The button text already written (uploaded cards): it wins over the key. */
  readonly actionText?: string
}

const PHOTO = (labelKey: ComfyLocaleKey, hintKey: ComfyLocaleKey): WorkflowSlot => ({ key: 'photo', labelKey, hintKey, kinds: ['image'], required: true })

const SPECS = {
  generate: {
    id: 'generate',
    titleKey: 'imagine.generate',
    summaryKey: 'imagine.actionGenerateHint',
    canKeys: ['imagine.spec.generate.can1', 'imagine.spec.generate.can2'],
    notesKeys: [],
    slots: [],
    prompt: {
      labelKey: 'imagine.slot.generate.1',
      placeholderKey: 'imagine.slot.generate.11',
      required: true,
      exampleKeys: ['imagine.specEx.generate.1', 'imagine.specEx.generate.2', 'imagine.specEx.generate.3'],
    },
    options: ['aspect', 'resolution', 'model'],
    actionKey: 'imagine.specAct.generate',
  },
  remix: {
    id: 'remix',
    titleKey: 'imagine.remix',
    summaryKey: 'imagine.actionRemixHint',
    canKeys: ['imagine.spec.remix.can1', 'imagine.spec.remix.can2'],
    notesKeys: ['imagine.spec.remix.notes1'],
    slots: [PHOTO('imagine.slot.remix.47', 'imagine.slot.remix.48')],
    prompt: {
      labelKey: 'imagine.slot.remix.2',
      placeholderKey: 'imagine.slot.remix.12',
      required: true,
      exampleKeys: ['imagine.specEx.remix.1', 'imagine.specEx.remix.2', 'imagine.specEx.remix.3'],
    },
    options: ['model'],
    actionKey: 'imagine.specAct.remix',
  },
  style: {
    id: 'style',
    titleKey: 'imagine.changeStyle',
    summaryKey: 'imagine.actionStyleHint',
    canKeys: ['imagine.spec.style.can1'],
    notesKeys: [],
    slots: [PHOTO('imagine.slot.style.49', 'imagine.slot.style.50')],
    options: ['style'],
    actionKey: 'imagine.specAct.style',
  },
  video: {
    id: 'video',
    titleKey: 'imagine.makeVideo',
    summaryKey: 'imagine.actionVideoHint',
    canKeys: ['imagine.spec.video.can1', 'imagine.spec.video.can2', 'imagine.spec.video.can3', 'imagine.spec.video.can4', 'imagine.spec.video.can5'],
    notesKeys: ['imagine.spec.video.notes1', 'imagine.spec.video.notes2'],
    slots: [
      { key: 'start', labelKey: 'imagine.slot.video.13', hintKey: 'imagine.slot.video.14', kinds: ['image', 'video'], required: true },
      { key: 'end', labelKey: 'imagine.slot.video.15', hintKey: 'imagine.slot.video.16', kinds: ['image'], required: false },
      { key: 'song', labelKey: 'imagine.slot.video.17', hintKey: 'imagine.slot.video.18', kinds: ['audio'], required: false },
    ],
    prompt: {
      labelKey: 'imagine.slot.video.3',
      placeholderKey: 'imagine.slot.video.19',
      required: false,
      exampleKeys: ['imagine.specEx.video.1', 'imagine.specEx.video.2', 'imagine.specEx.video.3'],
    },
    options: ['resolution', 'seconds', 'aspect', 'model'],
    actionKey: 'imagine.specAct.video',
  },
  objectSwap: {
    id: 'objectSwap',
    titleKey: 'imagine.objectSwap',
    summaryKey: 'imagine.actionObjectSwapHint',
    canKeys: [
      'imagine.spec.objectSwap.can1',
      'imagine.spec.objectSwap.can2',
      'imagine.spec.objectSwap.can3',
    ],
    notesKeys: ['imagine.spec.objectSwap.notes1'],
    slots: [
      { key: 'clip', labelKey: 'imagine.slot.objectSwap.clip', hintKey: 'imagine.slot.objectSwap.clipHint', kinds: ['video'], required: true },
      { key: 'reference', labelKey: 'imagine.slot.objectSwap.object', hintKey: 'imagine.slot.objectSwap.objectHint', kinds: ['image'], required: false },
    ],
    prompt: {
      labelKey: 'imagine.slot.objectSwap.prompt',
      placeholderKey: 'imagine.slot.objectSwap.promptHint',
      required: true,
      exampleKeys: [],
    },
    options: ['objectMode', 'resolution', 'model'],
    videoCanvas: true,
    actionKey: 'imagine.specAct.objectSwap',
  },
  relight: {
    id: 'relight',
    titleKey: 'imagine.relight',
    summaryKey: 'imagine.actionRelightHint',
    canKeys: [
      'imagine.spec.relight.can1',
      'imagine.spec.relight.can2',
    ],
    notesKeys: ['imagine.spec.relight.notes1'],
    slots: [PHOTO('imagine.slot.relight.photo', 'imagine.slot.relight.photoHint')],
    /*
     * No "Model that writes the prompt" pill: here the prompt is the look's
     * sentence, no model writes it (as for "bg" and "upscale", which have no
     * options).
     */
    options: ['light'],
    actionKey: 'imagine.specAct.relight',
  },
  recreate: {
    id: 'recreate',
    titleKey: 'imagine.recreateVideo',
    summaryKey: 'imagine.actionRecreateHint',
    canKeys: [
      'imagine.spec.recreate.can1',
      'imagine.spec.recreate.can2',
      'imagine.spec.recreate.can3',
      'imagine.spec.recreate.can4',
      'imagine.spec.recreate.can5',
    ],
    notesKeys: [
      'imagine.spec.recreate.notes1',
      'imagine.spec.recreate.notes2',
      'imagine.spec.recreate.notes3',
    ],
    slots: [
      { key: 'plate', labelKey: 'imagine.slot.recreate.29', hintKey: 'imagine.slot.recreate.30', kinds: ['video'], required: true },
    ],
    prompt: {
      labelKey: 'imagine.slot.recreate.5',
      placeholderKey: 'imagine.slot.recreate.31',
      required: false,
      exampleKeys: ['imagine.specEx.recreate.1', 'imagine.specEx.recreate.2', 'imagine.specEx.recreate.3'],
    },
    options: ['references', 'resolution', 'keepAudio', 'model'],
    referenceLabel: 'imagine.frameCandidatesCount',
    videoCanvas: true,
    actionKey: 'imagine.specAct.recreate',
  },
  regenerate: {
    id: 'regenerate',
    titleKey: 'imagine.regenerateDetail',
    summaryKey: 'imagine.actionRegenerateHint',
    canKeys: [
      'imagine.spec.regenerate.can1',
      'imagine.spec.regenerate.can2',
      'imagine.spec.regenerate.can3',
      'imagine.spec.regenerate.can4',
      'imagine.spec.regenerate.can5',
    ],
    notesKeys: [
      'imagine.spec.regenerate.notes1',
      'imagine.spec.regenerate.notes2',
    ],
    slots: [{ key: 'clip', labelKey: 'imagine.slot.regenerate.32', hintKey: 'imagine.slot.regenerate.33', kinds: ['video'], required: true }],
    prompt: {
      labelKey: 'imagine.slot.regenerate.6',
      placeholderKey: 'imagine.slot.regenerate.34',
      required: false,
      exampleKeys: ['imagine.specEx.regenerate.1', 'imagine.specEx.regenerate.2'],
    },
    options: [],
    videoCanvas: true,
    actionKey: 'imagine.specAct.regenerate',
  },
  loop: {
    id: 'loop',
    titleKey: 'imagine.makeLoop',
    summaryKey: 'imagine.actionLoopHint',
    canKeys: ['imagine.spec.loop.can1', 'imagine.spec.loop.can2'],
    notesKeys: ['imagine.spec.loop.notes1'],
    slots: [PHOTO('imagine.slot.loop.51', 'imagine.slot.loop.52')],
    prompt: {
      labelKey: 'imagine.slot.loop.7',
      placeholderKey: 'imagine.slot.loop.35',
      required: false,
      exampleKeys: ['imagine.specEx.loop.1', 'imagine.specEx.loop.2', 'imagine.specEx.loop.3'],
    },
    options: ['loopSeconds', 'aspect', 'model'],
    actionKey: 'imagine.specAct.loop',
  },
  frames: {
    id: 'frames',
    titleKey: 'imagine.extractFrames',
    summaryKey: 'imagine.actionFramesHint',
    canKeys: ['imagine.spec.frames.can1', 'imagine.spec.frames.can2', 'imagine.spec.frames.can3'],
    notesKeys: ['imagine.spec.frames.notes1'],
    slots: [{ key: 'clip', labelKey: 'imagine.slot.frames.36', hintKey: 'imagine.slot.frames.37', kinds: ['video'], required: true }],
    options: [],
    actionKey: 'imagine.specAct.frames',
  },
  compose: {
    id: 'compose',
    titleKey: 'imagine.compose',
    summaryKey: 'imagine.actionComposeHint',
    canKeys: ['imagine.spec.compose.can1', 'imagine.spec.compose.can2'],
    notesKeys: ['imagine.spec.compose.notes1'],
    slots: [
      PHOTO('imagine.slot.compose.53', 'imagine.slot.compose.54'),
      { key: 'reference', labelKey: 'imagine.slot.compose.38', hintKey: 'imagine.slot.compose.39', kinds: ['image'], required: true },
    ],
    prompt: {
      labelKey: 'imagine.slot.compose.8',
      placeholderKey: 'imagine.slot.compose.40',
      required: true,
      exampleKeys: ['imagine.specEx.compose.1', 'imagine.specEx.compose.2'],
    },
    options: [],
    actionKey: 'imagine.specAct.compose',
  },
  bg: {
    id: 'bg',
    titleKey: 'imagine.bgRemoval',
    summaryKey: 'imagine.actionBgHint',
    canKeys: ['imagine.spec.bg.can1'],
    notesKeys: [],
    slots: [PHOTO('imagine.slot.bg.55', 'imagine.slot.bg.56')],
    options: [],
    actionKey: 'imagine.specAct.bg',
  },
  upscale: {
    id: 'upscale',
    titleKey: 'imagine.upscale',
    summaryKey: 'imagine.actionUpscaleHint',
    canKeys: ['imagine.spec.upscale.can1'],
    notesKeys: ['imagine.spec.upscale.notes1'],
    slots: [{ key: 'source', labelKey: 'imagine.slot.upscale.41', hintKey: 'imagine.slot.upscale.42', kinds: ['image', 'video'], required: true }],
    options: [],
    actionKey: 'imagine.specAct.upscale',
  },
  music: {
    id: 'music',
    titleKey: 'imagine.makeMusic',
    summaryKey: 'imagine.actionMusicHint',
    canKeys: ['imagine.spec.music.can1', 'imagine.spec.music.can2'],
    notesKeys: ['imagine.spec.music.notes1'],
    slots: [],
    prompt: {
      labelKey: 'imagine.slot.music.9',
      placeholderKey: 'imagine.slot.music.43',
      required: true,
      exampleKeys: ['imagine.specEx.music.1', 'imagine.specEx.music.2', 'imagine.specEx.music.3'],
    },
    options: ['lyrics'],
    actionKey: 'imagine.specAct.music',
  },
  voice: {
    id: 'voice',
    titleKey: 'imagine.changeVoice',
    summaryKey: 'imagine.actionVoiceHint',
    canKeys: ['imagine.spec.voice.can1'],
    notesKeys: ['imagine.spec.voice.notes1'],
    slots: [{ key: 'track', labelKey: 'imagine.slot.voice.44', hintKey: 'imagine.slot.voice.45', kinds: ['audio', 'video'], required: true }],
    options: [],
    actionKey: 'imagine.specAct.voice',
  },
  tts: {
    id: 'tts',
    titleKey: 'imagine.makeSpeech',
    summaryKey: 'imagine.actionSpeechHint',
    canKeys: ['imagine.spec.tts.can1'],
    notesKeys: [],
    slots: [],
    prompt: {
      labelKey: 'imagine.slot.tts.10',
      placeholderKey: 'imagine.slot.tts.46',
      required: true,
      exampleKeys: [],
    },
    options: [],
    actionKey: 'imagine.specAct.tts',
  },
  clip: {
    id: 'clip',
    titleKey: 'imagine.makeClip',
    summaryKey: 'imagine.actionClipHint',
    canKeys: ['imagine.spec.clip.can1'],
    notesKeys: ['imagine.spec.clip.notes1'],
    slots: [],
    options: [],
    actionKey: 'imagine.specAct.clip',
  },
} satisfies Readonly<Record<string, WorkflowSpec>>

/** The cards that open a panel of their own, by id. */
export type WorkflowCardId = keyof typeof SPECS

/** Each card's panel, keyed by the card's id. */
export const WORKFLOW_SPECS: Readonly<Record<WorkflowCardId, WorkflowSpec>> = SPECS
