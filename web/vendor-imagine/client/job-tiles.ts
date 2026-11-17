/**
 * Which live jobs claim a tile of their own on the board.
 *
 * Almost all of them do: a job is a thing the user is waiting for, and the
 * board is where waiting happens. The exception is a story's preparation job —
 * the one that holds the queue's place while the track's voice is measured —
 * which has no file to draw until the shots it queues exist. Drawn anyway, it
 * was an empty frame the user watched for the length of the measurement
 * (measured 2026-11-17).
 *
 * Only that job is hidden. A job in error keeps its tile even with no files:
 * the tile is where the failure is said.
 * @module job-tiles
 */

/** What {@link claimsTile} reads of a job. */
export interface TileJob {
  readonly action: string
  readonly status: string
  readonly files?: readonly { readonly name: string }[]
}

/**
 * Whether this job is drawn as a tile of its own.
 * @param job - the job, as the queue holds it.
 * @returns false only for a story's preparation job that has nothing to show.
 */
export function claimsTile(job: TileJob): boolean {
  if (job.action !== 'story' || job.status === 'error') return true
  return (job.files?.length ?? 0) > 0
}
