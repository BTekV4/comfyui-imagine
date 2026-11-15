/**
 * "New generation": the headline, the composer and the grid of cards — or
 * the dedicated panel one card opened. Split out of ImaginePage.tsx
 * (2026-10-25). The panel reads its fields from the composer store, so typing
 * in it draws the panel and not the page.
 * @module HomeView
 */

import { memo, type ReactNode, type RefObject } from 'react'
import type {
  GalleryItem, ImagineObjectMode, ImaginePlacement, ModelRoute,
} from '../../../shared/imagine-types.ts'
import type { FrameCard } from './FrameExtractor.tsx'
import type { ImagineAspect, ImagineResolution } from '../../../shared/imagine-media.ts'
import { ComfyUIMark } from './comfyui-mark.tsx'
import { useComposer, type ComposerStore } from './composer-store.ts'
import { clampSeconds } from './imagine-settings.ts'
import { CoverMedia } from './cover-media.tsx'
import { CARD_MOTION, JOB_CARDS, slotsOf, type JobCardId } from './job-cards.ts'
import { CustomWorkflows, type CustomWorkflow } from './custom-workflows-view.tsx'
import { CustomWorkflowPanel, type CustomBatchRequest, type CustomRunRequest } from './custom-workflow-panel.tsx'
import { useEvent } from './use-event.ts'
import { WorkflowPanel } from './WorkflowPanel.tsx'
import { WORKFLOW_SPECS, type WorkflowSlot, type WorkflowSpec } from './workflow-specs.ts'
import css from './HomeView.module.css'
import { translate } from './locale-store.ts'

type JobCard = (typeof JOB_CARDS)[number]

/**
 * The cards run down three columns instead of lining up in rows, so each one
 * keeps its own height and the columns interlock like a masonry wall. The
 * first card of the middle column is the tall one: that is the shape the home
 * of Grok Imagine shows (the centre card higher than its neighbours). The
 * composer's column width is not touched; on a phone the same cards fall back
 * into two plain columns (`.column { display: contents }` in the CSS).
 */
const CARD_COLUMNS = 3

const CARD_GROUPS: JobCard[][] = Array.from({ length: CARD_COLUMNS }, () => [])
JOB_CARDS.forEach((card, i) => { CARD_GROUPS[i % CARD_COLUMNS].push(card) })

/** Which card is the tall one: the top of the middle column. */
const TALL_CARD = CARD_GROUPS[1][0]

/** The grid of workflow cards. */
const HomeCards = memo(function HomeCards({ onCard }: {
  onCard: (id: JobCardId) => void
}) {
  return (
    <div className={css.actions}>
      {CARD_GROUPS.map((group, gi) => (
      <div className={css.column} key={gi}>
      {group.map(card => {
        const motion = CARD_MOTION[card.id]
        return (
        <button
          key={card.id}
          type="button"
          className={card === TALL_CARD ? `${css.action} ${css.actionTall}` : css.action}
          onClick={() => { onCard(card.id) }}
        >
          {/*
            * One function for every surface (`CoverMedia`: the precedence
            * lives in `cover-plan.ts`). The repo's clip is passed from here
            * (`motion`) even when there is a custom cover: the cards that have
            * one play it with the user's image as poster, otherwise they stand
            * still and the user loses the motion that was there before
            * (reported on 2026-11-04: some cards used to be videos).
            */}
          <CoverMedia className={css.actionCover} cover={card.cover} motion={motion} />
          <span className={css.actionShade} aria-hidden="true" />
          <span className={css.actionCopy}>
            <span className={css.actionTitle}>{translate(card.title)}</span>
            {/*
              The tile clips this to one line; the tooltip carries the
              whole sentence so nothing is lost on a square.
            */}
            <span className={css.actionHint} title={translate(card.hint)}>
              {translate(card.hint)}
            </span>
          </span>
        </button>
        )
      })}
      </div>
      ))}
    </div>
  )
})

/** What the page does with a panel; the fields themselves go to the composer store. */
interface PanelActions {
  readonly onBack: () => void
  readonly onStage: (spec: WorkflowSpec, slot: WorkflowSlot, item: GalleryItem | undefined) => void
  readonly onUpload: (spec: WorkflowSpec, slot: WorkflowSlot, file: File) => Promise<void>
  readonly onRun: (spec: WorkflowSpec) => void
  readonly onFrameSaved: (item: GalleryItem) => void
  readonly onUseFrame: (item: GalleryItem, card: FrameCard) => void
}

/** One card's panel, reading its fields from the composer store. */
function WorkflowPanelBox({ store, spec, cover, motion, items, busy, actions }: {
  store: ComposerStore
  spec: WorkflowSpec
  cover: string
  motion: string | undefined
  items: readonly GalleryItem[]
  busy: boolean
  actions: PanelActions
}) {
  const state = useComposer(store, all => all)
  const set = store.set
  const onPrompt = useEvent((value: string) => { set({ prompt: value }) })
  const onAspect = useEvent((value: ImagineAspect) => { set({ aspect: value }) })
  const onResolution = useEvent((value: ImagineResolution) => {
    set(current => ({ resolution: value, seconds: clampSeconds(current.mode, value, current.seconds) }))
  })
  const onReferences = useEvent((value: number) => { set({ frameCandidates: value }) })
  const onObjectMode = useEvent((value: ImagineObjectMode) => { set({ objectMode: value }) })
  const onPlacement = useEvent((value: ImaginePlacement) => { set({ placement: value }) })
  const onLight = useEvent((value: string) => { set({ light: value }) })
  const onSeconds = useEvent((value: number) => { set({ seconds: value }) })
  const onLyrics = useEvent((value: string) => { set({ lyrics: value }) })
  const onKeepAudio = useEvent((value: boolean) => { set({ keepAudio: value }) })
  const onLipSync = useEvent((value: boolean) => { set({ lipSync: value }) })
  // Stable: the model select reloads its list whenever this changes.
  const onModel = useEvent((route: ModelRoute) => { set({ chatModel: route }) })
  const onUpscaleTo = useEvent((short: number | undefined) => { set({ panelUpscaleTo: short }) })
  return (
    <WorkflowPanel
      spec={spec}
      cover={cover}
      motion={motion}
      items={items}
      staged={slotsOf(spec, state.sources)}
      prompt={state.prompt}
      aspect={state.aspect}
      resolution={state.resolution}
      references={state.frameCandidates}
      objectMode={state.objectMode}
      placement={state.placement}
      onPlacement={onPlacement}
      light={state.light}
      seconds={state.seconds}
      lyrics={state.lyrics}
      keepAudio={state.keepAudio}
      lipSync={state.lipSync}
      busy={busy}
      note={state.note}
      onBack={actions.onBack}
      onStage={(slot, item) => { actions.onStage(spec, slot, item) }}
      onUpload={(slot, file) => actions.onUpload(spec, slot, file)}
      onPrompt={onPrompt}
      onAspect={onAspect}
      onResolution={onResolution}
      onReferences={onReferences}
      onObjectMode={onObjectMode}
      onLight={onLight}
      onSeconds={onSeconds}
      onLyrics={onLyrics}
      onKeepAudio={onKeepAudio}
      onLipSync={onLipSync}
      onModel={onModel}
      onRun={() => { actions.onRun(spec) }}
      upscaleTo={state.panelUpscaleTo}
      onUpscaleTo={onUpscaleTo}
      onFrameSaved={actions.onFrameSaved}
      onUseFrame={actions.onUseFrame}
    />
  )
}

export interface HomeViewProps extends PanelActions {
  readonly store: ComposerStore
  readonly busy: boolean
  /** The card whose panel is open, if any. */
  readonly panelCard: JobCardId | undefined
  readonly items: readonly GalleryItem[]
  /** The composer, as the page builds it ("All media" shows the same one). */
  readonly composer: ReactNode
  /** The home's own scroll box, which a card sends back to the composer. */
  readonly homeRef: RefObject<HTMLDivElement>
  readonly onCard: (id: JobCardId) => void
  /** The uploaded card whose panel is open, if any. */
  readonly customPanel?: CustomWorkflow
  /** Open the full panel of an uploaded card. */
  readonly onOpenCustom: (workflow: CustomWorkflow) => void
  readonly onBackCustom: () => void
  /** Run an uploaded card with its panel's values and files. */
  readonly onRunCustomJob: (workflow: CustomWorkflow, request: CustomRunRequest) => void
  /** Queue one run per value of the card's batch control. */
  readonly onRunCustomBatch: (workflow: CustomWorkflow, request: CustomRunRequest, batch: CustomBatchRequest) => void
}

export function HomeView(props: HomeViewProps) {
  const { store, busy, panelCard, items, composer, homeRef, onCard } = props
  // Every card id has a spec (WORKFLOW_SPECS is a full record), so an open
  // card always has its panel.
  if (panelCard !== undefined) {
    const spec = WORKFLOW_SPECS[panelCard]
    return (
      <div className={css.home} ref={homeRef}>
        <WorkflowPanelBox
          store={store}
          spec={spec}
          cover={JOB_CARDS.find(card => card.id === panelCard)?.cover ?? ''}
          motion={CARD_MOTION[panelCard]}
          items={items}
          busy={busy}
          actions={props}
        />
      </div>
    )
  }
  const customPanel = props.customPanel
  if (customPanel !== undefined) {
    return (
      <div className={css.home} ref={homeRef}>
        <CustomWorkflowPanel
          workflow={customPanel}
          items={items}
          busy={busy}
          onBack={props.onBackCustom}
          onRun={(request) => { props.onRunCustomJob(customPanel, request) }}
          onRunBatch={(request, batch) => { props.onRunCustomBatch(customPanel, request, batch) }}
          onGalleryAdd={props.onFrameSaved}
        />
      </div>
    )
  }
  return (
    <div className={css.home} ref={homeRef}>
      <div className={css.hero}>
        {/*
          * The title and the composer in a single block, centred in the first
          * screen (as on Grok): they used to stick to the top with the cards
          * starting right away, so the chat bar looked tall.
          */}
        <div className={css.heroLead}>
        {/*
          * A still title. It used to rotate a word after "ComfyUI Imagine"
          * every 2.8 s (landscapes, a poster, …): it added nothing, moved the
          * text on every turn, and made the DOM unstable — every check of the
          * page read "observed content changed" and lost time. The studio's
          * name is enough: the real invitation is the composer below.
          * (requested on 2026-11-04)
          */}
        <h1 className={css.headline}>
          <ComfyUIMark size={28} />
          {translate('imagine.headlineSimple')}
        </h1>
        {/*
          A wrapper of its own so the phone layout can pin the composer to
          the bottom of the scrollport without touching the docked
          composer in the chat column; on desktop it has no box at all.
        */}
        <div className={css.heroComposer}>{composer}</div>
        </div>
        <HomeCards onCard={onCard} />
        <CustomWorkflows onOpen={props.onOpenCustom} />
      </div>
    </div>
  )
}
