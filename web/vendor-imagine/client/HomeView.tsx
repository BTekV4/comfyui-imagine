/**
 * "New generation": the headline, the composer and the grid of cards — or
 * the dedicated panel one card opened. Split out of ImaginePage.tsx
 * (2026-10-25). The panel reads its fields from the composer store, so typing
 * in it draws the panel and not the page.
 * @module HomeView
 */

import { memo, useMemo, useState, type ReactNode, type RefObject } from 'react'
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
import {
  AddWorkflowPanel, coverOf, type CustomWorkflow, type CustomWorkflowList,
} from './custom-workflows-view.tsx'
import { CustomWorkflowPanel, type CustomBatchRequest, type CustomRunRequest } from './custom-workflow-panel.tsx'
import { TemplatePanel } from './TemplatePanel.tsx'
import { SetupStatusCard } from './SetupStatusCard.tsx'
import { templateById, type Template } from '../../../shared/imagine-templates.ts'
import {
  FILTER_LABEL, HOME_GROUPS, filterHome, homeOrder, storeHomeFilter, storedHomeFilter,
  type HomeEntry, type HomeFilter,
} from './home-groups.ts'
import type { ComfyLocaleKey } from './locales.ts'
import { useEvent } from './use-event.ts'
import { WorkflowPanel } from './WorkflowPanel.tsx'
import { WORKFLOW_SPECS, type WorkflowSlot, type WorkflowSpec } from './workflow-specs.ts'
import css from './HomeView.module.css'
import { translate } from './locale-store.ts'

/** The flow cards by id, so an entry of the grid finds its cover and words. */
const CARD_BY_ID = new Map(JOB_CARDS.map(card => [card.id, card]))

/** The key of a catalog text, as the page's translator takes it. */
const catalogKey = (name: string): ComfyLocaleKey => name as ComfyLocaleKey

/**
 * The cards run down three columns instead of lining up in rows, so each one
 * keeps its own height and the columns interlock like a masonry wall. The
 * first card of the middle column is the tall one: that is the shape the home
 * of Grok Imagine shows (the centre card higher than its neighbours). The
 * composer's column width is not touched; on a phone the same cards fall back
 * into two plain columns (`.column { display: contents }` in the CSS), and
 * each card's `order` keeps them in the grid's order there.
 */
const CARD_COLUMNS = 3

/** The chips, «All» first. */
const FILTERS: readonly HomeFilter[] = ['all', ...HOME_GROUPS]

/** What a card of the grid does when pressed, by kind. */
interface HomeCardActions {
  readonly onCard: (id: JobCardId) => void
  readonly onTemplate: (template: Template) => void
  readonly onCustom: (workflow: CustomWorkflow) => void
  readonly onRemoveCustom: (workflow: CustomWorkflow) => void
}

/**
 * One card, whichever kind: the same face for a flow, a model and an uploaded
 * workflow (a cover, a title, one line), and what a press does stays the
 * kind's own — a flow prepares the composer, a model opens its form, an
 * uploaded workflow its panel page.
 */
function HomeCard({ entry, tall, order, custom, actions }: {
  entry: HomeEntry
  tall: boolean
  order: number
  custom: ReadonlyMap<string, CustomWorkflow>
  actions: HomeCardActions
}) {
  let cover: ReactNode
  let title: string
  let hint: string
  let onClick: () => void
  let workflow: CustomWorkflow | undefined
  if (entry.kind === 'flow') {
    const card = CARD_BY_ID.get(entry.id)
    if (card === undefined) return null
    /*
     * One function for every surface (`CoverMedia`: the precedence lives in
     * `cover-plan.ts`). The repo's clip is passed from here (`motion`) even
     * when there is a custom cover: the cards that have one play it with the
     * user's image as poster, otherwise they stand still and the user loses
     * the motion that was there before (reported on 2026-11-04: some cards
     * used to be videos).
     */
    cover = <CoverMedia className={css.actionCover} cover={card.cover} motion={CARD_MOTION[card.id]} />
    title = translate(card.title)
    hint = translate(card.hint)
    onClick = () => { actions.onCard(card.id) }
  } else if (entry.kind === 'model') {
    const template = templateById(entry.id)
    if (template === undefined) return null
    // Every model ships the studio's own render; the bed stands in if one does not.
    const file: string | undefined = template.cover
    cover = file === undefined
      ? <span className={css.actionBlank} aria-hidden="true" />
      : <CoverMedia className={css.actionCover} cover={file} />
    title = translate(catalogKey(template.titleKey))
    hint = translate(catalogKey(template.descriptionKey))
    onClick = () => { actions.onTemplate(template) }
  } else {
    workflow = custom.get(entry.id)
    if (workflow === undefined) return null
    const own = workflow
    const file = coverOf(own)
    /*
     * An uploaded cover is a file of a known type, drawn as is (`direct`),
     * and a video there honours reduced motion like every other card.
     */
    cover = file === undefined
      ? <span className={css.actionBlank} aria-hidden="true" />
      : <CoverMedia className={css.actionCover} cover={file} direct={own.coverKind === 'video' ? 'video' : 'image'} />
    title = own.title
    hint = own.description
    onClick = () => { actions.onCustom(own) }
  }
  const face = (
    <button
      type="button"
      className={tall ? `${css.action} ${css.actionTall}` : css.action}
      style={workflow === undefined ? { order } : undefined}
      onClick={onClick}
    >
      {cover}
      <span className={css.actionShade} aria-hidden="true" />
      <span className={css.actionCopy}>
        <span className={css.actionTitle}>{title}</span>
        {/*
          The tile clips this to two lines; the tooltip carries the
          whole sentence so nothing is lost on a square.
        */}
        <span className={css.actionHint} title={hint}>{hint}</span>
      </span>
    </button>
  )
  if (workflow === undefined) return face
  const own = workflow
  // An uploaded card can be deleted from its corner, as before.
  return (
    <div className={css.ownCard} style={{ order }}>
      {face}
      <button
        type="button"
        className={css.ownRemove}
        title={translate('imagine.remove')}
        aria-label={translate('imagine.remove')}
        onClick={() => { actions.onRemoveCustom(own) }}
      >
        ×
      </button>
    </div>
  )
}

/**
 * The home's one grid: the workflow cards, the ready-made models and the
 * user's uploaded workflows together (as on Grok Imagine, one set of tools),
 * with a row of chips that keeps one group. The chip is remembered per viewer.
 */
const HomeCards = memo(function HomeCards({ custom, actions, onAdd }: {
  custom: readonly CustomWorkflow[]
  actions: HomeCardActions
  /** Open the form that adds an uploaded workflow. */
  onAdd: () => void
}) {
  const [filter, setFilter] = useState<HomeFilter>(storedHomeFilter)
  const byId = useMemo(() => new Map(custom.map(workflow => [workflow.id, workflow])), [custom])
  const entries = useMemo(() => filterHome(homeOrder(custom), filter), [custom, filter])
  const columns: { entry: HomeEntry; order: number }[][] = Array.from({ length: CARD_COLUMNS }, () => [])
  entries.forEach((entry, order) => { columns[order % CARD_COLUMNS]?.push({ entry, order }) })
  const pick = (next: HomeFilter): void => {
    setFilter(next)
    storeHomeFilter(next)
  }
  return (
    <>
      <div className={css.filters} role="group" aria-label={translate('imagine.home.filterLabel')}>
        {FILTERS.map(chip => (
          <button
            key={chip}
            type="button"
            className={css.filter}
            aria-pressed={chip === filter}
            data-on={chip === filter || undefined}
            onClick={() => { pick(chip) }}
          >
            {translate(FILTER_LABEL[chip])}
          </button>
        ))}
      </div>
      <div className={css.actions}>
        {columns.map((column, gi) => (
          <div className={css.column} key={gi}>
            {column.map(({ entry, order }) => (
              <HomeCard
                key={`${entry.kind}:${entry.id}`}
                entry={entry}
                // The tall one: the top of the middle column.
                tall={order === 1}
                order={order}
                custom={byId}
                actions={actions}
              />
            ))}
            {/*
              * Adding a workflow is one more card, not a strip under the
              * grid: the user's workflows are cards of this same grid, so
              * the way to make one belongs here too. Only under «All» —
              * a chip is a filter, and «Add» is not a photo or a clip.
              */}
            {filter === 'all' && gi === CARD_COLUMNS - 1 && (
              <button
                type="button"
                className={css.addTile}
                // The cards carry their place as `order`; without one of its
                // own the tile would sort first, above the grid's first card.
                style={{ order: entries.length }}
                onClick={onAdd}
              >
                <span className={css.addGlyph} aria-hidden="true">+</span>
                {translate('imagine.custom.add')}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
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
  readonly homeRef: RefObject<HTMLDivElement | null>
  readonly onCard: (id: JobCardId) => void
  /** The uploaded card whose panel is open, if any. */
  readonly customPanel?: CustomWorkflow
  /** The uploaded workflows: their cards sit in the grid. */
  readonly customWorkflows: CustomWorkflowList
  /** Open the full panel of an uploaded card. */
  readonly onOpenCustom: (workflow: CustomWorkflow) => void
  readonly onBackCustom: () => void
  /** The model whose panel is open, by id, if any. */
  readonly templatePanel?: string
  /** Open the panel of one of the ready-made models. */
  readonly onTemplate: (template: Template) => void
  /** Back from a model's panel to the grid. */
  readonly onBackTemplate: () => void
  /**
   * Run a model with its form's answers: the page files the runs in a
   * project (`runTemplateForm`), and the panel hears whether anything started
   * and what stopped it.
   */
  readonly onRunTemplate: (
    template: Template,
    request: { values: Record<string, string | string[]>; files: Record<string, string[]> },
  ) => Promise<{ readonly started: boolean; readonly error?: string }>
  /** Run an uploaded card with its panel's values and files. */
  readonly onRunCustomJob: (workflow: CustomWorkflow, request: CustomRunRequest) => void
  /** Queue one run per value of the card's batch control. */
  readonly onRunCustomBatch: (workflow: CustomWorkflow, request: CustomRunRequest, batch: CustomBatchRequest) => void
}

export function HomeView(props: HomeViewProps) {
  const { store, busy, panelCard, items, composer, homeRef, onCard, onTemplate, onOpenCustom, customWorkflows } = props
  const { remove: removeCustom } = customWorkflows
  /*
   * The add form stands where the grid was, as a card's panel does. It is
   * local to the home: nothing else on the page opens it, and the address
   * of a card is the only thing the URL carries.
   */
  const [adding, setAdding] = useState(false)
  const startAdding = useEvent(() => { setAdding(true) })
  const stopAdding = useEvent(() => { setAdding(false) })
  const cardActions = useMemo((): HomeCardActions => ({
    onCard,
    onTemplate,
    onCustom: onOpenCustom,
    onRemoveCustom: (workflow) => { void removeCustom(workflow) },
  }), [onCard, onTemplate, onOpenCustom, removeCustom])
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
  /*
   * A model's panel stands where the grid was, as a flow card's panel does.
   * The id is kept in the page, so the panel is found again by id: the catalog
   * is the one place that says what a model is.
   */
  const template = props.templatePanel === undefined ? undefined : templateById(props.templatePanel)
  if (template !== undefined) {
    return (
      <div className={css.home} ref={homeRef}>
        <TemplatePanel
          key={template.id}
          template={template}
          items={items}
          busy={busy}
          onRun={async request => await props.onRunTemplate(template, request)}
          onBack={props.onBackTemplate}
          onDone={props.onBackTemplate}
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
  if (adding) {
    return (
      <div className={css.home} ref={homeRef}>
        <AddWorkflowPanel workflows={customWorkflows} onBack={stopAdding} />
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
        {/* What a first run is missing, before the cards promise anything. */}
        <SetupStatusCard />
        <HomeCards custom={customWorkflows.list} actions={cardActions} onAdd={startAdding} />
      </div>
    </div>
  )
}
