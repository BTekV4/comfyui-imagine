/**
 * What a music video was made of, kept after the jobs are gone.
 *
 * A montage's shots are jobs, and jobs live thirty minutes in memory: once
 * they are gone the finished video is just a file, and so is every shot. The
 * user asked for the obvious thing — "redo only the 10-second part I'd
 * like to redo and then re-cut the whole video" — and for that the studio
 * has to remember, for every shot, the photo it started from, the beat it
 * was given, its seconds of the song, the latent slot it continued from and
 * the file it produced. That is this record, one JSON per story under
 * `<data home>/comfy/stories/`.
 *
 * The shots are also named for the user: `videoclip-<label>-03of10.mp4`
 * rather than `create_video-<hash>.mp4`, so a shot can be told apart on the
 * board and asked for by number in the chat.
 * @module tool-comfy/story-manifest
 */

import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { serialized, writeFileAtomic } from '../atomic-write/index.ts'
import { dataPath } from '../home-paths/index.ts'
import type { ComfyChainLink } from './index.ts'
import { mapWithConcurrency } from './media-tools.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'

/** One shot of a montage, as it was rendered. */
export interface StoryShotRecord {
  /** Its position, from 0. */
  readonly index: number
  /** The seconds it was asked for. */
  readonly seconds: number
  /** The second of the track it sings from. */
  readonly songStart?: number
  /** The photo it was generated from, once the plan settled it. */
  readonly source?: string
  /** The beat the director wrote for it, as the sampler was told. */
  readonly prompt?: string
  /** Its place in the chain of latents, when the shots continue each other. */
  readonly chain?: ComfyChainLink
  /** The file it produced, once it did. */
  readonly file?: string
  /**
   * How well its mouth followed the voice, 0-1, when a probe measured it.
   *
   * The correlation at zero lag between the mouth's aperture and the vocal's
   * loudness. Measured on the 2c6807 videoclip: 0.19 on a shot whose lips
   * ran a second off, 0.47-0.54 on shots that sang in time.
   */
  readonly lipsync?: number
}

/** One music video: its parts and how they were cut together. */
export interface StoryManifest {
  readonly storyId: string
  /** Six characters of the id, the part the file names carry. */
  readonly label: string
  readonly createdAt: number
  /** The music video this story is the montage of, when it was one. */
  readonly clipId?: string
  /** The track laid over the cut. */
  readonly song?: string
  /** The photos, in the order they were given. */
  readonly sources: readonly string[]
  readonly aspectRatio?: string
  readonly megapixels?: number
  readonly model?: ModelRoute
  readonly shots: readonly StoryShotRecord[]
  /** The finished video, latest version first. */
  readonly finals: readonly string[]
  /**
   * How many times the studio has queued this story's own missing shots to
   * close a hole in the cut. Bounded, so a shot that can never render cannot
   * put the card in a loop; reset to zero by a cut that comes out whole.
   */
  readonly repairs?: number
}

/**
 * Where the stories live.
 * @returns the absolute directory holding one JSON per story.
 */
export function storiesDir(): string {
  return dataPath('comfy', 'stories')
}

/**
 * Path of one story's record.
 * @param storyId - the story.
 * @returns an absolute path under the data home.
 */
function storyManifestPath(storyId: string): string {
  return join(storiesDir(), `${storyId}.json`)
}

/** The six characters of a story id that name its files. */
export function storyLabel(storyId: string): string {
  return storyId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()
}

/**
 * The file name a shot is delivered under.
 * @param label - the story's label.
 * @param index - the shot's position, from 0.
 * @param count - how many shots the story has.
 * @param version - which rendering of this shot; the first has none.
 * @returns e.g. `videoclip-a1b2c3-03of10.mp4`.
 */
export function shotFileName(label: string, index: number, count: number, version = 1): string {
  const width = Math.max(2, String(count).length)
  const n = String(index + 1).padStart(width, '0')
  const total = String(count).padStart(width, '0')
  return `videoclip-${label}-${n}of${total}${version > 1 ? `-v${String(version)}` : ''}.mp4`
}

/**
 * The file name the finished video is delivered under.
 * @param label - the story's label.
 * @param version - which cut; the first has none.
 * @returns e.g. `videoclip-a1b2c3.mp4`, then `videoclip-a1b2c3-v2.mp4`.
 */
export function finalFileName(label: string, version = 1): string {
  return `videoclip-${label}${version > 1 ? `-v${String(version)}` : ''}.mp4`
}

/**
 * The shot number a delivered file name carries, when it is a shot.
 * @param name - a gallery basename.
 * @returns the story label, the shot's position from 0, the count and the rendering's version (1 when unnumbered).
 */
export function shotOfFileName(name: string): { label: string; index: number; count: number; version: number } | undefined {
  /*
   * The version suffix repeats: a shot redone twice is `-v2-3.mp4`, because
   * every redo appends its own version instead of replacing the last. A
   * pattern accepting one suffix reads that name as "not a shot", so redoing
   * an already-redone shot dies with a 400 and the shot stays out of time in
   * the cut (seen 2026-09-21: wave 2 refused every file it was handed).
   */
  const match = /^videoclip-([a-z0-9]{1,8})-(\d+)of(\d+)((?:-v?\d+)*)\.mp4$/i.exec(name)
  if (match === null) return undefined
  const index = Number(match[2]) - 1
  const count = Number(match[3])
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(count) || count <= index) return undefined
  // The last number the name carries is which cut this file is; the earlier
  // ones are history. A redo appends a bare `-N` when the previous file was
  // already versioned, so both `-v2` and `-3` count.
  const suffix = match[4] ?? ''
  const versions = [...suffix.matchAll(/-v?(\d+)/g)].map(entry => Number(entry[1]))
  const version = versions.length === 0 ? 1 : Math.max(...versions)
  return { label: (match[1] ?? '').toLowerCase(), index, count, version }
}

/**
 * Read one story's record.
 * @param storyId - the story.
 * @returns the record, or undefined when there is none or it is unreadable.
 */
export async function readStoryManifest(storyId: string): Promise<StoryManifest | undefined> {
  try {
    return sanitize(JSON.parse(await readFile(storyManifestPath(storyId), 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

/**
 * Write one story's record whole.
 * @param manifest - the record.
 */
export async function writeStoryManifest(manifest: StoryManifest): Promise<void> {
  await mkdir(storiesDir(), { recursive: true, mode: 0o700 })
  const path = storyManifestPath(manifest.storyId)
  await serialized(path, async () => {
    await writeFileAtomic(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600, dirMode: 0o700 })
  })
  storyByLabel.set(manifest.label, manifest.storyId)
}

/**
 * Change one story's record in place, under its lock.
 * @param storyId - the story.
 * @param edit - produces the record to write from the one on disk.
 * @returns the record as written, or undefined when there was none.
 */
export async function updateStoryManifest(
  storyId: string,
  edit: (manifest: StoryManifest) => StoryManifest,
): Promise<StoryManifest | undefined> {
  const path = storyManifestPath(storyId)
  return serialized(path, async () => {
    const current = await readStoryManifest(storyId)
    if (current === undefined) return undefined
    const next = edit(current)
    await writeFileAtomic(path, `${JSON.stringify(next)}\n`, { mode: 0o600, dirMode: 0o700 })
    return next
  })
}

/**
 * Change one shot of a story's record.
 * @param storyId - the story.
 * @param index - the shot.
 * @param patch - the fields to set.
 * @returns the record as written, or undefined when there was none.
 */
export async function updateStoryShot(
  storyId: string,
  index: number,
  patch: Partial<StoryShotRecord>,
): Promise<StoryManifest | undefined> {
  return updateStoryManifest(storyId, manifest => ({
    ...manifest,
    shots: manifest.shots.map(shot => (shot.index === index ? { ...shot, ...patch } : shot)),
  }))
}

/**
 * The story a delivered file belongs to, by the label in its name.
 * @param name - a gallery basename, a shot or a finished cut.
 * @returns the record, or undefined when no story carries that label.
 */
export async function findStoryByFile(name: string): Promise<StoryManifest | undefined> {
  const label = shotOfFileName(name)?.label ?? /^videoclip-([a-z0-9]{1,8})(?:-v\d+)?\.mp4$/i.exec(name)?.[1]?.toLowerCase()
  if (label === undefined) return undefined
  const known = storyByLabel.get(label)
  if (known !== undefined) {
    const manifest = await readStoryManifest(known)
    if (manifest?.label === label) return manifest
  }
  // Not indexed yet (a story written by another process, or before the first
  // look): read every record once and index them all.
  let entries: string[]
  try {
    entries = await readdir(storiesDir())
  } catch {
    return undefined
  }
  // A few at a time, and in the directory's order: the first match still wins.
  const manifests = await mapWithConcurrency(entries.filter(entry => entry.endsWith('.json')), MANIFEST_READS,
    async entry => readStoryManifest(entry.slice(0, -'.json'.length)))
  let found: StoryManifest | undefined
  for (const manifest of manifests) {
    if (manifest === undefined) continue
    storyByLabel.set(manifest.label, manifest.storyId)
    if (manifest.label === label) found ??= manifest
  }
  return found
}

/** How many story records the index read opens at once. */
const MANIFEST_READS = 8

/**
 * Which story carries which label, filled as records are read and written.
 *
 * Looking a file up read every story record in turn (35 on 2026-10-20) each
 * time a shot or a cut was opened.
 */
const storyByLabel = new Map<string, string>()

/** Keep only a well-formed record. */
function sanitize(value: unknown): StoryManifest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.storyId !== 'string' || record.storyId.length === 0) return undefined
  if (!Array.isArray(record.shots) || !Array.isArray(record.sources)) return undefined
  const shots = record.shots.flatMap((shot): StoryShotRecord[] => {
    if (typeof shot !== 'object' || shot === null) return []
    const entry = shot as Record<string, unknown>
    if (typeof entry.index !== 'number' || typeof entry.seconds !== 'number') return []
    const chain = entry.chain as { folder?: unknown; index?: unknown } | undefined
    return [{
      index: entry.index,
      seconds: entry.seconds,
      ...typeof entry.songStart === 'number' ? { songStart: entry.songStart } : {},
      ...typeof entry.source === 'string' ? { source: entry.source } : {},
      ...typeof entry.prompt === 'string' ? { prompt: entry.prompt } : {},
      ...typeof entry.file === 'string' ? { file: entry.file } : {},
      ...typeof entry.lipsync === 'number' && Number.isFinite(entry.lipsync) ? { lipsync: entry.lipsync } : {},
      ...typeof chain?.folder === 'string' && typeof chain.index === 'number'
        ? { chain: { folder: chain.folder, index: chain.index } }
        : {},
    }]
  })
  const model = record.model as { provider?: unknown; model?: unknown } | undefined
  return {
    storyId: record.storyId,
    label: typeof record.label === 'string' ? record.label : storyLabel(record.storyId),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    ...typeof record.clipId === 'string' ? { clipId: record.clipId } : {},
    ...typeof record.song === 'string' ? { song: record.song } : {},
    sources: record.sources.filter((name): name is string => typeof name === 'string'),
    ...typeof record.aspectRatio === 'string' ? { aspectRatio: record.aspectRatio } : {},
    ...typeof record.megapixels === 'number' ? { megapixels: record.megapixels } : {},
    ...typeof model?.provider === 'string' && typeof model.model === 'string'
      ? { model: { provider: model.provider, model: model.model } }
      : {},
    shots,
    finals: Array.isArray(record.finals) ? record.finals.filter((name): name is string => typeof name === 'string') : [],
    // Kept, or the repair bound never holds: every read used to drop it, so a
    // shot that could never render was queued again after every failed cut.
    ...typeof record.repairs === 'number' && Number.isFinite(record.repairs) ? { repairs: record.repairs } : {},
  }
}
