/**
 * The override layer the Imagine settings page maintains.
 *
 * The deployment's choices live in `config.yaml`, which the page never edits:
 * what the user changes is stored in `imagine-settings.json` under the data
 * directory instead. The entry merges that file over its configuration at
 * boot, so the file only carries the fields the user actually changed. ComfyUI
 * graphs are read once at activation, so a saved change reaches a running
 * process only at the next restart; the surface reports which values the
 * process is using and which ones the file now holds.
 * @module tool-comfy/imagine-settings
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '../atomic-write/index.ts'
import type { ComfyConnectionOverrides } from '../comfyui/index.ts'
import { dataPath } from '../home-paths/index.ts'
import { message } from '../../src/messages.ts'
import type { Config } from './index.ts'
import { isPlainObject } from './guards.ts'
import { ALL_WORKFLOW_FIELDS, RETIRED_WORKFLOW_FIELDS, WORKFLOW_KEYS, WORKFLOW_ROWS, type FieldSpec } from './workflow-fields.ts'
import type { ImagineSettingOp } from '../../../shared/imagine-types.ts'

/** Version this module writes and accepts. */
const IMAGINE_SETTINGS_VERSION = 1

/** One workflow map of the plugin configuration. */
export type WorkflowMap = NonNullable<Config['workflows']>

/**
 * The configuration entry behind one inventory key.
 *
 * The two vocabularies differ — the studio names what an action does, the
 * configuration names the entry it belongs to — and the settings page speaks
 * both: it lists the configuration entries and edits them under the inventory
 * key. Both come from the one table in `workflow-fields.ts`.
 * @param key - the key the studio addresses the workflow by.
 * @returns the configuration entry name, or undefined for a key nothing configures.
 */
export function workflowConfigKey(key: string): string | undefined {
  return WORKFLOW_ROWS.find(row => 'key' in row && row.key === key)?.config
}

/** The override layer: only the fields the user changed are present. */
export interface ImagineOverrides {
  /** Connection fields that replace the composed ones. */
  server?: ComfyConnectionOverrides
  /** Media output directory replacing the composed one. */
  outputDir?: string
  /** Per-workflow patches, merged onto the composed entry. */
  workflows?: Record<string, Record<string, unknown>>
}

/** What one read of the file answered. */
export interface ImagineSettingsRead {
  /** The accepted overrides; empty when the file is missing or unusable. */
  readonly overrides: ImagineOverrides
  /** The file as it stands, or undefined when there is none. */
  readonly raw: string | undefined
  /** Why the file was not accepted, when it was not. */
  readonly problem?: string
}

/** Connection fields the override layer accepts. */
const SERVER_FIELDS = new Set([
  'baseURL', 'timeoutMs', 'pollIntervalMs', 'pathStyle', 'preview', 'restartCommand', 'restartReadyMs',
])

/** Sections the file may carry. */
const SECTIONS = new Set(['version', 'server', 'outputDir', 'workflows'])

/** Path of the Imagine settings file. */
export function imagineSettingsPath(): string {
  return dataPath('comfy', 'imagine-settings.json')
}

/** Whether a value is a positive whole number. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Whether a value is one non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Why one connection field is not a value this file may carry.
 * @param field - the connection field name.
 * @param value - the value the page asked to store.
 * @returns the refusal, or undefined when the value is accepted.
 */
function serverFieldProblem(field: string, value: unknown): string | undefined {
  switch (field) {
    case 'baseURL':
      return typeof value === 'string' && /^https?:\/\/\S+$/.test(value)
        ? undefined
        : message('settings.baseUrl')
    case 'timeoutMs':
    case 'pollIntervalMs':
    case 'restartReadyMs':
      return isPositiveInteger(value) ? undefined : message('settings.positiveInteger', { where: `server.${field}` })
    case 'pathStyle':
      return value === 'auto' || value === 'posix' || value === 'nt'
        ? undefined
        : message('settings.pathStyle')
    case 'preview':
      return typeof value === 'boolean' ? undefined : message('settings.preview')
    case 'restartCommand':
      return Array.isArray(value) && value.every(isText)
        ? undefined
        : message('settings.restartCommand')
    default:
      return message('settings.notConfigurable', { where: `server.${field}` })
  }
}

/**
 * Why one value does not fit the way a field is written.
 * @param where - the dotted path the refusal names.
 * @param spec - how the field is written.
 * @param value - the value the page asked to store.
 * @returns the refusal, or undefined when the value is accepted.
 */
function specProblem(where: string, spec: FieldSpec, value: unknown): string | undefined {
  switch (spec.kind) {
    case 'text':
      return isText(value) ? undefined : message('settings.textRequired', { where })
    case 'string':
      return typeof value === 'string' ? undefined : message('settings.text', { where })
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return message('settings.number', { where })
      if (spec.min !== undefined && value < spec.min) return message('settings.minimum', { where, min: spec.min })
      if (spec.max !== undefined && value > spec.max) return message('settings.maximum', { where, max: spec.max })
      return undefined
    }
    case 'list':
      return Array.isArray(value) && value.every(isText) ? undefined : message('settings.list', { where })
    case 'object': {
      if (!isPlainObject(value)) return message('settings.object', { where })
      for (const [member, memberValue] of Object.entries(value)) {
        const memberSpec = spec.members[member]
        if (memberSpec === undefined) return message('settings.notConfigurable', { where: `${where}.${member}` })
        const problem = specProblem(`${where}.${member}`, memberSpec, memberValue)
        if (problem !== undefined) return problem
      }
      return undefined
    }
  }
}

/**
 * Why one workflow entry field is not a value this file may carry.
 * @param key - the workflow key it belongs to.
 * @param field - the workflow entry field.
 * @param value - the value the page asked to store.
 * @returns the refusal, or undefined when the value is accepted.
 */
function workflowFieldProblem(key: string, field: string, value: unknown): string | undefined {
  const where = `workflows.${key}.${field}`
  const spec = ALL_WORKFLOW_FIELDS[field]
  if (spec === undefined) return message('settings.notConfigurable', { where })
  const problem = specProblem(where, spec, value)
  if (problem !== undefined) return problem
  if (field === 'path' && typeof value === 'string' && !value.endsWith('.json')) return message('settings.jsonFile', { where })
  if (field === 'outputExt' && typeof value === 'string' && value.startsWith('.')) return message('settings.noLeadingDot', { where })
  return undefined
}

/** Whether a key names a workflow entry the configuration accepts. */
function isWorkflowKey(key: string | undefined): key is string {
  return key !== undefined && (WORKFLOW_KEYS as readonly string[]).includes(key)
}

/**
 * Why one whole workflow patch is not a value this file may carry.
 * @param key - the workflow key the patch is addressed to.
 * @param patch - the patch object.
 * @returns the refusal, or undefined when every field is accepted.
 */
function workflowPatchProblem(key: string, patch: unknown): string | undefined {
  if (!isWorkflowKey(key)) return message('settings.unknownWorkflow', { where: `workflows.${key}` })
  if (!isPlainObject(patch)) return message('settings.object', { where: `workflows.${key}` })
  for (const [field, value] of Object.entries(patch)) {
    const problem = workflowFieldProblem(key, field, value)
    if (problem !== undefined) return problem
  }
  return undefined
}

/**
 * Why one addressed path is not a field this file may carry.
 * @param path - the path from the file's root.
 * @returns the refusal, or undefined when the path addresses a configurable field.
 */
function pathProblem(path: readonly string[]): string | undefined {
  const [head, second, third, fourth] = path
  if (head === 'server') {
    if (second === undefined || path.length !== 2) return message('settings.serverOneField')
    return SERVER_FIELDS.has(second) ? undefined : message('settings.notConfigurable', { where: `server.${second}` })
  }
  if (head === 'outputDir') return path.length === 1 ? undefined : message('settings.outputDirNoChildren')
  if (head === 'workflows') {
    if (!isWorkflowKey(second)) return message('settings.unknownWorkflow', { where: `workflows.${second ?? ''}` })
    if (third === undefined) return message('settings.workflowNeedsField')
    const spec = ALL_WORKFLOW_FIELDS[third]
    if (spec === undefined) return message('settings.notConfigurable', { where: `workflows.${second}.${third}` })
    if (spec.kind !== 'object') return path.length === 3 ? undefined : message('settings.noChildren', { where: `workflows.${second}.${third}` })
    if (path.length === 3) return undefined
    if (path.length !== 4) return message('settings.oneLevel', { where: `workflows.${second}.${third}` })
    return spec.members[fourth ?? ''] === undefined
      ? message('settings.notConfigurable', { where: `workflows.${second}.${third}.${fourth ?? ''}` })
      : undefined
  }
  return message('settings.unknownSection', { name: head ?? '' })
}

/**
 * Why one value cannot be stored at one path.
 * @param path - the path from the file's root, already known to address a field.
 * @param value - the value the page asked to store.
 * @returns the refusal, or undefined when the value is accepted.
 */
function valueProblem(path: readonly string[], value: unknown): string | undefined {
  const [head, second, third, fourth] = path
  if (head === 'server' && second !== undefined) return serverFieldProblem(second, value)
  if (head === 'outputDir') {
    return typeof value === 'string' && value.startsWith('/') && value.length > 1
      ? undefined
      : message('settings.absolutePath')
  }
  if (head === 'workflows' && second !== undefined && third !== undefined) {
    if (fourth === undefined) return workflowFieldProblem(second, third, value)
    const spec = ALL_WORKFLOW_FIELDS[third]
    const member = spec?.kind === 'object' ? spec.members[fourth] : undefined
    return member === undefined
      ? message('settings.notConfigurable', { where: `workflows.${second}.${third}.${fourth}` })
      : specProblem(`workflows.${second}.${third}.${fourth}`, member, value)
  }
  return message('settings.pathNotConfigurable')
}

/**
 * Read the settings file, accepting only the fields the page maintains.
 *
 * Synchronous on purpose: boot needs the layer before anything is registered.
 * The request paths read it with {@link readImagineOverrides}.
 *
 * A file that does not parse, or carries a field this module does not know, is
 * reported and ignored rather than applied: a bad settings file must not stop
 * the studio from generating.
 * @returns the accepted overrides, the raw text, and any refusal.
 */
export function loadImagineOverrides(): ImagineSettingsRead {
  try {
    return settingsOf(readFileSync(imagineSettingsPath(), 'utf8'))
  } catch (error: unknown) {
    return unreadable(error)
  }
}

/**
 * The same read as {@link loadImagineOverrides}, off the event loop.
 * @returns the accepted overrides, the raw text, and any refusal.
 */
export async function readImagineOverrides(): Promise<ImagineSettingsRead> {
  try {
    return settingsOf(await readFile(imagineSettingsPath(), 'utf8'))
  } catch (error: unknown) {
    return unreadable(error)
  }
}

/** A file that could not be read: absent is no layer, anything else a problem. */
function unreadable(error: unknown): ImagineSettingsRead {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return { overrides: {}, raw: undefined }
  return { overrides: {}, raw: undefined, problem: message('settings.unreadable', { reason: String(error) }) }
}

/** Parse and validate the file's text. */
function settingsOf(raw: string): ImagineSettingsRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    return { overrides: {}, raw, problem: message('settings.invalidJson', { reason: String(error) }) }
  }
  const { overrides, errors } = parseImagineOverrides(parsed)
  return errors.length > 0 ? { overrides: {}, raw, problem: errors.join('; ') } : { overrides, raw }
}

/**
 * Validate a whole settings document.
 * @param value - the parsed JSON.
 * @returns the accepted overrides plus one line per refusal.
 */
function parseImagineOverrides(value: unknown): { overrides: ImagineOverrides; errors: readonly string[] } {
  if (!isPlainObject(value)) return { overrides: {}, errors: [message('settings.fileObject')] }
  const errors: string[] = []
  for (const section of Object.keys(value)) {
    if (!SECTIONS.has(section)) errors.push(message('settings.unknownSection', { name: section }))
  }
  const version = value['version']
  if (version !== undefined && version !== IMAGINE_SETTINGS_VERSION) {
    errors.push(message('settings.version', { found: String(version), expected: IMAGINE_SETTINGS_VERSION }))
  }
  const server = value['server']
  if (server !== undefined && !isPlainObject(server)) errors.push(message('settings.object', { where: 'server' }))
  const workflows = value['workflows']
  if (workflows !== undefined && !isPlainObject(workflows)) errors.push(message('settings.object', { where: 'workflows' }))
  const overrides: ImagineOverrides = {}
  if (isPlainObject(server)) {
    // One check per field: a field that passes is a valid connection override.
    const accepted: Record<string, unknown> = {}
    for (const [field, fieldValue] of Object.entries(server)) {
      const problem = serverFieldProblem(field, fieldValue)
      if (problem !== undefined) errors.push(problem)
      else accepted[field] = fieldValue
    }
    if (Object.keys(accepted).length > 0) overrides.server = accepted as ComfyConnectionOverrides
  }
  const outputDir = value['outputDir']
  if (outputDir !== undefined) {
    const problem = valueProblem(['outputDir'], outputDir)
    if (problem !== undefined) errors.push(problem)
    else if (typeof outputDir === 'string') overrides.outputDir = outputDir
  }
  if (isPlainObject(workflows)) {
    const accepted: Record<string, Record<string, unknown>> = {}
    for (const [key, patch] of Object.entries(workflows)) {
      /*
       * A field that was retired is dropped before the check, not refused: a
       * file written while it was still on the page would otherwise lose the
       * whole layer to it. The next save writes the file without it.
       */
      const current = isPlainObject(patch)
        ? Object.fromEntries(Object.entries(patch).filter(([field]) => !RETIRED_WORKFLOW_FIELDS.has(field)))
        : patch
      const problem = workflowPatchProblem(key, current)
      if (problem !== undefined) errors.push(problem)
      else if (isPlainObject(current)) accepted[key] = current
    }
    if (Object.keys(accepted).length > 0) overrides.workflows = accepted
  }
  // One unusable field makes the whole document unusable: a layer applied in
  // part is a deployment nobody can explain by reading the file.
  return errors.length > 0 ? { overrides: {}, errors } : { overrides, errors }
}

/**
 * Apply ordered path edits to the override layer, refusing what it may not carry.
 * @param current - the overrides as read.
 * @param ops - the edits, in order.
 * @returns the edited layer and one line per refused edit.
 */
export function applyOverrideOps(
  current: ImagineOverrides,
  ops: readonly ImagineSettingOp[],
): { next: ImagineOverrides; errors: readonly string[] } {
  let next: Record<string, unknown> = { ...current }
  const errors: string[] = []
  for (const op of ops) {
    const problem = pathProblem(op.path) ?? (op.op === 'set' ? valueProblem(op.path, op.value) : undefined)
    if (problem !== undefined) {
      errors.push(problem)
      continue
    }
    next = op.op === 'set' ? setAt(next, op.path, op.value) : unsetAt(next, op.path)
  }
  // Every path that reached this write was validated by {@link pathProblem}
  // and {@link valueProblem}, so the document is the layer's declared fields.
  return { next: next as ImagineOverrides, errors }
}

/** One path write, creating the objects along the way. */
function setAt(root: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path
  if (head === undefined) return root
  if (rest.length === 0) return { ...root, [head]: value }
  const child = isPlainObject(root[head]) ? root[head] : {}
  return { ...root, [head]: setAt(child, rest, value) }
}

/** One path removal, dropping the objects it leaves empty. */
function unsetAt(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  const [head, ...rest] = path
  if (head === undefined) return root
  if (rest.length === 0) {
    const next = { ...root }
    Reflect.deleteProperty(next, head)
    return next
  }
  if (!isPlainObject(root[head])) return root
  const child = unsetAt(root[head], rest)
  if (Object.keys(child).length === 0) {
    const next = { ...root }
    Reflect.deleteProperty(next, head)
    return next
  }
  return { ...root, [head]: child }
}

/**
 * Merge one workflow map onto another, entry by entry and field by field.
 *
 * A patch field replaces the composed one, and a patch object is merged into
 * the composed object of the same name: a page that sets `realism.strength`
 * leaves `realism.nodeId` as `config.yaml` declared it.
 * @param base - the composed workflow map.
 * @param overrides - the per-workflow patches.
 * @returns a new map carrying the composed entries with the patches applied.
 */
export function mergeWorkflowMaps(
  base: WorkflowMap,
  overrides: Readonly<Record<string, Record<string, unknown>>>,
): WorkflowMap {
  const next: Record<string, unknown> = { ...base }
  for (const [key, patch] of Object.entries(overrides)) {
    const current = next[key]
    next[key] = isPlainObject(current) ? mergeDeep(current, patch) : { ...patch }
  }
  // The patches were validated field by field by {@link workflowPatchProblem},
  // and a merged entry keeps the composed fields it did not patch.
  return next as WorkflowMap
}

/** Merge plain objects recursively; every other value replaces the one below. */
function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = next[key]
    next[key] = isPlainObject(current) && isPlainObject(value) ? mergeDeep(current, value) : value
  }
  return next
}

/**
 * Write the override layer, replacing the file's whole contents.
 * @param overrides - the layer to store.
 * @returns nothing; the write is atomic.
 */
export async function saveImagineOverrides(overrides: ImagineOverrides): Promise<void> {
  const document = { version: IMAGINE_SETTINGS_VERSION, ...overrides }
  await writeFileAtomic(imagineSettingsPath(), `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
}
