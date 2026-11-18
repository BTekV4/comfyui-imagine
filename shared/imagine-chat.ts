/**
 * The written lane (POST /comfy-imagine/chat) and the workflow changes it can
 * offer (POST /comfy-imagine/workflows…): what the page sends back and forth
 * with the server's reader. Types only, read by both sides.
 *
 * Until 2026-10-25 the page re-declared each of these beside the server's own.
 */

import type {
  ImagineAction, ImagineObjectMode, ImagineQuality, ImagineRegion, ImagineSpeed, MediaFileRef, ModelRoute,
} from './imagine-types.ts'

/** A value a workflow change reads or writes: everything else is structure. */
export type WorkflowScalar = string | number | boolean

/** One change asked for: a node's input takes a new scalar. */
export interface WorkflowValueChange {
  /** Node id inside the graph. */
  readonly node: string
  /** The input key. */
  readonly field: string
  /** The value to write. */
  readonly value: WorkflowScalar
}

/** One change as it will be applied, with what it replaces. */
export interface WorkflowDiff {
  readonly node: string
  readonly classType: string
  readonly field: string
  readonly from: WorkflowScalar
  readonly to: WorkflowScalar
}

/** One node input a page can edit: a scalar, never a link. */
export interface WorkflowField {
  /** Node id inside the graph. */
  readonly node: string
  /** The node's class, so a page can label the row. */
  readonly classType: string
  /** The input key. */
  readonly field: string
  /** The input's current value. */
  readonly value: WorkflowScalar
  /** Which control the value asks for. */
  readonly kind: 'text' | 'number' | 'boolean'
}

/**
 * What one node input accepts, beyond the value it holds: the facts a change
 * has to respect, read from ComfyUI (`/object_info`).
 *
 * The graph says what each input is NOW. It does not say that a combo holds a
 * closed list, that a number has bounds, or that a measure must be a multiple
 * of something: those live in the node's Python, and a value outside them is
 * refused by ComfyUI only after the run has been queued.
 */
export interface WorkflowFieldFact {
  /** Node id inside the graph. */
  readonly node: string
  /** The input key. */
  readonly field: string
  /** Which control the input takes; a combo is a closed list of strings. */
  readonly kind: 'text' | 'number' | 'boolean' | 'combo'
  /** The values a combo accepts, in the node's own spelling. */
  readonly options?: readonly string[]
  /** Bounds of a numeric input, when the node declares them. */
  readonly min?: number
  readonly max?: number
  /** What a numeric input must be a multiple of, when the node declares it. */
  readonly step?: number
}

/** What a set of changes would do to one workflow file, nothing written yet. */
export interface WorkflowPlan {
  readonly file: string
  readonly diff: readonly WorkflowDiff[]
  /** Changes that were refused, and why, in the studio's language. */
  readonly errors: readonly string[]
  /** Pins this deployment has that the graph no longer carries. */
  readonly warnings: readonly string[]
}

/** A workflow change the studio is offering to make, once the user says so. */
export interface WorkflowProposal extends WorkflowPlan {
  readonly key: string
  readonly label: string
}

/** One run the sentence asked for, in the fields the composer used to hold. */
export interface ImagineChatIntent {
  readonly action: ImagineAction
  /** What to generate; already in the language the workflow wants. */
  readonly prompt: string
  readonly aspect?: string
  readonly resolution?: string
  readonly seconds?: number
  /** How many variants of the same prompt. */
  readonly count?: number
  readonly lyrics?: string
  /** The voice a `voice` run sings its source with. */
  readonly voice?: string
  /** Semitones the voice is shifted by; negative goes down. */
  readonly pitch?: number
  /** The second photo: an object swap's object, a composition's reference. */
  readonly reference?: string
  /**
   * An object swap's recipe: which of the four edits the sentence asked for.
   *
   * Read only for `objectSwap`, and absent means the host's default (`change`,
   * the one that takes the photo).
   */
  readonly objectMode?: ImagineObjectMode
  /**
   * A relight's look, by slug (`shared/relight-looks.ts`).
   *
   * Read only for `relight`; absent means the recipe's first look.
   */
  readonly light?: string
  /** A staged or gallery file this run starts from. */
  readonly source?: string
  /**
   * One photo per shot, when a long video is a montage rather than one take.
   *
   * `story` uses a single still and grows it: every clip continues the last,
   * so a project with eight photos got a video made from one of them. These
   * are the pictures the video cuts between instead.
   */
  readonly sources?: readonly string[]
  /** A track to lay over a long video. */
  readonly song?: string
  /**
   * Whether a recreation keeps the reference clip's own soundtrack.
   *
   * Read off the user's words as much as the model's: the checkbox belongs to
   * the composer, and a line written in a project never sees it.
   */
  readonly keepAudio?: boolean
  /** Character swap only: false when the people in the clip do not sing or talk along. */
  readonly lipSync?: boolean
  /**
   * How much detail a run buys, with the graph's high recipe (`quality: 'high'`)
   * or its slower one (`speed: 'slow'`).
   *
   * Both are the composer's «Quality» pill, whose two faces travel together;
   * a sentence may ask for them ("falla in alta qualità", "fai la versione
   * lenta") and until 2026-11-18 the reading could not carry the choice.
   */
  readonly quality?: ImagineQuality
  readonly speed?: ImagineSpeed
  /**
   * Upscale only: the short side to raise the file to.
   *
   * One of the steps the page's upscale menu offers (1080/1440/2160 for a
   * still, 720/1080 for a clip); the host refuses a value off that ladder.
   */
  readonly upscaleTo?: number
  /**
   * Remix only: the zone a precise edit may change, as fractions of the photo.
   *
   * The rest of the picture stays the source's own pixels. Absent is a full
   * redraw, which is what "remix" means when nobody marks a zone.
   */
  readonly region?: ImagineRegion
  /**
   * Custom only: which uploaded card to run, by id.
   *
   * The card's own controls travel beside it in `customFields`, exactly as the
   * MCP's `custom` action sends them.
   */
  readonly customWorkflowId?: string
  /** Custom only: the card's exposed inputs, keyed `<node>.<field>`. */
  readonly customFields?: Readonly<Record<string, string | number | boolean>>
}

/** One run of the project still going, as the page's job list shows it. */
export interface ImagineChatWorking {
  /** The action the run asked for, as the studio names it. */
  readonly action: string
  /** Whether it is waiting for the GPU or holding it. */
  readonly status: 'queued' | 'running'
  /** How far the run is, when ComfyUI reported it. */
  readonly percent?: number
  /** The ComfyUI node class executing now, when the studio knows it. */
  readonly stage?: string
  /** Seconds left at the pace the run is going, when the studio could measure it. */
  readonly etaSeconds?: number
}

/**
 * What the page sends with one written line (POST /comfy-imagine/chat).
 *
 * The server reads the same body and adds what only the host knows (the
 * language from the header, the installed voices, the files' notes and
 * shapes): see `ImagineChatRequest` in `tool-comfy/imagine-chat.ts`. Until
 * 2026-11-14 the page wrote this shape on its own, with fields (`looks`, a
 * preset's look and pose) the server had stopped reading.
 */
export interface ImagineChatAsk {
  /** The line the user wrote. */
  readonly text: string
  /** The conversation so far, oldest first, already trimmed by the client. */
  readonly history?: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[]
  /** Files staged in the composer: the sentence's "questa foto". */
  readonly staged?: readonly MediaFileRef[]
  /** The newest files on the board, for "l'ultimo video", "quella immagine". */
  readonly recent?: readonly MediaFileRef[]
  /** What the toolbar would have sent, and what an unsaid field falls back to. */
  readonly defaults?: {
    readonly aspect?: string
    readonly resolution?: string
    readonly seconds?: number
  }
  /**
   * What the studio itself last said happened: outcomes, failures, refusals.
   *
   * These are not part of the conversation — nobody wrote them — but they are
   * the only thing that can answer "perche' e' fallito?".
   */
  readonly events?: readonly string[]
  /**
   * The model the composer is showing, when the studio knows it. Absent, the
   * reading runs on Imagine's own text model.
   */
  readonly model?: ModelRoute
  /**
   * The runs of this project that are still going: "sta andando?" is answered
   * from these, not from what the conversation implies.
   */
  readonly working?: readonly ImagineChatWorking[]
  /**
   * What the home composer is holding: the chip and the style it drives. A
   * mode chosen on the home page is not a sentence, and "con questo preset"
   * would otherwise point at nothing the reading was told about.
   */
  readonly preset?: {
    readonly mode?: string
    readonly style?: string
  }
}

/** The reading: what to say back, and what to queue. */
export interface ImagineChatReply {
  /**
   * The assistant's answer in the chat: prose, not a label.
   *
   * Two to four sentences that say what was understood, what is being queued
   * and what the user will see. Always present on a reading, and in the
   * interface's language (`x-app-language`), which is not always the language
   * the sentence was written in. It is stored as an assistant message, so the
   * next turn's history carries it.
   */
  readonly reply: string
  /** The runs to start, in order. Empty when the turn is a question or an answer. */
  readonly intents: readonly ImagineChatIntent[]
  /** True when the reading came from the model rather than from the fallback. */
  readonly read: boolean
  /**
   * A workflow change waiting for a yes.
   *
   * Never applied by the reading: these graphs are the deployment, they are
   * not in the repository, and a pinned node id that stops resolving switches
   * a studio feature off without failing. The user reads the diff first.
   */
  readonly proposal?: WorkflowProposal
  /**
   * Why the fallback ran, when it did.
   *
   * `read: false` alone cannot tell the two fallbacks apart, and they are
   * opposite answers: a deployment with no reading model runs the line as it
   * was written — that is the toolbar's own behaviour — while a reading that
   * was configured and did not come back must say so. Silently generating the
   * sentence there is how 700 characters of song lyrics became a picture of
   * themselves (2026-09-07) with nothing in the chat to explain it.
   */
  readonly failed?: boolean
}

/**
 * One thing the studio did while reading a line, sent as it happens.
 *
 * The written lane is a single JSON call, not an agent turn, so nothing ever
 * reached the chat between "sto leggendo" and the finished answer: a reading
 * that took twelve seconds and one that had already fallen back looked
 * identical. These are the steps behind that spinner. Steps are named, not
 * written: the client owns the wording, in the user's language, the way it
 * already does for job notices.
 */
export type ImagineChatEvent =
  /** A step of the reading, in the order it happened. */
  | {
    readonly kind: 'step'
    readonly step: 'sight' | 'route' | 'writing' | 'workflow' | 'retry' | 'fallback'
    /** What the step is about: a model, a workflow label, a file name. */
    readonly detail?: string
    /** How many things the step covered, when it covered things. */
    readonly count?: number
  }
  /** The model's own thinking, when the route emits any. */
  | { readonly kind: 'reasoning'; readonly text: string }
