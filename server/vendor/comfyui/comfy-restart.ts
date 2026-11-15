/**
 * What the ComfyUI client does when the server is out of memory, away, or
 * still running work a previous process left behind: the restart command, the
 * wait for the server to answer again, and the sweep of orphaned runs.
 *
 * Kept apart from the transport in `index.ts`: the client hands these
 * functions the few requests they need, so they hold no connection of their own.
 * @module comfyui/comfy-restart
 */

import { spawn } from 'node:child_process'
import { CLIENT_ID_PREFIX } from './progress.ts'
import { ComfyError } from './types.ts'

/** How long the restart command may take before its caller gives up on it. */
export const RESTART_COMMAND_TIMEOUT_MS = 60_000

/**
 * How many times {@link dropOrphanRuns} re-reads the queue before it stops.
 * One pass is not enough: the server promotes a waiting run the moment the one
 * before it goes, and deleting by id only removes what is still waiting.
 */
const ORPHAN_SWEEP_PASSES = 4

/**
 * Whether a ComfyUI execution error is the card running out of memory.
 *
 * Matched on the exception text because ComfyUI reports every node failure
 * the same way, with the Python message as the only distinguishing fact.
 * @param message - the exception message from the history record.
 * @returns true when the run failed for want of VRAM.
 */
export function isOutOfMemory(message: string): boolean {
  // "VRAM grow failed" / "VRAM Allocation failed" are ComfyUI's dynamic-VRAM
  // allocator (comfy_aimdo) running out, which it reports without the words
  // "out of memory": unrecognised, it failed a shot and every shot after it.
  return /out of memory|exceed allowed memory|CUDA error: out of memory|VRAM (grow|allocation) failed/i.test(message)
}

/**
 * Wait a while, or less when the signal aborts first.
 *
 * Resolves either way: the caller's loop checks the signal and says why it
 * stopped, which a rejection here would hide behind a generic abort.
 * @param ms - how long to wait.
 * @param signal - the run's cancellation and deadline.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Run one restart argv and wait for the command itself to exit.
 *
 * The argv is passed to the process as written, never through a shell.
 * @param argv - the command and its arguments.
 * @param signal - cancellation; aborting stops waiting on the command.
 * @throws {ComfyError} when the command cannot run or exits non-zero.
 */
export async function spawnRestart(argv: readonly string[], signal: AbortSignal): Promise<void> {
  const [command, ...args] = argv
  if (command === undefined) return
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', signal })
    child.on('error', (error) => {
      reject(new ComfyError(`ComfyUI restart could not run: ${String(error)}`, 'COMFY_UNREACHABLE', { cause: error }))
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new ComfyError(`ComfyUI restart exited with ${String(code)}`, 'COMFY_UNREACHABLE'))
    })
  })
}

/**
 * Wait until ComfyUI answers again.
 *
 * Used after a restart and after an absence: both are the same question,
 * and a busy server answers as soon as it is done loading.
 * @param answers - one status probe; true when the server answered.
 * @param readyMs - the readiness window.
 * @param pollMs - the pause between probes.
 * @param signal - cancellation, which ends the wait immediately.
 * @throws {ComfyError} when the readiness window passes with no answer.
 */
export async function waitUntilReady(
  answers: (signal: AbortSignal) => Promise<boolean>,
  readyMs: number,
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  const until = Date.now() + readyMs
  for (;;) {
    if (signal.aborted) throw new ComfyError('ComfyUI wait aborted', 'COMFY_WAIT_FAILED')
    try {
      if (await answers(signal)) return
    } catch {
      // Still not answering: loading a model, or not listening at all.
    }
    if (Date.now() > until) {
      throw new ComfyError('ComfyUI did not answer', 'COMFY_UNREACHABLE')
    }
    await sleep(pollMs, signal)
  }
}

/** The requests the orphan sweep makes, lent by the client. */
export interface OrphanQueue {
  /** Read the running and waiting rows of `/queue`. */
  readonly read: (signal?: AbortSignal) => Promise<{ running: readonly unknown[]; pending: readonly unknown[] }>
  /** Remove one waiting prompt by id. */
  readonly deletePending: (promptId: string, signal?: AbortSignal) => Promise<unknown>
  /** Stop one prompt, if it is the one executing. */
  readonly interrupt: (promptId: string, signal?: AbortSignal) => Promise<unknown>
}

/**
 * Throw away the runs a previous process of this harness left executing.
 *
 * The host holds its job queue in memory and serves one job at a time, so a
 * restart in the middle of a run leaves ComfyUI computing something nobody
 * will ever collect — and, worse, the resumed story queues that same shot
 * again behind it. On 2026-09-09 the duplicate is what wedged: the orphan
 * finished into the void at 07:05 and its twin sat in the sampler until the
 * kernel killed the server nine hours later.
 *
 * Only ours, and only the dead ones: an entry is dropped when its
 * `extra_data.client_id` carries {@link CLIENT_ID_PREFIX} and is not the id
 * this process submits under. A prompt queued by a person on ComfyUI's own
 * page has no such id and is left exactly where it is — the same scruple the
 * out-of-memory restart keeps.
 * @param queue - the client's queue requests.
 * @param mine - the client id this process submits under, when it tracks one.
 * @param signal - optional caller cancellation.
 * @returns how many runs were dropped; zero when there was nothing of ours.
 */
export async function dropOrphanRuns(queue: OrphanQueue, mine: string | undefined, signal?: AbortSignal): Promise<number> {
  const orphan = (entry: unknown): string | undefined => {
    // A queue row is [number, prompt_id, prompt, extra_data, outputs] —
    // confirmed against a live server, five columns with the client id
    // where the submit put it.
    if (!Array.isArray(entry)) return undefined
    const row: readonly unknown[] = entry
    const promptId = row[1]
    const extra = row[3]
    if (typeof promptId !== 'string' || typeof extra !== 'object' || extra === null) return undefined
    const client = (extra as { client_id?: unknown }).client_id
    if (typeof client !== 'string' || client === mine) return undefined
    if (!client.startsWith(CLIENT_ID_PREFIX)) return undefined
    return promptId
  }
  const dropped = new Set<string>()
  /*
   * The queue moves while it is being read: measured on a live server,
   * deleting seven pending runs promoted an eighth to running between the
   * snapshot and the deletes, and it survived the pass — deleting by id
   * only removes what is still waiting. A few passes settle it; the bound
   * is there so a server that keeps handing out work cannot hold the boot.
   */
  for (let pass = 0; pass < ORPHAN_SWEEP_PASSES; pass++) {
    let rows: { running: readonly unknown[]; pending: readonly unknown[] }
    try {
      rows = await queue.read(signal)
    } catch {
      // A server that cannot be read has nothing to clean up here; the run
      // that needs it will meet the same server and say so.
      break
    }
    const running = rows.running.map(entry => orphan(entry)).filter(id => id !== undefined)
    const pending = rows.pending.map(entry => orphan(entry)).filter(id => id !== undefined)
    if (running.length === 0 && pending.length === 0) break
    for (const promptId of pending) {
      dropped.add(promptId)
      await queue.deletePending(promptId, signal).catch(() => undefined)
    }
    // The interrupt names the prompt and is sent only while it is the one
    // executing: ComfyUI is shared, and a bare `/interrupt` would end whatever
    // is running, whoever queued it.
    for (const promptId of running) {
      dropped.add(promptId)
      await queue.interrupt(promptId, signal).catch(() => undefined)
    }
  }
  return dropped.size
}
