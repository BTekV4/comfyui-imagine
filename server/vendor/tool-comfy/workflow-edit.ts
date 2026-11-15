/**
 * Reading and changing this deployment's ComfyUI workflows from the studio.
 *
 * The graphs are the deployment, not the code: they live outside the
 * repository, `config.yaml` pins node ids into them, and a wrong edit does not
 * fail loudly — it produces a worse video, or silently switches a feature off.
 * So this module changes one thing only: the scalar value of an input a node
 * already has. It never adds a node, never adds a field, and never touches an
 * input whose value is a link (`["12", 0]` in API format), which is what wires
 * the graph together.
 * @module tool-comfy/workflow-edit
 */

import { copyFile, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { serialized, writeFileAtomic } from '../atomic-write/index.ts'
import type { ComfyGraph } from '../comfyui/index.ts'
import { message } from '../../src/messages.ts'
import { danglingLinks } from './lora.ts'
import type { WorkflowDiff, WorkflowField, WorkflowScalar, WorkflowValueChange } from '../../../shared/imagine-chat.ts'

/**
 * How many previous copies of one workflow are kept beside it. They live in
 * the live workflow folder, so without a bound every edit left one more file
 * there for good.
 */
const KEPT_BACKUPS = 10

/** Longest string value shown in a summary before it is cut. */
const MAX_VALUE_LENGTH = 90

/** One change asked for: a node's input takes a new scalar. */
export type WorkflowChange = WorkflowValueChange

/** What a plan came to: the changes that hold, and why the others do not. */
export interface WorkflowPatchPlan {
  readonly diff: readonly WorkflowDiff[]
  /** One line per rejected change, in the studio's language. */
  readonly errors: readonly string[]
}

/** Whether a value is one this module reads and writes. */
function isScalar(value: unknown): value is WorkflowScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** One input as a summary shows it. */
function shownValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim()
    return `"${flat.length > MAX_VALUE_LENGTH ? `${flat.slice(0, MAX_VALUE_LENGTH)}…` : flat}"`
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // A link, and the one thing that must not read as an editable value.
  return undefined
}

/**
 * The graph as a list a model can read and point at.
 *
 * Only the inputs that can be changed are shown: a link would be an offer to
 * rewire the graph, which this module refuses anyway, and showing it invites
 * the attempt.
 * @param graph - the loaded workflow.
 * @returns one line per node carrying at least one scalar input.
 */
export function summariseWorkflow(graph: ComfyGraph): string {
  const lines: string[] = []
  for (const id of flowOrder(graph)) {
    const node = graph[id]
    if (node === undefined) continue
    const fields = Object.entries(node.inputs)
      .map(([field, value]) => {
        const shown = shownValue(value)
        return shown === undefined ? undefined : `${field}=${shown}`
      })
      .filter((entry): entry is string => entry !== undefined)
    if (fields.length === 0) continue
    lines.push(`${id} ${node.class_type}: ${fields.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * The graph's node ids in the order the model flows through them.
 *
 * Object order is no order here: ids that look like numbers come out sorted
 * by number, so a LoRA chain rewired as 321 → 317 → 318 was still listed
 * 317, 318, 321 in the settings, and a new order looked as if it had not been
 * saved (2026-10-20). A node comes after every node it reads from; nodes with
 * no link between them keep their id order.
 * @param graph - the loaded workflow.
 * @returns every node id, each after the nodes feeding it.
 */
function flowOrder(graph: ComfyGraph): readonly string[] {
  const ids = Object.keys(graph)
  const known = new Set(ids)
  const feeds = new Map<string, Set<string>>()
  for (const id of ids) {
    const from = new Set<string>()
    for (const value of Object.values(graph[id]?.inputs ?? {})) {
      // A link is [source node id, output slot].
      if (Array.isArray(value) && value.length === 2 && known.has(String(value[0]))) from.add(String(value[0]))
    }
    feeds.set(id, from)
  }
  const out: string[] = []
  const done = new Set<string>()
  const visit = (id: string, path: Set<string>): void => {
    // A cycle would not run in ComfyUI either: break it instead of looping.
    if (done.has(id) || path.has(id)) return
    path.add(id)
    for (const source of feeds.get(id) ?? []) visit(source, path)
    path.delete(id)
    done.add(id)
    out.push(id)
  }
  for (const id of ids) visit(id, new Set())
  return out
}

/**
 * One graph's editable inputs, node by node.
 *
 * The same rule as {@link summariseWorkflow}: a link is structure, not a value,
 * and is left out so nothing offers to rewire the graph.
 * @param graph - the loaded workflow.
 * @returns every scalar input, in the order the model flows (see flowOrder).
 */
export function listWorkflowFields(graph: ComfyGraph): readonly WorkflowField[] {
  const fields: WorkflowField[] = []
  for (const node of flowOrder(graph)) {
    const entry = graph[node]
    if (entry === undefined) continue
    for (const [field, value] of Object.entries(entry.inputs)) {
      if (!isScalar(value)) continue
      fields.push({
        node,
        classType: entry.class_type,
        field,
        value,
        kind: typeof value === 'string' ? 'text' : typeof value === 'number' ? 'number' : 'boolean',
      })
    }
  }
  return fields
}

/**
 * Work out what a set of changes would do, without touching anything.
 *
 * A change is refused rather than coerced: a node or a field that is not
 * there, a link, and a value of a different type than the one the input
 * carries are all reported back, so the studio can say why instead of writing
 * a graph ComfyUI will reject at the next run.
 * @param graph - the loaded workflow.
 * @param changes - the changes asked for.
 * @returns the changes that hold and the reasons the others do not.
 */
export function planWorkflowPatch(graph: ComfyGraph, changes: readonly WorkflowChange[]): WorkflowPatchPlan {
  const diff: WorkflowDiff[] = []
  const errors: string[] = []
  for (const change of changes) {
    const node = graph[change.node]
    if (node === undefined) {
      errors.push(message('workflow.nodeMissing', { node: change.node }))
      continue
    }
    if (!Object.hasOwn(node.inputs, change.field)) {
      errors.push(message('workflow.nodeNoField', { node: change.node, class: node.class_type, field: change.field }))
      continue
    }
    const from = node.inputs[change.field]
    if (!isScalar(from)) {
      errors.push(message('workflow.fieldIsLink', { path: `${change.node}.${change.field}` }))
      continue
    }
    if (typeof from !== typeof change.value) {
      errors.push(message('workflow.fieldType', { path: `${change.node}.${change.field}`, wanted: typeof from, given: typeof change.value }))
      continue
    }
    if (from === change.value) continue
    diff.push({ node: change.node, classType: node.class_type, field: change.field, from, to: change.value })
  }
  return { diff, errors }
}

/**
 * Node ids `config.yaml` pinned that the graph no longer carries.
 *
 * The pins are the deployment's wiring between the studio's controls and this
 * graph, and they live in a file this module never sees. A pin that stops
 * resolving does not fail: the input is simply never written, which is how a
 * feature switches off in silence. Reported beside a change so it is read
 * before the change is applied, not after a run comes back wrong.
 * @param graph - the loaded workflow.
 * @param pins - pinned node ids by the name of what they pin.
 * @returns one line per pin that no longer resolves.
 */
export function stalePins(graph: ComfyGraph, pins: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(pins)
    .filter(([, id]) => id !== undefined && graph[id] === undefined)
    .map(([name, id]) => message('workflow.danglingPin', { pin: name, node: String(id) }))
}

/**
 * The indentation a workflow file is written with.
 * @param text - the file as it is on disk.
 * @returns what to hand `JSON.stringify`, or undefined for a compact file.
 */
function indentOf(text: string): string | number | undefined {
  const first = /\n([ \t]+)\S/.exec(text)?.[1]
  if (first === undefined) return undefined
  return first.startsWith('\t') ? '\t' : first.length
}

/**
 * Change one workflow file: the single write path for every graph edit.
 *
 * Both editors go through here — a value change planned by the settings page
 * or the chat, and a LoRA added, removed or tuned from the settings page or
 * from a personal card. Until 2026-11-07 they were two implementations that
 * had drifted (one wrote with a plain `writeFile` and no backup, one never
 * checked the links on a tune). The steps, in order:
 * - queued per file, so two edits cannot each write back the graph they read;
 * - the graph is read from the file, not from memory, so the edit lands on
 *   whatever the last edit wrote;
 * - the result is refused when a link points at a node it does not have, the
 *   one fault a rewiring leaves behind and ComfyUI reports only at run time;
 * - the previous file is kept beside it (these graphs are not in the
 *   repository, so a bad edit has no other way back), pruned to the newest few;
 * - the file is replaced by rename, keeping its indentation, its trailing
 *   newline (or lack of one) and its permissions.
 * Updating the copies the process holds in memory is the caller's job: only
 * it knows which loaded workflows came from this file.
 * @param path - the workflow file.
 * @param change - turns the stored graph into the one to store; may throw to
 *   refuse the edit, and may return a new object or the same one changed.
 * @returns where the previous file was kept, and the graph now stored.
 * @throws {Error} when the file is not a graph, `change` throws, or the
 *   result has dangling links; nothing is written then.
 */
export async function editWorkflowFile(
  path: string,
  change: (graph: ComfyGraph) => ComfyGraph,
): Promise<{ backup: string; graph: ComfyGraph }> {
  return serialized(path, async () => {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    const stored: unknown = JSON.parse(text)
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
      throw new Error(message('graph.apiObject'))
    }
    const next = change(stored as ComfyGraph)
    const dangling = danglingLinks(next)
    if (dangling.length > 0) throw new Error(message('graph.brokenLinks', { links: dangling.join(', ') }))
    const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await copyFile(path, backup)
    await pruneBackups(path)
    /*
     * The file keeps the shape it had. A graph exported compactly by ComfyUI
     * came back pretty-printed at two spaces and 50% larger, which is a diff
     * nobody asked for in a file the user also edits by hand — and the same
     * for its permissions. The trailing newline is the file's too: ComfyUI
     * exports without one and a hand-edited graph may have it (the value
     * editor used to add one whenever the file was indented).
     */
    const newline = text.endsWith('\n') ? '\n' : ''
    await writeFileAtomic(path, `${JSON.stringify(next, undefined, indentOf(text))}${newline}`, { mode: info.mode & 0o777 })
    return { backup, graph: next }
  })
}

/**
 * The edit that applies a planned value change, for `editWorkflowFile` (through
 * the graph editor, which also brings every loaded copy along).
 * @param diff - the changes, already planned against the loaded graph.
 * @returns the change to run on the stored graph.
 */
export function patchWorkflow(diff: readonly WorkflowDiff[]): (graph: ComfyGraph) => ComfyGraph {
  return (graph) => {
    // A node the file no longer has is skipped, as the planner would have
    // refused it: the plan was made from the copy in memory.
    for (const change of diff) {
      const node = graph[change.node]
      if (node !== undefined) node.inputs[change.field] = change.to
    }
    return graph
  }
}

/**
 * Make a loaded graph object hold another graph's nodes, keeping its identity.
 *
 * The runner, the settings page and the chat all hold the loaded object, not
 * a lookup: emptying it into the new graph is what makes them all see the
 * edit. Each holder gets its own copy, so no two loaded workflows share nodes
 * a later run could change in one place.
 * @param target - the loaded graph, changed in place.
 * @param next - the graph it should now be.
 */
export function replaceGraphInPlace(target: ComfyGraph, next: ComfyGraph): void {
  const copy = structuredClone(next)
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key)
  Object.assign(target, copy)
}

/**
 * Drop all but the newest {@link KEPT_BACKUPS} copies of one workflow.
 *
 * The copies are named `<file>.bak-<ISO time>`, so their names sort by age.
 * Best effort: a copy that cannot be removed stays, and the edit goes on.
 * @param path - the workflow file.
 */
async function pruneBackups(path: string): Promise<void> {
  const prefix = `${basename(path)}.bak-`
  const entries = await readdir(dirname(path)).catch(() => [] as string[])
  const backups = entries.filter(entry => entry.startsWith(prefix)).sort()
  await Promise.all(backups.slice(0, Math.max(0, backups.length - KEPT_BACKUPS))
    .map(async entry => unlink(join(dirname(path), entry)).catch(() => undefined)))
}
