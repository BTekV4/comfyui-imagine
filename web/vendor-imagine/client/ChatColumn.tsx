/**
 * The project's chat column: its controls, the runs in flight, the
 * conversation with the model's thinking, a workflow change on offer, the
 * reading in progress and the docked composer.
 *
 * Split out of ImaginePage.tsx (2026-10-21).
 * @module ChatColumn
 */

import { memo, useEffect, useMemo, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { IconPanelLeftOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular } from '../../shims/primitives/index.ts'
import { Still } from './Still.tsx'
import { THUMB_SMALL, THUMB_TILE, thumbUrlOf } from './gallery-api.ts'
import { setupPackUnverified, type ImagineJobView as ImagineJob, type MediaFileRef } from '../../../shared/imagine-types.ts'
import type { WorkflowProposal } from '../../../shared/imagine-chat.ts'
import type { AgentPending } from '../../../shared/agent-chat.ts'
import type { ImagineMessage, ImagineProject } from '../../../shared/imagine-projects.ts'
import { isSeedMessage } from './imagine-projects.ts'
import { clockStamp, formatGigabytes } from './format.ts'
import { AudioMark, GeneratingLabel } from './imagine-bits.tsx'
import { joinStage, Percent, ProgressBar, stageLineOf, useJobProgress } from './job-progress.tsx'
import { useTrace, type TraceStore } from './reading-trace.ts'
import css from './ChatColumn.module.css'
import { translate } from './locale-store.ts'
import { noticeText } from './imagine-messages.ts'

/** A file a line carries or produced, as a thumbnail button (a note for audio). */
function FileChip({ file, className, thumbClassName, size, picked, onOpen }: {
  readonly file: MediaFileRef
  readonly className: string | undefined
  readonly thumbClassName: string | undefined
  readonly size: number
  readonly picked: boolean
  readonly onOpen: (name: string) => void
}) {
  return (
    <button
      type="button"
      className={className}
      data-on={picked || undefined}
      aria-label={file.name}
      title={file.name}
      onClick={() => { onOpen(file.name) }}
    >
      {file.kind === 'audio'
        ? <AudioMark className={css.audioThumb} />
        : <Still className={thumbClassName} src={thumbUrlOf(file.name, size)} />}
    </button>
  )
}

/** One bubble: a message, or a run of identical status lines shown once. */
interface ChatBubble {
  message: ImagineMessage
  ids: string[]
  count: number
  /**
   * The files the runs of this line produced, drawn under its prose.
   *
   * They come from the stored result lines the line claims through `jobIds`;
   * those lines are no longer bubbles of their own, so the column reads as a
   * sentence and what it made, the way Grok Imagine does.
   */
  results?: readonly MediaFileRef[]
  /**
   * An answer's paragraphs and lists, split once here inside the column's
   * memo rather than on every render of every bubble.
   */
  blocks?: ProseBlock[]
}

/**
 * Collapse a run of identical status lines into one bubble with a count: a
 * music video posts "I generated a look." once per photo, and seventeen
 * identical lines drowned the conversation. Presentation only — the stored
 * messages are untouched, and the bubble's delete removes the whole run.
 * @param messages - the project's lines.
 * @returns the bubbles to draw.
 */
function bubblesOf(messages: readonly ImagineMessage[]): ChatBubble[] {
  const out: ChatBubble[] = []
  /*
   * The line that queued a run keeps its result, wherever the result lands in
   * the column: a job can settle after the next sentence was already written,
   * so position alone does not say whose file it is. `jobIds` does.
   */
  const ownerByJob = new Map<string, ChatBubble>()
  for (const message of messages) {
    // The seed line is bookkeeping — it keeps a fresh project on the rail
    // and out of the empty sweep — not something said in the chat: a new
    // project opens on an empty column (asked 2026-09-10).
    if (isSeedMessage(message)) continue
    /*
     * A line with nothing in it is not drawn. A status message can be left
     * without text — a notice the studio now shows as the job's own row, a key
     * a build does not know — and an empty bubble with only its hour under it
     * read as a run that had nothing to say (seen 2026-11-17). A line carrying
     * files is drawn whatever its text says: the files are the message.
     */
    if (message.text.trim() === '' && (message.files?.length ?? 0) === 0) continue
    if (message.role === 'assistant') {
      const bubble: ChatBubble = { message, ids: [message.id], count: 1, blocks: proseBlocks(message.text) }
      for (const jobId of message.jobIds ?? []) ownerByJob.set(jobId, bubble)
      out.push(bubble)
      continue
    }
    const owner = message.role === 'status' && message.jobId !== undefined
      ? ownerByJob.get(message.jobId)
      : undefined
    /*
     * Only a result is folded: a notice or a failure is the studio talking
     * about the run itself, and it keeps its own line. The result's id joins
     * the sentence too, so deleting the sentence takes its runs with it.
     */
    if (owner !== undefined && message.files !== undefined && message.files.length > 0) {
      const known = new Set((owner.results ?? []).map(file => file.name))
      owner.results = [...owner.results ?? [], ...message.files.filter(file => !known.has(file.name))]
      owner.ids.push(message.id)
      continue
    }
    const prev = out[out.length - 1]
    if (prev !== undefined && message.role === 'status' && prev.message.role === 'status'
      && prev.message.text === message.text) {
      prev.ids.push(message.id)
      prev.count += 1
      // Twenty-one "I generated a look." are one line, and their twenty-one
      // results stay under it.
      const files = [...prev.message.files ?? [], ...message.files ?? []]
      prev.message = files.length === 0 ? message : { ...message, files }
    } else {
      out.push({ message, ids: [message.id], count: 1 })
    }
  }
  return out
}

/** One block of a written answer: a paragraph, or the items of a list. */
interface ProseBlock {
  kind: 'p' | 'ul'
  lines: string[]
}

/**
 * Split an answer into paragraphs and bullet lists.
 *
 * The reader writes a few sentences and sometimes a short list, and drawing
 * it as one block of pre-wrapped text made a three-line answer read as a
 * single breath. Only the bullets the reader actually writes are recognised:
 * nothing here is parsed as markup, so a line that starts with a dash in the
 * middle of a sentence stays a sentence.
 * @param text - what the studio said.
 * @returns the blocks to draw, in order.
 */
function proseBlocks(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const item = /^[-*\u2022]\s+(.+)$/.exec(line)
    if (item !== null) {
      const last = blocks[blocks.length - 1]
      if (last !== undefined && last.kind === 'ul') last.lines.push(item[1] as string)
      else blocks.push({ kind: 'ul', lines: [item[1] as string] })
    } else if (line.length > 0) {
      blocks.push({ kind: 'p', lines: [line] })
    }
  }
  return blocks
}

interface ChatColumnProps {
  readonly project: ImagineProject
  readonly picked: readonly string[]
  /** The project's runs still going, upscales included. */
  readonly ownLive: readonly ImagineJob[]
  readonly reading: boolean
  /** A run is starting: the retry buttons wait. */
  readonly busy: boolean
  /** The trace of the reading in progress, or of the last one. */
  readonly trace: TraceStore
  readonly proposal: WorkflowProposal | undefined
  /** The work the agent stopped before doing, waiting for a yes. */
  readonly pending: AgentPending | undefined
  /** Answers that offer: true runs it, false tells the model no. */
  readonly onConfirm: (accept: boolean) => void
  /**
   * The opening frames of a "Recreate video" waiting for a choice.
   *
   * Present while the newest scan of this project has its frames and the user
   * has not launched a recreation from one of them yet — and, after that, as
   * the one-click way to try another frame.
   */
  readonly choose?: {
    /** The scan job the frames were drawn by. */
    readonly id: string
    /** The candidate frames, in draw order. */
    readonly candidates: readonly string[]
    /** The one a recreation was already started from, when there is one. */
    readonly chosen?: string
    /** Whether that recreation is still rendering: the block says "in progress" only then. */
    readonly live?: boolean
    /** The line the scan was asked for, so the choice is made with it in view. */
    readonly scene?: string
  }
  readonly composer: ReactNode
  /** A file a line carried was clicked. */
  readonly onOpenFile: (name: string) => void
  /** One of the scan's frames was clicked: recreate the video from it. */
  readonly onChooseFrame: (scanId: string, name: string) => void
  /** The block was closed with "Cancel": it stays closed for that set. */
  readonly onDismissChoose: (scanId: string) => void
  readonly onClearChat: () => void
  readonly onHideChat: () => void
  readonly onRetry: (text: string) => void
  readonly onDeleteMessage: (ids: readonly string[]) => void
  readonly onApplyProposal: () => void
  readonly onCancelProposal: () => void
  readonly onStopReading: () => void
  readonly onStopJob: (id: string) => void
  /** «Install»: the user agrees to what ComfyUI has to install for a job. */
  readonly onApproveSetup: (id: string) => void
  readonly onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void
}

/**
 * One run in flight: what it is doing, how far it is and the button that
 * stops it. One row per job: the column used to list each live job twice, a
 * row with the progress at the top and a bubble with the stop button at the
 * foot of the conversation. The progress is read here, from `job-progress`,
 * so a moving percentage redraws this row alone.
 */
const JobRow = memo(function JobRow({ job, onStop, onApproveSetup }: {
  job: ImagineJob
  onStop: (id: string) => void
  onApproveSetup: (id: string) => void
}) {
  const live = useJobProgress(job.id)
  /*
   * ComfyUI first has to install what this run needs (comfyui-imagine's
   * setup): the run waits for a yes, then shows the download instead of the
   * render (2026-11-15).
   */
  if (job.notice === 'setup-needed' && job.setup !== undefined) {
    const what = [...job.setup.packs.map(pack => pack.name), ...job.setup.models.map(model => model.name)].join(', ')
    return (
      <div className={css.chatWork} data-imagine-job={job.id}>
        <span className={css.chatWorkLabel}>{translate('imagine.setupNeededTitle')}</span>
        <span className={css.setupText}>{translate('imagine.setupNeeded', { what, size: formatGigabytes(job.setup.bytes) })}</span>
        {job.setup.packs.length > 0 && (
          <ul className={css.setupPacks}>
            {job.setup.packs.map(pack => (
              <li key={pack.id}>
                {pack.name} — {translate(pack.source === 'github' ? 'imagine.setupFromGithub' : pack.registryStatus === 'Active' ? 'imagine.setupFromRegistry' : 'imagine.setupFromRegistryFlagged')}
              </li>
            ))}
          </ul>
        )}
        {job.setup.packs.some(setupPackUnverified) && <span className={css.setupWarning} role="note">{translate('imagine.setupUnverified')}</span>}
        <span className={css.chatWorkLabel}>
          <button type="button" className={css.approveSetup} onClick={() => { onApproveSetup(job.id) }}>{translate('imagine.setupInstall')}</button>
          <button type="button" className={css.stopJob} onClick={() => { onStop(job.id) }}>{translate('imagine.cancel')}</button>
        </span>
      </div>
    )
  }
  const setupProgress = live?.setupProgress ?? job.setupProgress
  const installing = (live?.notice ?? job.notice) === 'setup-running' && job.promptId === undefined
  const { percent, stage, eta } = stageLineOf(live?.progress)
  const scan = live?.scanProgress
  /*
   * A job that is measuring the track's voice before its shots exist is not
   * generating: the row said "Generating… 0%" over a bar at zero, which reads
   * as a run stuck at the first per cent (seen 2026-11-17). The notice is the
   * truth, and there is no percentage to show until the shots start.
   */
  const preparing = (live?.notice ?? job.notice) === 'separating-voice'
    ? noticeText('separating-voice')
    : undefined
  const setupStage = installing && setupProgress !== undefined && setupProgress.stage !== ''
    ? setupProgress.stage === 'restart' ? translate('imagine.setupRestart') : setupProgress.stage
    : undefined
  return (
    <div className={css.chatWork} data-imagine-job={job.id}>
      <span className={css.chatWorkLabel}>
        {preparing !== undefined
          ? preparing
          : job.status === 'queued'
            ? translate('imagine.jobQueued')
            : installing
              ? translate('imagine.setupRunning')
              : scan === undefined
                ? <GeneratingLabel />
                : translate('imagine.scanningFrame', { done: String(scan.done), total: String(scan.total) })}
        {preparing === undefined && <Percent value={percent} />}
        <button type="button" className={css.stopJob} onClick={() => { onStop(job.id) }}>
          {translate('imagine.stop')}
        </button>
      </span>
      {(setupStage !== undefined || stage !== undefined || eta !== undefined) && (
        <span className={css.chatWorkStage}>{joinStage(setupStage ?? stage, eta)}</span>
      )}
      <ProgressBar value={percent} />
    </div>
  )
})

/**
 * What the studio is doing with the sentence just sent, and the model's own
 * thinking when the route emits any. The only reader of the whole trace: a
 * token of thinking redraws this box and nothing else.
 */
function ReadingTrace({ trace, reading, onStop }: {
  trace: TraceStore
  reading: boolean
  onStop: () => void
}) {
  const thoughts = useTrace(trace, all => all)
  /*
   * What is left of that trace once the reading is over. The steps are the
   * studio talking about itself — which model it used, that it was deciding,
   * how many runs it queued — and under every answer they read as if the
   * studio were narrating instead of working. They belong to the seconds they
   * describe; afterwards only a retry or a fallback is still news, and when
   * there is none the whole bubble goes.
   */
  const kept = useMemo(() => thoughts.filter(thought => thought.keep === true), [thoughts])
  /*
   * What is shown while the reading is still going: the model's own thinking
   * and the steps that are news, not the studio saying which model it is
   * reading with or that it is deciding. Those lines were on screen under
   * every sentence for the seconds they took and read as narration — the
   * user asked for the studio to keep quiet about its own machinery
   * (2026-09-10). The "reading…" line below the trace says all of it.
   */
  const liveTrace = useMemo(() => thoughts.filter(thought => thought.kind === 'reasoning' || thought.keep === true), [thoughts])
  if (!reading && kept.length === 0) return null
  return (
    <div className={`${css.bubble} ${css.thinking}`} data-role="status">
      {/*
      * Afterwards only what still means something is left standing, so a
      * reading that fell back to generating the line does not look like one
      * that understood it, and an ordinary one leaves the column to the
      * answer instead of to its own commentary.
      */}
      {(reading ? liveTrace : kept).map(thought => (
        <p
          key={thought.id}
          className={thought.kind === 'reasoning' ? css.thinkingReasoning : css.thinkingStep}
          /*
          * Thinking is capped at a few lines and scrolls inside itself, so
          * without this it shows its first sentence for the whole reading
          * while the model is eleven hundred pixels further down. Measured:
          * the box stays 140px and the text reached 1093.
          */
          ref={thought.kind === 'reasoning'
            ? (element) => { if (element !== null) element.scrollTop = element.scrollHeight }
            : undefined}
        >
          {reading || thought.kind === 'reasoning' ? thought.text : thought.text.replace(/(…|\.\.\.)\s*$/u, '')}
        </p>
      ))}
      {reading && (
        <p className={css.thinkingLive}>
          {translate('imagine.reading')}
          {/*
          * The way out of a reading that is not coming back. The client sets
          * no deadline and the server's is 45 seconds per candidate route, so
          * without this the column can sit on "reading" with nothing to
          * press.
          */}
          <button type="button" className={css.stopJob} onClick={onStop}>
            {translate('imagine.stop')}
          </button>
        </p>
      )}
    </div>
  )
}

export const ChatColumn = memo(function ChatColumn(props: ChatColumnProps) {
  const {
    project, picked, ownLive, reading, busy, trace, proposal, pending, onConfirm, choose, composer, onOpenFile,
    onClearChat, onHideChat, onRetry, onDeleteMessage, onApplyProposal, onCancelProposal, onStopReading, onStopJob, onApproveSetup,
    onChooseFrame, onDismissChoose, onResizeStart,
  } = props
  /** How long the trace is: a new line moves the column down, a token does not. */
  const traceLength = useSyncExternalStore(trace.subscribe, () => trace.get().length, () => trace.get().length)
  const chatBubbles = useMemo(() => bubblesOf(project.messages), [project.messages])
  const pickedSet = useMemo(() => new Set(picked), [picked])
  /*
   * The column follows the conversation. It never scrolled on its own: a line
   * sent from the composer, and the thumbnails it was sent with, landed
   * under the fold of a project with a long history — measured at 2206px
   * down a 900px window — and read as not there at all.
   */
  const messagesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const column = messagesRef.current
    if (column !== null) column.scrollTop = column.scrollHeight
  }, [project.id, project.messages.length, traceLength, reading])

  return (
    <div className={css.chatCol} data-imagine-chat>
      {/*
      * The column's own controls: empty it, or put it away. They sit
      * above the conversation rather than in the studio's top bar,
      * where a bin next to the project title reads as "delete the
      * project".
      */}
      <div className={css.chatHead}>
        <button
          type="button"
          className={css.chatHeadBtn}
          disabled={project.messages.length === 0}
          onClick={onClearChat}
        >
          {translate('imagine.clearChat')}
        </button>
        {/* The phone's Expand: there the bar above the canvas is not drawn. */}
        <button
          type="button"
          className={`${css.iconBtn} ${css.chatHideNarrow}`}
          aria-label={translate('imagine.hideChat')}
          title={translate('imagine.hideChat')}
          onClick={onHideChat}
        >
          <IconPanelLeftOutlineRegular size={16} />
        </button>
      </div>
      {/*
       * What is running, where the user is looking.
       *
       * The canvas draws a tile per live job and the column said
       * nothing: asked in the chat whether a run was going, the
       * column had no state to answer from and the reading made one
       * up — "shows as queued" for a job that never existed
       * (2026-10-17). Same list the tiles are drawn from.
       */}
      {ownLive.length > 0 && (
        <div className={css.chatWorking} data-imagine-working={ownLive.length}>
          {ownLive.map(job => <JobRow key={job.id} job={job} onStop={onStopJob} onApproveSetup={onApproveSetup} />)}
        </div>
      )}
      <div className={css.messages} ref={messagesRef}>
        {chatBubbles.map(({ message, ids, count, results, blocks }) => (
          <div key={message.id} className={css.bubbleWrap} data-role={message.role}>
            {message.files !== undefined && message.files.length > 0 && (
              /*
               * What the line was written about, kept with it: the
               * composer empties after the run, and a line with its
               * files gone read as one written without context.
               */
              <div className={css.bubbleFiles} data-imagine-message-files={message.files.length}>
                {message.files.map(file => (
                  /*
                   * On the board: go there and select it. A file the line
                   * carried that is not on this board — the photo a run
                   * started from, kept in another project — is put on it
                   * first, as Grok does (asked 2026-10-17).
                   */
                  <FileChip
                    key={file.name}
                    file={file}
                    className={css.bubbleFile}
                    thumbClassName={css.fileThumb}
                    size={THUMB_SMALL}
                    picked={pickedSet.has(file.name)}
                    onOpen={onOpenFile}
                  />
                ))}
              </div>
            )}
            {message.thinking !== undefined && message.thinking.trim().length > 0 && (
              /*
               * The model's thinking stays with its answer, folded:
               * open to read what led there, closed so the column
               * reads as a conversation.
               */
              <details className={css.thinkingKept}>
                <summary>{translate('imagine.thinking')}</summary>
                <p className={css.thinkingReasoning}>{message.thinking}</p>
              </details>
            )}
            {message.text.length > 0 && (message.role === 'assistant'
              ? (
                <div className={css.prose}>
                  {(blocks ?? []).map((block, index) => (block.kind === 'ul'
                    ? (
                      <ul key={`block-${String(index)}`} className={css.proseList}>
                        {block.lines.map((line, item) => <li key={`item-${String(item)}`}>{line}</li>)}
                      </ul>
                      )
                    : <p key={`block-${String(index)}`} className={css.proseLine}>{block.lines[0]}</p>))}
                </div>
                )
              : (
                <p className={css.bubble} data-role={message.role}>
                  {count > 1 ? `${message.text} ×${String(count)}` : message.text}
                </p>
                ))}
            {/*
            * What the runs of this line made, under the words that asked for
            * them: Grok Imagine's column, where the pictures are the answer's
            * consequence and not a separate receipt.
            */}
            {results !== undefined && results.length > 0 && (
              <div className={css.bubbleResults} data-imagine-results={results.length}>
                {results.map(file => (
                  <FileChip
                    key={file.name}
                    file={file}
                    className={css.result}
                    thumbClassName={css.resultThumb}
                    size={THUMB_TILE}
                    picked={pickedSet.has(file.name)}
                    onOpen={onOpenFile}
                  />
                ))}
              </div>
            )}
            {/*
            * The stamp and the line's own controls share a row: a
            * misread line is sent again from where it is written,
            * and a line the user does not want in the conversation
            * can leave it. Both appear on hover and on focus, so the
            * column reads as a conversation until something is
            * wanted from it.
            */}
            <span className={css.chatMeta}>
              <span className={css.chatTimestamp}>{clockStamp(message.createdAt)}</span>
              {message.role === 'user' && (
                <button
                  type="button"
                  className={css.msgBtn}
                  aria-label={translate('imagine.retryMessage')}
                  title={translate('imagine.retryMessage')}
                  disabled={reading || busy}
                  onClick={() => { onRetry(message.text) }}
                >
                  <IconRefreshOutlineRegular size={12} />
                </button>
              )}
              <button
                type="button"
                className={css.msgBtn}
                aria-label={translate('imagine.deleteMessage')}
                title={translate('imagine.deleteMessage')}
                onClick={() => { onDeleteMessage(ids) }}
              >
                <IconTrashOutlineRegular size={12} />
              </button>
            </span>
          </div>
        ))}
        {/*
        * The change the studio is offering. It sits below the
        * conversation and above the job rows, where the answer that
        * proposed it has just been said, and nothing has reached the
        * file until the button is pressed.
        */}
        {proposal !== undefined && (
          <div className={css.proposal}>
            <p className={css.proposalFile}>{proposal.file}</p>
            {proposal.diff.map(change => (
              <p key={`${change.node}.${change.field}`} className={css.proposalRow}>
                <span className={css.proposalNode}>{`${change.node} ${change.classType}`}</span>
                <span className={css.proposalField}>{change.field}</span>
                <span className={css.proposalFrom}>{String(change.from)}</span>
                <span className={css.proposalTo}>{String(change.to)}</span>
              </p>
            ))}
            {proposal.errors.map(line => (
              <p key={line} className={css.proposalWarn}>{line}</p>
            ))}
            {proposal.warnings.map(line => (
              <p key={line} className={css.proposalWarn}>{line}</p>
            ))}
            <div className={css.proposalActions}>
              <button type="button" className={css.proposalApply} onClick={onApplyProposal}>
                {translate('imagine.workflowApply')}
              </button>
              <button type="button" className={css.proposalCancel} onClick={onCancelProposal}>
                {translate('imagine.workflowCancel')}
              </button>
            </div>
          </div>
        )}
        {/*
        * The work the agent stopped before doing. It is a question, not a
        * run: nothing is queued, nothing is cancelled, and the buttons are
        * the only way forward. A question that outlived the page is gone
        * with it, on purpose (see `AgentPending`).
        */}
        {pending !== undefined && (
          <div className={css.proposal} data-imagine-confirm={pending.kind}>
            <p className={css.proposalFile}>{pending.summary}</p>
            <div className={css.proposalActions}>
              <button
                type="button"
                className={css.proposalApply}
                disabled={reading}
                onClick={() => { onConfirm(true) }}
              >
                {translate(pending.kind === 'cancel' ? 'imagine.agentConfirmCancelYes' : 'imagine.agentConfirmYes')}
              </button>
              <button
                type="button"
                className={css.proposalCancel}
                disabled={reading}
                onClick={() => { onConfirm(false) }}
              >
                {translate(pending.kind === 'cancel' ? 'imagine.agentConfirmCancelNo' : 'imagine.agentConfirmNo')}
              </button>
            </div>
          </div>
        )}
        {/*
        * The line is being read. It sits where the job rows go, so
        * the column always says what the studio is doing with the
        * sentence that was just sent.
        */}
        <ReadingTrace trace={trace} reading={reading} onStop={onStopReading} />
        {/*
        * The opening frames a "Recreate video" scan drew, and the one click
        * that starts the recreation from one of them.
        *
        * It sits at the bottom of the column, next to the composer, because it
        * is the thing to do next: the scan left its frames on the board and the
        * recipe cannot go on without a choice. The tiles are the biggest stills
        * the column holds — a frame has to be judged here, not recognised.
        */}
        {choose !== undefined && (
          <div className={css.choose} data-imagine-choose={choose.candidates.length}>
            <div className={css.chooseHead}>
              <p className={css.chooseTitle}>
                {translate(choose.chosen === undefined
                  ? 'imagine.chooseFrame'
                  : choose.live === true ? 'imagine.chooseFrameAgain' : 'imagine.chooseFrameRetry')}
              </p>
              {/*
              * Closes the block, nothing else: the photos stay on the board and
              * a render already started keeps going (its Stop is in the live
              * row). The word follows the state, because "Cancel" over a
              * running render reads as "stop that".
              */}
              <button
                type="button"
                className={css.chooseCancel}
                onClick={() => { onDismissChoose(choose.id) }}
              >
                {translate(choose.live === true ? 'imagine.chooseClose' : 'imagine.chooseCancel')}
              </button>
            </div>
            {choose.scene !== undefined && <p className={css.chooseScene}>{`«${choose.scene}»`}</p>}
            <div className={css.chooseGrid}>
              {choose.candidates.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  className={css.chooseTile}
                  data-chosen={name === choose.chosen || undefined}
                  aria-label={translate('imagine.chooseFramePick')}
                  title={translate('imagine.chooseFramePick')}
                  disabled={busy}
                  onClick={() => { onChooseFrame(choose.id, name) }}
                >
                  <Still className={css.chooseThumb} src={thumbUrlOf(name, THUMB_TILE)} lazy />
                  <span className={css.chooseNumber}>{String(index + 1)}</span>
                </button>
              ))}
            </div>
            <p className={css.chooseHint}>
              {translate('imagine.chooseFrameHint')}
            </p>
          </div>
        )}
      </div>
      <div className={css.chatDock}>{composer}</div>
      <button
        type="button"
        className={css.chatResize}
        aria-label={translate('imagine.resizeChat')}
        onPointerDown={onResizeStart}
      />
    </div>
  )
})
