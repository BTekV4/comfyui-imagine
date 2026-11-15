/**
 * A workflow the user uploaded, as the host stores it and reports it to the
 * page: one type for both sides (the page kept its own copy until 2026-11-14,
 * and it had already lost `steps`).
 * @module custom-workflows
 */

import type { CoverKind } from './cover-kinds.ts'

/** One graph input the user chose to expose, as a control on the card. */
export interface CustomInput {
  /** The node carrying it. */
  readonly node: string
  /** The node's input key. */
  readonly field: string
  /** What the control is called on the card. */
  readonly label: string
  /**
   * What kind of control it is. `combo` is decided when the card opens, from
   * ComfyUI: only the node knows whether its value is a closed list.
   */
  readonly kind: 'text' | 'number' | 'boolean' | 'combo' | 'frame'
  /** The value the graph holds now, so the control starts on it. */
  readonly value?: string | number | boolean
}

/**
 * Two file slots of which only one is given, and the switch that says which.
 *
 * A graph that can take either a clip or a photo (`LoadVideo` and `LoadImage`,
 * picked by a `ComfySwitchNode`) cannot demand both: the panel has no other way
 * to know that one of the two is enough. The switch node is written by the run
 * — true when the video slot is the one carrying the file — and its two inputs
 * are lazy, so the branch left empty is never executed.
 */
export interface CustomEither {
  /** The node ids of the two slots: exactly one of them carries a file. */
  readonly slots: readonly string[]
  /** The switch node whose value says whether the video slot is the one. */
  readonly switch: { readonly node: string; readonly field: string; readonly video: string }
}

/** What the user wrote about a workflow, plus the pins that make it run. */
export interface CustomWorkflowMeta {
  readonly id: string
  readonly title: string
  readonly description: string
  /** `image` or `video`: what the gallery should file the result as. */
  readonly output: 'image' | 'video'
  /** Extension of the produced file, without the dot. */
  readonly outputExt: string
  /** The node the prompt is written into; absent, the graph runs as saved. */
  readonly promptNodeId?: string
  /**
   * The input key of that node the prompt goes into; absent, the first of
   * `value`/`text`/`prompt`/`caption` is used. A graph whose prompt lives on an
   * unusual key (`title`, `caption_it`, …) needs this to be runnable at all.
   */
  readonly promptField?: string
  /**
   * A control that has a list of values — the lookbook: the poses. The panel
   * offers «all», which means one run per value.
   */
  readonly batchControl?: { readonly node: string; readonly field: string }
  /**
   * The high-quality recipe, for an uploaded card.
   *
   * «Velocità» stays the value saved in the graph — the card's panel edits it
   * like any other field — and this is the second number, the one the
   * composer writes when «Qualità: Alta» is chosen. Without it the pill had no
   * effect on a card: a card saved at ten steps still did ten with «Qualità»
   * on (2026-11-05).
   */
  readonly steps?: { readonly nodeId: string; readonly field: string; readonly high: number }
  /** The node the seed is written into; absent, the graph's own seed is used. */
  readonly seedNodeId?: string
  /** The input key of the seed node; absent, `seed`. */
  readonly seedField?: string
  /** The node an uploaded picture is written into; absent, no picture. */
  readonly imageNodeId?: string
  /** The clip-or-photo pair of slots, when the graph takes either. */
  readonly either?: CustomEither
  /** The inputs the user exposed, in the order the card shows them. */
  readonly inputs: readonly CustomInput[]
  /** True when a cover file is on disk beside the graph. */
  readonly hasCover: boolean
  /**
   * What the cover is: an image or a short video (since 4-11-2026).
   * Absent when the workflow has none.
   */
  readonly coverKind?: CoverKind
}
