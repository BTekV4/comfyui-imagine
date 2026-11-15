/**
 * Reading the configured workflows at boot: the file behind each entry, the
 * graph check at the file boundary, and the pins each loaded workflow keeps.
 *
 * Split out of `index.ts` on 2026-11-07; the graphs are still read once, at
 * boot, and every later change reaches them through `workflow-inventory.ts`.
 * @module tool-comfy/workflow-load
 */

import { readFileSync } from 'node:fs'
import { ComfyError } from '../comfyui/index.ts'
import { customGraphFile, isCustomPath } from './custom-workflows.ts'
import { finite, isPlainObject } from './guards.ts'
import type { WorkflowMap } from './imagine-settings.ts'
import type { LoadedWorkflow, WorkflowConfig, WorkflowExtras } from './index.ts'
import { ALL_WORKFLOW_FIELDS, WORKFLOW_ROWS, type FieldSpec, type WorkflowGraphs } from './workflow-fields.ts'

/**
 * One configured field as the loaded workflow keeps it, or undefined when the
 * deployment left it out.
 *
 * An object field is read off its members in the table, not off its name:
 * every `text` member is needed (both halves of a pin, a check's probe, both
 * nodes of a chain), the others are kept when present. Until 2026-10-25 the
 * objects were matched by name, and a field not in the list was dropped at
 * load without a word.
 * @param spec - how the field is written.
 * @param value - the configured value.
 * @returns the value to keep, or undefined.
 */
function loadedField(spec: FieldSpec, value: unknown): unknown {
  switch (spec.kind) {
    case 'text':
      return typeof value === 'string' && value.length > 0 ? value : undefined
    case 'string':
      return typeof value === 'string' ? value : undefined
    case 'number':
      return finite(value)
    case 'list':
      return Array.isArray(value) && value.length > 0 ? [...value] : undefined
    case 'object': {
      if (!isPlainObject(value)) return undefined
      const loaded: Record<string, unknown> = {}
      for (const [name, member] of Object.entries(spec.members)) {
        const got = loadedField(member, value[name])
        if (got !== undefined) loaded[name] = got
        else if (member.kind === 'text') return undefined
      }
      return loaded
    }
  }
}

/**
 * The file behind a workflow path: `custom:<id>` is a graph the user uploaded
 * (`<data>/custom-workflows/<id>/graph.json`), anything else is a file path.
 * Writes go here too: until 2026-11-07 the settings page wrote to a file named
 * literally `custom:<id>` and every «Applica» on a personal graph failed.
 * @param path - the path as the configuration writes it.
 * @returns the file to read and write.
 * @throws {ComfyError} for a `custom:` path whose id is not one the studio
 *   minted: it is a path segment, and `custom:../x` would leave the folder.
 */
export function workflowFile(path: string): string {
  if (!isCustomPath(path)) return path
  const file = customGraphFile(path)
  if (file === undefined) throw new ComfyError(`workflow ${path} is not a valid custom:<id>`, 'COMFY_SUBMIT_FAILED')
  return file
}

/**
 * Load and validate one API-format workflow at plugin activation.
 * @param config - the workflow entry.
 * @returns the graph with the pins the entry configured.
 * @throws {ComfyError} when the file cannot be read or is not an API graph.
 */
function loadWorkflow(config: WorkflowConfig & WorkflowExtras): LoadedWorkflow {
  /*
   * A `custom:<id>` path reads the graph from the workflows the user uploaded,
   * not from the repo: so a `config.yaml` action can point at a personal graph
   * — with its LoRA — without that file joining the tracked ones.
   */
  const source = workflowFile(config.path)
  let raw: string
  try {
    raw = readFileSync(source, 'utf8')
  } catch (error: unknown) {
    throw new ComfyError(`cannot read workflow ${config.path}`, 'COMFY_SUBMIT_FAILED', { cause: error })
  }
  let graph: unknown
  try {
    graph = JSON.parse(raw)
  } catch (error: unknown) {
    throw new ComfyError(`workflow ${config.path} is not valid JSON`, 'COMFY_SUBMIT_FAILED', { cause: error })
  }
  if (!isPlainObject(graph)) {
    throw new ComfyError(`workflow ${config.path} is not an API-format graph`, 'COMFY_SUBMIT_FAILED')
  }
  // Every node is checked here, at the file boundary, so the parameterizing
  // code can address `node.inputs` as the type promises.
  for (const [id, node] of Object.entries(graph)) {
    const entry = node as { class_type?: unknown; inputs?: unknown } | null
    if (typeof entry !== 'object' || entry === null
      || typeof entry.class_type !== 'string'
      || !isPlainObject(entry.inputs)) {
      throw new ComfyError(`workflow ${config.path} node "${id}" is not an API-format node`, 'COMFY_SUBMIT_FAILED')
    }
  }
  const loaded: Record<string, unknown> = { graph }
  for (const [field, spec] of Object.entries(ALL_WORKFLOW_FIELDS)) {
    if (field === 'path') continue
    const value = loadedField(spec, (config as unknown as Record<string, unknown>)[field])
    if (value !== undefined) loaded[field] = value
  }
  return loaded as unknown as LoadedWorkflow
}

/** One configured workflow row, loaded: the job runner's name, the studio's key and label, and its file. */
export interface LoadedRow {
  readonly run: string
  readonly key: string | undefined
  readonly label: string | undefined
  readonly path: string | undefined
  readonly loaded: LoadedWorkflow | undefined
}

/**
 * A loaded graph and the file it was read from.
 *
 * Several loaded workflows can come from one file — a row and a personal card
 * both reading `custom:<id>`, or two rows sharing a graph — and an edit has to
 * reach every one of them (`workflow-inventory.ts`, {@link graphEditor}).
 */
export interface GraphHolder {
  /** The file, with `custom:` resolved. */
  readonly file: string
  /** The loaded workflow whose `graph` is updated in place. */
  readonly loaded: LoadedWorkflow
}

/**
 * Load every configured graph, once, at boot.
 *
 * One row per workflow (`workflow-fields.ts`): the name the job runner knows
 * it by, the config entry it is read from, and — when the studio may talk
 * about it — the key and label the chat and the settings page show. An entry
 * without a path is one the deployment did not configure.
 * @param workflows - the workflow entries, settings page over `config.yaml`.
 * @returns the loaded rows, the graphs by the job runner's name, and every
 *   loaded graph with its file (the high-recipe ones included).
 */
export function loadWorkflows(workflows: WorkflowMap): {
  readonly rows: readonly LoadedRow[]
  readonly byRun: WorkflowGraphs
  readonly holders: readonly GraphHolder[]
} {
  const holders: GraphHolder[] = []
  const rows = WORKFLOW_ROWS.map((row): LoadedRow => {
    const entry = workflows[row.config] as (WorkflowConfig & WorkflowExtras) | undefined
    const loaded = entry?.path === undefined || entry.path === '' ? undefined : loadWorkflow(entry)
    if (loaded !== undefined && entry !== undefined) holders.push({ file: workflowFile(entry.path), loaded })
    return {
      run: row.run,
      key: 'key' in row ? row.key : undefined,
      label: 'label' in row ? row.label : undefined,
      path: entry?.path,
      loaded,
    }
  })
  /*
   * The second graph of every entry that declares one (`pathHigh`): the same
   * action rendered with the high-quality recipe, with the same pins, so
   * «Velocità» and «Qualità: Alta» pick the graph instead of raising the
   * steps. An entry without `pathHigh` has none: quality stays the usual graph.
   */
  const high: Record<string, LoadedWorkflow> = {}
  for (const row of WORKFLOW_ROWS) {
    const entry = workflows[row.config] as (WorkflowConfig & WorkflowExtras) | undefined
    if (entry?.pathHigh === undefined || entry.pathHigh === '') continue
    const loaded = loadWorkflow({ ...entry, path: entry.pathHigh })
    high[row.run] = loaded
    holders.push({ file: workflowFile(entry.pathHigh), loaded })
  }
  const byRun: WorkflowGraphs = {
    ...Object.fromEntries(rows
      .filter(row => row.loaded !== undefined)
      .map(row => [row.run, row.loaded])),
    ...Object.keys(high).length === 0 ? {} : { high },
  }
  return { rows, byRun, holders }
}
