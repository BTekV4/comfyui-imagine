/**
 * Paths written in the config file: resolved against the file itself, not
 * against the folder the process is launched from, except for virtual
 * prefixes.
 *
 * Needed since a `path:` may not be a file: `custom:<id>` is the graph of a
 * personal workflow, which the loader reads from
 * `<data>/custom-workflows/<id>/graph.json`. Anchoring it like a relative
 * path turned it into `<config folder>/custom:<id>`, the loader no longer
 * recognised it as virtual and boot died with ENOENT (measured on 4-11-2026
 * while migrating the first personal entries).
 * @module config-paths
 */

import { dirname, isAbsolute, resolve } from 'node:path'
import { isCustomPath } from '../vendor/tool-comfy/custom-workflows.ts'

/**
 * True when the path is a virtual one the loader resolves itself.
 *
 * The `custom:` rule has one owner, `custom-workflows.ts`; any id is left
 * verbatim here, so a malformed one reaches the loader and is refused there
 * by name instead of being anchored into a file path.
 * @param value - the path as written.
 * @returns true for a `custom:` path.
 */
export function isVirtualWorkflowPath(value: string): boolean {
  return isCustomPath(value)
}

/**
 * A config-file path, anchored to the file's folder.
 * @param configPath - the config file's path.
 * @param value - the path as written.
 * @returns the absolute path, or the value when it already is one.
 */
export function absoluteFrom(configPath: string, value: string): string {
  return isAbsolute(value) ? value : resolve(dirname(resolve(configPath)), value)
}

/**
 * The `toolComfy` block with its file paths anchored to the config file.
 *
 * A workflow `path:` or `pathHigh:` that is a virtual `custom:<id>` is left
 * verbatim: it is not a file, and the loader needs to see the prefix to find
 * the graph.
 * @param configPath - the config file's path.
 * @param block - the `toolComfy` section as written.
 * @returns the same block with its file paths resolved.
 */
export function anchoredToolComfy(configPath: string, block: Record<string, unknown>): Record<string, unknown> {
  const absolute = (value: string): string => absoluteFrom(configPath, value)
  const out: Record<string, unknown> = { ...block }
  if (typeof out.outputDir === 'string') out.outputDir = absolute(out.outputDir)
  const persona = out.persona as { path?: unknown } | undefined
  if (typeof persona?.path === 'string') out.persona = { ...persona, path: absolute(persona.path) }
  const workflows = out.workflows
  if (typeof workflows === 'object' && workflows !== null && !Array.isArray(workflows)) {
    out.workflows = Object.fromEntries(Object.entries(workflows as Record<string, unknown>).map(([key, entry]) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [key, entry]
      // `pathHigh` is the same kind of file as `path` (the graph a `slow` or
      // `high` run picks instead), so it is anchored by the same rule.
      const anchored: Record<string, unknown> = { ...entry }
      for (const field of ['path', 'pathHigh'] as const) {
        const value = (entry as Record<string, unknown>)[field]
        if (typeof value === 'string' && value !== '') {
          anchored[field] = isVirtualWorkflowPath(value) ? value : absolute(value)
        }
      }
      return [key, anchored]
    }))
  }
  return out
}
