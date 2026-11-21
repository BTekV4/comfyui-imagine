/**
 * What one turn has already tried, and what its checks found.
 *
 * A turn may run the same request three times at most, may not repeat a set of
 * parameters that already failed, and must build its reply on the verdicts its
 * checks produced rather than on what it remembers intending (2026-11-21).
 * The board lives beside the turn, not in the model: a model that forgets is
 * the reason the guard is here at all.
 * @module tool-comfy/run-attempts
 */

import type { RunAttempt } from './edit-spec.ts'
import type { Verdict } from './edit-verify.ts'

/** The attempts and verdicts of one turn. */
export interface TurnAttempts {
  /** Every attempt so far, oldest first. */
  readonly list: () => readonly RunAttempt[]
  /** Files one attempt, before or after it runs. */
  readonly add: (attempt: RunAttempt) => void
  /** Gives the last attempt of a key and fingerprint its outcome. */
  readonly mark: (key: string, fingerprint: string, state: RunAttempt['state'], why?: string) => void
  /** The files earlier attempts of this key made. */
  readonly filesOf: (key: string) => readonly string[]
  /** The last attempt of this key a check accepted, when there is one. */
  readonly lastKept: (key: string) => RunAttempt | undefined
  /** Remembers that a file came from this key's attempt. */
  readonly keepFile: (key: string, file: string) => void
  /** The verdicts the checks produced, oldest first. */
  readonly verdicts: () => readonly Verdict[]
  /** Files one check's verdict. */
  readonly keepVerdict: (verdict: Verdict) => void
}

/**
 * A fresh board for one turn.
 * @returns the board the tools write to and the report reads.
 */
export function createAttempts(): TurnAttempts {
  const attempts: RunAttempt[] = []
  const files = new Map<string, string[]>()
  const verdicts: Verdict[] = []
  return {
    list: () => attempts,
    add: attempt => { attempts.push(attempt) },
    mark: (key, fingerprint, state, why) => {
      for (let index = attempts.length - 1; index >= 0; index -= 1) {
        const attempt = attempts[index]
        if (attempt === undefined || attempt.key !== key || attempt.fingerprint !== fingerprint) continue
        attempts[index] = { ...attempt, state, ...why === undefined ? {} : { why } }
        return
      }
    },
    filesOf: key => files.get(key) ?? [],
    lastKept: key => [...attempts].reverse().find(attempt => attempt.key === key && attempt.state === 'kept'),
    keepFile: (key, file) => {
      const seen = files.get(key) ?? []
      if (!seen.includes(file)) files.set(key, [...seen, file])
    },
    verdicts: () => verdicts,
    keepVerdict: verdict => { verdicts.push(verdict) },
  }
}
