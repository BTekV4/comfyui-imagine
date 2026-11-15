/**
 * Imagine studio HTTP client: gallery inventory, job queue, and generate /
 * remix / video starts over same-origin `/comfy-media` and `/comfy-imagine`.
 * @module gallery-api
 */

import { failureOf, getJson, getJsonRevalidating, postJson, readJson, request, send } from './http.ts'
import { translate } from './locale-store.ts'
import type {
  GalleryItem, ImagineAction, ImagineJobView as ImagineJob, ImagineObjectMode, ImaginePlacement, ImagineRegion,
  ImagineSettingOp, MediaTag, ModelRoute, MusicClipPlan,
  MusicClipRequest,
} from '../../../shared/imagine-types.ts'
import type {
  ImagineChatAsk, ImagineChatEvent, ImagineChatReply, WorkflowDiff, WorkflowPlan, WorkflowValueChange,
} from '../../../shared/imagine-chat.ts'
import type { CanvasRect, ImagineProject, ImagineRemovals } from '../../../shared/imagine-projects.ts'
import type { SocialComment, SocialCommentPass, SocialPost, SocialPostKind, SocialStory } from '../../../shared/social-types.ts'

/**
 * Fetch the Imagine inventory from GET /comfy-media.
 * @returns the gallery items, newest first.
 * @throws when the answer is not an inventory: a body without an `items` list
 *   is a response from something other than the gallery, not an empty gallery.
 */
export async function fetchGallery(): Promise<readonly GalleryItem[] | undefined> {
  const body = await getJsonRevalidating<{ items?: GalleryItem[] }>('/comfy-media', 'gallery')
  // 304: the inventory is the one the caller already holds, and there is
  // nothing to replace it with.
  if (body === undefined) return undefined
  if (!Array.isArray(body.items)) throw new Error('gallery: no items list')
  return body.items
}

/**
 * How many empty inventories in a row it takes before the board believes one
 * over the files it is already showing. Each one is a separate read, a tick
 * apart, so a server that is still coming up has time to answer properly.
 */
const EMPTY_GALLERY_CONFIRMATIONS = 3

/**
 * Whether a freshly read inventory replaces the one on the board.
 *
 * Every tile is drawn only for a name the inventory lists, so applying one
 * empty read blanks the whole canvas — and nothing reads the gallery again
 * until a job settles, which left the board empty until the page was
 * reloaded. An empty read over a board that holds files is therefore held
 * back and asked again, and believed only once it repeats.
 * @param shown - how many items the board currently holds.
 * @param next - the inventory just read.
 * @param emptyStreak - empty reads held back in a row before this one.
 * @returns whether to apply `next`, and the streak to carry to the next read.
 */
export function acceptGallery(
  shown: number,
  next: readonly GalleryItem[],
  emptyStreak: number,
): { readonly accept: boolean; readonly emptyStreak: number } {
  if (next.length > 0 || shown === 0) return { accept: true, emptyStreak: 0 }
  const streak = emptyStreak + 1
  return streak >= EMPTY_GALLERY_CONFIRMATIONS
    ? { accept: true, emptyStreak: 0 }
    : { accept: false, emptyStreak: streak }
}

/**
 * The page origin, or an empty string outside a browser.
 *
 * The DOM types declare `location` as always present; the client modules are
 * also imported by node-side specs, where it is not.
 * @returns the origin to prefix media URLs with.
 */
function pageOrigin(): string {
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? ''
}

/** Shared Imagine studio (projects + canvas positions). */
export interface ImagineStudio {
  readonly projects: readonly ImagineProject[]
  readonly placed: Readonly<Record<string, CanvasRect>>
  /** Ids of deleted projects, by id and delete time, so a merge cannot undo one. */
  readonly deleted?: Readonly<Record<string, number>>
  /**
   * Files and jobs taken out of a project, by project id, so a merge with a
   * stale rail cannot put them back — the way tombstones work for projects.
   */
  readonly removed?: ImagineRemovals
  /** Files renamed on disk, old name to new, so a stale rail follows them. */
  readonly renamed?: Readonly<Record<string, string>>
  /**
   * Tiles whose saved position is to be dropped, by id. `placed` is merged key
   * by key, so an omitted tile means "I have nothing to say about it" and
   * never "forget it" — without this a regrid could not be persisted at all.
   */
  readonly unplaced?: readonly string[]
}

/**
 * Fetch the shared Imagine studio from GET /comfy-imagine/projects.
 * @returns projects and canvas positions.
 */
export async function fetchImagineStudio(): Promise<ImagineStudio | undefined> {
  const body = await getJsonRevalidating<Partial<ImagineStudio>>('/comfy-imagine/projects', 'studio')
  // 304: this browser already has this studio.
  if (body === undefined) return undefined
  return {
    projects: Array.isArray(body.projects) ? body.projects : [],
    placed: typeof body.placed === 'object' ? body.placed : {},
    deleted: typeof body.deleted === 'object' ? body.deleted : {},
    removed: typeof body.removed === 'object' ? body.removed : {},
    renamed: typeof body.renamed === 'object' ? body.renamed : {},
  }
}

/**
 * Persist the shared Imagine studio on PUT /comfy-imagine/projects.
 *
 * The payload may be partial: the host replaces the projects it names, merges
 * `placed` key by key, adds the tombstones, and keeps everything left out.
 * @param studio - the projects and canvas positions that changed, and the tombstones.
 */
export async function saveImagineStudio(studio: ImagineStudio): Promise<void> {
  const response = await request('/comfy-imagine/projects', 'PUT', studio)
  if (!response.ok) throw await failureOf(response, 'studio')
  // The host answers `{ ok: true }` (an older host sent the whole studio);
  // nothing in it is read: the next read revalidates.
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Say yes to what ComfyUI has to install before a job can run
 * (POST /comfy-imagine/<id>/setup): the job waiting for it goes on.
 * @param id - the job.
 * @returns nothing; a refusal throws with the status.
 */
export async function approveImagineSetup(id: string): Promise<void> {
  const response = await request(`/comfy-imagine/${encodeURIComponent(id)}/setup`, 'POST')
  if (!response.ok && response.status !== 404) throw new Error(`setup ${String(response.status)}`)
}

/**
 * Stop a live job through DELETE /comfy-imagine/<id>.
 * @param id - the job to stop.
 * @returns nothing; a refusal throws with the status.
 */
export async function cancelImagineJob(id: string): Promise<void> {
  const response = await request(`/comfy-imagine/${encodeURIComponent(id)}`, 'DELETE')
  // 404 means it settled between the click and the request, which is the
  // outcome the user wanted anyway.
  if (!response.ok && response.status !== 204 && response.status !== 404) {
    throw new Error(`cancel ${String(response.status)}`)
  }
}

/** The last queue read, handed back when the server answers 304. */
let lastJobs: readonly ImagineJob[] = []

/**
 * Fetch the Imagine job list from GET /comfy-imagine.
 * @returns the jobs, newest first.
 */
export async function fetchImagineJobs(): Promise<readonly ImagineJob[]> {
  const body = await getJsonRevalidating<{ jobs?: ImagineJob[] }>('/comfy-imagine', 'jobs')
  if (body !== undefined) lastJobs = Array.isArray(body.jobs) ? body.jobs : []
  return lastJobs
}

/**
 * Apply a workflow change the user confirmed (POST /comfy-imagine/workflows).
 *
 * The changes go back by node and field rather than as the diff that was
 * shown: the host plans them again against the graph it is running, so what
 * reaches the file is never a client's idea of what the file contains.
 * @param key - the workflow's key, as the proposal named it.
 * @param diff - the changes the user accepted.
 * @returns where the previous file was kept, and how many inputs changed.
 */
export async function applyWorkflowChanges(
  key: string,
  diff: readonly WorkflowDiff[],
): Promise<{ backup: string; applied: number }> {
  return await send<{ backup: string; applied: number }>('/comfy-imagine/workflows', 'POST', {
    key,
    changes: diff.map(change => ({ node: change.node, field: change.field, value: change.to })),
  }, 'workflow')
}

/**
 * Read one written line into the runs it asks for (POST /comfy-imagine/chat).
 *
 * Inside a project the composer has no controls, so this is what decides the
 * action and its parameters. It queues nothing: the caller starts the runs, so
 * a misreading is corrected by writing again rather than by cancelling a job.
 * @param asked - the line, the conversation, the staged and recent files.
 * @param signal - aborts a reading the user gave up on.
 * @returns what to say back and what to queue.
 */
export async function readImagineChat(
  asked: ImagineChatAsk,
  signal?: AbortSignal,
  watch?: (event: ImagineChatEvent) => void,
): Promise<ImagineChatReply> {
  const streaming = watch !== undefined
  // The reading has no deadline of its own: a model that never answers is a
  // spinner the chat cannot leave, so the column carries a way to give up.
  const response = await request('/comfy-imagine/chat', 'POST', streaming ? { ...asked, stream: true } : asked,
    signal === undefined ? {} : { signal })
  if (!streaming) return await readJson<ImagineChatReply>(response, 'chat')
  return await readChatStream(response, watch)
}

/**
 * Ask the host to look at these stills now, so a later line finds them seen.
 *
 * Fire and forget: the host queues one vision call per still it has not seen
 * and answers at once. A failure costs nothing the chat cannot recover from
 * by looking when the line arrives, so it is swallowed here.
 * @param names - basenames of the stills on the board.
 */
export async function askToLook(names: readonly string[]): Promise<void> {
  if (names.length === 0) return
  try {
    await request('/comfy-imagine/sight', 'POST', { names })
  } catch { /* the look is a head start, not a requirement */ }
}

/**
 * Read the event stream one reading produces, up to its finished answer.
 *
 * Steps are handed to the caller as they arrive and the answer is returned;
 * a frame that does not parse is dropped rather than failing the turn, since
 * losing a step costs a line of thinking and failing costs the answer.
 * @param response - the open `text/event-stream` response.
 * @param watch - told about each step as it happens.
 * @returns the finished answer.
 * @throws {Error} when the stream ends without one.
 */
async function readChatStream(
  response: Response,
  watch: (event: ImagineChatEvent) => void,
): Promise<ImagineChatReply> {
  if (!response.ok || response.body === null) return await readJson<ImagineChatReply>(response, 'chat')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer: ImagineChatReply | undefined
  /** One `data:` frame: a step for the caller, or the answer to return. */
  const take = (frame: string): void => {
    const payload = frame.split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trim())
      .join('')
    if (payload.length === 0) return
    let event: { kind?: string; answer?: ImagineChatReply }
    try {
      event = JSON.parse(payload) as typeof event
    } catch {
      return
    }
    if (event.kind === 'done') {
      answer = event.answer
      return
    }
    watch(event as ImagineChatEvent)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Frames are separated by a blank line; the tail is an unfinished frame.
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) take(frame)
  }
  if (buffer.trim().length > 0) take(buffer)
  // Same shape as readJson's failures: the page turns these into words.
  if (answer === undefined) throw new Error('chat stream ended without an answer')
  return answer
}

/**
 * Ask the host for a short name for a project the studio is about to fill
 * (POST /comfy-imagine/title).
 *
 * One bounded text call, no side effect. A title that never comes back is not
 * an error: the caller keeps the provisional name and asks again with the
 * next content, so the timeout and the refusals resolve to undefined rather
 * than throwing.
 * @param source - the content the project will hold: the line, the prompt, the lyrics.
 * @param model - the model the composer is showing, when the page has one.
 * @returns the name, or undefined when the host had nothing to give.
 */
export async function requestProjectTitle(
  source: string,
  model?: ModelRoute,
): Promise<string | undefined> {
  const controller = new AbortController()
  // The host gives up on 30 s; the caller waits a little past that so a late
  // but valid answer is not thrown away by its own timeout.
  const timer = globalThis.setTimeout(() => { controller.abort() }, 40_000)
  try {
    const body = await send<{ title?: string }>(
      '/comfy-imagine/title', 'POST', model === undefined ? { text: source } : { text: source, model }, 'title',
      { signal: controller.signal },
    )
    return typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : undefined
  } catch {
    return undefined
  } finally {
    globalThis.clearTimeout(timer)
  }
}

/**
 * The shot number a delivered file name carries, when it is a shot of a
 * music video: `videoclip-<label>-03of10.mp4` is the third of ten.
 *
 * A redo appends its own suffix to the delivered name — `-v4`, `-3`, or both
 * (`videoclip-4664f8-09of17-v11-3.mp4`) — so anything may follow the position.
 * Matching only `-v<digits>` dropped the badge from every redone shot, which is
 * exactly the ones a person needs to tell apart while assembling the cut.
 * @param name - a gallery basename.
 * @returns the position from 1 and the count, or undefined for any other file.
 */
export function shotNumberOf(name: string): { n: number; total: number } | undefined {
  const match = /^videoclip-[a-z0-9]{1,8}-(\d+)of(\d+)(?:-[a-z0-9]+)*\.mp4$/i.exec(name)
  if (match === null) return undefined
  const n = Number(match[1])
  const total = Number(match[2])
  return Number.isInteger(n) && Number.isInteger(total) && n >= 1 && n <= total ? { n, total } : undefined
}

/**
 * Start a music video: photos from a look, a song from the form, then the cut.
 *
 * The montage is not queued here. It cannot be — it needs the names the photos
 * and the song produce — so the host starts it once those land, and this
 * answers with the jobs to watch in the meantime.
 * @param form - the answers to the music-video form.
 * @returns the queued photo and song jobs.
 */
export async function startMusicClip(form: MusicClipRequest): Promise<MusicClipPlan> {
  return await postJson<MusicClipPlan>('/comfy-imagine/clip', form, 'clip')
}

/**
 * Start one Imagine generate / remix / video job.
 * @param action - which workflow to run.
 * @param prompt - the user prompt.
 * @param source - optional source basename for remix/video.
 * @param extras - size / aspect / seconds / megapixels / count and the rest the workflow reads.
 * @returns the queued job.
 */
export async function startImagineJob(
  action: ImagineAction,
  prompt: string,
  source?: string,
  extras?: {
    size?: string
    aspectRatio?: string
    seconds?: number
    megapixels?: number
    lyrics?: string
    voice?: string
    pitch?: number
    count?: number
    /** `custom` only: which uploaded workflow to run. */
    customWorkflowId?: string
    /** `custom` only: the card's own controls, keyed `<node>.<field>`. */
    customFields?: Readonly<Record<string, unknown>>
    /** `custom` only: the card's file slots, keyed by node id (gallery names). */
    customFiles?: Readonly<Record<string, string>>
    /** `scanFrame` only: how many candidate opening frames to draw (1-20). */
    candidates?: number
    song?: string
    /** A montage's photos, one per shot; `story` only. */
    sources?: readonly string[]
    /**
     * The second photo of an `objectSwap` or a `compose`; the first file
     * travels in `source`, so the two inputs never share a field.
     */
    reference?: string
    /**
     * The model the composer's chip is showing.
     *
     * Imagine writes text before it runs a graph — a song's caption and
     * structure tags, a story's beats, a look's rewrite. Without this the host
     * used its own configured model for those, so the chip named one model
     * while another wrote.
     */
    model?: ModelRoute
    /** Upscale only: the short side to arrive at (the tile menu's choice). */
    upscaleTo?: number
    /** Remix only: the zone "Precise edit" confines the edit to. */
    region?: ImagineRegion
    /** Video only: the photo the clip arrives at. */
    lastSource?: string
    /** Remix only: a painted zone, as a PNG data URL. */
    mask?: string
    /** Recreate only: whether the reference clip's soundtrack is kept. */
    keepAudio?: boolean
    /** Character swap only: false turns lip-sync off. */
    lipSync?: boolean
    /** `objectSwap` only: which of the four recipes runs. */
    objectMode?: ImagineObjectMode
    /** `objectSwap` → `add`: the box the new object goes into. */
    placement?: ImaginePlacement
    /** `relight` only: the light look to paint, by slug. */
    light?: string
  },
): Promise<ImagineJob> {
  /*
   * Undefined fields drop out of the JSON on their own; only the two whose
   * "nothing" is a value (a count of one, an empty montage list) are left out
   * by hand, as the host reads their presence.
   */
  const { count, sources, ...rest } = extras ?? {}
  return await postJson<ImagineJob>('/comfy-imagine', {
    action,
    prompt,
    source,
    ...rest,
    ...count === undefined || count <= 1 ? {} : { count },
    ...sources === undefined || sources.length === 0 ? {} : { sources },
  }, 'imagine')
}

/**
 * Upload a dropped still or clip to POST /comfy-media.
 * @param file - the browser file.
 * @returns the new gallery item.
 */
export async function uploadGalleryItem(file: File): Promise<GalleryItem> {
  // The file is the body, as it is: no JSON around it.
  return await readJson<GalleryItem>(
    await request('/comfy-media', 'POST', undefined, { headers: { 'x-filename': encodeURIComponent(file.name) }, body: file }),
    'upload',
  )
}

/**
 * Delete one produced file by basename.
 * @param name - the file name returned by the inventory.
 */
export async function deleteGalleryItem(name: string): Promise<void> {
  await send<{ ok: boolean }>(`/comfy-media/${encodeURIComponent(name)}`, 'DELETE', undefined, 'delete')
}

/**
 * Same-origin URL the browser uses to load one produced file.
 * @param name - the file name returned by the inventory.
 * @returns the `/comfy-media/<name>` URL.
 */
export function mediaUrlOf(name: string): string {
  const origin = pageOrigin()
  return `${origin}/comfy-media/${encodeURIComponent(name)}`
}

/** Width of the board tile's cut; the server also cuts THUMB_SMALL. */
export const THUMB_TILE = 640
/** Width of the rail, film strip and composer chips' cut. */
export const THUMB_SMALL = 256

/**
 * Same-origin URL of a gallery file's small WebP copy: the still itself, or a
 * clip's first frame. The server falls back to the original when it cannot
 * cut one, so this is always safe to draw.
 * @param name - the file name returned by the inventory.
 * @param width - the width the picture is drawn at, in device pixels.
 * @param mtime - the file's mtime, so a crop is not served from the cache.
 * @returns the `/comfy-media/<name>?thumb=<width>` URL.
 */
export function thumbUrlOf(name: string, width: number, mtime?: number): string {
  const version = mtime === undefined ? '' : `&v=${String(mtime)}`
  return `${mediaUrlOf(name)}?thumb=${String(width)}${version}`
}

/** True while the job has not settled. */
export function jobIsLive(job: ImagineJob): boolean {
  return job.status === 'queued' || job.status === 'running'
}

/**
 * Live upscales keyed by the file they are replacing.
 *
 * An upscale is a swap, not an addition: it overwrites its source on disk and
 * takes the source's place in the project. Giving it a tile of its own put a
 * second, empty frame on the board for the length of the run, so the progress
 * is drawn on the tile being replaced instead — and SeedVR2 sends no preview
 * frames, so that empty frame never had anything to show but a percentage.
 * @param jobs - the latest job list.
 * @returns the running upscale for each source name.
 */
export function upscalesInFlight(jobs: readonly ImagineJob[]): Readonly<Record<string, ImagineJob>> {
  const out: Record<string, ImagineJob> = {}
  for (const job of jobs) {
    if (job.action !== 'upscale' || !jobIsLive(job) || job.source === undefined) continue
    out[job.source] ??= job
  }
  return out
}

/**
 * The live jobs that get a tile of their own on the board.
 * @param jobs - the latest job list.
 * @returns every live job except the upscales, which draw on their source.
 */
export function boardJobs(jobs: readonly ImagineJob[]): readonly ImagineJob[] {
  return jobs.filter(job => job.action !== 'upscale')
}

/**
 * Ask the host for one ZIP of the named gallery files.
 *
 * The archive is built on the host, where the files already are: zipping in
 * the browser would download every file first and hold them all in memory to
 * produce bytes the host can stream.
 * @param names - the selected media names.
 * @returns the archive and the filename the host named it.
 */
export async function fetchMediaZip(names: readonly string[]): Promise<{ blob: Blob; filename: string }> {
  const response = await request('/comfy-zip', 'POST', { names })
  // The failure body is the host's sentence; a bare status would reach the
  // user as a number.
  if (!response.ok) throw await failureOf(response, 'zip')
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(disposition)
  return { blob: await response.blob(), filename: match?.[1] ?? 'imagine.zip' }
}

/**
 * The files with a "Like" (GET /api/likes).
 * @returns their names; an empty list when the host keeps none.
 */
export async function fetchLikes(): Promise<readonly string[]> {
  const body = await getJson<{ names?: string[] }>('/api/likes', 'likes')
  return Array.isArray(body.names) ? body.names : []
}

/**
 * Set or clear the "Like" on some files (POST /api/likes).
 * @param names - the files.
 * @param liked - whether they are liked now.
 * @returns every liked name after the write, when the host says.
 */
export async function saveLikes(names: readonly string[], liked: boolean): Promise<readonly string[] | undefined> {
  const body = await postJson<{ names?: string[] }>('/api/likes', { names, liked }, 'likes')
  return Array.isArray(body.names) ? body.names : undefined
}

/**
 * The tags of "All media" (GET /api/tags).
 * @returns every tag with its files.
 */
export async function fetchTags(): Promise<readonly MediaTag[]> {
  const body = await getJson<{ tags?: MediaTag[] }>('/api/tags', 'tag:')
  return Array.isArray(body.tags) ? body.tags : []
}

/**
 * Change the tags (POST /api/tags): create, rename, delete, add or remove files.
 * @param body - the action and its fields, as the host route reads them.
 * @returns every tag after the change, and the id of a tag just created.
 */
export async function changeTags(body: Readonly<Record<string, unknown>>): Promise<{ tags?: MediaTag[]; id?: string }> {
  return await postJson<{ tags?: MediaTag[]; id?: string }>('/api/tags', body, 'tag:')
}

/** One answer of "Search the media" (GET /api/media-search). */
export interface MediaSearchAnswer {
  /** The normalised request, as the server read it. */
  readonly query: string
  /** The files that contain every word, in inventory order. */
  readonly names: readonly string[]
  /** How many the index found: `names` stops at the answer's page. */
  readonly total: number
  /** The files the index knows (those with a note). */
  readonly indexed: number
  readonly tookMs: number
}

/**
 * Search the media by their words (GET /api/media-search): the prompt a file
 * was made with and what vision saw in it.
 * @param query - what is in the box.
 * @returns the names found, or undefined when the host does not answer properly.
 */
export async function searchMedia(query: string): Promise<MediaSearchAnswer | undefined> {
  const body = await getJson<Partial<MediaSearchAnswer>>(`/api/media-search?q=${encodeURIComponent(query)}`, 'media-search')
  if (!Array.isArray(body.names)) return undefined
  return {
    query: body.query ?? query,
    names: body.names,
    total: body.total ?? body.names.length,
    indexed: body.indexed ?? 0,
    tookMs: body.tookMs ?? 0,
  }
}

/**
 * A second copy of a photo, beside the first (POST /api/duplicate).
 * @param name - the photo to copy.
 * @returns the new gallery item.
 */
export async function duplicateGalleryItem(name: string): Promise<GalleryItem> {
  return await postJson<GalleryItem>('/api/duplicate', { name }, 'duplicate')
}

/**
 * Join clips into one video, in the order given (POST /api/merge).
 * @param names - the clips.
 * @returns the joined video's gallery item.
 */
export async function mergeClips(names: readonly string[]): Promise<GalleryItem> {
  return await postJson<GalleryItem>('/api/merge', { names }, 'merge')
}

// ─── Social publishing ───────────────────────────────────────────────

// The queue's wire types live in shared/, read by the Instagram plugin too.
export type {
  SocialPost, SocialPostKind, SocialPostStatus, SocialStory, SocialStoryStatus,
} from '../../../shared/social-types.ts'

/** Caption preview from the social-publish plugin. */
export interface CaptionPreview {
  readonly ok: boolean
  readonly caption: string
  readonly hashtags: string
  /** True when the vision pass judged the frame unsafe for the feed. */
  readonly unsafe?: boolean
  /** Which stage produced the copy: written, facts-only, or template. */
  readonly source?: string
  readonly error?: string
}

/** The fields a caller may set when queueing or editing a post. */
export interface SocialPostInput {
  readonly kind?: SocialPostKind
  readonly files?: readonly string[]
  readonly caption?: string
  readonly hashtags?: string
  readonly aiLabel?: boolean
  /** An ISO date to schedule it, or null to turn it back into a draft. */
  readonly scheduledAt?: string | null
}

/**
 * Read the publication queue from GET /social/posts.
 * @returns the posts, newest first.
 */
export async function fetchSocialPosts(): Promise<readonly SocialPost[]> {
  const body = await getJson<{ posts?: SocialPost[] }>('/plugin/instagram/social/posts', 'social-posts')
  return Array.isArray(body.posts) ? body.posts : []
}

/**
 * One queued post through GET /social/posts/<id>.
 * @param id - the post's id.
 * @returns the post as the queue holds it now.
 */
export async function fetchSocialPost(id: string): Promise<SocialPost> {
  const body = await getJson<{ post: SocialPost }>(`/plugin/instagram/social/posts/${encodeURIComponent(id)}`, 'social-post')
  return body.post
}

/**
 * Queue one post through POST /social/posts.
 * @param input - the post to queue; a date makes it scheduled.
 * @returns the stored post.
 */
export async function createSocialPost(input: SocialPostInput): Promise<SocialPost> {
  return (await send<{ post: SocialPost }>('/plugin/instagram/social/posts', 'POST', input, 'social-posts')).post
}

/**
 * Edit one queued post through PATCH /social/posts/<id>.
 * @param id - the post to change.
 * @param input - the fields to set.
 * @returns the stored post.
 */
export async function updateSocialPost(id: string, input: SocialPostInput): Promise<SocialPost> {
  return (await send<{ post: SocialPost }>(`/plugin/instagram/social/posts/${encodeURIComponent(id)}`, 'PATCH', input, 'social-posts')).post
}

/**
 * Drop one queued post through DELETE /social/posts/<id>.
 * @param id - the post to remove.
 */
export async function deleteSocialPost(id: string): Promise<void> {
  await send<{ ok: boolean }>(`/plugin/instagram/social/posts/${encodeURIComponent(id)}`, 'DELETE', undefined, 'social-posts')
}

/**
 * Send one queued post now through POST /social/posts/<id>/publish.
 * @param id - the post to publish.
 * @returns the post in its new state, carrying the error when it failed.
 */
export async function publishSocialPost(id: string): Promise<SocialPost> {
  return (await send<{ post: SocialPost }>(`/plugin/instagram/social/posts/${encodeURIComponent(id)}/publish`, 'POST', undefined, 'social-posts')).post
}

/* A comment and a pass are the plugin's own types (`shared/social-types.ts`). */
export type { SocialComment, SocialCommentPass } from '../../../shared/social-types.ts'

/** The comment record, as the page reads it. */
export interface SocialComments {
  readonly comments: readonly SocialComment[]
  readonly lastRunAt: string | null
  readonly lastError: string | null
  readonly lastCounters: SocialCommentPass | null
  /** The hours a pass runs, local time on the host. */
  readonly hours: readonly number[]
}

/**
 * Read the handled comments from GET /social/comments.
 * @returns the comments, newest first, with when the last pass ran.
 */
export async function fetchSocialComments(): Promise<SocialComments> {
  const body = await getJson<Partial<SocialComments>>('/plugin/instagram/social/comments', 'social-comments')
  return {
    comments: Array.isArray(body.comments) ? body.comments : [],
    lastRunAt: body.lastRunAt ?? null,
    lastError: body.lastError ?? null,
    lastCounters: body.lastCounters ?? null,
    hours: Array.isArray(body.hours) ? body.hours : [],
  }
}

/**
 * Run one pass now through POST /social/comments/run.
 * @param dry - work out the replies without sending them.
 * @returns what the pass did.
 */
export async function runSocialCommentPass(dry = false): Promise<SocialCommentPass> {
  return (await send<{ counters: SocialCommentPass }>(`/plugin/instagram/social/comments/run${dry ? '?dry=1' : ''}`, 'POST', undefined, 'social-comments')).counters
}

/**
 * Like one comment through POST /social/comments/<id>/like.
 * @param id - the comment to like.
 * @returns the comment in its new state.
 */
export async function likeSocialComment(id: string): Promise<SocialComment> {
  return (await send<{ comment: SocialComment }>(`/plugin/instagram/social/comments/${encodeURIComponent(id)}/like`, 'POST', undefined, 'social-comments')).comment
}

/**
 * Reply to one comment through POST /social/comments/<id>/reply.
 * @param id - the comment to answer.
 * @param text - the reply, which goes out publicly as written.
 * @returns the comment in its new state.
 */
export async function replySocialComment(id: string, text: string): Promise<SocialComment> {
  return (await send<{ comment: SocialComment }>(`/plugin/instagram/social/comments/${encodeURIComponent(id)}/reply`, 'POST', { text }, 'social-comments')).comment
}

/** The story queue, as the page reads it. */
export interface SocialStories {
  readonly stories: readonly SocialStory[]
  /**
   * The first day a story may go out: the plugin's `storiesFrom` setting, or
   * '' when there is no such limit.
   */
  readonly from: string
  /** The hour they go out, local time on the host. */
  readonly hour: number
}

/**
 * Read the story queue from GET /social/stories.
 * @returns the stories, soonest first.
 */
export async function fetchSocialStories(): Promise<SocialStories> {
  const body = await getJson<Partial<SocialStories>>('/plugin/instagram/social/stories', 'social-stories')
  return {
    stories: Array.isArray(body.stories) ? body.stories : [],
    from: body.from ?? '',
    hour: body.hour ?? 8,
  }
}

/**
 * Move one queued story through PATCH /social/stories/<id>.
 * @param id - the story to change.
 * @param publishAt - the new date, as an ISO string.
 * @returns the stored story.
 */
export async function rescheduleSocialStory(id: string, publishAt: string): Promise<SocialStory> {
  return (await send<{ story: SocialStory }>(`/plugin/instagram/social/stories/${encodeURIComponent(id)}`, 'PATCH', { publishAt }, 'social-stories')).story
}

/**
 * Drop one queued story through DELETE /social/stories/<id>.
 * @param id - the story to remove.
 */
export async function deleteSocialStory(id: string): Promise<void> {
  await send<{ ok: boolean }>(`/plugin/instagram/social/stories/${encodeURIComponent(id)}`, 'DELETE', undefined, 'social-stories')
}

/**
 * Send one queued story now through POST /social/stories/<id>/publish.
 * @param id - the story to publish.
 * @returns the story in its new state, carrying the error when it failed.
 */
export async function publishSocialStory(id: string): Promise<SocialStory> {
  return (await send<{ story: SocialStory }>(`/plugin/instagram/social/stories/${encodeURIComponent(id)}/publish`, 'POST', undefined, 'social-stories')).story
}

/**
 * Get a caption preview for a gallery item.
 * @param type - post type.
 * @param opts - optional context.
 * @returns caption preview.
 */
export async function getCaptionPreview(
  type: 'photo' | 'reel',
  opts?: { theme?: string; filename?: string; prompt?: string },
): Promise<CaptionPreview> {
  return await postJson<CaptionPreview>('/plugin/instagram/social/caption-preview', { type, ...opts }, 'caption-preview')
}

/*
 * The settings page's view of the host (settings, connection, one workflow's
 * fields) is the type the server builds it with: `shared/imagine-settings-view.ts`.
 */
import type { ImagineSettingsView, WorkflowDetail } from '../../../shared/imagine-settings-view.ts'
export type {
  ComfyConnectionOverride, ComfyConnectionView, ImagineSettingsView, WorkflowDetail, WorkflowSettingsEntry,
} from '../../../shared/imagine-settings-view.ts'

/** Live state of the connected ComfyUI (GET /comfy-imagine/server). */
export interface ComfyServerStatus {
  readonly ok: boolean
  readonly endpoint: string
  readonly version?: string
  readonly os?: string
  readonly devices: readonly {
    readonly name: string
    readonly vramTotal?: number
    readonly vramFree?: number
  }[]
  readonly queue: { readonly running: number; readonly pending: number }
  /** Why the probe failed, when it did. */
  readonly error?: string
}

/**
 * Read the Imagine settings layers (GET /comfy-imagine/settings).
 * @returns the composed, applied, and running values of every editable field.
 */
export async function fetchImagineSettings(): Promise<ImagineSettingsView> {
  return await getJson<ImagineSettingsView>('/comfy-imagine/settings', 'settings')
}

/**
 * Write edits to the settings file (POST /comfy-imagine/settings).
 *
 * The answer is the view after the write, so a page never has to guess what
 * the host stored or re-read it.
 * @param ops - the edits, in order.
 * @returns the settings view after the write.
 */
export async function saveImagineSettingOps(ops: readonly ImagineSettingOp[]): Promise<ImagineSettingsView> {
  return await postJson<ImagineSettingsView>('/comfy-imagine/settings', { ops }, 'settings')
}

/**
 * Read the connected ComfyUI's own report (GET /comfy-imagine/server).
 *
 * A server that does not answer is reported in the body with `ok: false`
 * rather than thrown: telling the user it is down is what this call is for.
 * @returns what the server reported, or why it could not be reached.
 */
export async function fetchComfyServer(): Promise<ComfyServerStatus> {
  return await getJson<ComfyServerStatus>('/comfy-imagine/server', 'ComfyUI status')
}

/**
 * Restart ComfyUI with the deployment's own command (POST /comfy-imagine/server/restart).
 *
 * The host answers once the command has exited; whether the server is back is
 * answered by {@link fetchComfyServer}, which the page polls.
 * @returns nothing.
 */
export async function restartComfyServer(): Promise<void> {
  await send<{ ok: true }>('/comfy-imagine/server/restart', 'POST', undefined, translate('imagine.settings.restart'))
}

/**
 * Read one workflow's editable inputs (GET /comfy-imagine/workflows/<key>).
 * @param key - the workflow's key.
 * @returns its file, its scalar inputs, and its stale pins.
 */
export async function fetchWorkflowDetail(key: string): Promise<WorkflowDetail> {
  return await getJson<WorkflowDetail>(`/comfy-imagine/workflows/${encodeURIComponent(key)}`, 'workflow')
}

/**
 * Work out what a set of node values would change, writing nothing
 * (POST /comfy-imagine/workflows/plan).
 * @param key - the workflow's key.
 * @param changes - the node inputs to change.
 * @returns the file, the diff, and the refusals.
 */
export async function planWorkflowValues(
  key: string,
  changes: readonly WorkflowValueChange[],
): Promise<WorkflowPlan> {
  return await postJson<WorkflowPlan>('/comfy-imagine/workflows/plan', { key, changes }, 'workflow')
}

/**
 * Read the values one node input accepts (GET /comfy-imagine/workflows/<key>/options).
 * @param key - the workflow's key.
 * @param node - the node id inside the graph.
 * @param field - the input key.
 * @returns the accepted values; empty when the server publishes no list for it.
 */
export async function fetchWorkflowOptions(key: string, node: string, field: string): Promise<readonly string[]> {
  const query = `node=${encodeURIComponent(node)}&field=${encodeURIComponent(field)}`
  const body = await getJson<{ options: readonly string[] }>(
    `/comfy-imagine/workflows/${encodeURIComponent(key)}/options?${query}`, translate('imagine.workflowOptions'),
  )
  return body.options
}
