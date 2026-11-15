/**
 * Adding and removing LoRAs in a graph, without editing it by hand.
 *
 * A LoRA is a node in the model chain, not a setting: `LoraLoaderModelOnly`
 * takes a model and gives one back, so putting one in means rewiring whoever
 * read the model before. Doing that by hand is where a graph goes wrong in a
 * way ComfyUI reports as "prompt rejected" minutes into a run, so the rewiring
 * lives here and is checked before anything is written.
 *
 * The chain is not patched in the middle of a run: these work on the stored
 * JSON, and the studio reloads the graph.
 * @module tool-comfy/lora
 */

import { randomBytes } from 'node:crypto'
import type { ComfyGraph } from '../comfyui/index.ts'
import { message } from '../../src/messages.ts'

/** One LoRA node already in the graph. */
export interface LoraInGraph {
  readonly node: string
  readonly loraName: string
  readonly strength: number
}

/** What to insert. */
export interface LoraRequest {
  /** The `.safetensors` name ComfyUI lists, e.g. `krea2\my-lora.safetensors`. */
  readonly loraName: string
  readonly strength: number
}

/** The class a plain (model-only) LoRA node uses. */
const LORA_CLASS = 'LoraLoaderModelOnly'

/** The class names a model chain starts at, in the order they are tried. */
const MODEL_SOURCES = ['UNETLoader', 'CheckpointLoaderSimple', 'CheckpointLoader', 'UnetLoaderGGUF', 'UNETLoaderGGUF']

/**
 * A strength as a request body carries it.
 *
 * Both LoRA routes take it from a form, where a number field can arrive as
 * its text: until 2026-11-07 the settings page's tune accepted `"0.8"` and a
 * personal card's did not. An empty or non-numeric string is not a number.
 * @param value - the body's `strength`.
 * @param fallback - what an absent value means (1 when adding; NaN when
 *   tuning, so the tune refuses it).
 * @returns the strength.
 */
export function loraStrength(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return value === undefined ? fallback : Number.NaN
}

const isRef = (value: unknown): value is readonly [string, number] =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'

/**
 * Every model-only LoRA the graph carries, in node-id order.
 * @param graph - the workflow.
 * @returns one entry per `LoraLoaderModelOnly` node.
 */
export function listLoras(graph: ComfyGraph): readonly LoraInGraph[] {
  const out: LoraInGraph[] = []
  for (const [node, entry] of Object.entries(graph)) {
    if (entry.class_type !== LORA_CLASS) continue
    const inputs = entry.inputs as Record<string, unknown>
    out.push({
      node,
      loraName: typeof inputs.lora_name === 'string' ? inputs.lora_name : '',
      strength: typeof inputs.strength_model === 'number' ? inputs.strength_model : 1,
    })
  }
  return out.sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }))
}

/**
 * The node the model chain starts at.
 *
 * A LoRA inserted at the start applies to every sampler downstream; one hooked
 * to a single sampler would leave the other passes of a two-pass graph without
 * it, which is the subtler bug of the two.
 * @param graph - the workflow.
 * @returns the loader's id, or undefined when the graph has no known loader.
 */
function modelSource(graph: ComfyGraph): string | undefined {
  for (const classType of MODEL_SOURCES) {
    for (const [node, entry] of Object.entries(graph)) {
      if (entry.class_type === classType) return node
    }
  }
  return undefined
}

/**
 * Who reads the model this node produces.
 * @param graph - the workflow.
 * @param node - the node producing it.
 * @returns the `[node, field]` pairs to rewire, in key order.
 */
function modelConsumers(graph: ComfyGraph, node: string): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = []
  for (const [id, entry] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(entry.inputs)) {
      if (!isRef(value) || value[0] !== node) continue
      // A model feeds `model` inputs; `clip`, `vae` and `samples` are other chains.
      if (field !== 'model') continue
      out.push([id, field])
    }
  }
  return out
}

/** An id nothing else uses: readable, and unique. */
function freshId(graph: ComfyGraph): string {
  for (;;) {
    const id = `lora_${randomBytes(3).toString('hex')}`
    if (graph[id] === undefined) return id
  }
}

/**
 * Insert a LoRA at the start of the model chain.
 *
 * The graph is changed IN PLACE and returned, as `patchWorkflow` does: every
 * caller hands in the copy `editWorkflowFile` has just parsed from disk, which
 * nobody else holds, so the deep copy made here until 2026-11-15 was a second
 * one for nothing. Every check runs before the first write, so a refusal
 * leaves the graph as it was.
 * @param graph - the workflow, changed in place.
 * @param request - which LoRA, and how strongly.
 * @returns the graph with the node in, and the node's id.
 * @throws {Error} when the graph has no model loader or no model consumer.
 */
export function insertLora(graph: ComfyGraph, request: LoraRequest): { graph: ComfyGraph; node: string } {
  const name = request.loraName.trim()
  if (name.length === 0) throw new Error(message('lora.nameRequired'))
  const strength = Number.isFinite(request.strength) ? request.strength : 1
  const source = modelSource(graph)
  if (source === undefined) throw new Error(message('lora.noLoader'))
  const consumers = modelConsumers(graph, source)
  if (consumers.length === 0) throw new Error(message('lora.noConsumer'))

  const next = graph
  const node = freshId(next)
  /*
   * The consumers are read off the graph BEFORE the node goes in: the new node
   * reads the source too, so asking afterwards hands it its own output and the
   * graph comes out with a LoRA wired to itself — which ComfyUI rejects as a
   * missing input, minutes into a run.
   */
  next[node] = {
    class_type: LORA_CLASS,
    inputs: { lora_name: name, strength_model: strength, model: [source, 0] },
    _meta: { title: `LoRA ${name.split(/[\\/]/).pop() ?? name}` },
  } as ComfyGraph[string]
  for (const [id, field] of consumers) {
    ;(next[id]!.inputs as Record<string, unknown>)[field] = [node, 0]
  }
  return { graph: next, node }
}

/**
 * Change one LoRA's strength.
 *
 * The strength is the only thing about a LoRA that is worth changing after it
 * is in: the node, its place in the chain and the model it reads are all
 * decided. Negative values are allowed, as ComfyUI does — a LoRA pushed the
 * other way is a normal way to soften one. Changed in place, like
 * {@link insertLora}.
 * @param graph - the workflow, changed in place.
 * @param node - the LoRA node's id.
 * @param strength - the model strength to write.
 * @returns the graph with the new value.
 * @throws {Error} when the node is not a LoRA, or the strength is not a number.
 */
export function setLoraStrength(graph: ComfyGraph, node: string, strength: number): ComfyGraph {
  const entry = graph[node]
  if (entry === undefined) throw new Error(message('lora.nodeMissing', { node }))
  if (entry.class_type !== LORA_CLASS) throw new Error(message('lora.nodeNotLora', { node, class: entry.class_type }))
  if (!Number.isFinite(strength)) throw new Error(message('lora.strengthRequired'))
  ;(entry.inputs as Record<string, unknown>).strength_model = strength
  return graph
}

/**
 * Take a LoRA out, handing its consumers the model it was reading. Changed in
 * place, like {@link insertLora}.
 * @param graph - the workflow, changed in place.
 * @param node - the LoRA node's id.
 * @returns the graph without it.
 * @throws {Error} when the node is not a model-only LoRA or has nothing feeding it.
 */
export function removeLora(graph: ComfyGraph, node: string): ComfyGraph {
  const entry = graph[node]
  if (entry === undefined) throw new Error(message('lora.nodeMissing', { node }))
  if (entry.class_type !== LORA_CLASS) throw new Error(message('lora.nodeNotLora', { node, class: entry.class_type }))
  const upstream = (entry.inputs as Record<string, unknown>).model
  if (!isRef(upstream)) throw new Error(message('lora.noUpstream', { node }))
  const next = graph
  for (const [id, field] of modelConsumers(next, node)) {
    ;(next[id]!.inputs as Record<string, unknown>)[field] = [upstream[0], upstream[1]]
  }
  delete next[node]
  return next
}

/**
 * Check a graph before it is stored: every link points at a node that exists.
 *
 * The one thing a rewiring bug leaves behind, and the one ComfyUI reports as a
 * validation error rather than as the node that is missing.
 * @param graph - the workflow.
 * @returns the dangling `node.field -> target` links, empty when none.
 */
export function danglingLinks(graph: ComfyGraph): readonly string[] {
  const ids = new Set(Object.keys(graph))
  const out: string[] = []
  for (const [node, entry] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(entry.inputs)) {
      if (isRef(value) && !ids.has(value[0])) out.push(`${node}.${field} -> ${value[0]}`)
    }
  }
  return out
}
