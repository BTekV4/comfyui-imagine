/**
 * The configured workflows as the studio sees them, and the one way a change
 * reaches a graph: the file and every loaded copy of it, together.
 *
 * Split out of `index.ts` on 2026-11-07, when the two LoRA editors (the
 * settings page's and the personal cards') were made one: both now go through
 * {@link graphEditor}.
 * @module tool-comfy/workflow-inventory
 */

import { basename, resolve } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { message } from '../../src/messages.ts'
import type { ComfyGraph } from '../comfyui/index.ts'
import { isPlainObject } from './guards.ts'
import { isComfyLink } from './high-inputs.ts'
import { isCustomPath } from './custom-workflows.ts'
import type { WorkflowCard, WorkflowInventory, WorkflowSummary } from './imagine-chat.ts'
import type { LoadedWorkflow } from './index.ts'
import { insertLora, listLoras, removeLora, setLoraStrength, type LoraInGraph, type LoraRequest } from './lora.ts'
import {
  editWorkflowFile, listWorkflowFields, patchWorkflow, planWorkflowPatch, replaceGraphInPlace, stalePins,
  summariseWorkflow, type WorkflowChange,
} from './workflow-edit.ts'
import type { WorkflowField, WorkflowFieldFact } from '../../../shared/imagine-chat.ts'
import type { CustomWorkflowMeta } from '../../../shared/custom-workflows.ts'
import { readGraphFile, workflowFile, type GraphHolder, type LoadedRow } from './workflow-load.ts'
import { writableOverlay, type WorkflowOverlay } from './workflow-overlay.ts'

/** The names the settings page gives the pins it has always reported. */
const PIN_NAMES: Readonly<Record<string, string>> = {
  promptNodeId: 'prompt', seedNodeId: 'seed', imageNodeId: 'immagine', videoNodeId: 'video', sizeNodeId: 'dimensioni',
  upscaleNodeId: 'upscaler',
  aspectRatio: 'formato', seconds: 'secondi', lyrics: 'testo', duration: 'durata',
  realism: 'realismo', subjectText: 'soggettoVideo', referenceText: 'soggettoFoto', placementText: 'riquadroPosa',
}

/**
 * Every node id a loaded workflow is pinned to, by name, so a pin that no
 * longer resolves is reported. All of them: before 2026-10-21 the list left
 * out the last frame, the audio, the song slice, the chain and the voice, and
 * a renamed node switched those features off without a word.
 * @param loaded - the loaded workflow.
 * @returns node id by pin name.
 */
function pinsOf(loaded: LoadedWorkflow): Record<string, string | undefined> {
  const pins: Record<string, string | undefined> = {}
  for (const [field, value] of Object.entries(loaded)) {
    const name = PIN_NAMES[field] ?? field
    if (typeof value === 'string' && field.endsWith('NodeId')) pins[name] = value
    else if (isPlainObject(value) && typeof value.nodeId === 'string') pins[name] = value.nodeId
  }
  if (loaded.chain !== undefined) {
    pins['chain.loadNodeId'] = loaded.chain.loadNodeId
    pins['chain.saveNodeId'] = loaded.chain.saveNodeId
  }
  // The high recipe's overrides: the node each one writes, and the node a
  // rewired link points at.
  for (const [index, input] of (loaded.highInputs ?? []).entries()) {
    pins[`highInputs[${String(index)}]`] = input.nodeId
    if (isComfyLink(input.value)) pins[`highInputs[${String(index)}].value`] = input.value[0]
  }
  return pins
}

/** What an edit came to: the backup beside the file and the graph now stored. */
export interface GraphEdit {
  readonly backup: string
  readonly graph: ComfyGraph
}

/** What a restore came to: whether there was a copy to remove, and the graph now in use. */
export interface GraphRestore {
  readonly restored: boolean
  readonly graph: ComfyGraph
}

/** The graph-edit step every route uses; see {@link graphEditor}. */
export interface GraphEditor {
  /**
   * Change one graph file (checked, backed up, written by rename) and every
   * loaded workflow read from it. In a packaged app the file written is the
   * user's copy, made from the program's file the first time.
   */
  readonly edit: (file: string, change: (graph: ComfyGraph) => ComfyGraph) => Promise<GraphEdit>
  /**
   * Bring every loaded workflow read from `file` to `graph`, for a write that
   * did not go through {@link GraphEditor.edit} (a personal card uploaded again).
   */
  readonly adopt: (file: string, graph: ComfyGraph) => void
  /**
   * Drop the user's copy of one graph and load the program's file again, so
   * the updates of that file come back. Nothing happens, and the graph is
   * returned unchanged, when there is no copy (or the installation writes
   * the program's own file).
   */
  readonly restore: (file: string, current: ComfyGraph) => Promise<GraphRestore>
}

/**
 * The one write path for a graph, and the in-memory copies that go with it.
 *
 * The graphs are read once at boot, and one file can be loaded more than
 * once: a `config.yaml` row pointing at `custom:<id>` and the personal card
 * of the same id were two objects, and a LoRA added through one route left
 * the other running the old graph until a restart (2026-11-07). Every loaded
 * copy is found by its file here, at the moment of the write, so a card
 * reloaded since boot is found too.
 * @param holders - every loaded graph with its file, read at each write.
 * @param overlay - where this installation reads and writes its graphs: the
 *   program's files, or the user's copies of them (`workflow-overlay.ts`).
 * @returns the edit step, the adopt step and the restore step.
 */
export function graphEditor(holders: () => Iterable<GraphHolder>, overlay: WorkflowOverlay = writableOverlay): GraphEditor {
  const adopt = (file: string, graph: ComfyGraph): void => {
    const target = resolve(file)
    for (const holder of holders()) {
      if (resolve(holder.file) === target) replaceGraphInPlace(holder.loaded.graph, graph)
    }
  }
  const edit = async (file: string, change: (graph: ComfyGraph) => ComfyGraph): Promise<GraphEdit> => {
    /*
     * The graph is written where the user's copy is, and in a packaged app
     * that copy is made here, from the program's file, on the first edit —
     * `editWorkflowFile` then reads and rewrites that one. The loaded copies
     * are found by the configured file, which does not change when a copy is
     * made, so an edit reaches every one of them either way.
     */
    const target = await overlay.ensureWritable(file)
    const done = await editWorkflowFile(target, change)
    adopt(file, done.graph)
    return done
  }
  const restore = async (file: string, current: ComfyGraph): Promise<GraphRestore> => {
    if (!await overlay.restore(file)) return { restored: false, graph: current }
    // Read first, swap after: a program file that no longer parses must leave
    // the graph in memory as it was, not blank.
    const graph = readGraphFile(file)
    adopt(file, graph)
    return { restored: true, graph }
  }
  return { edit, adopt, restore }
}

/** A LoRA edit's answer: the backup and the LoRAs the graph now carries. */
type LoraEdit = Promise<{ backup: string; loras: readonly LoraInGraph[] }>

/** The personal card a configured entry points at, by its `custom:<id>` path. */
function cardOfPath(path: string, cards: readonly CustomWorkflowMeta[]): CustomWorkflowMeta | undefined {
  if (!isCustomPath(path)) return undefined
  const id = path.slice('custom:'.length)
  return cards.find(card => card.id === id)
}

/**
 * When to use one workflow: the card's own description for a personal graph,
 * the configured entry's for a shipped one.
 *
 * The graphs are the deployment's own files and nothing in them says what they
 * are for; the reading that has to choose one was told only a title.
 */
function descriptionOf(entry: { readonly card: CustomWorkflowMeta | undefined; readonly loaded: LoadedWorkflow }): string | undefined {
  const description = entry.card?.description ?? entry.loaded.description
  return description === undefined || description.trim().length === 0 ? undefined : description.trim()
}

/** The facts by `${node}.${field}`, as a plan looks them up. */
function factsMap(facts: readonly WorkflowFieldFact[]): ReadonlyMap<string, WorkflowFieldFact> {
  return new Map(facts.map(fact => [`${fact.node}.${fact.field}`, fact]))
}

/**
 * The workflows the studio may talk about, and how a confirmed change reaches
 * one: one entry per configured graph, carrying the file it came from and the
 * pins the configuration put into it. A change goes through `editor`, which
 * writes the file and every loaded copy of it together, or every run until
 * the next restart would use the old values.
 * @param ctx - plugin context, for the node options ComfyUI reports.
 * @param rows - the loaded rows.
 * @param editor - the graph-edit step.
 * @param overlay - where this installation reads and writes its graphs: it
 *   answers whether a graph was changed here (`workflow-overlay.ts`).
 * @returns the inventory the chat and the routes read, and the apply steps.
 */
export function workflowInventory(
  ctx: ImagineHost,
  rows: readonly LoadedRow[],
  editor: GraphEditor,
  overlay: WorkflowOverlay = writableOverlay,
  cards: () => readonly CustomWorkflowMeta[] = () => [],
): {
  readonly inventory: WorkflowInventory
  readonly applyKeyed: (key: string, changes: readonly WorkflowChange[]) => Promise<{ backup: string; applied: number }>
  /** Adds a LoRA to one workflow's model chain, and stores the graph. */
  readonly addLora: (key: string, request: LoraRequest) => LoraEdit
  /** Takes one out by node id. */
  readonly removeLora: (key: string, node: string) => LoraEdit
  /** The LoRAs one workflow carries. */
  readonly lorasOf: (key: string) => readonly LoraInGraph[] | undefined
  /** Changes one LoRA's strength, keeping the node where it is. */
  readonly tuneLora: (key: string, node: string, strength: number) => LoraEdit
  /** Whether this workflow was changed, and the user's copy wins over the program's. */
  readonly overridden: (key: string) => boolean
  /** Drop the user's copy: the program's file, and its updates, are in use again. */
  readonly restoreDefault: (key: string) => Promise<GraphRestore>
} {
  const editable: {
    key: string
    label: string
    /** The name the job runner knows its graph by. */
    run: string
    path: string
    /** The file the graph is read from and written to (`custom:` resolved). */
    file: string
    loaded: LoadedWorkflow
    pins: Record<string, string | undefined>
    /** The personal card behind this entry, when it points at one. */
    card: CustomWorkflowMeta | undefined
  }[] = (() => {
    // The cards are read once for the whole list: one directory read per row
    // was two dozen reads of the same folder at boot.
    const cardList = cards()
    return rows.flatMap(row => row.key === undefined || row.label === undefined
      || row.path === undefined || row.loaded === undefined
      ? []
      : [{
        key: row.key, label: row.label, run: row.run, path: row.path, file: workflowFile(row.path),
        loaded: row.loaded, pins: pinsOf(row.loaded), card: cardOfPath(row.path, cardList),
      }])
  })()
  const workflowOfKey = (key: string) => editable.find(entry => entry.key === key)
  /**
   * What one node input accepts, read from ComfyUI.
   *
   * One read per node class, because `/object_info` answers per class and the
   * client keeps the class for a few seconds: a graph with forty inputs has a
   * dozen classes. A class ComfyUI cannot describe leaves no facts for its
   * fields, and a change is then checked on the graph alone.
   */
  const factsOf = async (entry: (typeof editable)[number], signal?: AbortSignal): Promise<readonly WorkflowFieldFact[]> => {
    const facts: WorkflowFieldFact[] = []
    // Grouped by node class: `/object_info` answers per class, so one question
    // covers every field of that class. A class that does not answer is not
    // asked again field by field: ComfyUI is down, and thirty timeouts would
    // hold the sentence for nothing.
    const byClass = new Map<string, WorkflowField[]>()
    for (const field of listWorkflowFields(entry.loaded.graph)) {
      byClass.set(field.classType, [...byClass.get(field.classType) ?? [], field])
    }
    for (const [classType, fields] of byClass) {
      for (const field of fields) {
        let spec: Awaited<ReturnType<typeof ctx.comfy.inputSpec>>
        try {
          spec = await ctx.comfy.inputSpec(classType, field.field, signal)
        } catch {
          // This class is not answering: its inputs are checked on the graph alone.
          break
        }
        if (spec !== undefined) facts.push({ node: field.node, field: field.field, ...spec })
      }
    }
    return facts
  }
  const entryOf = (key: string) => {
    const entry = workflowOfKey(key)
    if (entry === undefined) throw new Error(message('workflow.notConfigured', { key }))
    return entry
  }
  /**
   * Apply a change to one workflow, planned again here.
   *
   * The plan the studio showed is not what gets written: it was made from this
   * same graph, but a client cannot be the one that decides which inputs a
   * file ends up with.
   */
  const applyKeyed = async (
    key: string,
    changes: readonly WorkflowChange[],
  ): Promise<{ backup: string; applied: number }> => {
    const entry = entryOf(key)
    // The facts are read again here, like the plan: the endpoint is what
    // writes, and it cannot trust the copy a page sent back.
    const planned = planWorkflowPatch(entry.loaded.graph, changes, factsMap(await factsOf(entry)))
    if (planned.diff.length === 0) {
      throw new Error(planned.errors[0] ?? message('change.nothing'))
    }
    const { backup } = await editor.edit(entry.file, patchWorkflow(planned.diff))
    return { backup, applied: planned.diff.length }
  }
  /*
   * A LoRA is not a value: it is a node, and putting one in rewires the model
   * chain. The whole graph goes through the editor, which checks the links,
   * keeps a backup and updates every loaded copy. The strength is the only
   * thing about a LoRA worth changing once it is in, and goes the same way.
   */
  const loraEdit = async (key: string, change: (graph: ComfyGraph) => ComfyGraph): LoraEdit => {
    const entry = entryOf(key)
    const { backup, graph } = await editor.edit(entry.file, change)
    return { backup, loras: listLoras(graph) }
  }
  const addLora = (key: string, request: LoraRequest): LoraEdit =>
    loraEdit(key, graph => insertLora(graph, request).graph)
  const removeLoraOf = (key: string, node: string): LoraEdit =>
    loraEdit(key, graph => removeLora(graph, node))
  const tuneLora = (key: string, node: string, strength: number): LoraEdit =>
    loraEdit(key, graph => setLoraStrength(graph, node, strength))
  /** Whether this workflow's copy exists: the program's file is not the one in use. */
  const overriddenOf = (key: string): boolean => {
    const entry = workflowOfKey(key)
    return entry === undefined ? false : overlay.overridden(entry.file)
  }
  const restoreDefault = async (key: string): Promise<GraphRestore> => {
    const entry = entryOf(key)
    return await editor.restore(entry.file, entry.loaded.graph)
  }
  const lorasOf = (key: string): readonly LoraInGraph[] | undefined => {
    const entry = workflowOfKey(key)
    return entry === undefined ? undefined : listLoras(entry.loaded.graph)
  }
  const inventory: WorkflowInventory = {
    list: editable.map((entry): WorkflowSummary => ({
      key: entry.key,
      label: entry.label,
      // A card says who it is by its title: `custom:<id>` names nothing, and
      // the id was shown to the reading as if it were a file name.
      file: entry.card?.title ?? basename(entry.path),
      ...entry.card === undefined ? {} : {
        card: { id: entry.card.id, title: entry.card.title, description: entry.card.description },
      },
      ...descriptionOf(entry) === undefined ? {} : { description: descriptionOf(entry) },
      run: entry.run,
    })),
    get cards() {
      // Read per turn: a card uploaded while the studio is open is runnable
      // from the chat without a restart.
      return cards().map((card): WorkflowCard => ({
        id: card.id, title: card.title, description: card.description, inputs: card.inputs,
      }))
    },
    summarise: (key) => {
      const entry = workflowOfKey(key)
      return entry === undefined ? undefined : summariseWorkflow(entry.loaded.graph)
    },
    fields: (key) => {
      const entry = workflowOfKey(key)
      return entry === undefined ? undefined : listWorkflowFields(entry.loaded.graph)
    },
    warnings: (key) => {
      const entry = workflowOfKey(key)
      return entry === undefined ? undefined : stalePins(entry.loaded.graph, entry.pins)
    },
    overridden: overriddenOf,
    facts: async (key, signal) => {
      const entry = workflowOfKey(key)
      return entry === undefined ? undefined : await factsOf(entry, signal)
    },
    options: async (key, node, field) => {
      const classType = workflowOfKey(key)?.loaded.graph[node]?.class_type
      return classType === undefined ? undefined : await ctx.comfy.nodeOptions(classType, field)
    },
    plan: (key, changes, facts) => {
      const entry = workflowOfKey(key)
      if (entry === undefined) return undefined
      const planned = planWorkflowPatch(entry.loaded.graph, changes, factsMap(facts ?? []))
      return {
        file: basename(entry.path),
        diff: planned.diff,
        errors: planned.errors,
        warnings: stalePins(entry.loaded.graph, entry.pins),
      }
    },
  }
  return { inventory, applyKeyed, addLora, removeLora: removeLoraOf, lorasOf, tuneLora, overridden: overriddenOf, restoreDefault }
}
