/**
 * Where a music video that stopped halfway picks up again.
 *
 * A montage is one job per shot, queued together, and the queue is what is
 * lost when the host restarts or when every shot after some point fails on
 * the same mistake: the finished shots stay on disk, numbered, with their
 * latents on the card. Rendering the whole video again for them was the only
 * offer the studio had ("I can't resume an interrupted chain
 * halfway"). This plans the other thing: keep every shot that is there,
 * drop the shots the song no longer needs, render what is missing in order
 * and cut the video together at the end.
 * @module tool-comfy/story-resume
 */

import { shotFileName, shotOfFileName, type StoryManifest, type StoryShotRecord } from './story-manifest.ts'

/** What it takes to finish a stopped story. */
export interface ResumePlan {
  /** The shots kept, renumbered from 0; a rendered one carries its file. */
  readonly shots: readonly StoryShotRecord[]
  /** The new indexes of the shots still to render, in order. */
  readonly pending: readonly number[]
  /** Old file name to new, for rendered shots whose number changed. */
  readonly renames: Readonly<Record<string, string>>
}

/**
 * A shot's slice of the song starts past the end of the track: nothing to
 * sing, nothing to show. Half a second of slack for a probe's rounding.
 */
const SONG_SLACK_SECONDS = 0.5

/**
 * Plan the rest of a story from what is on disk.
 *
 * A rendered shot is kept whatever the song says: it was cut into the
 * timeline already, and the final cut is trimmed to the track. A missing shot
 * whose slice of the song starts after the track ends is dropped: the plan
 * was made for a longer song than the one that came back. A missing shot the
 * song still needs is rendered again, continuing the latent the shot before
 * it saved.
 * @param manifest - the story's record.
 * @param present - the shot files that are on disk.
 * @param songSeconds - the track's real length, when the story has one.
 * @returns the shots to keep and the ones to render.
 */
export function resumePlan(
  manifest: StoryManifest,
  present: ReadonlySet<string>,
  songSeconds?: number,
): ResumePlan {
  const ordered = [...manifest.shots].sort((a, b) => a.index - b.index)
  const rendered = (shot: StoryShotRecord): boolean => shot.file !== undefined && present.has(shot.file)
  const kept = ordered.filter(shot => rendered(shot)
    || songSeconds === undefined
    || shot.songStart === undefined
    || shot.songStart < songSeconds - SONG_SLACK_SECONDS)
  const count = kept.length
  const renames: Record<string, string> = {}
  const pending: number[] = []
  const shots = kept.map((shot, index): StoryShotRecord => {
    const previous = kept[index - 1]
    if (rendered(shot)) {
      const file = shot.file ?? ''
      const named = shotOfFileName(file)
      const renamed = named === undefined || (shot.index === index && named.count === count)
        ? file
        : shotFileName(manifest.label, index, count, named.version)
      if (renamed !== file) renames[file] = renamed
      return { ...shot, index, file: renamed }
    }
    pending.push(index)
    const { file: _file, chain: _chain, ...rest } = shot
    // The latent to continue is the one the shot before saved, under ITS
    // number in the chain: the folder is numbered by the original plan. The
    // first shot loads nothing and saves into slot 1.
    const chain = shot.chain === undefined
      ? undefined
      : { folder: shot.chain.folder, index: previous === undefined ? 0 : (previous.chain?.index ?? previous.index) + 1 }
    return { ...rest, index, ...chain === undefined ? {} : { chain } }
  })
  return { shots, pending, renames }
}
