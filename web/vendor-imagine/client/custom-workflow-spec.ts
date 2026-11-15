/**
 * The "spec" of an uploaded card, derived from its graph.
 *
 * A custom workflow has no entry in `workflow-specs.ts`: its nodes say what
 * can be done with it. This module is pure — graph and meta in, slots/options/
 * controls out — so the same derivation is tested and used by the panel.
 *
 * The rules are deliberately plain: a load node is a slot, a
 * `ResolutionSelector` gives aspect ratio and resolution, a field with a closed
 * list gives a dropdown, a duration node gives the seconds. Nothing the graph
 * does not declare is invented.
 * @module client/custom-workflow-spec
 */
import type { MediaKind } from '../../../shared/imagine-types.ts'
import { VIDEO_ASPECT_LABELS } from '../../../shared/imagine-media.ts'
import type { ComfyLocaleKey } from './locales.ts'

/** A file the graph expects, and the node that receives it. */
export interface CustomFileSlot {
  /** The file's key in the run: the node id. */
  readonly key: string
  readonly node: string
  /** The node field that takes the uploaded file's name. */
  readonly field: string
  readonly kind: MediaKind
  readonly labelKey: ComfyLocaleKey
  readonly hintKey: ComfyLocaleKey
  readonly required: boolean
}

/** A closed-list field, which the panel shows as a dropdown. */
export interface CustomComboControl {
  readonly key: string
  readonly node: string
  readonly field: string
  readonly labelKey: ComfyLocaleKey
  /** The accepted values, when the caller has already asked ComfyUI for them. */
  readonly options: readonly string[]
}

/** What an uploaded card declares it can do. */
export interface CustomWorkflowControls {
  readonly slots: readonly CustomFileSlot[]
  readonly options: readonly ('aspect' | 'resolution' | 'seconds')[]
  readonly aspect?: { readonly node: string; readonly field: string; readonly labels: Readonly<Partial<Record<string, string>>> }
  readonly resolution?: { readonly node: string; readonly field: string }
  readonly seconds?: { readonly node: string; readonly field: string }
  readonly combos: readonly CustomComboControl[]
  readonly prompt?: { readonly node: string; readonly field?: string; readonly required: boolean }
  /** A control with N values: the panel offers "all", one run per value. */
  readonly batch?: { readonly node: string; readonly field: string }
  readonly seed?: { readonly node: string; readonly field?: string }
}

/** The least of a node needed to recognise it. */
interface GraphNode {
  readonly class_type?: string
  readonly inputs?: Record<string, unknown>
}

/** The graph, in API format. */
export type CustomGraph = Readonly<Record<string, GraphNode>>

/** The card's meta, for the pins not visible in the graph. */
interface MetaPins {
  readonly promptNodeId?: string
  readonly promptField?: string
  readonly seedNodeId?: string
  readonly seedField?: string
  readonly batchControl?: { readonly node: string; readonly field: string }
}

const VIDEO_LOADERS: readonly string[] = ['LoadVideo', 'VHS_LoadVideo', 'LoadVideoUpload', 'VHS_LoadVideoPath', 'VHS_LoadVideoUpload']
const AUDIO_LOADERS: readonly string[] = ['LoadAudio']
const VIDEO_FIELDS: readonly string[] = ['file', 'video', 'video_path', 'filename']
const SECONDS_FIELDS: readonly string[] = ['seconds', 'length', 'duration']

/**
 * Derive a card's controls from its graph.
 * @param meta - the card's pins (prompt and seed).
 * @param graph - the graph in API format.
 * @returns slots, options, dropdowns and the prompt/seed pins.
 */
export function deriveCustomWorkflowControls(meta: MetaPins, graph: CustomGraph): CustomWorkflowControls {
  const slots: CustomFileSlot[] = []
  const combos: CustomComboControl[] = []
  let aspect: CustomWorkflowControls['aspect']
  let resolution: CustomWorkflowControls['resolution']
  let seconds: CustomWorkflowControls['seconds']

  for (const [node, entry] of Object.entries(graph)) {
    const classType = entry.class_type ?? ''
    const inputs = entry.inputs ?? {}
    if (classType === 'LoadImage') {
      slots.push({ key: node, node, field: 'image', kind: 'image', labelKey: 'imagine.custom.slot.image', hintKey: 'imagine.custom.slotHint.image', required: true })
    } else if (classType === 'LoadImageMask') {
      /*
       * The mask is a second file, not a second framing: without one, the
       * graph uses the one it saved, so the slot is not required.
       */
      slots.push({ key: node, node, field: 'image', kind: 'image', labelKey: 'imagine.custom.slot.mask', hintKey: 'imagine.custom.slotHint.mask', required: false })
    } else if (VIDEO_LOADERS.includes(classType)) {
      const field = VIDEO_FIELDS.find(candidate => candidate in inputs) ?? 'file'
      slots.push({ key: node, node, field, kind: 'video', labelKey: 'imagine.custom.slot.video', hintKey: 'imagine.custom.slotHint.video', required: true })
    } else if (AUDIO_LOADERS.includes(classType)) {
      slots.push({ key: node, node, field: 'audio', kind: 'audio', labelKey: 'imagine.custom.slot.audio', hintKey: 'imagine.custom.slotHint.audio', required: true })
    }
    if (classType === 'ResolutionSelector') {
      // The node takes the aspect-ratio label and the megapixels: the two
      // options the panel calls "Aspect ratio" and "Resolution".
      aspect = { node, field: 'aspect_ratio', labels: VIDEO_ASPECT_LABELS }
      resolution = { node, field: 'megapixels' }
    }
    if (classType === 'PromptSelector') {
      if ('title' in inputs) combos.push({ key: `${node}.title`, node, field: 'title', labelKey: 'imagine.custom.field.title', options: [] })
      if ('pose' in inputs) combos.push({ key: `${node}.pose`, node, field: 'pose', labelKey: 'imagine.custom.field.pose', options: [] })
    }
  }

  for (const [node, entry] of Object.entries(graph)) {
    for (const field of SECONDS_FIELDS) {
      const value = entry.inputs?.[field]
      if (typeof value === 'number') {
        seconds = { node, field }
        break
      }
    }
    if (seconds !== undefined) break
  }

  const options: CustomWorkflowControls['options'] = [
    ...aspect === undefined ? [] : ['aspect', 'resolution'] as const,
    ...seconds === undefined ? [] : ['seconds'] as const,
  ]
  const prompt = meta.promptNodeId === undefined
    ? undefined
    : { node: meta.promptNodeId, ...meta.promptField === undefined ? {} : { field: meta.promptField }, required: !combos.some(combo => combo.node === meta.promptNodeId) }
  const seed = meta.seedNodeId === undefined
    ? undefined
    : { node: meta.seedNodeId, ...meta.seedField === undefined ? {} : { field: meta.seedField } }
  return {
    slots,
    options,
    ...aspect === undefined ? {} : { aspect },
    ...resolution === undefined ? {} : { resolution },
    ...seconds === undefined ? {} : { seconds },
    combos,
    ...prompt === undefined ? {} : { prompt },
    ...seed === undefined ? {} : { seed },
    ...meta.batchControl === undefined ? {} : { batch: meta.batchControl },
  }
}
