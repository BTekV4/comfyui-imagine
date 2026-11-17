/**
 * Whether a slice of the isolated vocals has anything to sing.
 *
 * A music video's shots are cut every ten seconds of the song, and songs have
 * instrumental intros, breaks and outros: the vocal track a shot is given can
 * be silent from end to end. Handed a silent recording marked "fully_copy",
 * H3 does not keep the singer quiet — measured 2026-09-08 on a song with a
 * sixteen-second intro, the first two shots sang with their mouths wide open
 * over nothing. The shot has to be told there is nothing to sing, and it can
 * only be told by looking at the slice first.
 * @module tool-comfy/vocal-silence
 */

import { ffmpegRead } from './media-tools.ts'

/**
 * Below this the vocal track is silence, not singing.
 *
 * The separator leaves a residue of the mix under -40 dBFS where nobody
 * sings; sung notes sit between -10 and -30 dBFS on every track measured.
 */
const SILENCE_DBFS = -40

/** How finely the slice is read, in seconds. */
const STEP_SECONDS = 0.5

/**
 * The share of the slice that may still carry a note before it counts as
 * sung: a single breath or a cut-off syllable at the very edge is not a
 * verse.
 */
const SUNG_SHARE = 0.1

/**
 * Loudness of a slice of a track, one RMS reading per half second.
 * @param path - absolute path of the track.
 * @param start - where the slice starts, in seconds.
 * @param seconds - how long the slice is.
 * @returns dBFS readings, in order; empty when ffmpeg could not read the file.
 */
export async function loudnessOf(path: string, start: number, seconds: number): Promise<readonly number[]> {
  try {
    const { stdout } = await ffmpegRead([
      '-v', 'error',
      '-ss', Math.max(0, start).toFixed(3),
      '-t', Math.max(STEP_SECONDS, seconds).toFixed(3),
      '-i', path,
      '-vn',
      '-af', `aresample=8000,asetnsamples=${String(Math.round(8000 * STEP_SECONDS))},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      '-f', 'null', '-',
    ], 60_000, 4 * 1024 * 1024)
    return parseLoudness(stdout)
  } catch {
    return []
  }
}

/**
 * The RMS readings out of ffmpeg's metadata print.
 * @param stdout - what `ametadata=print:file=-` wrote.
 * @returns the readings in dBFS; `-inf` reads as silence.
 */
function parseLoudness(stdout: string): readonly number[] {
  const readings: number[] = []
  for (const line of stdout.split('\n')) {
    const match = /RMS_level=(-?[\d.]+|-inf|inf)/.exec(line)
    if (match === null) continue
    const value = match[1]
    readings.push(value === '-inf' ? Number.NEGATIVE_INFINITY : value === 'inf' ? 0 : Number(value))
  }
  return readings
}

/**
 * Above this share of a track's isolated vocal the track carries a voice.
 *
 * Measured 2026-11-17 on the 32 isolated vocals the studio had on disk, with the
 * readings {@link voicedShare} builds: the lowest track that carries a voice —
 * a song sung over less than half of its length — comes out at 0.40, the spoken
 * tracks at 0.87-0.89, and the rest between them. Where nobody sings the
 * separator leaves a residue under {@link SILENCE_DBFS}, so an instrumental
 * track lands near zero: the threshold sits in the empty gap between the two.
 * What the number decides is whether a montage cuts its shots or keeps them
 * chained (see `chainedShots` in story-jobs).
 */
export const VOICED_SHARE_MIN = 0.25

/**
 * The share of a track that carries a voice.
 * @param readings - dBFS per half second, as `loudnessOf` returns them.
 * @returns the share of the readings above the silence floor, or undefined when
 *   there are none: a track that could not be read is not known to have no
 *   voice, and the caller treats that as a reason to cut rather than to chain.
 */
export function voicedShare(readings: readonly number[]): number | undefined {
  if (readings.length === 0) return undefined
  return readings.filter(level => level > SILENCE_DBFS).length / readings.length
}

/**
 * Whether these readings are a silent slice.
 * @param readings - dBFS per step, as `loudnessOf` returns them.
 * @returns true when nothing worth singing is in them; false for an empty
 * reading, because a slice that could not be read is not known to be silent.
 */
export function isSilent(readings: readonly number[]): boolean {
  if (readings.length === 0) return false
  const sung = readings.filter(level => level > SILENCE_DBFS).length
  return sung / readings.length <= SUNG_SHARE
}
