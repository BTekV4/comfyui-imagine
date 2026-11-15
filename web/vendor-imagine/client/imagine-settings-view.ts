/**
 * Pure folds behind the Imagine settings page: how one editable field converts
 * between its stored value and draft text, how staged drafts become the
 * path-addressed edits the host stores, and which rows a workflow's own
 * configuration offers. The page renders this; it decides nothing itself.
 */

import type { ImagineSettingOp } from '../../../shared/imagine-types.ts'
import type { WorkflowField } from '../../../shared/imagine-chat.ts'
import type { WorkflowValueChange } from '../../../shared/imagine-chat.ts'
import type { ComfyLocaleKey } from './locales.ts'

/** How one editable field converts between its stored value and draft text. */
export type FieldKind =
  /** Free text, optionally matching a pattern or an absolute path. */
  | { readonly kind: 'text'; readonly pattern?: RegExp; readonly absolute?: boolean }
  /** A number, optionally a positive whole one. */
  | { readonly kind: 'number'; readonly positive?: boolean }
  /** One argument per line, stored as a list. */
  | { readonly kind: 'lines' }
  /** One of a closed set. */
  | { readonly kind: 'choice'; readonly choices: readonly string[] }
  /** A boolean. */
  | { readonly kind: 'flag' }

/** One field the settings page edits by path. */
export interface SettingField {
  /** Path from the settings file's root. */
  readonly path: readonly string[]
  /** Dictionary key of the visible label. */
  readonly label: ComfyLocaleKey
  /** Dictionary key of the one-line explanation. */
  readonly hint: ComfyLocaleKey
  /** How the control reads and writes the value. */
  readonly kind: FieldKind
}

/** What one parse of draft text came to. */
export interface FieldParse {
  /** The value a save would store; absent for a clear and for an invalid draft. */
  readonly value?: unknown
  /** True when the draft asks to go back to the composed value. */
  readonly clear?: boolean
  /** True when the text is not a value this field accepts. */
  readonly invalid?: boolean
}

/** One staged draft of one field. */
export interface SettingDraft extends FieldParse {
  /** The text the control shows. */
  readonly text: string
}

/** The ComfyUI connection fields the page edits. */
export const SERVER_FIELDS: readonly SettingField[] = [
  {
    path: ['server', 'baseURL'],
    label: 'imagine.settings.baseURL',
    hint: 'imagine.settings.baseURLHint',
    kind: { kind: 'text', pattern: /^https?:\/\/\S+$/ },
  },
  {
    path: ['server', 'timeoutMs'],
    label: 'imagine.settings.timeout',
    hint: 'imagine.settings.timeoutHint',
    kind: { kind: 'number', positive: true },
  },
  {
    path: ['server', 'pathStyle'],
    label: 'imagine.settings.pathStyle',
    hint: 'imagine.settings.pathStyleHint',
    kind: { kind: 'choice', choices: ['auto', 'posix', 'nt'] },
  },
  {
    path: ['server', 'restartReadyMs'],
    label: 'imagine.settings.restartReady',
    hint: 'imagine.settings.restartReadyHint',
    kind: { kind: 'number', positive: true },
  },
  {
    path: ['server', 'restartCommand'],
    label: 'imagine.settings.restartCommand',
    hint: 'imagine.settings.restartCommandHint',
    kind: { kind: 'lines' },
  },
]

/** The media directory field. */
export const OUTPUT_FIELDS: readonly SettingField[] = [
  {
    path: ['outputDir'],
    label: 'imagine.settings.output',
    hint: 'imagine.settings.outputHint',
    kind: { kind: 'text', absolute: true },
  },
]

/** Whether a value is a plain data object rather than an array or a scalar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one value out of a layer by path.
 * @param root - the layer document.
 * @param path - the path from its root.
 * @returns the value, or undefined when the path is absent.
 */
export function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = Reflect.get(node, key)
  }
  return node
}

/**
 * Render one stored value as the text its control shows.
 * @param kind - how the field reads and writes its value.
 * @param value - the stored value, when there is one.
 * @returns the draft text.
 */
export function formatField(kind: FieldKind, value: unknown): string {
  if (kind.kind === 'lines') {
    return Array.isArray(value) ? value.filter(entry => typeof entry === 'string').join('\n') : ''
  }
  if (value === undefined || value === null) return ''
  if (kind.kind === 'flag') return value === true ? 'true' : 'false'
  return String(value)
}

/**
 * Read one draft's text as the value it would store.
 * @param kind - how the field reads and writes its value.
 * @param text - the control's text.
 * @returns the parsed value, a clear, or the refusal.
 */
function parseField(kind: FieldKind, text: string): FieldParse {
  if (kind.kind === 'lines') {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    return lines.length === 0 ? { clear: true } : { value: lines }
  }
  const trimmed = text.trim()
  if (trimmed === '') return { clear: true }
  switch (kind.kind) {
    case 'text':
      if (kind.pattern !== undefined && !kind.pattern.test(trimmed)) return { invalid: true }
      if (kind.absolute === true && !trimmed.startsWith('/')) return { invalid: true }
      return { value: trimmed }
    case 'number': {
      const value = Number(trimmed)
      if (!Number.isFinite(value)) return { invalid: true }
      if (kind.positive === true && (!Number.isInteger(value) || value <= 0)) return { invalid: true }
      return { value }
    }
    case 'choice':
      return kind.choices.includes(trimmed) ? { value: trimmed } : { invalid: true }
    case 'flag':
      return trimmed === 'true' || trimmed === 'false' ? { value: trimmed === 'true' } : { invalid: true }
  }
}

/**
 * Stage one field's text as a draft.
 * @param kind - how the field reads and writes its value.
 * @param text - the control's text.
 * @returns the draft a save would read.
 */
export function draftOf(kind: FieldKind, text: string): SettingDraft {
  return { text, ...parseField(kind, text) }
}

/**
 * The path edits a set of drafts stages, skipping what no value can be stored for.
 * @param drafts - the staged drafts, keyed by dotted path.
 * @returns the edits, in the order the drafts were listed.
 */
export function stagedOps(drafts: Readonly<Record<string, SettingDraft>>): readonly ImagineSettingOp[] {
  const ops: ImagineSettingOp[] = []
  for (const [path, draft] of Object.entries(drafts)) {
    if (draft.invalid === true) continue
    const segments = path.split('.')
    if (draft.clear === true) {
      ops.push({ op: 'unset', path: segments })
      continue
    }
    if (draft.value !== undefined) ops.push({ op: 'set', path: segments, value: draft.value })
  }
  return ops
}

/** Whether any staged draft is not a value its field accepts. */
export function hasInvalidDraft(drafts: Readonly<Record<string, SettingDraft>>): boolean {
  return Object.values(drafts).some(draft => draft.invalid === true)
}

/** One workflow configuration field the page shows. */
export interface WorkflowRow {
  /** The key the page stages this row under. */
  readonly key: string
  /** Path from the settings file's root. */
  readonly path: readonly string[]
  /** The field as the workflow entry names it, nested members dotted. */
  readonly label: string
  /** How the control reads and writes the value. */
  readonly kind: FieldKind
}

/** The kind a value asks for, so an untouched field still gets the right control. */
function kindOfField(name: string, value: unknown): FieldKind {
  if (typeof value === 'number') return { kind: 'number' }
  if (typeof value === 'boolean') return { kind: 'flag' }
  if (Array.isArray(value)) return { kind: 'lines' }
  if (name === 'path' || name.endsWith('Path')) return { kind: 'text', pattern: /\.json$/ }
  return { kind: 'text' }
}

/**
 * The fields one workflow's configuration offers, composed and overridden alike.
 *
 * A nested member is shown one level deep, which is where every pin this
 * deployment configures lives (`realism.strength`, `songFrame.field`), and a
 * field the override added is shown even when the profile has never named it.
 * @param key - the workflow key.
 * @param composed - what the profile declares.
 * @param override - what the settings file overrides.
 * @returns the rows, sorted by name.
 */
export function workflowRows(
  key: string,
  composed: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): readonly WorkflowRow[] {
  const rows: WorkflowRow[] = []
  for (const name of [...new Set([...Object.keys(composed), ...Object.keys(override)])].sort()) {
    const composedValue = composed[name]
    const overrideValue = override[name]
    const sample = overrideValue ?? composedValue
    // A list of records (`highInputs`) has no one-line control: it is edited
    // in config.yaml, and a "lines" box would show it empty.
    if (Array.isArray(sample) && sample.some(entry => typeof entry !== 'string')) continue
    if (isPlainObject(sample)) {
      const members = [...new Set([...Object.keys(sample), ...Object.keys(isPlainObject(overrideValue) ? overrideValue : {})])].sort()
      for (const member of members) {
        rows.push({
          key: `workflows.${key}.${name}.${member}`,
          path: ['workflows', key, name, member],
          label: `${name}.${member}`,
          kind: kindOfField(member, Reflect.get(sample, member)),
        })
      }
      continue
    }
    rows.push({
      key: `workflows.${key}.${name}`,
      path: ['workflows', key, name],
      label: name,
      kind: kindOfField(name, sample),
    })
  }
  return rows
}


/** The dotted key one node input is staged under. */
export function nodeFieldKey(node: string, field: string): string {
  return `${node}\u0000${field}`
}

/**
 * The node values a set of drafts asks for, dropping the ones already there.
 * @param drafts - the staged text, keyed by {@link nodeFieldKey}.
 * @param fields - the workflow's editable inputs.
 * @returns the changes to plan, and the keys whose text its field refuses.
 */
export function nodeValueChanges(
  drafts: Readonly<Record<string, string>>,
  fields: readonly WorkflowField[],
): { changes: readonly WorkflowValueChange[]; invalid: readonly string[] } {
  const changes: WorkflowValueChange[] = []
  const invalid: string[] = []
  for (const field of fields) {
    const key = nodeFieldKey(field.node, field.field)
    const text = drafts[key]
    if (text === undefined) continue
    const parsed = parseField(field.kind === 'number' ? { kind: 'number' } : field.kind === 'boolean' ? { kind: 'flag' } : { kind: 'text' }, text)
    // An invalid draft carries no value, so one check answers both.
    const value = parsed.value
    if (value === undefined || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) {
      invalid.push(key)
      continue
    }
    if (value === field.value) continue
    changes.push({ node: field.node, field: field.field, value })
  }
  return { changes, invalid }
}
