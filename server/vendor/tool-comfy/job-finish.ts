/**
 * What happens to a run's files after the render: the soundtrack laid back,
 * the montage cut, the continuation joined, the frame snapped to its size —
 * and the terminal write that puts the result on the job and the board.
 * @module tool-comfy/job-finish
 */

import { renameWithRetry, unlinkWithRetry } from '../retry-fs/index.ts'
import { basename, join } from 'node:path'
import type { ImagineHost } from '../../src/host.ts'
import { declaredOutputPath, freeOutputPath } from './index.ts'
import type { ComfyProducedFile } from './index.ts'
import { layPlateAudio, muxAudio, probeMedia, samePicture, type MediaProbe } from './media-tools.ts'
import { kindOf, probePixels, safeBasename } from './gallery.ts'
import { exactVideoFrame, fourKFrame, parseSize, snapClip, snapStill } from './snap-size.ts'
import { joinAtSeam } from './extend-video.ts'
import { finalFileName, readStoryManifest, shotOfFileName, storyLabel, updateStoryManifest, updateStoryShot } from './story-manifest.ts'
import { rememberWrittenPrompt } from './written-prompts.ts'
import { rememberOrigin } from './imagine-notes.ts'
import { lookSoon } from './imagine-sight.ts'
import { segmentSoon } from './segments.ts'
import { adoptJobFiles } from './imagine-store.ts'
import { laySongOver } from './story.ts'
import type { ImagineWorkflows } from './workflow-fields.ts'
import type { MediaKind } from '../../../shared/imagine-types.ts'
import { getImagineJob, isSettled, listImagineJobs, patchJob, setJobNotice, type ImagineJob } from './job-queue.ts'
import { joinShots, rebuildStory, repairStory, storyCaption } from './story-jobs.ts'

/** A shot of a music video, delivered under its number. */
export interface DeliveredShot {
  readonly storyId: string
  readonly index: number
  readonly count: number
}

/** Everything the steps after the render read off the run. */
interface FinishRun {
  readonly ctx: ImagineHost
  readonly workflows: ImagineWorkflows
  readonly outputDir: string
  /** The run's working copy of the job. */
  readonly job: ImagineJob
  /** The files the render delivered, after its retries. */
  readonly files: readonly ComfyProducedFile[]
  readonly sourceKind: MediaKind | undefined
  readonly sourceVideo: string | undefined
  readonly tool: string
  /** The declared-name arguments of the run's result. */
  readonly args: Record<string, unknown>
  /** The length of the clip a continuation extends. */
  readonly extendDuration: number | undefined
  /** That clip's pixels, measured with its length: the continuation is fitted to them at the seam. */
  readonly extendPixels?: { readonly width: number; readonly height: number }
  /** The produced file is already the source followed by its continuation (a chained extend). */
  readonly wholeClip?: boolean
  readonly shot: DeliveredShot | undefined
  readonly writtenPrompt: string | undefined
  readonly lipsync: number | undefined
  /** The source's header, read at most once per run. */
  readonly pixelsOf: (path: string, kind: 'image' | 'video') => ReturnType<typeof probePixels>
  /** The song's probe, measured at most once per run. */
  readonly songTrack: () => Promise<MediaProbe>
}

/**
 * Carry a rendered run to its delivered files and write the result.
 * @param run - the run, its render done.
 */
export async function finishRun(run: FinishRun): Promise<void> {
  const delivered = await deliveredFiles(run)
  await snapToSize(run, delivered)
  await sayWhenNothingChanged(run, delivered)
  await writeResult(run, delivered)
}

/**
 * Say when an edit delivered the photo it started from.
 *
 * A full redraw that ignored the instruction — or a precise edit whose zone
 * the sampler left alone — comes back as the source, and beside the original
 * it reads as a broken run with no reason. The job still delivers the file;
 * the notice is what tells the user to name the part more precisely, or to
 * take it out with the eraser.
 * @param run - the run, its files snapped to their size.
 * @param delivered - the files the run is about to publish.
 */
async function sayWhenNothingChanged(run: FinishRun, delivered: readonly ComfyProducedFile[]): Promise<void> {
  if (run.job.action !== 'remix' || run.job.source === undefined) return
  const source = safeBasename(run.job.source)
  const made = delivered.find(file => kindOf(file.path) === 'image')
  if (source === undefined || made === undefined || kindOf(source) !== 'image') return
  if (await samePicture(join(run.outputDir, source), made.path)) setJobNotice(run.job.id, 'edit-unchanged')
}

/**
 * The files the run delivers, from what the render produced.
 *
 * The take delivered is the one that was measured: `files` is the last
 * take's, and the record has to point at the last take too — with the first
 * assignment left where it was, the record named take one while its
 * `lipsync` came from take three, the orphan `-2`/`-3` files were never cut
 * in, and the retries could not improve the video at all. Measured on
 * AUTUNNO 26/09/2026: the cut carried a take the probe had never scored on 7
 * shots out of 18.
 * @returns every delivered file, its kind read off its name where it has one.
 */
async function deliveredFiles(run: FinishRun): Promise<readonly ComfyProducedFile[]> {
  const { ctx, workflows, outputDir, job, files, sourceKind, sourceVideo } = run
  let finalFiles = files
  /*
   * «Recreate video» can keep the soundtrack that was filmed.
   *
   * The video model writes audio of its own under the new picture — a guess
   * about a room it only saw through one frame — while a recreation of a
   * filmed clip usually wants its own track back. The checkbox in the
   * composer is the whole control: on, the reference clip's audio replaces
   * the generated one; off, the run delivers what the model wrote. A silent
   * reference delivers a silent video, which is what was asked for.
   */
  if (job.action === 'recreate' && job.keepAudio === true && sourceVideo !== undefined) {
    const mine = finalFiles.find(file => file.kind === 'video')
    if (mine !== undefined) {
      const muxed = await layPlateAudio(mine.path, sourceVideo, outputDir, 'recreate-audio')
      if (muxed !== mine.path) {
        try {
          await renameWithRetry(muxed, mine.path)
        } catch {
          await unlinkWithRetry(muxed).catch(() => undefined)
          setJobNotice(job.id, 'recreate-audio-failed')
        }
      }
    }
  }
  /*
   * A voice change on a CLIP gives the clip back, not only its soundtrack.
   *
   * The graph converts the track and writes an audio file; "cambia la voce di
   * questa clip" asks for the video with the new voice, and an .mp3 in the
   * gallery beside an unchanged clip is half an answer (2026-10-17). A clip
   * that cannot be remounted keeps the track as its result and says so: the
   * minutes of conversion are not thrown away over a mux that failed.
   *
   * After the lipsync retries, which reassign `files`: placed before them,
   * the muxed clip was dropped on the floor before it ever reached the job
   * (measured 2026-10-17).
   */
  if (job.action === 'voice' && sourceKind === 'video' && job.source !== undefined) {
    const track = finalFiles.find(file => kindOf(file.path) === 'audio')
    if (track !== undefined) {
      try {
        const out = freeOutputPath(declaredOutputPath(outputDir, run.tool, 'mp4', run.args))
        // The picture is copied, never re-encoded, and the track is padded with
        // silence to the clip's length: a converted track comes out a hair
        // shorter than its container, and `-shortest` alone would cut the last
        // frames of the picture away.
        const muxed = await muxAudio(join(outputDir, job.source), track.path, out, { pad: true, faststart: true })
        finalFiles = [{ path: muxed, kind: 'video' }]
      } catch {
        setJobNotice(job.id, 'voice-mux-failed')
      }
    }
  }
  /*
   * The last shot of a montage cuts the whole video together. It is done
   * here rather than in a job of its own because the song is laid over the
   * finished video just below, and because a story's last clip already is
   * the file the studio treats as the whole video.
   */
  if (job.redo !== undefined) {
    /*
     * The shot is in: put it in the record in place of the old one and cut
     * the video again. The old cut stays on the board under its own name.
     */
    const mine = files.find(file => file.kind === 'video')
    if (mine !== undefined) {
      await updateStoryShot(job.redo.storyId, job.redo.index, {
        file: basename(mine.path),
        prompt: job.prompt,
        // A redo with words of its own replaced the beat, and the recorded
        // caption describes the shot it no longer is: it goes with the beat.
        ...job.caption === undefined || job.captionLanguage === undefined
          ? { caption: undefined, captionLanguage: undefined }
          : { caption: job.caption, captionLanguage: job.captionLanguage },
        ...run.lipsync === undefined ? {} : { lipsync: run.lipsync },
      })
      if (job.redo.rebuild !== false) {
        try {
          const final = await rebuildStory(job.redo.storyId, outputDir)
          finalFiles = [{ path: final, kind: 'video' }, mine]
        } catch {
          const repairing = await repairStory(ctx, workflows, outputDir, job.redo.storyId, job.model)
          setJobNotice(job.id, repairing ? 'montage-repairing' : 'montage-failed')
        }
      }
    }
  }
  /*
   * Not `rebuildStory`, though a song montage has a record by now: the cut is
   * made from the shots that LANDED, holes and all, while a rebuild refuses a
   * video with a shot missing; the record does not name this shot's file yet
   * (it is filed below, after the cut); and a montage without a song has no
   * record at all.
   */
  if (job.redo === undefined && job.cut === true && job.storyIndex === (job.storyCount ?? 0) - 1 && job.storyId !== undefined) {
    const mine = files.find(file => file.kind === 'video')
    const earlier = listImagineJobs()
      .filter(other => other.storyId === job.storyId && other.id !== job.id && other.storyIndex !== undefined)
      .sort((a, b) => (a.storyIndex ?? 0) - (b.storyIndex ?? 0))
      .flatMap(other => other.files?.filter(file => file.kind === 'video').map(file => join(outputDir, file.name)) ?? [])
    if (mine !== undefined && earlier.length > 0) {
      try {
        const story = await readStoryManifest(job.storyId)
        const track = job.song === undefined ? undefined : await run.songTrack()
        const joined = await joinShots(
          [...earlier, mine.path],
          story === undefined ? undefined : [...story.shots].sort((a, b) => a.index - b.index),
          track,
          outputDir,
        )
        if (run.shot !== undefined) {
          // The cut gets the story's own name and the last shot keeps its
          // number: a redo needs every shot, the last one included.
          const final = join(outputDir, finalFileName(storyLabel(job.storyId)))
          await renameWithRetry(joined, final)
          finalFiles = [{ path: final, kind: 'video' }, mine]
        } else {
          // The whole video takes the declared output name, as a story's last
          // clip does: otherwise the gallery shows the last shot as the result.
          await renameWithRetry(joined, mine.path)
          finalFiles = [{ path: mine.path, kind: 'video' }]
        }
      } catch {
        // The shots are all on the board and playable; a montage that could
        // not be cut is a video to assemble by hand, not a failed run.
        setJobNotice(job.id, 'montage-failed')
      }
    }
  }
  /*
   * For 'extend', join the source clip and its continuation. The
   * continuation opens on the guide it was given — the source's own last
   * frames, generated a second time — so that overlap is dropped and the
   * two are crossfaded over the single frame the seam is worth.
   */
  if (job.action === 'extend' && run.wholeClip !== true && job.source !== undefined && sourceKind === 'video' && files.length > 0) {
    const videoFile = files.find(f => f.kind === 'video')
    if (videoFile !== undefined) {
      const concatenated = await joinAtSeam(join(outputDir, job.source), videoFile.path, run.extendDuration ?? 0, outputDir, run.extendPixels)
      // The whole clip takes the declared output name, replacing the
      // continuation: otherwise the job leaves two videos in the gallery and
      // the one it reports is the half-length one.
      await renameWithRetry(concatenated, videoFile.path)
      finalFiles = [{ path: videoFile.path, kind: 'video' }]
    }
  }
  /*
   * The song goes on last, over the whole video: the final clip of a story
   * carries it, and by then every earlier clip has been merged into the file
   * this one produced. A track that cannot be laid over the video leaves the
   * video as it is — with the generated soundtrack — rather than failing a
   * run that took the card the best part of an hour.
   */
  if (job.song !== undefined) {
    const videoFile = finalFiles.find(file => file.kind === 'video')
    if (videoFile !== undefined) {
      try {
        const [made, track] = await Promise.all([probeMedia(videoFile.path), run.songTrack()])
        const scored = await laySongOver(videoFile.path, join(outputDir, job.song), made.duration, track.duration, outputDir)
        await renameWithRetry(scored, videoFile.path)
        // The shot the cut was made from stays listed beside it.
        finalFiles = finalFiles.filter(file => file.kind === 'video')
      } catch {
        setJobNotice(job.id, 'song-failed')
      }
    }
  }
  // The kind each file is listed as, read off its name once: the snaps below
  // and the job's files all go by it.
  return finalFiles.map(file => ({ path: file.path, kind: kindOf(file.path) ?? file.kind }))
}

/**
 * Stills a few pixels off the size they were meant to have go onto it (see
 * snap-size.ts): the asked size for a generation, the source's for
 * an edit or a cut-out; clips onto the exact 720p/1080p frame.
 */
async function snapToSize(run: FinishRun, files: readonly ComfyProducedFile[]): Promise<void> {
  const { job, outputDir } = run
  // A still upscale lands on the exact 4K frame of its shape (fourKFrame),
  // when it came out about 4K: SeedVR2 works on the long side and rounds.
  if (job.action === 'upscale') {
    for (const file of files) {
      if (file.kind !== 'image') continue
      const made = await probePixels(file.path, 'image')
      const frame = 'width' in made ? fourKFrame(made.width, made.height, job.upscaleTo ?? 2160) : undefined
      if (frame !== undefined) await snapStill(file.path, frame)
    }
  }
  /*
   * Clips onto the exact 720p/1080p frame (snap-size.ts exactVideoFrame):
   * single videos and backgrounds, and video upscales. Not the shots of a
   * story or a music video — those are cut together and continued from one
   * another, and must keep the size the chain renders at.
   */
  const singleClip = job.storyId === undefined && job.clipId === undefined
    && (job.action === 'video' || job.action === 'loop' || job.action === 'upscale')
  if (singleClip) {
    for (const file of files) {
      if (file.kind !== 'video') continue
      const made = await probePixels(file.path, 'video')
      const frame = 'width' in made ? exactVideoFrame(made.width, made.height) : undefined
      if (frame !== undefined) await snapClip(file.path, frame)
    }
  }
  if (job.action === 'generate' || job.action === 'remix' || job.action === 'bg') {
    const target = job.action === 'remix' || job.action === 'bg'
      ? (job.source === undefined ? undefined : await run.pixelsOf(join(outputDir, job.source), 'image').then(p => ('width' in p ? p : undefined)))
      : parseSize(job.size)
    if (target !== undefined) {
      for (const file of files) {
        if (file.kind === 'image') await snapStill(file.path, { width: target.width, height: target.height })
      }
    }
  }
}

/**
 * The job with the caption the plan carries now, when the run started without
 * one.
 *
 * A story's shot is handed its caption when its turn comes, and on a plan the
 * director left without captions the fallback reply lands later — while the
 * clip is rendering. The plan is read once more here so that shot is filed with
 * its caption: the note outlives the job, and the Details card reads it.
 * @param job - the run's working copy.
 * @returns the same job, or the job with the caption the plan now carries.
 */
async function withStoryCaption(job: ImagineJob): Promise<ImagineJob> {
  if (job.caption !== undefined || job.redo !== undefined || job.storyId === undefined
    || job.storyIndex === undefined) {
    return job
  }
  const caption = await storyCaption(job)
  return caption === undefined ? job : { ...job, caption: caption.text, captionLanguage: caption.language }
}

/**
 * The terminal write: the prompt filed under the clip, the story's record,
 * the origin of every file, the stills queued for a look, the job marked done
 * on the live copy, and the files put on the board.
 */
async function writeResult(run: FinishRun, files: readonly ComfyProducedFile[]): Promise<void> {
  const { ctx, outputDir, shot, lipsync } = run
  /*
   * The caption this shot is filed with is the one the plan carries now, not
   * the one it carried when the run started: on a plan the director left
   * without captions, the fallback reply lands while the clip renders (see
   * `fillMissingCaptions`), and this is the only copy of it that outlives the
   * job. Read off the plan for that case alone — a job that already has a
   * caption (the director's, a redo's own line) keeps it.
   */
  const job = await withStoryCaption(run.job)
  // A cancel decided while the run was settling wins: the user asked for it
  // to stop, and a late "done" would put a file they cancelled on the board.
  // So does the deadline's error: the queue has already moved on.
  if (isSettled(job.id)) return
  /*
   * File the prompt under the name of the clip it produced: the job map is
   * pruned, and a clip continued tomorrow would otherwise have no soundtrack
   * to carry.
   */
  if (run.writtenPrompt !== undefined) {
    const produced = files.find(file => file.kind === 'video')
    if (produced !== undefined) await rememberWrittenPrompt(basename(produced.path), run.writtenPrompt)
  }
  if (shot !== undefined && job.redo === undefined) {
    const shotFile = files.find(file => shotOfFileName(basename(file.path)) !== undefined)
    const finalFile = files.find(file => file.kind === 'video' && shotOfFileName(basename(file.path)) === undefined)
    await updateStoryShot(shot.storyId, shot.index, {
      ...shotFile === undefined ? {} : { file: basename(shotFile.path) },
      prompt: job.prompt,
      ...job.caption === undefined || job.captionLanguage === undefined
        ? {}
        : { caption: job.caption, captionLanguage: job.captionLanguage },
      ...lipsync === undefined ? {} : { lipsync },
    }).catch(() => undefined)
    if (finalFile !== undefined) {
      await updateStoryManifest(shot.storyId, current => ({ ...current, finals: [basename(finalFile.path), ...current.finals] }))
        .catch(() => undefined)
    }
  }
  /*
   * File how each produced file was made, and have the stills looked at.
   * The job is pruned from memory half an hour from now; the note is what
   * the chat reads when a line says "rifai queste foto in 9:16", and the
   * look is what lets it say what is in them without waiting.
   */
  const producedNames = files.map(file => basename(file.path))
  /*
   * How long this file was in the making: from the moment the run took the
   * GPU, not from when it was queued — a batch of shots waits its turn, and
   * the last one would otherwise claim an hour it spent queued. Read off the
   * live job, which is where the runner recorded it.
   */
  const startedAt = getImagineJob(job.id)?.startedAt ?? job.createdAt
  const tookMs = Math.max(0, Date.now() - startedAt)
  await Promise.all(producedNames.map(name => rememberOrigin(name, {
    action: job.action,
    prompt: job.prompt,
    ...job.aspectRatio === undefined ? {} : { aspect: job.aspectRatio },
    ...job.size === undefined ? {} : { resolution: job.size },
    ...job.seconds === undefined ? {} : { seconds: job.seconds },
    ...job.source === undefined ? {} : { source: job.source },
    ...job.caption === undefined || job.captionLanguage === undefined
      ? {}
      : { caption: job.caption, captionLanguage: job.captionLanguage },
    ...lipsync === undefined || shotOfFileName(name) === undefined ? {} : { lipsync },
    tookMs,
  })))
  const producedStills = files.filter(file => file.kind === 'image').map(file => basename(file.path))
  if (producedStills.length > 0) {
    lookSoon(ctx, outputDir, producedStills)
    // «Segments», as on Grok: ready before the photo is opened.
    segmentSoon(ctx, outputDir, producedStills)
  }
  patchJob(job.id, {
    status: 'done',
    updatedAt: Date.now(),
    files: files.map(file => ({ name: basename(file.path), kind: file.kind })),
  })
  /*
   * Into the project on the host too, not only in the browser: the browser
   * folds a job's files while the job is in memory, and a montage's last
   * shot lands after the tab that queued it is gone. An upscale is left to
   * the browser, which puts it in place of its source rather than beside it.
   */
  if (job.action !== 'upscale') {
    await adoptJobFiles(job.id, producedNames).catch(() => undefined)
  }
}
