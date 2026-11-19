/**
 * Starting work: a run from the composer, a panel, a tile or the chat's
 * reading; a batch of upscales; one run per value of a card's batch control;
 * a written line read and answered. Split out of ImaginePage.tsx (2026-10-25).
 *
 * The functions are made again on every render and read that render's state,
 * as they did in the page. What the composer holds is read from its store at
 * the moment of the call.
 * @module use-runner
 */

import type { Dispatch, SetStateAction } from 'react'
import type { ImagineChatIntent, WorkflowProposal } from '../../../shared/imagine-chat.ts'
import type { AgentPending } from '../../../shared/agent-chat.ts'
import { aspectFor, upscaleBlocked, type ImagineAspect, type ImagineResolution } from '../../../shared/imagine-media.ts'
import type { ImagineProject } from '../../../shared/imagine-projects.ts'
import {
  type GalleryItem, type ImagineAction, type ImagineJobView as ImagineJob, type ImagineObjectMode,
  type ImaginePlacement, type ImagineQuality, type ImagineRegion, type ImagineSpeed,
} from '../../../shared/imagine-types.ts'
import type { ComposerStore } from './composer-store.ts'
import { applyWorkflowChanges, confirmAgentChat, fetchImagineJobs, readAgentChat, runTemplate, startImagineJob } from './gallery-api.ts'
import { SEED_MESSAGE_PREFIX, appendMessage, createProject, isSeedMessage, rememberJob, titleFromPrompt } from './imagine-projects.ts'
import { HISTORY_PROJECT_ID } from '../../../shared/imagine-projects.ts'
import {
  STORY_MIN_SECONDS, clampResolution, clampStorySeconds, editSizeFor, isStoryLength, megapixelsFor, sizeFor,
  canvasMegapixelsFor, swapResolutionOf, videoAspectLabel, clampSeconds,
} from './imagine-settings.ts'
import { isChatHostAction } from '../../../shared/imagine-chat.ts'
import { IOPAINT_PLUGIN, pluginEnabled } from './plugin-presence.ts'
import { postJson } from './http.ts'
import { removalMask } from './erase-mask.ts'
import { STORY_MINUTES_PER_CLIP, nextThoughtId, noteFromError, thoughtOf } from './imagine-messages.ts'
import { slotsOf } from './job-cards.ts'
import { relightLookOf } from '../../../shared/relight-looks.ts'
import { jobProgress } from './job-progress.tsx'
import type { ImaginePageProps } from './props.ts'
import type { TraceStore } from './reading-trace.ts'
import type { PickedGroups } from './SelectionTools.tsx'
import { pickUpscaleStep } from './upscale-choices.ts'
import type { ProjectNaming } from './use-project-naming.ts'
import type { WorkflowSpec } from './workflow-specs.ts'
import { translate } from './locale-store.ts'
import { ACTION_TRAITS, inputKindOf } from './action-traits.ts'

/**
 * What a run takes instead of the composer's state.
 *
 * Inside a project the composer holds nothing but the text, so the written
 * line is what carries the ratio, the step and the duration. They arrive here
 * because the reading and the run happen in the same event, and from controls
 * far from the composer (a tile, a dialog, a scan's picker).
 */
export interface RunOverride {
  /** `custom` only: which uploaded workflow to run. */
  customWorkflowId?: string
  /** `custom` only: the card's own controls, keyed `<node>.<field>`. */
  customFields?: Readonly<Record<string, unknown>>
  /** `custom` only: the card's file slots, keyed by node id (gallery names). */
  customFiles?: Readonly<Record<string, string>>
  /** Upscale only: the short side the user picked in the upscale menu. */
  upscaleTo?: number
  /** The «Quality» pill's photo half, when the written line chose it. */
  quality?: ImagineQuality
  /** The same pill's clip half (the slower, higher-quality recipe). */
  speed?: ImagineSpeed
  /** Remix only: the zone "Precise edit" marked on the photo. */
  region?: ImagineRegion
  /**
   * Remix only: the thing the zone was grounded on, when the reading found it.
   *
   * Set only with `grounded`: the server cuts the object's own outline with
   * SAM 3 instead of regenerating the whole rectangle.
   */
  target?: string
  /** Video only: the photo the clip arrives at. */
  lastSource?: string
  /** The second photo (object swap, composition), when the caller named one rather than staging it. */
  reference?: GalleryItem
  /**
   * The canvas area the run was queued with.
   *
   * The picker of "Recreate video" sends the recreation with the canvas its
   * scan recorded, not with what the composer has been set to since: the click
   * on a frame comes minutes later, from another part of the page.
   */
  megapixels?: number
  /** A recreation only: keep the reference clip's own soundtrack. */
  keepAudio?: boolean
  /** A character swap only: false turns lip-sync off. */
  lipSync?: boolean
  /** `objectSwap` only: which of the four recipes runs. */
  objectMode?: ImagineObjectMode
  /** `objectSwap` → `add`: the box the new object goes into. */
  placement?: ImaginePlacement
  /** `relight` only: the light look to paint, by slug. */
  light?: string
  /**
   * A recreation only: the opening frame the scan drew and the user clicked.
   *
   * Handed back so the run draws nothing and renders from that picture — the
   * request carries `frame`, which the host already honours on a retry.
   */
  frame?: GalleryItem
  /** Remix only: a zone painted with the brush, as a PNG data URL. */
  mask?: string
  prompt?: string
  /** The voice a `voice` run sings its source with, and its pitch shift. */
  voice?: string
  pitch?: number
  aspect?: ImagineAspect
  resolution?: ImagineResolution
  seconds?: number
  count?: number
  lyrics?: string
  source?: GalleryItem
  /**
   * One photo per shot: a long video cut together rather than grown from one
   * still. `source` is the single take's opening frame; these are a montage's
   * pictures, in the order they play.
   */
  sources?: readonly string[]
  song?: GalleryItem
  /** The user's line is already in the column, so the run must not repeat it. */
  quiet?: boolean
  /** The line the column shows for the run, when it is not the prompt itself. */
  line?: string
  /** The title of the project the run opens, when it is not made from the prompt. */
  title?: string
  /**
   * The project as the caller has it, messages and all.
   *
   * `current` is the render's copy, and the written lane has already added two
   * lines to the project since that render: reading it here and saving it
   * again wrote those lines back out of existence.
   */
  project?: ImagineProject
  /**
   * The run comes from a written line rather than from a control.
   *
   * A refusal from the lane has to reach the column: the composer's note sits
   * under the conversation, and a note there is what the user does not see
   * while waiting for a run that never started.
   */
  lane?: boolean
}

/**
 * The extras a run sends, as `startImagineJob` declares them (the recipe's
 * speed and quality and the recreation's chosen frame included).
 */
type JobExtras = NonNullable<Parameters<typeof startImagineJob>[3]>

/** What the runner reads of the page, current on every render. */
export interface RunnerContext {
  readonly actions: ImaginePageProps['actions']
  readonly view: string
  readonly projectId: string | undefined
  readonly projects: readonly ImagineProject[]
  readonly current: ImagineProject | undefined
  readonly composer: ComposerStore
  readonly busy: string | undefined
  readonly setBusy: Dispatch<SetStateAction<string | undefined>>
  readonly reading: boolean
  readonly setReading: Dispatch<SetStateAction<boolean>>
  /** The reading in flight, so the column can give up on it. */
  readonly readingRef: { current: AbortController | undefined }
  readonly trace: TraceStore
  readonly editJobs: (update: (current: readonly ImagineJob[]) => readonly ImagineJob[]) => void
  readonly patch: (project: ImagineProject) => ImagineProject
  readonly naming: ProjectNaming
  /** The open board's files, newest first. */
  readonly visible: readonly GalleryItem[]
  /** The open project's runs still going. */
  readonly ownLive: readonly ImagineJob[]
  readonly jobs: readonly ImagineJob[]
  readonly allByName: ReadonlyMap<string, GalleryItem>
  readonly pickedGroups: PickedGroups
  readonly setPicked: Dispatch<SetStateAction<readonly string[]>>
  readonly proposal: WorkflowProposal | undefined
  readonly setProposal: Dispatch<SetStateAction<WorkflowProposal | undefined>>
  /** The work the agent stopped before doing, waiting for a yes. */
  readonly pending: AgentPending | undefined
  readonly setPending: Dispatch<SetStateAction<AgentPending | undefined>>
  /** Open the music-video form. */
  readonly openClip: () => void
  /**
   * Read the gallery again from the host.
   *
   * A host edit (the eraser, a track laid over a clip) writes a file outside
   * the job queue, so nothing else tells the board it exists.
   */
  readonly reloadGallery: () => Promise<void>
}

export function useRunner(ctx: RunnerContext) {
  const {
    actions, view, projectId, projects, current, composer, busy, setBusy, reading, setReading, readingRef,
    trace, editJobs, patch, naming, visible, ownLive, jobs, allByName, pickedGroups, setPicked, proposal, setProposal,
    pending, setPending, reloadGallery,
  } = ctx
  const setNote = (note: string | undefined): void => { composer.set({ note }) }

  /**
   * Give a freshly created project its title as a first line, so the rail
   * (which hides content-less projects) shows it immediately. The line is not
   * shown in the chat column: see `isSeedMessage`.
   * @param project - the new project.
   * @returns the project with a seed message.
   */
  const seedProject = (project: ImagineProject): ImagineProject =>
    appendMessage(project, {
      id: `${SEED_MESSAGE_PREFIX}${project.id}`,
      role: 'status',
      text: project.title,
      createdAt: Date.now(),
    })

  const openOrCreate = (title: string): ImagineProject => {
    if (current !== undefined) return current
    const existing = projects.find(project =>
      project.id !== HISTORY_PROJECT_ID && project.title === title)
    if (existing !== undefined) {
      actions.openProject(existing.id)
      return existing
    }
    // The title here is always the studio's own placeholder — a truncated
    // first line, a card label, an untitled number — so the project is born
    // with the flag that lets its first content replace it with a real name.
    const project = seedProject(createProject(title, true))
    actions.upsertProject(project)
    actions.openProject(project.id)
    return project
  }

  /**
   * Queue one job and file it in a project: the job into the queue at once,
   * its id into the project, and the user's line for it into the column.
   * @param project - the project the job belongs to.
   * @param line - the line the column shows for it, and the files it was sent with; none for a quiet run.
   * @returns the job and the project as it now is.
   */
  const queueJob = async (
    project: ImagineProject,
    action: ImagineAction,
    text: string,
    source: string | undefined,
    extras: JobExtras | undefined,
    line: { text: string; files?: readonly GalleryItem[] } | undefined,
  ): Promise<{ job: ImagineJob; project: ImagineProject }> => {
    const job = await startImagineJob(action, text, source, extras)
    jobProgress.take([job])
    editJobs(currentJobs => [job, ...currentJobs.filter(entry => entry.id !== job.id)])
    let next = rememberJob(project, job.id)
    if (line !== undefined) {
      next = appendMessage(next, {
        id: `m-${job.id}`,
        role: 'user',
        text: line.text,
        createdAt: Date.now(),
        jobId: job.id,
        ...line.files === undefined || line.files.length === 0
          ? {}
          : { files: line.files.map(item => ({ name: item.name, kind: item.kind })) },
      })
    }
    patch(next)
    return { job, project: next }
  }

  const run = async (action: ImagineAction, from?: GalleryItem, over?: RunOverride): Promise<ImagineProject | undefined> => {
    // The one gate every start passes through. The send button's `disabled`
    // covers neither Enter in the textarea nor the tile's floating chips, so
    // two presses inside one round trip queued two jobs on a serial GPU with
    // no way to cancel either, and from the home view they also created two
    // projects with the same title.
    if (busy !== undefined) return
    const state = composer.get()
    const { sources } = state
    const traits = ACTION_TRAITS[action]
    /*
     * Every control the toolbar used to hold can arrive from the written line
     * instead, so each one is read from the override first and from the
     * composer second.
     */
    /*
     * The ratio is re-read against the run's surface (2026-11-03): a photo
     * ratio picked as "Cinematic" does not exist on the video node, and the
     * "Speed" recipe offers fewer ratios than "Quality". What is sent is
     * always a ratio the graph accepts.
     */
    const liveQuality = over?.quality ?? state.quality
    const liveSpeed = over?.speed ?? state.speed
    const liveAspect = aspectFor(
      over?.aspect ?? state.aspect,
      traits.ladder,
      liveQuality,
    )
    const liveSeconds = over?.seconds ?? state.seconds
    const written = over?.prompt ?? state.prompt
    // A redo carries only what should change in the shot; nothing means the
    // same beat again, and the composer's line is not that. A resume changes
    // nothing at all.
    const text = traits.ownLineOnly === true
      ? (over?.prompt ?? '').trim()
      : written.trim() || (traits.emptyLine ?? '')
    if (traits.promptOptional !== true && text.length === 0) {
      setNote(translate('imagine.needPrompt'))
      return
    }
    /*
     * A long video takes two staged files, not one: the picture or clip it
     * starts from, and the song it is cut to.
     */
    const song = over?.song ?? (action === 'story' ? sources.find(item => item.kind === 'audio') : undefined)
    /*
     * An object swap and a composition read two staged files, and the second
     * is not "the first one picked": it travels beside the source, so it is
     * found by kind however it was staged. Named by the caller first, staged
     * otherwise.
     */
    const reference = traits.reference === 'staged'
      ? over?.reference ?? sources.find(item => item.kind === 'image' && item.name !== from?.name)
      : traits.reference === 'named' ? over?.reference : undefined
    const overClip = over?.source?.kind === 'video' ? over.source : undefined
    const input = traits.input === 'clip'
      ? overClip ?? (from?.kind === 'video' ? from : undefined) ?? sources.find(item => item.kind === 'video')
      : over?.source ?? (action === 'story'
        ? from ?? sources.find(item => item.kind === 'image' || item.kind === 'video')
        : from ?? sources[0])
    const needs = inputKindOf(action)
    if (needs !== undefined && (input === undefined || input.kind !== needs)) {
      setNote(translate(needs === 'image' ? 'imagine.needImage' : 'imagine.needVideo'))
      return
    }
    // "Compose" wants two different photos: the person and the reference.
    if (action === 'compose' && (input === undefined || input.kind !== 'image' || reference === undefined || reference.name === input.name)) {
      setNote(translate('imagine.needImageAndReference'))
      return
    }
    if (action === 'upscale') {
      if (input === undefined || input.kind === 'audio') {
        setNote(translate('imagine.needSource'))
        return
      }
      if (input.width !== undefined && input.height !== undefined && upscaleBlocked(input.kind, input.width, input.height)) {
        setNote(input.kind === 'video' ? translate('imagine.already1080') : translate('imagine.already4k'))
        return
      }
    }
    setNote(undefined)
    setBusy(action)
    const liveResolution = clampResolution(traits.ladder, over?.resolution ?? state.resolution)
    const liveLyrics = over?.lyrics ?? state.lyrics
    const extras = ((): JobExtras => {
      switch (action) {
        case 'story':
          return {
            aspectRatio: videoAspectLabel(liveAspect),
            megapixels: megapixelsFor(liveResolution),
            // The opening frame is a still, and it is generated at the ratio the
            // whole video is rendered in.
            size: sizeFor(liveAspect, liveResolution),
            // A video with a song on it lasts as long as the song, so the length
            // the composer is showing is not sent at all.
            ...song === undefined ? { seconds: clampStorySeconds(liveSeconds) } : { song: song.name },
            /*
             * The photos a videoclip cuts between. Without them a story grows one
             * still through the whole video, and a project holding eight pictures
             * gets a video made from one.
             */
            ...over?.sources === undefined || over.sources.length < 2 ? {} : { sources: over.sources },
            /*
             * Lyrics with no track go to the clips themselves: the video model
             * writes its own audio and sings the words it is given. With a song
             * they are already in that file, and a second voice over it is not
             * the ask.
             */
            ...song === undefined && liveLyrics.trim().length > 0 ? { lyrics: liveLyrics.trim() } : {},
          }
        case 'video':
        case 'loop':
        case 'extend':
          return {
            aspectRatio: videoAspectLabel(liveAspect),
            // The step decides the ladder, so a length the composer is no longer
            // showing is never the one sent. A background has a ladder of its
            // own: it reaches the minute, and past ten seconds the studio renders
            // the segments and joins them.
            seconds: clampSeconds(action === 'loop' ? 'loop' : 'video', liveResolution, liveSeconds),
            megapixels: megapixelsFor(liveResolution),
          }
        case 'music':
          return {
            // A length only when the sentence said one: otherwise the writer
            // that structures the words decides how long they take to sing.
            ...over?.seconds === undefined ? {} : { seconds: over.seconds },
            lyrics: liveLyrics.trim(),
          }
        // A voice change carries no size, no length and no prompt: the track
        // it is given decides all three.
        case 'voice':
          return { voice: over?.voice, pitch: over?.pitch }
        /*
         * "Object swap": the clip decides the canvas (the composer's step is
         * the area), and the mode is the one chosen
         * in the panel. The photo travels only for `change`.
         */
        case 'objectSwap':
          return {
            swapResolution: swapResolutionOf(over?.resolution ?? state.resolution),
            objectMode: over?.objectMode ?? state.objectMode,
            ...(over?.objectMode ?? state.objectMode) !== 'add'
              ? {}
              : { placement: over?.placement ?? state.placement },
            ...reference === undefined ? {} : { reference: reference.name },
          }
        // The light decides the prompt: the look's id is sent, not a sentence.
        case 'relight':
          return { light: over?.light ?? state.light }
        // The clip decides the frame's ratio; the two controls that matter for
        // the recreation travel now and come back with the click.
        case 'scanFrame':
          return { candidates: state.frameCandidates, megapixels: canvasMegapixelsFor(liveResolution) }
        /*
         * "Regenerate detail" has no controls: the clip decides the size
         * (1.5× its sides), the length is its own, and the prompt is optional.
         * Sending the composer's `size` here would override it with an
         * unrelated canvas.
         */
        case 'regenerate':
          return {}
        // «Character swap»: the graph sizes, cuts and describes by itself; only the photo travels.
        case 'swapPerson':
          return {
            // The swaps' own ladder reaches 1080p, past the clips' 720p.
            swapResolution: swapResolutionOf(over?.resolution ?? state.resolution),
            ...reference === undefined ? {} : { reference: reference.name },
            ...(over?.lipSync ?? state.lipSync) ? {} : { lipSync: false },
          }
        // A recreation takes its canvas and its length from the clip; the one
        // thing the composer decides is where the soundtrack comes from.
        case 'recreate':
          return {
            ...(over?.keepAudio ?? state.keepAudio) ? { keepAudio: true } : {},
            // The chosen frame, when the click on a candidate is what started
            // this run: the host then skips its own drawing.
            ...over?.frame === undefined ? {} : { frame: over.frame.name },
            ...over?.megapixels === undefined ? {} : { megapixels: over.megapixels },
          }
        default: {
          if (action === 'compose') return reference === undefined ? {} : { reference: reference.name }
          /*
           * An edit keeps the photo's own shape unless the line named a
           * ratio: the graph measures the photo it is given, and a canvas
           * sent anyway is what made a 4:5 photo come back cropped. A run
           * from a control (a tile, the panel) still sends the composer's
           * canvas, which is the choice the user made there.
           */
          const namedCanvas = over?.lane !== true || over?.aspect !== undefined
          const size = editSizeFor(namedCanvas, liveAspect, liveResolution)
          return {
            ...size === undefined ? {} : { size },
            ...action === 'remix' && reference !== undefined ? { reference: reference.name } : {},
          }
        }
      }
    })()
    /*
     * The recipe (2026-11-03): "Speed" or "Quality" is a single switch, so
     * its two faces always travel together — `quality` for the photo graphs,
     * `speed` for the video ones. A workflow without the `steps` pin ignores
     * them.
     */
    const recipe: JobExtras = { quality: liveQuality, speed: liveSpeed }
    try {
      /*
       * A clip staged from several stills runs one job per file, each with the
       * prompt and the controls the composer is showing. Every other action
       * reads the single staged source. A run from the chat that names its own
       * source is that one file only: the reading already splits "3 video" over
       * 3 photos into three runs, and fanning each over the staging queued nine
       * (2026-10-18).
       */
      const inputs = action === 'video' && from === undefined && over?.source === undefined && sources.length > 1
        ? sources.filter(item => item.kind === 'image')
        : [input]
      let project = over?.project ?? openOrCreate(over?.title ?? titleFromPrompt(text) ?? translate('imagine.untitled'))
      /*
       * Content reaching a project still on a system-minted name is what the
       * reading model names it with: the line, the prompt, or the file the
       * run is about. A look settles its catalogue title as-is — it is
       * already a name, and a second author would shorten it.
       */
      if (naming.isNamingCandidate(project)) {
        const sourceForTitle = traits.titleFrom === 'lyrics'
          ? (liveLyrics.trim() || text)
          : traits.titleFrom === 'input'
            ? (input?.name ?? text)
            : text
        naming.titleIfNeeded(project, sourceForTitle)
      }
      let started: ImagineJob | undefined
      for (const target of inputs) {
        const queued = await queueJob(project, action, text, target?.name, {
          ...extras,
          ...recipe,
          /*
           * Passed as they are: an undefined field drops out of the JSON, and
           * `startImagineJob` itself leaves out a count of one. None of these
           * is set by `extras` or `recipe`, so nothing above is overwritten.
           */
          count: over?.count,
          // Only a ratio the sentence named overrides an edit's own shape.
          ...over?.lane === true && over?.aspect !== undefined ? { canvasAsked: true } : {},
          upscaleTo: over?.upscaleTo,
          region: over?.region,
          target: over?.target,
          lastSource: over?.lastSource,
          mask: over?.mask,
          customWorkflowId: over?.customWorkflowId,
          customFields: over?.customFields,
          customFiles: over?.customFiles,
          // The chip's model, so the prompts the host writes for this run — a
          // song's caption and tags, a story's beats — come from the model the
          // composer is showing rather than the one the deployment pinned.
          model: state.chatModel,
        }, over?.quiet === true
          /*
           * The written lane has already put the user's line in the column —
           * it goes up the moment they press send — so repeating it here would
           * show the same sentence twice, once per queued run.
           */
          ? undefined
          // The staged files go up with the line: a request sent with a photo
          // pinned showed the sentence alone once the composer emptied.
          : { text: over?.line ?? text, files: sources })
        started = queued.job
        project = queued.project
      }
      /**
       * Put the host's queued jobs that belong with `started` on the project,
       * beside it; how many there were.
       */
      const adoptQueued = (queue: readonly ImagineJob[], belongs: (entry: ImagineJob) => boolean): number => {
        const queued = queue.filter(entry => belongs(entry) && entry.id !== started?.id)
        if (queued.length === 0) return 0
        editJobs(currentJobs => [
          ...queued,
          ...currentJobs.filter(entry => !queued.some(job => job.id === entry.id)),
        ])
        for (const job of queued) project = rememberJob(project, job.id)
        patch(project)
        return queued.length
      }
      const storyId = started?.storyId
      const batchId = started?.batchId
      // One read of the queue serves both: a story and a batch.
      const queue = storyId === undefined && batchId === undefined
        ? []
        : await fetchImagineJobs().catch((): readonly ImagineJob[] => [])
      /*
       * A story answers with its first clip only, and the rest are queued
       * behind it: without this the project would remember one tile and the
       * other five would generate off-screen.
       */
      if (storyId !== undefined) {
        const adopted = adoptQueued(queue, entry => entry.storyId === storyId)
        const clips = started?.storyCount ?? adopted + 1
        setNote(translate('imagine.storyStarted', {
          count: String(clips),
          minutes: String(Math.round(clips * STORY_MINUTES_PER_CLIP)),
        }))
      }
      /*
       * A batch is one request and several runs: `count: 3` makes three jobs on
       * the host with different seeds, and the answer names only the first.
       * Until 2026-11-04 the other two were queued and their files landed in
       * the gallery, but the project remembered one tile and the chat one
       * result — so "make 3 photos" produced one photo where it stood. The
       * siblings travel together through `batchId`, like a story's clips.
       */
      if (batchId !== undefined) adoptQueued(queue, entry => entry.batchId === batchId)
      if (projectId !== project.id) actions.openProject(project.id)
      composer.set({ prompt: '' })
      if (traits.keepsStaging !== true) composer.set({ sources: [] })
      // What the project became, so a caller queueing a second run from the
      // same turn builds on the jobs and the lines this one just added.
      return project
    } catch (error: unknown) {
      const message = noteFromError(error)
      setNote(message)
      /*
       * A run the written lane asked for and did not get reports into the
       * column as well: a refusal that only lands under the composer reads as
       * a run still coming (measured 2026-10-17).
       */
      if (over?.lane === true) {
        const into = over.project ?? current
        if (into !== undefined) {
          patch(appendMessage(into, {
            id: `e-${String(Date.now())}`,
            role: 'status',
            text: message,
            createdAt: Date.now(),
          }))
        }
      }
      return undefined
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * "All poses", for a card that declares a batch control: one run per
   * value, in the same project, with the rest of the request unchanged.
   *
   * The first refusal stops the series: a batch that went on after an error
   * would queue runs whose outcome is already known.
   * @param workflow - the card to run.
   * @param base - prompt, controls and files of the single run.
   * @param batch - the field with N values, and the values, in order.
   */
  const runCustomBatch = async (
    workflow: { readonly id: string; readonly title: string },
    base: { readonly prompt: string; readonly customFields: Readonly<Record<string, unknown>>; readonly customFiles: Readonly<Record<string, string>> },
    batch: { readonly field: { readonly node: string; readonly field: string }; readonly values: readonly string[] },
  ): Promise<void> => {
    if (busy !== undefined || batch.values.length === 0) return
    setNote(undefined)
    setBusy('custom')
    const text = base.prompt
    let project = openOrCreate(titleFromPrompt(text) ?? workflow.title)
    if (naming.isNamingCandidate(project)) naming.titleIfNeeded(project, workflow.title)
    try {
      for (const value of batch.values) {
        const extras = {
          customWorkflowId: workflow.id,
          customFields: { ...base.customFields, [`${batch.field.node}.${batch.field.field}`]: value },
          ...Object.keys(base.customFiles).length === 0 ? {} : { customFiles: base.customFiles },
        }
        project = (await queueJob(project, 'custom', text, undefined, extras, { text: workflow.title })).project
      }
      if (projectId !== project.id) actions.openProject(project.id)
      composer.set({ prompt: '' })
    } catch (error: unknown) {
      setNote(noteFromError(error))
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * Run a home-page model («Models») and file what it started in a project,
   * as a composer run is filed.
   *
   * The home has no open project (`go('home')` clears it), so a model run
   * gets one the way a new composer run does (`openOrCreate`): the open
   * project when there is one, else the project already named after the
   * model, else a new one. A new project is minted here but put in the rail
   * only once the server has started something: created first, a refused
   * form would leave an empty project (the page purges those) and the panel
   * would close on its own error. Its id goes with the request, so the
   * server adopts the jobs, the files they read and the composed files into
   * it, the chain steps included as they are queued later.
   *
   * The jobs queued now get their live tiles at once (the queue is read for
   * them, as a batch's siblings are) and the composed files are listed in the
   * project; the chain steps queued later arrive through the live tick, like
   * any job of another session filed in a project.
   * @param template - the model's id and the title its project takes.
   * @param request - the answers and the gallery files of each photo field.
   * @returns whether anything started, and the server's sentence when the run
   *   stopped half way; a refusal is thrown, with nothing started.
   */
  const runTemplateForm = async (
    template: { readonly id: string; readonly title: string },
    request: { readonly values: Record<string, string | string[]>; readonly files: Record<string, string[]> },
  ): Promise<{ readonly started: boolean; readonly error?: string }> => {
    if (busy !== undefined) return { started: false }
    setBusy('template')
    try {
      const existing = current ?? projects.find(project =>
        project.id !== HISTORY_PROJECT_ID && project.title === template.title)
      const base = existing ?? seedProject(createProject(template.title, true))
      const answer = await runTemplate(template.id, { ...request, projectId: base.id })
      const error = answer.error === undefined ? {} : { error: answer.error }
      if (answer.jobs.length === 0 && answer.files.length === 0) return { started: false, ...error }
      const queue = answer.jobs.length === 0 ? [] : await fetchImagineJobs().catch((): readonly ImagineJob[] => [])
      const started = queue.filter(job => answer.jobs.includes(job.id))
      if (started.length > 0) {
        jobProgress.take(started)
        editJobs(currentJobs => [...started, ...currentJobs.filter(entry => !started.some(job => job.id === entry.id))])
      }
      let next = base
      for (const id of answer.jobs) next = rememberJob(next, id)
      const fresh = answer.files.filter(name => !next.itemNames.includes(name))
      if (fresh.length > 0) next = { ...next, itemNames: [...next.itemNames, ...fresh] }
      if (existing === undefined) actions.upsertProject(next)
      else patch(next)
      // A run that stopped half way stays on its panel, which says so; the
      // runs that did start are already in the project, in the rail.
      if (answer.error === undefined && projectId !== next.id) actions.openProject(next.id)
      return { started: true, ...error }
    } finally {
      setBusy(undefined)
    }
  }

  /** The upscale of every picked file the upscale can still raise, one job each. */
  const runBatchUpscale = async (upscaleTo?: { image?: number; video?: number }): Promise<void> => {
    const targets = pickedGroups.upscalable
    if (targets.length === 0 || busy !== undefined) return
    setNote(undefined)
    setBusy('upscale')
    let project = openOrCreate(translate('imagine.upscale'))
    // The files themselves are the content the project gets named from.
    if (naming.isNamingCandidate(project)) naming.titleIfNeeded(project, targets[0]?.name ?? '')
    try {
      for (const item of targets) {
        // A still the chosen step would not grow (already past it) keeps the default target.
        const choice = pickUpscaleStep(item, item.kind === 'video' ? upscaleTo?.video : upscaleTo?.image, false)?.short
        project = (await queueJob(project, 'upscale', 'upscale', item.name,
          choice === undefined ? undefined : { upscaleTo: choice },
          { text: translate('imagine.batchLine', { name: item.name }) })).project
      }
      if (projectId !== project.id) actions.openProject(project.id)
      setPicked([])
    } catch (error: unknown) {
      setNote(noteFromError(error))
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * Put a file the host made outside the job queue on the board.
   *
   * The eraser and the audio lay-over answer with a gallery file, not with a
   * job: nothing else would tell the board about it, so the gallery is read
   * again and the tile placed where a run's own file would go.
   * @param item - the file the host made.
   * @param into - the project as the lane has it.
   * @returns the project with the file on its board.
   */
  const placeHostFile = async (item: GalleryItem, into: ImagineProject): Promise<ImagineProject> => {
    await reloadGallery()
    actions.regrid([item.name])
    return patch(into.itemNames.includes(item.name) ? into : { ...into, itemNames: [...into.itemNames, item.name] })
  }

  /**
   * Run one host edit the reading asked for.
   *
   * `erase` is «Remove object» (IOPaint's LaMa), with the mask drawn from the
   * box the reading grounded: grown and softened, so the fill meets the
   * surroundings instead of leaving a halo. `addAudio` lays a track already in
   * the gallery over a clip that is already there. Neither queues a job.
   * @param intent - the host edit out of the reading.
   * @param into - the project as the lane has it.
   * @returns the project with the new file on its board.
   */
  const runHostEdit = async (intent: ImagineChatIntent, into: ImagineProject): Promise<ImagineProject> => {
    const named = (name: string | undefined): GalleryItem | undefined => name === undefined ? undefined : allByName.get(name)
    const source = named(intent.source)
    try {
      if (intent.action === 'erase') {
        if (source === undefined || source.kind !== 'image') {
          setNote(translate('imagine.needImage'))
          return into
        }
        if (pluginEnabled(IOPAINT_PLUGIN) === false) {
          setNote(translate('imagine.erasePluginOff'))
          return into
        }
        if (intent.region === undefined) {
          setNote(translate('imagine.eraseNoZone'))
          return into
        }
        setBusy('erase')
        const mask = await removalMask(source, intent.region)
        if (mask === undefined) {
          setNote(translate('imagine.needImage'))
          return into
        }
        const item = await postJson<GalleryItem>('/plugin/iopaint/erase', { name: source.name, mask }, 'erase')
        return await placeHostFile(item, into)
      }
      const track = named(intent.song)
      if (source === undefined || source.kind !== 'video' || track === undefined || track.kind !== 'audio') {
        setNote(translate('imagine.needVideo'))
        return into
      }
      setBusy('addAudio')
      const item = await postJson<GalleryItem>('/api/add-audio', { name: source.name, track: track.name }, 'add audio')
      return await placeHostFile(item, into)
    } catch (error: unknown) {
      setNote(noteFromError(error))
      return into
    } finally {
      setBusy(undefined)
    }
  }

  /**
   * Start one run the reading asked for.
   *
   * The reading names files and ladder steps as strings; they become the same
   * values the toolbar used to send, and anything the reading left out keeps
   * whatever the project was already using. A name the studio does not have is
   * dropped rather than sent.
   * @param intent - one run out of the reading.
   * @param into - the project as the lane has it.
   * @returns the project as the run left it.
   */
  const runIntent = async (intent: ImagineChatIntent, into: ImagineProject): Promise<ImagineProject | undefined> => {
    /*
     * The two host edits run on the host's own routes: no graph is queued and
     * no job is created, so they do not go through `run`.
     */
    if (isChatHostAction(intent.action)) return await runHostEdit(intent, into)
    const named = (name: string | undefined): GalleryItem | undefined => name === undefined ? undefined : allByName.get(name)
    const source = named(intent.source)
    const song = named(intent.song)
    const reference = named(intent.reference)
    const asked = intent.seconds
    /*
     * A clip the studio cannot render as one run becomes a chain, whatever the
     * reading called the action. Two ways to get there: a duration past the
     * longest single clip, and a video asked for from nothing — `video` needs
     * a still to animate and would be refused, while the chain generates its
     * own opening frame and then animates that.
     */
    const startsFrom = source ?? composer.get().sources.find(item => item.kind === 'image' || item.kind === 'video')
    /*
     * Since 2026-11-15 one long take from one picture stays `video`: the
     * studio renders it as a chain of scenes of at most six seconds
     * (createVideoChain). The story is for a video cut on a song, from
     * several pictures, or from nothing.
     */
    const sung = intent.song !== undefined || composer.get().sources.some(item => item.kind === 'audio')
    const cutOrSung = sung || (intent.sources?.length ?? 0) > 1
    /*
     * A track staged or named is the video's length (2026-11-16), whatever
     * the sentence or the reading said: the story is cut to the song and
     * sings it. Before, a reading that wrote no length (or a short one) sent a
     * single six-second clip and the rest of the track was never animated.
     */
    const chained = intent.action === 'video'
      && (sung || (asked !== undefined && asked >= STORY_MIN_SECONDS && cutOrSung) || startsFrom === undefined)
    const over: RunOverride = {
      prompt: intent.prompt,
      quiet: true,
      // What this run refuses has to come back to the column, not only to the
      // composer: the caller is the written lane.
      lane: true,
      project: into,
      /*
       * What the reading left out stays undefined, and `run` reads every one
       * of these with `??` or an `=== undefined` test: an absent field falls
       * back to the composer exactly as a missing key would.
       */
      aspect: intent.aspect as ImagineAspect | undefined,
      resolution: intent.resolution as ImagineResolution | undefined,
      seconds: asked,
      count: intent.count,
      lyrics: intent.lyrics,
      // A single name is not a montage: the run then reads `source`.
      ...intent.sources === undefined || intent.sources.length < 2 ? {} : { sources: intent.sources },
      voice: intent.voice,
      pitch: intent.pitch,
      source,
      song,
      reference,
      keepAudio: intent.keepAudio,
      lipSync: intent.lipSync,
      // "Object swap": the recipe read from the sentence, which the panel does
      // not see (the line is written in the column; the composer is not involved).
      objectMode: intent.objectMode,
      light: intent.light,
      quality: intent.quality,
      speed: intent.speed,
      upscaleTo: intent.upscaleTo,
      region: intent.region,
      // Only a zone the host grounded keeps the name it was found by: a
      // rectangle the user marked has no object to cut out.
      target: intent.grounded === true ? intent.target : undefined,
      customWorkflowId: intent.customWorkflowId,
      customFields: intent.customFields,
    }
    return await run(chained ? 'story' : intent.action, undefined, over)
  }

  /**
   * Send one written line: read it, say something back, and run what it asked.
   *
   * The line goes into the column first and the reading follows, so the chat
   * behaves like a chat even when the model takes a few seconds. A reading
   * that queues nothing is a conversation turn and leaves the studio exactly
   * as it was, saying so.
   * @param text - the line to read.
   * @param echo - whether to write the line into the column first; a retry of
   * a line that is already there does not.
   */
  const sendLine = async (text: string, echo: boolean): Promise<void> => {
    if (text.length === 0 || busy !== undefined || reading) return
    setNote(undefined)
    const state = composer.get()
    let project = openOrCreate(titleFromPrompt(text) ?? translate('imagine.untitled'))
    // The line the project is being born from names it; the ask is fire and
    // forget and a project the user already named never comes back to it.
    naming.titleIfNeeded(project, text)
    if (echo) {
      const at = Date.now()
      // The line keeps what it was written about: with the composer emptied
      // after the run, a bare "redo this one in 9:16" read as context-free.
      const files = state.sources.map(item => ({ name: item.name, kind: item.kind }))
      project = appendMessage(project, {
        id: `w-${String(at)}`,
        role: 'user',
        text,
        createdAt: at,
        ...files.length === 0 ? {} : { files },
      })
      patch(project)
    }
    const controller = new AbortController()
    readingRef.current = controller
    setReading(true)
    trace.set([])
    // The whole of the thinking, to keep with the answer once it comes.
    let thinking = ''
    /*
     * Thinking arrives one delta at a time and steps arrive whole, so a delta
     * grows the line already open instead of starting a new one: the column
     * shows a paragraph being written, not a stack of syllables.
     */
    const note = (event: Parameters<typeof thoughtOf>[0]): void => {
      if (event.kind === 'reasoning') thinking += event.text
      trace.set((thoughts) => {
        if (event.kind === 'reasoning') {
          const last = thoughts[thoughts.length - 1]
          return last?.kind === 'reasoning'
            ? [...thoughts.slice(0, -1), { id: last.id, kind: 'reasoning', text: last.text + event.text }]
            : [...thoughts, { id: nextThoughtId(), kind: 'reasoning', text: event.text }]
        }
        const thought = thoughtOf(event)
        return thought === undefined ? thoughts : [...thoughts, thought]
      })
    }
    try {
      const answer = await readAgentChat({
        text,
        // The agent queues the runs itself: the project it files them in has to
        // be named here, the way the MCP names it.
        projectId: project.id,
        history: project.messages
          .filter(message => message.role === 'user' || message.role === 'assistant')
          .slice(-8)
          .map(message => ({
            role: message.role === 'user' ? 'user' as const : 'assistant' as const,
            // The files a line was sent with are part of what it said: a
            // follow-up ("that one in 9:16 too") points back at them.
            text: message.files === undefined || message.files.length === 0
              ? message.text
              : `${message.text} [file: ${message.files.map(file => file.name).join(', ')}]`,
          })),
        staged: state.sources.map(item => ({ name: item.name, kind: item.kind })),
        // What the board is showing, newest first: "the last video" has to
        // name a file, and the reading can only name one it was given.
        recent: visible.slice(0, 80).map(item => ({ name: item.name, kind: item.kind })),
        // What the studio last reported, which is not part of the
        // conversation and is the only thing that can answer "why did it
        // fail?": the failure never passed through the chat at all.
        events: project.messages.filter(message => message.role === 'status' && !isSeedMessage(message)).slice(-6).map(message => message.text),
        ...state.chatModel === undefined ? {} : { model: state.chatModel },
        /*
         * «Remove object» is a plugin, and the page is the only side that
         * knows whether it is mounted: without it a line that asks for a
         * watermark to come out is told so, instead of the client POSTing to
         * a route that does not exist.
         */
        eraseTool: pluginEnabled(IOPAINT_PLUGIN) !== false,
        /*
         * The runs of this project still going: "Is it running?" is asked in
         * this column, and the reading had no state to answer from
         * (2026-10-17). The list is the one the canvas tiles are drawn from.
         */
        working: ownLive.map((job) => {
          const progress = jobProgress.get(job.id)?.progress
          return {
            action: job.action,
            status: job.status === 'running' ? 'running' as const : 'queued' as const,
            ...progress?.percent === undefined ? {} : { percent: progress.percent },
            ...progress?.nodeClass === undefined ? {} : { stage: progress.nodeClass },
            ...progress?.etaSeconds === undefined ? {} : { etaSeconds: progress.etaSeconds },
          }
        }),
        /*
         * No `defaults` and no `preset`: a project's chat no longer has the
         * controls (2026-11-04), so there is no hidden choice to tell the
         * reader about. It decides ratio, resolution and length from the
         * sentence; the composer's values are only the fallback when a run
         * arrives without them.
         */
      }, controller.signal, note)
      /*
       * The trace ends with what came of it, so a reading that has finished
       * does not look like one still running. One that never read the
       * sentence keeps its line — that is the whole reason the trace outlives
       * the answer.
       */
      trace.set(thoughts => [...thoughts, answer.read
        ? { id: nextThoughtId(), kind: 'step', text: translate('imagine.thoughtDone', { count: String(answer.mode === 'agent' ? answer.jobIds.length : answer.intents.length) }) }
        : { id: nextThoughtId(), kind: 'step', text: translate('imagine.thoughtDoneUnread'), keep: true }])
      // The answer, and the thinking that led to it, folded under it. A line
      // with no text of its own is not written: a turn that stopped for a
      // confirmation has no reply yet, and writing the thinking alone left an
      // empty assistant bubble in the project (seen in F2, on story and music).
      const answeredId = `a-${String(Date.now())}`
      let spoken = false
      if (answer.reply.trim().length > 0) {
        project = appendMessage(project, {
          id: answeredId,
          role: 'assistant',
          text: answer.reply,
          createdAt: Date.now(),
          ...thinking.trim().length === 0 ? {} : { thinking: thinking.trim() },
        })
        patch(project)
        spoken = true
      }
      if (answer.mode === 'agent') {
        /*
         * The runs are already queued by the server: their ids go on the reply
         * line, so the column draws what each produced under it when it lands.
         * The page's own poll folds the finished runs in, so the result shows
         * up by itself, without the user asking again.
         */
        for (const jobId of answer.jobIds) project = rememberJob(project, jobId)
        if (answer.jobIds.length > 0 && spoken) {
          project = {
            ...project,
            messages: project.messages.map(message => message.id === answeredId
              ? { ...message, jobIds: [...new Set([...(message.jobIds ?? []), ...answer.jobIds])] }
              : message),
          }
        }
        // A file a host edit made (the eraser) has no job: it joins the board.
        const made = answer.files.map(file => file.name).filter(name => !project.itemNames.includes(name))
        if (made.length > 0) {
          await reloadGallery()
          actions.regrid(made)
          project = { ...project, itemNames: [...project.itemNames, ...made] }
        }
        patch(project)
      }
      if (projectId !== project.id) actions.openProject(project.id)
      setProposal(answer.proposal)
      setPending(answer.pending)
      if (answer.mode !== 'agent') for (const intent of answer.intents) {
        const before = project.jobIds
        const next = await runIntent(intent, project)
        if (next === undefined) continue
        project = next
        const queued = project.jobIds.filter(jobId => !before.includes(jobId))
        /*
         * The runs are what the sentence did, so the sentence keeps them: the
         * column draws their files under its prose instead of leaving them in
         * status lines that read as a separate receipt (2026-11-04). The ids
         * are written back onto the line as they are queued, one intent at a
         * time, so a run refused in the middle still leaves the ones before it
         * attached.
         */
        if (!spoken || queued.length === 0) continue
        project = {
          ...project,
          messages: project.messages.map(message => message.id === answeredId
            ? { ...message, jobIds: [...new Set([...message.jobIds ?? [], ...queued])] }
            : message),
        }
        patch(project)
      }
      /*
       * A reading that queued nothing says so, in the studio's own voice: it is
       * the difference between "the studio started something" and "the studio
       * only answered" (2026-10-17). A status line, not the reply: the
       * reader's own words are not evidence of what it did.
       */
      if (answer.pending === undefined && answer.intents.length === 0 && answer.jobIds.length === 0 && answer.files.length === 0) {
        project = appendMessage(project, {
          id: `s-${String(Date.now())}`,
          role: 'status',
          text: translate('imagine.noWorkQueued'),
          createdAt: Date.now(),
        })
        patch(project)
      }
    } catch (error: unknown) {
      // Giving up on a reading is not a failure worth reporting: the user
      // pressed the button that stops it.
      if (!controller.signal.aborted) setNote(noteFromError(error))
    } finally {
      if (readingRef.current === controller) readingRef.current = undefined
      setReading(false)
    }
  }

  /** The composer's send inside a project: the line goes to the reading. */
  const submitChat = (): void => {
    const text = composer.get().prompt.trim()
    if (text.length === 0 || busy !== undefined || reading) return
    composer.set({ prompt: '' })
    void sendLine(text, true)
  }

  /**
   * The composer's send. Inside a project the sentence decides what to run, and
   * the composer's controls are the defaults it reads (since 2026-11-02 they are
   * the same controls the home view has). The home view goes straight to the
   * run its mode describes.
   */
  const submit = (over?: RunOverride): void => {
    if (view === 'project') {
      submitChat()
      return
    }
    const { mode, resolution, seconds, sources } = composer.get()
    const source = sources[0]
    // A clip as the source means "carry this on", which is `extend`; `video`
    // needs a still to animate.
    if (mode === 'video') {
      /*
       * Past the longest clip the sampler can render in one go — or with a
       * song staged, which the video is cut to — the run is a chain of clips
       * rather than one, and that is the `story` action.
       */
      // A long take from one picture is a chain of scenes (`video`); a song
      // staged, or several pictures, make it a cut music video (`story`).
      const sung = sources.some(item => item.kind === 'audio')
      const pictures = sources.filter(item => item.kind === 'image').length
      const long = sung || (isStoryLength(clampResolution('video', resolution), seconds) && pictures > 1)
      void run(long ? 'story' : source?.kind === 'video' ? 'extend' : 'video', undefined, over)
    }
    // One action whatever the length: the studio chains a background's
    // segments itself, so a minute of it is still this card and not a story.
    else if (mode === 'loop') void run('loop')
    else if (mode === 'music') void run('music')
    else if (mode === 'speak') void run('speak')
    else if (mode === 'recreate') void run('recreate')
    else if (mode === 'regenerate') void run('regenerate')
    else if (mode === 'style') void run('remix')
    else void run(source === undefined ? 'generate' : 'remix')
  }

  /** A panel's run button: the run its card describes, with the files in its slots. */
  const runPanel = (spec: WorkflowSpec): void => {
    const { sources, prompt, panelUpscaleTo, objectMode, light, placement } = composer.get()
    const staged = slotsOf(spec, sources)
    const line = prompt.trim() === '' ? {} : { prompt: prompt.trim() }
    /*
     * The Video card says "What happens · optional" (2026-11-16): left empty,
     * the run used to stop on "Type a prompt first" and, with a song staged,
     * the button seemed to do nothing. The card's own line stands in: the
     * prompt writer and the director still read the photo and the track.
     */
    const videoLine = prompt.trim() !== ''
      ? { prompt: prompt.trim() }
      : { prompt: translate(staged.song === undefined ? 'imagine.videoEmptyLine' : 'imagine.videoEmptyLineSong') }
    // The panel's title is the line these runs carry: without it the project
    // and its first message were named after the action id ("bg").
    if (spec.id === 'bg' && staged.photo !== undefined) void run('bg', staged.photo, { prompt: translate(spec.titleKey) })
    else if (spec.id === 'upscale' && staged.source !== undefined) {
      const upscaleTo = pickUpscaleStep(staged.source, panelUpscaleTo, true)?.short
      void run('upscale', staged.source, { prompt: translate(spec.titleKey), ...upscaleTo === undefined ? {} : { upscaleTo } })
    }
    else if (spec.id === 'voice' && staged.track !== undefined) void run('voice', staged.track, { prompt: translate('imagine.changeVoice') })
    else if (spec.id === 'clip') ctx.openClip()
    /*
     * "Recreate video" queues the frame SCAN, not the recreation (2026-10-25):
     * the studio draws the candidate opening frames and the choice is the
     * user's. Picking one starts the second half (`chooseFrame`).
     */
    else if (spec.id === 'recreate' && staged.plate !== undefined) void run('scanFrame', staged.plate, line)
    // Two photos: the person and the reference, in a single image.
    /*
     * "Object swap": the clip and, for the `change` mode, the photo of the
     * object to put in. The other three modes have no photo; the sentence
     * describes them.
     */
    else if (spec.id === 'objectSwap' && staged.clip !== undefined) {
      void run('objectSwap', staged.clip, {
        ...line, reference: staged.reference, objectMode,
        ...objectMode === 'add' ? { placement } : {},
      })
    }
    // "Character swap": the clip and the photo of who plays the part.
    else if (spec.id === 'swapPerson' && staged.clip !== undefined) {
      void run('swapPerson', staged.clip, { prompt: prompt.trim() || translate(spec.titleKey), reference: staged.reference })
    }
    /*
     * "Light the photo": the photo and the light look chosen in the panel.
     * The look IS the prompt, so there is no line to send.
     */
    else if (spec.id === 'relight' && staged.photo !== undefined) {
      /*
       * The line the panel puts in the column: the action's title and the
       * chosen light. The prompt that goes to the graph stays the look's,
       * written by the server; this is the sentence the user reads on the board.
       */
      const lookName = relightLookOf(light)?.name
      void run('relight', staged.photo, {
        ...line,
        light,
        prompt: lookName === undefined ? translate(spec.titleKey) : `${translate(spec.titleKey)} · ${lookName}`,
      })
    }
    else if (spec.id === 'compose' && staged.photo !== undefined && staged.reference !== undefined) {
      void run('compose', staged.photo, { ...line, reference: staged.reference })
    }
    // Two photos: one clip from the first to the second, not one clip each.
    else if (spec.id === 'video' && staged.start?.kind === 'image' && staged.end !== undefined) {
      void run('video', staged.start, { lastSource: staged.end.name, ...videoLine })
    }
    else if (spec.id === 'video') submit(videoLine)
    else submit()
  }

  /**
   * One of the opening frames a scan drew, clicked: start the recreation with it.
   *
   * The card is the whole recipe, so this click is the second half of one
   * gesture and not a new request: no confirmation, no second card. The clip,
   * the line about the scene and the canvas come from the scan job itself,
   * because the composer may have been used for something else since; the
   * soundtrack switch is read as it stands now.
   * @param scanId - the scan the frame belongs to.
   * @param name - the chosen frame.
   */
  const chooseFrame = (scanId: string, name: string): void => {
    const scan = jobs.find(job => job.id === scanId)
    const photo = allByName.get(name)
    const clip = scan?.source === undefined ? undefined : allByName.get(scan.source)
    if (scan === undefined || scan.action !== 'scanFrame' || photo === undefined || clip === undefined || clip.kind !== 'video') {
      setNote(translate('imagine.chooseFrameGone'))
      return
    }
    void run('recreate', clip, {
      ...scan.prompt.trim().length === 0 ? {} : { prompt: scan.prompt },
      ...scan.megapixels === undefined ? {} : { megapixels: scan.megapixels },
      // The scan's line in the column is the gesture: repeating it here would
      // put the same sentence twice under one click.
      quiet: true,
      ...current === undefined ? {} : { project: current },
      frame: photo,
      keepAudio: composer.get().keepAudio,
    })
  }

  /**
   * Answer the agent's offer: yes runs the work it stopped before, no tells
   * the model and nothing is queued. The turn resumes on the server, so the
   * reply, the job ids and any further offer come back through the same
   * stream the line did.
   * @param accept - the user's answer.
   */
  const confirmAgent = async (accept: boolean): Promise<void> => {
    const offer = pending
    if (offer === undefined || reading) return
    setPending(undefined)
    setNote(undefined)
    const controller = new AbortController()
    readingRef.current = controller
    setReading(true)
    trace.set([])
    let thinking = ''
    const note = (event: Parameters<typeof thoughtOf>[0]): void => {
      if (event.kind === 'reasoning') thinking += event.text
      trace.set((thoughts) => {
        if (event.kind === 'reasoning') {
          const last = thoughts[thoughts.length - 1]
          return last?.kind === 'reasoning'
            ? [...thoughts.slice(0, -1), { id: last.id, kind: 'reasoning', text: last.text + event.text }]
            : [...thoughts, { id: nextThoughtId(), kind: 'reasoning', text: event.text }]
        }
        const thought = thoughtOf(event)
        return thought === undefined ? thoughts : [...thoughts, thought]
      })
    }
    try {
      const open = current
      if (open === undefined) return
      let project: ImagineProject = open
      const answer = await confirmAgentChat({ token: offer.token, accept }, project.id, controller.signal, note)
      trace.set(thoughts => [...thoughts, answer.read
        ? { id: nextThoughtId(), kind: 'step', text: translate('imagine.thoughtDone', { count: String(answer.mode === 'agent' ? answer.jobIds.length : answer.intents.length) }) }
        : { id: nextThoughtId(), kind: 'step', text: translate('imagine.thoughtDoneUnread'), keep: true }])
      if (answer.pending !== undefined) {
        setPending(answer.pending)
        return
      }
      // Same rule as the first pass: no text, no assistant line (the thinking
      // alone is not an answer).
      const answeredId = `a-${String(Date.now())}`
      let spoken = false
      if (answer.reply.trim().length > 0) {
        project = appendMessage(project, {
          id: answeredId,
          role: 'assistant',
          text: answer.reply,
          createdAt: Date.now(),
          ...thinking.trim().length === 0 ? {} : { thinking: thinking.trim() },
        })
        patch(project)
        spoken = true
      }
      if (answer.mode === 'agent') {
        for (const jobId of answer.jobIds) project = rememberJob(project, jobId)
        if (answer.jobIds.length > 0 && spoken) {
          const board: ImagineProject = project
          project = {
            ...board,
            messages: board.messages.map(message => message.id === answeredId
              ? { ...message, jobIds: [...new Set([...(message.jobIds ?? []), ...answer.jobIds])] }
              : message),
          }
        }
        const made = answer.files.map(file => file.name).filter(name => !project.itemNames.includes(name))
        if (made.length > 0) {
          await reloadGallery()
          actions.regrid(made)
          const board: ImagineProject = project
          project = { ...board, itemNames: [...board.itemNames, ...made] }
        }
        patch(project)
      }
      setProposal(answer.proposal)
      setPending(answer.pending)
    } catch (error: unknown) {
      if (!controller.signal.aborted) setNote(noteFromError(error))
    } finally {
      if (readingRef.current === controller) readingRef.current = undefined
      setReading(false)
    }
  }

  /**
   * Write the workflow change the user just accepted. The outcome is a status
   * line in the column, backup path included: these graphs are not in the
   * repository, and where the previous one went is the only way back.
   */
  const applyProposal = async (): Promise<void> => {
    if (proposal === undefined || current === undefined) return
    setProposal(undefined)
    try {
      const done = await applyWorkflowChanges(proposal.key, proposal.diff)
      patch(appendMessage(current, {
        id: `wf-${String(Date.now())}`,
        role: 'status',
        text: translate('imagine.workflowApplied', { file: proposal.file, backup: done.backup }),
        createdAt: Date.now(),
      }))
    } catch (error: unknown) {
      setNote(noteFromError(error))
    }
  }

  return {
    run, runCustomBatch, runBatchUpscale, sendLine, submit, runPanel, chooseFrame, applyProposal, confirmAgent,
    openOrCreate, seedProject, runTemplateForm,
  }
}
