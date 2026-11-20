/**
 * A graph as the agent needs to read it: what it draws with, what turns a
 * branch on, and what may be changed for one run.
 *
 * The agent filled a workflow's exposed fields and nothing else, so it could
 * not know how a graph behaves inside. Measured on 2026-11-20: a personal
 * generation graph switches a LoRA on only when the prompt contains a word
 * (`StringContains` → `ComfySwitchNode`), the agent rewrote the user's line
 * without that word, the LoRA stayed off, and the reply then claimed that "no
 * tool has a slot for a LoRA". The reading below is derived from the JSON
 * alone, for any graph, so the agent can see such a switch, keep its word in
 * the prompt, and change a LoRA's weight or a sampler value for one run.
 *
 * A change for one run ({@link planRunTweaks}) goes through the same checks
 * as the settings page's edits (`planWorkflowPatch`): only a scalar input the
 * node already has, of the same type, within the node's own bounds. It is
 * written on the run's clone, never on the file.
 * @module tool-comfy/graph-reading
 */

import type { ComfyGraph } from '../comfyui/index.ts'
import type { WorkflowFieldFact, WorkflowScalar } from '../../../shared/imagine-chat.ts'
import { planWorkflowPatch } from './workflow-edit.ts'

/** A link in API format: `[source node id, output slot]`. */
const isLink = (value: unknown): value is readonly [string, number] =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'

/** The classes that test a text for a word, and the inputs they read. */
const TEXT_TESTS: Readonly<Record<string, { readonly text: string; readonly word: string }>> = {
  StringContains: { text: 'string', word: 'substring' },
}

/** The classes that pick one of two links on a boolean, and their inputs. */
const SWITCHES: Readonly<Record<string, { readonly test: string; readonly whenTrue: string; readonly whenFalse: string }>> = {
  ComfySwitchNode: { test: 'switch', whenTrue: 'on_true', whenFalse: 'on_false' },
}

/** The LoRA loaders, and the input that carries their weight. */
const LORA_STRENGTH: Readonly<Record<string, readonly string[]>> = {
  LoraLoaderModelOnly: ['strength_model'],
  LoraLoader: ['strength_model', 'strength_clip'],
}

/** Sampler inputs worth naming to the agent: the ones a request can be about. */
const SAMPLER_FIELDS = ['steps', 'cfg', 'denoise', 'sampler_name', 'scheduler'] as const

/** A word the prompt must contain (or must not) for a branch to run. */
export interface GraphGate {
  /** The node that tests the text. */
  readonly node: string
  /** The word it looks for, as written in the graph. */
  readonly word: string
  readonly caseSensitive: boolean
  /** Whether the text it tests is the prompt the studio writes. */
  readonly readsPrompt: boolean
}

/** One LoRA in the graph, with the word that turns it on when one does. */
export interface GraphLora {
  readonly node: string
  /** The file name without its folder: the deployment's own label for it. */
  readonly name: string
  readonly strength: number
  /** The input to change for this run, keyed `<node>.<field>`. */
  readonly strengthKey: string
  /** Present when the LoRA only runs if the prompt contains (or lacks) a word. */
  readonly gate?: GraphGate & { readonly when: 'contains' | 'lacks' }
}

/** What the agent is told about one graph. */
export interface GraphReading {
  readonly loras: readonly GraphLora[]
  /** Every word test, whether or not a LoRA sits behind it. */
  readonly gates: readonly GraphGate[]
  /** The sampler values, keyed `<node>.<field>`. */
  readonly sampler: Readonly<Record<string, WorkflowScalar>>
  /** The latent size, when the graph has one with plain numbers. */
  readonly size?: { readonly node: string; readonly width: number; readonly height: number }
  /** Whether the graph takes a picture in (a reference or a source). */
  readonly takesImage: boolean
}

/**
 * Every node a link reaches by walking upstream, the start included.
 * @param graph - the workflow.
 * @param start - the node to walk from.
 * @returns the node ids feeding it, directly or not.
 */
function upstream(graph: ComfyGraph, start: string): ReadonlySet<string> {
  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const id = queue.pop()
    if (id === undefined || seen.has(id)) continue
    const node = graph[id]
    if (node === undefined) continue
    seen.add(id)
    for (const value of Object.values(node.inputs)) {
      if (isLink(value) && !seen.has(value[0])) queue.push(value[0])
    }
  }
  return seen
}

/**
 * The nodes one side of a switch runs that the other side does not.
 * @param graph - the workflow.
 * @param side - the link on the side asked about.
 * @param other - the link on the other side.
 * @returns the ids only `side` reaches.
 */
function onlyOn(graph: ComfyGraph, side: unknown, other: unknown): ReadonlySet<string> {
  if (!isLink(side)) return new Set()
  const mine = upstream(graph, side[0])
  const theirs = isLink(other) ? upstream(graph, other[0]) : new Set<string>()
  return new Set([...mine].filter(id => !theirs.has(id)))
}

/**
 * Read a graph for the agent.
 * @param graph - the workflow, as it will run.
 * @param promptNodeId - the node the studio writes the prompt into, when pinned.
 * @returns what it draws with and what turns its branches on.
 */
export function readGraph(graph: ComfyGraph, promptNodeId?: string): GraphReading {
  const gates = new Map<string, GraphGate>()
  for (const [id, node] of Object.entries(graph)) {
    const test = TEXT_TESTS[node.class_type]
    if (test === undefined) continue
    const word = node.inputs[test.word]
    if (typeof word !== 'string' || word.trim() === '') continue
    const text = node.inputs[test.text]
    gates.set(id, {
      node: id,
      word,
      caseSensitive: node.inputs['case_sensitive'] === true,
      // Directly the prompt node, or a text the prompt node feeds.
      readsPrompt: promptNodeId !== undefined && isLink(text) && upstream(graph, text[0]).has(promptNodeId),
    })
  }
  // Which LoRA runs only on one side of a switch driven by a word test.
  const gated = new Map<string, GraphGate & { readonly when: 'contains' | 'lacks' }>()
  for (const node of Object.values(graph)) {
    const kind = SWITCHES[node.class_type]
    if (kind === undefined) continue
    const test = node.inputs[kind.test]
    if (!isLink(test)) continue
    const gate = gates.get(test[0])
    if (gate === undefined) continue
    const whenTrue = node.inputs[kind.whenTrue]
    const whenFalse = node.inputs[kind.whenFalse]
    for (const id of onlyOn(graph, whenTrue, whenFalse)) gated.set(id, { ...gate, when: 'contains' })
    for (const id of onlyOn(graph, whenFalse, whenTrue)) gated.set(id, { ...gate, when: 'lacks' })
  }
  const loras: GraphLora[] = []
  const sampler: Record<string, WorkflowScalar> = {}
  let size: GraphReading['size']
  let takesImage = false
  for (const [id, node] of Object.entries(graph)) {
    const strengths = LORA_STRENGTH[node.class_type]
    if (strengths !== undefined) {
      const field = strengths[0] ?? 'strength_model'
      const strength = node.inputs[field]
      const file = typeof node.inputs['lora_name'] === 'string' ? node.inputs['lora_name'] : ''
      const gate = gated.get(id)
      loras.push({
        node: id,
        name: file.split(/[\\/]/).pop()?.replace(/\.safetensors$/i, '') ?? file,
        strength: typeof strength === 'number' ? strength : 1,
        strengthKey: `${id}.${field}`,
        ...gate === undefined ? {} : { gate },
      })
    }
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
      for (const field of SAMPLER_FIELDS) {
        const value = node.inputs[field]
        if (typeof value === 'number' || typeof value === 'string') sampler[`${id}.${field}`] = value
      }
    }
    if (size === undefined && /^Empty.*Latent/.test(node.class_type)) {
      const { width, height } = node.inputs
      if (typeof width === 'number' && typeof height === 'number') size = { node: id, width, height }
    }
    if (node.class_type === 'LoadImage') takesImage = true
  }
  loras.sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }))
  return { loras, gates: [...gates.values()], sampler, ...size === undefined ? {} : { size }, takesImage }
}

/**
 * The reading in a few lines the model can act on.
 * @param reading - what {@link readGraph} found.
 * @returns plain lines, English like the rest of the instruction.
 */
export function readingLines(reading: GraphReading): readonly string[] {
  const lines: string[] = []
  for (const lora of reading.loras) {
    const gate = lora.gate === undefined
      ? 'always on'
      : `ON ONLY WHEN the prompt ${lora.gate.when === 'contains' ? 'contains' : 'does not contain'} "${lora.gate.word}"${lora.gate.caseSensitive ? ' (case-sensitive)' : ''}`
    lines.push(`LoRA "${lora.name}" weight ${String(lora.strength)} (${lora.strengthKey}), ${gate}`)
  }
  for (const gate of reading.gates) {
    if (reading.loras.some(lora => lora.gate?.node === gate.node)) continue
    lines.push(`a branch runs when the ${gate.readsPrompt ? 'prompt' : 'text'} contains "${gate.word}" (node ${gate.node})`)
  }
  const sampler = Object.entries(reading.sampler)
  if (sampler.length > 0) lines.push(`sampler: ${sampler.map(([key, value]) => `${key}=${String(value)}`).join(', ')}`)
  if (reading.size !== undefined) lines.push(`frame ${String(reading.size.width)}x${String(reading.size.height)} (the studio writes it from aspect/resolution)`)
  lines.push(reading.takesImage ? 'takes a picture in' : 'takes no picture in: a reference can only be described in the prompt')
  return lines
}

/**
 * The words a gate needs that the user wrote and the prompt lost.
 *
 * Only a word the user's own line carries is asked back: a gate the user did
 * not mean to open is not opened by the studio.
 * @param reading - the graph's reading.
 * @param prompt - the prompt about to run.
 * @param asked - the user's line.
 * @returns the missing words, in the graph's spelling.
 */
export function droppedGateWords(reading: GraphReading, prompt: string, asked: string): readonly string[] {
  const missing: string[] = []
  for (const gate of reading.gates) {
    if (!gate.readsPrompt) continue
    const has = (text: string): boolean => gate.caseSensitive
      ? text.includes(gate.word)
      : text.toLowerCase().includes(gate.word.toLowerCase())
    if (has(asked) && !has(prompt)) missing.push(gate.word)
  }
  return missing
}

/** What a set of run changes came to. */
export interface RunTweaks {
  /** The values to write on this run's clone, keyed `<node>.<field>`. */
  readonly fields: Readonly<Record<string, WorkflowScalar>>
  /** One sentence per refused change. */
  readonly errors: readonly string[]
}

/**
 * Check changes the agent asked for one run.
 *
 * The prompt and the seed are the studio's: a change aimed at them is
 * refused, since the studio writes them after the run's fields and the change
 * would silently not happen.
 * @param graph - the workflow.
 * @param raw - the model's `tweaks`, keyed `<node>.<field>`.
 * @param reserved - what the studio writes itself: a whole node (`73`, the
 *   prompt) or one input (`53.seed`), so the sampler's other values stay open.
 * @param facts - what each input accepts, when ComfyUI answered.
 * @returns the values that hold and why the others do not.
 */
export function planRunTweaks(
  graph: ComfyGraph,
  raw: unknown,
  reserved: readonly (string | undefined)[],
  facts?: readonly WorkflowFieldFact[],
): RunTweaks {
  if (raw === undefined) return { fields: {}, errors: [] }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { fields: {}, errors: ['tweaks must be an object keyed "<node>.<field>"'] }
  }
  const errors: string[] = []
  const changes: { node: string; field: string; value: WorkflowScalar }[] = []
  for (const [key, value] of Object.entries(raw)) {
    const dot = key.indexOf('.')
    if (dot <= 0) {
      errors.push(`"${key}" is not "<node>.<field>"`)
      continue
    }
    const node = key.slice(0, dot)
    if (reserved.includes(node) || reserved.includes(key)) {
      errors.push(`${key} is written by the studio itself (prompt or seed): change it through the tool's own arguments`)
      continue
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      errors.push(`${key} must be a text, a number or true/false`)
      continue
    }
    changes.push({ node, field: key.slice(dot + 1), value })
  }
  const factMap = new Map((facts ?? []).map(fact => [`${fact.node}.${fact.field}`, fact]))
  const plan = planWorkflowPatch(graph, changes, factMap)
  const fields: Record<string, WorkflowScalar> = {}
  for (const change of plan.diff) fields[`${change.node}.${change.field}`] = change.to
  return { fields, errors: [...errors, ...plan.errors] }
}
