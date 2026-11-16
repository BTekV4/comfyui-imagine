/**
 * What the studio needs before it can do anything, as the host reports it.
 *
 * The first-run card in the page reads this: a fresh installation that cannot
 * reach ComfyUI, has no `ffmpeg`, or has no model configured used to look like
 * a page that simply does not answer. The checks belong to the host (it is the
 * one that has a filesystem, a PATH and a ComfyUI client); the sentences
 * belong to the page, so the `problem` is a code and not a phrase — see
 * `imagine.setup.*` in the page's dictionary.
 * @module shared/setup-status
 */

/** Why one check failed, as a code the page translates. */
export type SetupProblem =
  | 'node-old'
  | 'ffmpeg-missing'
  | 'comfy-unreachable'
  | 'comfy-http'
  | 'no-model'
  | 'provider-missing'
  | 'output-missing'

/** One check: whether it passed, why not, and what it found when it did. */
export interface SetupCheck {
  readonly ok: boolean
  /** The code of the failure; absent when `ok`. */
  readonly problem?: SetupProblem
  /**
   * The host's own words for a failure (`ENOENT`, `HTTP 404`, the URL it
   * tried): shown under the sentence, because it is what a search needs.
   */
  readonly detail?: string
}

/** A device as ComfyUI reports it, so the card can say what card it found. */
export interface SetupDevice {
  readonly name: string
  /** VRAM in bytes, when ComfyUI says it. */
  readonly vramTotal?: number
}

/** The whole report: every check the page draws one row for. */
export interface SetupStatus {
  /** Every check passed. */
  readonly ok: boolean
  /** The studio's own version, as `package.json` declares it. */
  readonly version?: string
  readonly node: SetupCheck & { readonly minimum: string; readonly found: string }
  readonly ffmpeg: SetupCheck
  readonly comfy: SetupCheck & {
    /** The address the studio is configured with, reachable or not. */
    readonly url: string
    /** ComfyUI's own version, when it answered. */
    readonly comfyVersion?: string
    readonly devices?: readonly SetupDevice[]
  }
  readonly model: SetupCheck & {
    readonly provider?: string
    readonly id?: string
  }
  readonly output: SetupCheck & { readonly dir: string }
}
