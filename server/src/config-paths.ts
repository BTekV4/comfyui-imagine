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
 *
 * The files the **program** owns — the page's build, the graphs an action runs,
 * the persona — are read from `IMAGINE_PROGRAM_DIR` when the studio runs from
 * a read-only package (the desktop app wraps them in the AppImage and keeps
 * `config.yaml` and the media in the user's folder): see {@link programAsset}.
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
 * A path the **program** owns, not the user: the page's build, a graph an
 * action runs, the persona the prompts describe.
 *
 * A relative path is read from the program's folder when the studio runs from
 * a read-only package (`IMAGINE_PROGRAM_DIR`), and from the config's folder
 * otherwise — which is the same folder in every installation made until now,
 * where the config sits beside `dist/`, `workflows/` and `persona/`. An
 * absolute path is taken as written in both cases: a graph the user keeps
 * elsewhere is not the program's.
 *
 * The folder the media lands in is **not** read this way: that one is the
 * user's, and `./data/outputs` must stay inside the data folder (see
 * {@link anchoredToolComfy}).
 * @param programDir - `IMAGINE_PROGRAM_DIR`, when set.
 * @param configPath - the config file's path.
 * @param value - the path as written.
 * @returns the absolute path.
 */
export function programAsset(programDir: string | undefined, configPath: string, value: string): string {
  if (isAbsolute(value) || programDir === undefined) return absoluteFrom(configPath, value)
  return resolve(programDir, value)
}

/**
 * The `toolComfy` block with its file paths anchored.
 *
 * A workflow `path:` or `pathHigh:` that is a virtual `custom:<id>` is left
 * verbatim: it is not a file, and the loader needs to see the prefix to find
 * the graph. The graphs and the persona come from the program when it is
 * packaged; `outputDir` always comes from the config, because it is the
 * folder the user's media lands in.
 * @param configPath - the config file's path.
 * @param block - the `toolComfy` section as written.
 * @param programDir - the read-only program folder, when there is one.
 * @returns the same block with its file paths resolved.
 */
export function anchoredToolComfy(configPath: string, block: Record<string, unknown>, programDir?: string): Record<string, unknown> {
  const absolute = (value: string): string => absoluteFrom(configPath, value)
  const asset = (value: string): string => programAsset(programDir, configPath, value)
  const out: Record<string, unknown> = { ...block }
  if (typeof out.outputDir === 'string') out.outputDir = absolute(out.outputDir)
  const persona = out.persona as { path?: unknown } | undefined
  if (typeof persona?.path === 'string') out.persona = { ...persona, path: asset(persona.path) }
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
          anchored[field] = isVirtualWorkflowPath(value) ? value : asset(value)
        }
      }
      return [key, anchored]
    }))
  }
  return out
}
