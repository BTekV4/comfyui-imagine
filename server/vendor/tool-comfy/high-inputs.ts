/**
 * The high recipe of a graph written as input overrides (`highInputs`).
 *
 * The Pika clip graphs used to ship as pairs of files, fast and quality, that
 * differed in a handful of inputs and one link (2026-11-15): the LoRA, the
 * sampler, the sigma source, a shift. One graph now carries both recipes: the
 * fast one as saved, plus the nodes only the quality recipe uses, left
 * unconnected. The entry lists the inputs the quality recipe writes; a value
 * that is a link (`["pika:sigmas", 0]`) rewires the input.
 *
 * Whatever the overrides leave without a consumer is taken out of the graph:
 * the scheduler a rewired link no longer reads on the quality run, the
 * quality-only nodes on the fast one. So both runs submit exactly the graph
 * the old file of that recipe was, and the setup check is never asked about a
 * node that does not run.
 * @module tool-comfy/high-inputs
 */

import { ComfyError, type ComfyGraph } from '../comfyui/index.ts'

/** A ComfyUI link in API format: the source node and its output index. */
export type ComfyLink = readonly [string, number]

/** A value a high-recipe override writes: a literal input or a link. */
export type HighInputValue = string | number | boolean | ComfyLink

/** One input the high recipe writes into the graph. */
export interface HighInput {
  /** The node whose input is written. */
  readonly nodeId: string
  /** The input key; it must already exist on the node. */
  readonly field: string
  /** The value, or a link (`[nodeId, outputIndex]`) to rewire the input. */
  readonly value: HighInputValue
}

/**
 * Whether a value is an API-format link.
 * @param value - an input value.
 * @returns true for `[nodeId, outputIndex]`.
 */
export function isComfyLink(value: unknown): value is ComfyLink {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && value[0].length > 0
    && Number.isInteger(value[1]) && (value[1] as number) >= 0
}

/**
 * Whether a value is one a high-recipe override may write.
 * @param value - the configured value.
 * @returns true for a string, a finite number, a boolean or a link.
 */
export function isHighInputValue(value: unknown): value is HighInputValue {
  return typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value)) || isComfyLink(value)
}

/**
 * Take out the given nodes when nothing reads them any more, and then the
 * nodes only they read, and so on up the chain.
 *
 * Only nodes that were (or would have been) a link's source are candidates, so
 * an output node — which nobody links to — is never dropped here.
 * @param graph - the run's clone, changed in place.
 * @param candidates - node ids a rewiring may have left unused.
 */
function dropUnused(graph: ComfyGraph, candidates: Iterable<string>): void {
  const pending = [...candidates]
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined) break
    const node = graph[id]
    if (node === undefined) continue
    const read = Object.values(graph).some(other => Object.values(other.inputs)
      .some(value => isComfyLink(value) && value[0] === id))
    if (read) continue
    Reflect.deleteProperty(graph, id)
    for (const value of Object.values(node.inputs)) if (isComfyLink(value)) pending.push(value[0])
  }
}

/**
 * Apply a workflow's high-recipe overrides to the run's clone, or, for the
 * base recipe, drop the nodes only those overrides would have used.
 *
 * Every pin is checked on both recipes — the node, its input, and the node a
 * link points at — so a renamed node fails the fast run too rather than only
 * the slow one, and fails before anything is uploaded.
 * @param graph - the run's clone, changed in place.
 * @param inputs - the workflow's `highInputs`.
 * @param high - whether the run asked for the high recipe.
 * @throws {ComfyError} for a pin that does not resolve.
 */
export function applyHighInputs(graph: ComfyGraph, inputs: readonly HighInput[] | undefined, high: boolean): void {
  if (inputs === undefined || inputs.length === 0) return
  for (const input of inputs) {
    const node = graph[input.nodeId]
    if (node === undefined) throw new ComfyError(`no node at ${input.nodeId} for highInputs`, 'COMFY_GRAPH_REJECTED')
    if (!Object.hasOwn(node.inputs, input.field)) {
      throw new ComfyError(`node ${input.nodeId} has no input ${input.field} for highInputs`, 'COMFY_GRAPH_REJECTED')
    }
    if (isComfyLink(input.value) && graph[input.value[0]] === undefined) {
      throw new ComfyError(`no node at ${input.value[0]} for the highInputs link into ${input.nodeId}.${input.field}`, 'COMFY_GRAPH_REJECTED')
    }
  }
  const released = new Set<string>()
  for (const input of inputs) {
    if (!high) {
      if (isComfyLink(input.value)) released.add(input.value[0])
      continue
    }
    const node = graph[input.nodeId]
    if (node === undefined) continue
    const before = node.inputs[input.field]
    if (isComfyLink(before)) released.add(before[0])
    ;(node.inputs as Record<string, unknown>)[input.field] = isComfyLink(input.value)
      ? [input.value[0], input.value[1]]
      : input.value
  }
  dropUnused(graph, released)
}
