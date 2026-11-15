/**
 * Capability discovery over an API-format workflow graph: which node id a
 * tool parameter should write into. Workflows vary, so the tool config may
 * pin node ids explicitly; when it does not, these helpers find the
 * conventional node by class type — the same convention the ComfyUI UI
 * itself uses for its own parameter injection.
 * @module comfyui/graph
 */

import type { ComfyGraph } from './types.ts'

/** A node id and its current input value, when both exist. */
export interface ComfyNodeSlot {
  readonly id: string
  readonly value: unknown
}

/** Nodes whose class type matches one of the given names, in graph order. */
function nodesByClass(graph: ComfyGraph, classTypes: readonly string[]): ComfyNodeSlot[] {
  return Object.entries(graph).flatMap(([id, node]) =>
    classTypes.includes(node.class_type) ? [{ id, value: node.inputs }] : [],
  )
}

/**
 * The node a generated-prompt text should land in. Prefers non-empty text
 * inputs; between several (positive/negative conditioning) the LAST
 * non-empty one wins, matching how ComfyUI's own UI places the typed prompt
 * into the final conditioning node.
 * @param graph - the workflow graph.
 * @returns the node id and its current `text`, or undefined when none exists.
 */
export function promptNode(graph: ComfyGraph): ComfyNodeSlot | undefined {
  const slots = nodesByClass(graph, ['CLIPTextEncode'])
    .filter(slot => typeof (slot.value as Record<string, unknown>).text === 'string')
  return slots.length === 0 ? undefined : slots[slots.length - 1]
}

/**
 * The node whose `seed` a run should randomize or fix. First KSampler wins;
 * an explicit seed input on it is returned for the tool to preserve or audit.
 * @param graph - the workflow graph.
 * @returns the node id and its current seed, or undefined.
 */
export function seedNode(graph: ComfyGraph): ComfyNodeSlot | undefined {
  const slots = nodesByClass(graph, ['KSampler', 'KSamplerAdvanced'])
  return slots.length === 0 ? undefined : slots[0]
}

/**
 * The `LoadImage` node whose `image` input names an uploaded file. The
 * workflow's input image for image-to-image nodes may also arrive through the
 * graph's links instead of a LoadImage; when several loaders exist, the first
 * wins.
 * @param graph - the workflow graph.
 * @returns the node id and its current image name, or undefined.
 */
export function imageInputNode(graph: ComfyGraph): ComfyNodeSlot | undefined {
  const slots = nodesByClass(graph, ['LoadImage'])
  return slots.length === 0 ? undefined : slots[0]
}

/**
 * The `LoadVideo` node whose `file` input names an uploaded clip. When
 * several loaders exist, the first wins.
 * @param graph - the workflow graph.
 * @returns the node id and its current file name, or undefined.
 */
export function videoInputNode(graph: ComfyGraph): ComfyNodeSlot | undefined {
  const slots = nodesByClass(graph, ['LoadVideo'])
  return slots.length === 0 ? undefined : slots[0]
}

/**
 * The `EmptyLatentImage` node whose `width`/`height` a size parameter writes
 * into; absent when the workflow derives size from an input image or the
 * model card instead.
 * @param graph - the workflow graph.
 * @returns the node id and its inputs, or undefined.
 */
export function sizeNode(graph: ComfyGraph): ComfyNodeSlot | undefined {
  const slots = nodesByClass(graph, ['EmptyLatentImage'])
  return slots.length === 0 ? undefined : slots[0]
}
