/**
 * What the settings page reads from the host: the layers of the settings
 * (GET /comfy-imagine/settings) and one workflow's editable inputs
 * (GET /comfy-imagine/workflows/<key>). The server builds both with
 * `satisfies` these types, so a field renamed on one side fails to compile
 * on the other.
 * @module imagine-settings-view
 */

import type { WorkflowField } from './imagine-chat.ts'

/** One workflow's editable inputs and pin warnings (GET /comfy-imagine/workflows/<key>). */
export interface WorkflowDetail {
  readonly key: string
  readonly label: string
  readonly file: string
  readonly fields: readonly WorkflowField[]
  /** Pins the profile declares that the graph no longer carries. */
  readonly warnings: readonly string[]
  /**
   * True when the graph was changed inside the app and the user's copy wins
   * over the one that ships with the program: only then is there a copy to
   * throw away, and the updates of that file are not reaching this graph.
   */
  readonly overridden: boolean
}

/** One workflow's configuration in the layer the page reads it from. */
export interface WorkflowSettingsEntry {
  /** The configuration entry name. */
  readonly key: string
  /** The key the studio addresses this workflow by, when it has a loaded graph. */
  readonly listedKey?: string
  /** The label the studio shows for it. */
  readonly label?: string
  readonly configured: boolean
  readonly path?: string
  readonly file?: string
  /**
   * True when this action's graph was changed inside the app and the user's
   * copy wins over the one that ships with the program. Always false in an
   * installation whose program is writable: there is no copy to speak of.
   */
  readonly overridden: boolean
  /** What the profile declares. */
  readonly composed: Readonly<Record<string, unknown>>
  /** What the settings file overrides. */
  readonly override: Readonly<Record<string, unknown>>
}

/** The ComfyUI connection as one of the three layers holds it. */
export interface ComfyConnectionView {
  readonly baseURL: string
  readonly timeoutMs: number
  readonly pollIntervalMs: number
  readonly pathStyle: 'auto' | 'posix' | 'nt'
  readonly preview: boolean
  readonly restartCommand?: readonly string[]
  readonly restartReadyMs: number
}

/** The connection fields the settings file may override; absent means "as composed". */
export type ComfyConnectionOverride = Partial<ComfyConnectionView>

/** Everything the settings page renders (GET /comfy-imagine/settings). */
export interface ImagineSettingsView {
  /** Path of the settings file the page writes. */
  readonly path: string
  /** True when the file holds changes this process has not loaded yet. */
  readonly pendingRestart: boolean
  /** Why the file was refused at boot, when it was. */
  readonly appliedProblem?: string
  /** Why the file is refused now, when it is. */
  readonly fileProblem?: string
  readonly server: {
    readonly composed: ComfyConnectionView
    readonly override: ComfyConnectionOverride
    readonly running: ComfyConnectionView
    readonly canRestart: boolean
  }
  readonly output: {
    readonly composed: string
    readonly running: string
    readonly override?: string
  }
  readonly workflows: readonly WorkflowSettingsEntry[]
  readonly inventory: readonly { readonly key: string; readonly label: string; readonly file: string }[]
}
