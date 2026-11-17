/**
 * The home view's panels: the card whose panel is open, the uploaded
 * workflow shown full page, the composer mode they set, and the slots a panel
 * stages its files in. Split out of ImaginePage.tsx (2026-11-07).
 * @module use-panel-state
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { GalleryItem } from '../../../shared/imagine-types.ts'
import { templateById, type Template } from '../../../shared/imagine-templates.ts'
import type { ComposerStore } from './composer-store.ts'
import { useCustomWorkflowList, type CustomWorkflow } from './custom-workflows-view.tsx'
import { uploadGalleryItem } from './gallery-api.ts'
import type { ImagineView } from './gallery-store.ts'
import { noteFromError } from './imagine-messages.ts'
import { pathOf, type HomePanel } from './imagine-routes.ts'
import { clampSeconds, type ImagineMode } from './imagine-settings.ts'
import { CARD_MODE, slotsOf, type JobCardId } from './job-cards.ts'
import { translate } from './locale-store.ts'
import { kindsLabel } from './labels.ts'
import { STYLE_PRESETS } from './style-catalog.ts'
import type { WorkflowSlot, WorkflowSpec } from './workflow-specs.ts'

/** What the panels read of the page. */
export interface PanelStateContext {
  readonly view: ImagineView
  readonly composer: ComposerStore
  /** The home's own scroll box, which a card sends back to the composer. */
  readonly homeRef: RefObject<HTMLDivElement | null>
  readonly addItems: (items: readonly GalleryItem[]) => void
  /** The note under the composer. */
  readonly setNote: (note: string | undefined) => void
}

export function usePanelState({ view, composer, homeRef, addItems, setNote }: PanelStateContext) {
  /** The card whose dedicated panel the home view shows, if any. */
  const [panelCard, setPanelCard] = useState<JobCardId | undefined>(undefined)
  /**
   * The uploaded workflow open full page, by id: an address can name one
   * before the host has listed them, and the panel shows once it has.
   */
  const [customId, setCustomId] = useState<string | undefined>(undefined)
  /** The uploaded workflows: the grid's cards, and what an id is checked against. */
  const customWorkflows = useCustomWorkflowList()
  const customPanel = customId === undefined ? undefined : customWorkflows.list.find(workflow => workflow.id === customId)
  /** The model («Models») whose panel the home view shows, by id; one at a time. */
  const [templatePanel, setTemplatePanel] = useState<string | undefined>(undefined)

  /**
   * Set the composer's mode and carry the fields only that mode has: the
   * cards and the composer's own seats both come through here.
   * @param next - the mode the next send will run.
   */
  const changeMode = (next: ImagineMode): void => {
    composer.set((state) => {
      let prompt = state.prompt
      if (next === 'style' && !STYLE_PRESETS.some(preset => preset.prompt === prompt)) prompt = STYLE_PRESETS[0]?.prompt ?? ''
      // Look and Style drive the prompt field from a catalogue rather than from
      // typing. Leaving either mode left that internal value sitting in the
      // free field, so the next plain generation ran an English edit
      // instruction, or a look title, that the user never wrote.
      if (next !== 'style' && STYLE_PRESETS.some(preset => preset.prompt === prompt)) prompt = ''
      // The picked step is kept as picked: `resolution` is clamped for display
      // and again at send time, so a trip through Video no longer costs a 1080p
      // choice the next still would have honoured.
      return { mode: next, prompt, seconds: clampSeconds(next, state.resolution, state.seconds) }
    })
    /*
     * The cards sit a screen below the composer on a phone, so a card that only
     * set the mode would look like it did nothing. Where the composer is pinned
     * to the bottom of the scrollport its field is already in view and
     * scrolling would move the tiles for nothing, so this pulls the composer
     * back only when it is really off-screen.
     */
    const home = homeRef.current
    const box = home?.getBoundingClientRect()
    if (home !== null && home !== undefined && box !== undefined) {
      const field = home.querySelector('textarea')?.getBoundingClientRect()
      const offScreen = field === undefined || field.bottom < box.top || field.top > box.bottom
      if (offScreen) home.scrollTo({ top: 0 })
    }
  }

  /*
   * A card opens its panel: a clean composer, in the mode the panel's run
   * this deployment. A model's panel stands down, as `openTemplate` closes the
   * card's: the home shows one surface at a time, and a model left open behind
   * a card came back the moment that card was closed.
   */
  const openPanel = (id: JobCardId): void => {
    setTemplatePanel(undefined)
    setCustomId(undefined)
    composer.set({ sources: [], prompt: '' })
    changeMode(CARD_MODE[id])
    composer.set({ note: undefined, panelUpscaleTo: undefined })
    setPanelCard(id)
    homeRef.current?.scrollTo({ top: 0 })
  }
  /** Close a card's panel: the home composer goes back to its two plain kinds. */
  const closePanel = (): void => {
    setPanelCard(undefined)
    const { mode } = composer.get()
    if (mode !== 'image' && mode !== 'video') changeMode('image')
  }
  /*
   * A model's card opens its own panel, and the other two stand down: the home
   * shows one surface at a time. The panel keeps its form while it is open,
   * so the answers survive a re-render of the page.
   */
  const openTemplate = (template: Template): void => {
    setPanelCard(undefined)
    setCustomId(undefined)
    setTemplatePanel(template.id)
    homeRef.current?.scrollTo({ top: 0 })
  }
  /** Back to the grid of models. */
  const closeTemplate = (): void => {
    setTemplatePanel(undefined)
  }
  /** An uploaded card opens its panel page, and the other two stand down. */
  const openCustom = (workflow: CustomWorkflow): void => {
    if (panelCard !== undefined) closePanel()
    setTemplatePanel(undefined)
    setCustomId(workflow.id)
    homeRef.current?.scrollTo({ top: 0 })
  }
  const closeCustom = (): void => { setCustomId(undefined) }
  /*
   * An address naming an uploaded workflow the host does not have (deleted,
   * mistyped) opens the bare grid, and the address says so without adding a
   * history entry: Back must not land on it again.
   */
  useEffect(() => {
    if (customId === undefined || !customWorkflows.loaded) return
    if (customWorkflows.list.some(workflow => workflow.id === customId)) return
    window.history.replaceState({ view: 'home' }, '', pathOf('home', undefined))
    setCustomId(undefined)
  }, [customId, customWorkflows.loaded, customWorkflows.list])

  /** The panel the home shows, for its address (`/tool/…`, `/model/…`, `/workflow/…`). */
  const homePanel = useMemo((): HomePanel | undefined => {
    if (panelCard !== undefined) return { kind: 'tool', id: panelCard }
    if (templatePanel !== undefined) return { kind: 'model', id: templatePanel }
    if (customId !== undefined) return { kind: 'workflow', id: customId }
    return undefined
  }, [panelCard, templatePanel, customId])
  /**
   * Show the panel an address names (a reload, a pasted link, Back or
   * Forward). A flow card opens exactly as its click opens it: the card's
   * composer mode, with nothing staged and an empty prompt — the address
   * carries the card, not what was typed in it.
   * @param panel - the panel, or undefined for the bare grid.
   */
  const showPanel = (panel: HomePanel | undefined): void => {
    if (panel === undefined) {
      if (panelCard !== undefined) closePanel()
      closeTemplate()
      closeCustom()
      return
    }
    if (panel.kind === 'tool') { openPanel(panel.id); return }
    if (panel.kind === 'model') {
      const template = templateById(panel.id)
      if (template !== undefined) openTemplate(template)
      return
    }
    if (panelCard !== undefined) closePanel()
    setTemplatePanel(undefined)
    setCustomId(panel.id)
  }
  /*
   * A run that opened its project leaves the home view, and the panel goes
   * with it.
   */
  const viewSeenRef = useRef(view)
  useEffect(() => {
    if (view !== 'home' && viewSeenRef.current === 'home') {
      if (panelCard !== undefined) closePanel()
      if (customId !== undefined) closeCustom()
      if (templatePanel !== undefined) closeTemplate()
    }
    viewSeenRef.current = view
    // Deliberately keyed on the view only: the panels close when the page changes.
  }, [view])

  const stageInSlot = (spec: WorkflowSpec, slot: WorkflowSlot, item: GalleryItem | undefined): void => {
    composer.set((state) => {
      const assigned = slotsOf(spec, state.sources)
      // Slot order is the order the run reads them in (`source` is the first).
      return {
        note: undefined,
        sources: spec.slots
          .map(entry => (entry.key === slot.key ? item : assigned[entry.key]))
          .filter((entry): entry is GalleryItem => entry !== undefined),
      }
    })
  }
  const uploadToSlot = async (spec: WorkflowSpec, slot: WorkflowSlot, file: File): Promise<void> => {
    try {
      const item = await uploadGalleryItem(file)
      if (!slot.kinds.includes(item.kind)) {
        setNote(translate('imagine.slotWants', { kinds: kindsLabel(slot.kinds), kind: item.kind }))
        return
      }
      addItems([item])
      stageInSlot(spec, slot, item)
    } catch (error: unknown) {
      setNote(noteFromError(error))
    }
  }

  return {
    panelCard, customPanel, openCustom, closeCustom, customWorkflows, homePanel, showPanel, changeMode, openPanel, closePanel, stageInSlot, uploadToSlot,
    templatePanel, openTemplate, closeTemplate,
  }
}
