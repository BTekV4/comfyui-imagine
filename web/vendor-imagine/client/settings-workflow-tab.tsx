/**
 * The settings page's "Workflow" tab: the action picked, its LoRAs and cover,
 * the pins of its configuration entry and the values of its graph. Split from
 * ImagineSettings (2026-11-07, D17). The staged values live in the page
 * through `useWorkflowValues`, since the page's one "Apply" writes them.
 * @module client/settings-workflow-tab
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  applyWorkflowChanges, fetchWorkflowDetail, fetchWorkflowOptions, planWorkflowValues, restoreWorkflow,
  type ImagineSettingsView, type WorkflowDetail,
} from './gallery-api.ts'
import { COVER_MAX_BYTES } from '../../../shared/cover-kinds.ts'
import type { WorkflowField, WorkflowPlan } from '../../../shared/imagine-chat.ts'
import { WorkflowLoras } from './workflow-loras.tsx'
import { messageOf } from './message-of.ts'
import { failureOf, request } from './http.ts'
import { nodeFieldKey, nodeValueChanges, workflowRows, type WorkflowRow } from './imagine-settings-view.ts'
import type { ComfyLocaleKey } from './locales.ts'
import { ConfigControl, type ControlContext } from './settings-controls.tsx'
import css from './ImagineSettings.module.css'
import { translate } from './locale-store.ts'

/** One node's editable inputs, as the page groups them. */
interface FieldGroup {
  readonly node: string
  readonly classType: string
  readonly fields: readonly WorkflowField[]
}

/**
 * Group one workflow's inputs by node, keeping the fields a filter accepts.
 * @param fields - the workflow's editable inputs.
 * @param filter - text every shown field must contain in its node, class, or field.
 * @returns the groups, in graph order.
 */
function groupFields(fields: readonly WorkflowField[], filter: string): readonly FieldGroup[] {
  const needle = filter.trim().toLowerCase()
  const groups: { node: string; classType: string; fields: WorkflowField[] }[] = []
  for (const field of fields) {
    if (needle.length > 0
      && !`${field.node} ${field.classType} ${field.field}`.toLowerCase().includes(needle)) continue
    const last = groups[groups.length - 1]
    if (last === undefined || last.node !== field.node) {
      groups.push({ node: field.node, classType: field.classType, fields: [field] })
      continue
    }
    last.fields.push(field)
  }
  return groups
}

/** The workflow section's state: the graph shown, the staged node values and what came of them. */
interface WorkflowPanelState {
  readonly detail?: WorkflowDetail | undefined
  readonly detailError?: string | undefined
  /** Staged text per node input, keyed by {@link nodeFieldKey}. */
  readonly fieldDrafts: Readonly<Record<string, string>>
  readonly plan?: WorkflowPlan | undefined
  readonly applying: boolean
  readonly applyError?: string | undefined
  /** The last write: how many values, the backup, and the changes it made (shown under the note). */
  readonly applied?: { readonly count: number; readonly backup: string; readonly diff: WorkflowPlan['diff'] } | undefined
  /** The values ComfyUI allows per node input, once asked for. */
  readonly options: Readonly<Record<string, readonly string[]>>
  readonly optionsError?: string | undefined
  /** The last «Restore default» succeeded: the program's graph is in use again. */
  readonly restoredNote?: boolean | undefined
}

/** What can happen to the workflow section. */
type WorkflowPanelEvent =
  | { readonly type: 'cleared' }
  | { readonly type: 'loaded'; readonly detail: WorkflowDetail }
  | { readonly type: 'loadFailed'; readonly error: string }
  | { readonly type: 'edited'; readonly key: string; readonly text: string }
  | { readonly type: 'planned'; readonly plan: WorkflowPlan }
  | { readonly type: 'applying' }
  | { readonly type: 'applied'; readonly count: number; readonly backup: string; readonly diff: WorkflowPlan['diff'] }
  | { readonly type: 'restored'; readonly detail: WorkflowDetail }
  | { readonly type: 'reloaded'; readonly detail: WorkflowDetail }
  | { readonly type: 'failed'; readonly error: string }
  | { readonly type: 'settled' }
  | { readonly type: 'discarded' }
  | { readonly type: 'options'; readonly key: string; readonly allowed: readonly string[] }
  | { readonly type: 'optionsFailed'; readonly error: string }

const WORKFLOW_PANEL_EMPTY: WorkflowPanelState = { fieldDrafts: {}, applying: false, options: {} }

/**
 * The workflow section's next state. Seven pieces used to be cleared one by
 * one each time another workflow was opened; here that is the `loaded` case.
 * @param state - the section as it is.
 * @param event - what happened.
 * @returns the section after it.
 */
function workflowPanel(state: WorkflowPanelState, event: WorkflowPanelEvent): WorkflowPanelState {
  switch (event.type) {
    case 'cleared': return { ...state, detail: undefined, detailError: undefined }
    case 'loaded': return { ...WORKFLOW_PANEL_EMPTY, applying: state.applying, detail: event.detail }
    case 'loadFailed': return { ...state, detailError: event.error }
    case 'edited': return { ...state, fieldDrafts: { ...state.fieldDrafts, [event.key]: event.text }, plan: undefined, applied: undefined }
    case 'planned': return { ...state, plan: event.plan }
    case 'applying': return { ...state, applying: true, applyError: undefined }
    case 'applied': return { ...state, applied: { count: event.count, backup: event.backup, diff: event.diff }, plan: undefined, fieldDrafts: {}, restoredNote: undefined }
    // The program's graph came back: its field values are the ones to show.
    case 'restored': return { ...state, detail: event.detail, fieldDrafts: {}, plan: undefined, applied: undefined, restoredNote: true }
    case 'reloaded': return { ...state, detail: event.detail }
    case 'failed': return { ...state, applyError: event.error }
    case 'settled': return { ...state, applying: false }
    case 'discarded': return { ...state, fieldDrafts: {}, plan: undefined, applyError: undefined }
    case 'options': return { ...state, options: { ...state.options, [event.key]: event.allowed }, optionsError: undefined }
    case 'optionsFailed': return { ...state, optionsError: event.error }
  }
}

/*
 * Which node inputs name a model, and so want a list instead of a text box.
 *
 * Opening a workflow is usually to change what it runs — the checkpoint, the
 * UNET, a LoRA, the VAE — and until now each of those needed a click on the
 * ▾ beside the field to ask ComfyUI what it has. They are asked for as soon
 * as the graph opens instead, once each.
 */
const MODEL_FIELD = /(^|_)(ckpt|unet|lora|vae|clip|control_net|style_model|model|clip_name\d*)_?name$/i

/** The workflow picked, its graph and the node values staged on it. */
export interface WorkflowValues {
  readonly workflowKey: string | undefined
  readonly setWorkflowKey: (key: string | undefined) => void
  /** The inventory key of the picked entry, when a loaded graph backs it. */
  readonly listedKey: string | undefined
  readonly selected: ImagineSettingsView['workflows'][number] | undefined
  readonly rows: readonly WorkflowRow[]
  readonly panel: WorkflowPanelState
  readonly dispatch: (event: WorkflowPanelEvent) => void
  readonly staged: ReturnType<typeof nodeValueChanges>
  /** Plans and writes the staged values in one go; throws what failed. */
  readonly applyValues: () => Promise<void>
  /** Throws away this app's copy of the graph: the program's file is used again. */
  readonly restoreDefault: () => Promise<void>
  readonly readOptions: (field: WorkflowField) => Promise<void>
  readonly filter: string
  readonly setFilter: (filter: string) => void
}

/**
 * The "Workflow" tab's state, kept by the page.
 * @param view - the settings as the host reports them.
 * @returns the picked workflow, its graph, the staged values and the write.
 */
export function useWorkflowValues(view: ImagineSettingsView | undefined): WorkflowValues {
  const [workflowKey, setWorkflowKey] = useState<string>()
  const [filter, setFilter] = useState('')
  const [panel, dispatch] = useReducer(workflowPanel, WORKFLOW_PANEL_EMPTY)

  // The first workflow the profile configured is the one worth opening.
  useEffect(() => {
    if (view === undefined || workflowKey !== undefined) return
    const configured = view.workflows.find(entry => entry.configured)
    setWorkflowKey(configured?.key ?? view.workflows[0]?.key)
  }, [view, workflowKey])

  // A configured entry is addressed by its inventory key: the node list comes
  // from a loaded graph, which an entry nothing points at does not have.
  const listedKey = view?.workflows.find(entry => entry.key === workflowKey)?.listedKey
  useEffect(() => {
    if (listedKey === undefined) {
      dispatch({ type: 'cleared' })
      return
    }
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const next = await fetchWorkflowDetail(listedKey)
        if (!cancelled) dispatch({ type: 'loaded', detail: next })
      } catch (error: unknown) {
        if (!cancelled) dispatch({ type: 'loadFailed', error: messageOf(error) })
      }
    })()
    return () => { cancelled = true }
  }, [listedKey])

  const selected = view?.workflows.find(entry => entry.key === workflowKey)
  const rows = useMemo(
    () => selected === undefined ? [] : workflowRows(selected.key, selected.composed, selected.override),
    [selected],
  )
  const staged = useMemo(() => nodeValueChanges(panel.fieldDrafts, panel.detail?.fields ?? []), [panel.fieldDrafts, panel.detail])

  /** The changed graph values: planned and written in one go, without a preview. */
  const applyValues = useCallback(async (): Promise<void> => {
    if (listedKey === undefined || staged.changes.length === 0) return
    dispatch({ type: 'applying' })
    try {
      const planned = await planWorkflowValues(listedKey, staged.changes)
      dispatch({ type: 'planned', plan: planned })
      if (planned.diff.length === 0) throw new Error(planned.errors[0] ?? translate('imagine.settings.nothingToApply'))
      const result = await applyWorkflowChanges(listedKey, planned.diff)
      dispatch({ type: 'applied', count: result.applied, backup: result.backup, diff: planned.diff })
      dispatch({ type: 'reloaded', detail: await fetchWorkflowDetail(listedKey) })
    } catch (error: unknown) {
      dispatch({ type: 'failed', error: messageOf(error) })
      throw error
    } finally {
      dispatch({ type: 'settled' })
    }
  }, [listedKey, staged])

  /**
   * «Restore default»: the only way back from a graph changed in the app.
   * Without it the copy in the data folder would win forever, and that graph
   * would never receive the updates that come with a new version.
   */
  const restoreDefault = useCallback(async (): Promise<void> => {
    if (listedKey === undefined) return
    dispatch({ type: 'applying' })
    try {
      await restoreWorkflow(listedKey)
      dispatch({ type: 'restored', detail: await fetchWorkflowDetail(listedKey) })
    } catch (error: unknown) {
      dispatch({ type: 'failed', error: messageOf(error) })
      throw error
    } finally {
      dispatch({ type: 'settled' })
    }
  }, [listedKey])

  const askedOptions = useRef<Set<string>>(new Set())
  const askedForDetail = useRef<unknown>(undefined)

  const readOptions = useCallback(async (field: WorkflowField): Promise<void> => {
    if (listedKey === undefined) return
    const key = nodeFieldKey(field.node, field.field)
    try {
      dispatch({ type: 'options', key, allowed: await fetchWorkflowOptions(listedKey, field.node, field.field) })
    } catch (error: unknown) {
      dispatch({ type: 'optionsFailed', error: messageOf(error) })
    }
  }, [listedKey])

  /*
   * One pass per opened graph: the set is cleared when the detail object
   * changes, so reopening the same workflow asks again instead of showing a
   * list frozen at the first read.
   */
  useEffect(() => {
    if (askedForDetail.current === panel.detail) return
    askedForDetail.current = panel.detail
    askedOptions.current = new Set()
  }, [panel.detail])

  useEffect(() => {
    if (panel.detail === undefined) return
    for (const field of panel.detail.fields) {
      if (field.kind !== 'text') continue
      if (!MODEL_FIELD.test(field.field)) continue
      const key = nodeFieldKey(field.node, field.field)
      if (askedOptions.current.has(key) || panel.options[key] !== undefined) continue
      askedOptions.current.add(key)
      void readOptions(field)
    }
  }, [panel.detail, panel.options, readOptions])

  return {
    workflowKey, setWorkflowKey, listedKey, selected, rows, panel, dispatch, staged, applyValues, restoreDefault,
    readOptions, filter, setFilter,
  }
}

/**
 * The "Workflow" tab.
 * @param props.values - the tab's state, from `useWorkflowValues`.
 * @param props.context - the staged configuration drafts, for the entry's pins.
 * @param props.labels - the actions' names, by configuration key.
 * @returns the tab's section.
 */
export function WorkflowTab({ view, values, context, labels }: {
  view: ImagineSettingsView
  /** The actions' names on the page, by configuration key (`WORKFLOW_LABEL`). */
  labels: Readonly<Record<string, ComfyLocaleKey>>
  values: WorkflowValues
  context: ControlContext
}) {
  const { workflowKey, setWorkflowKey, listedKey, selected, rows, panel, dispatch, readOptions, filter, setFilter, staged } = values
  const { detail, detailError, fieldDrafts, plan, applied, applyError, options, optionsError, restoredNote } = panel
  const groups = useMemo(() => groupFields(detail?.fields ?? [], filter), [detail, filter])
  const invalidFields = useMemo(() => new Set(staged.invalid), [staged])
  /** What came of the last cover upload. */
  const [coverNote, setCoverNote] = useState<string | undefined>(undefined)

  /**
   * One configuration control of a workflow entry, beside the profile's own.
   * @param row - the workflow field to render.
   * @returns the control's row.
   */
  const workflowControl = (row: WorkflowRow) => (
    <ConfigControl
      key={row.path.join('.')}
      spec={{ label: row.label, hint: '', path: row.path, kind: row.kind, composed: selected?.composed, override: selected?.override }}
      context={context}
    />
  )

  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{translate('imagine.settings.workflows')}</h3>
      <p className={css.sectionHint}>{translate('imagine.settings.workflowsHint')}</p>
      <label className={`${css.field} ${css.actionPick}`}>
        <span className={css.fieldLabel}>{translate('imagine.settings.pickWorkflow')}</span>
        <select
          className={css.select}
          value={workflowKey ?? ''}
          onChange={(event) => { setWorkflowKey(event.target.value === '' ? undefined : event.target.value) }}
        >
          {workflowKey === undefined && <option value="">—</option>}
          {view.workflows.map((entry) => {
            const labelKey = labels[entry.key]
            const label = labelKey === undefined ? entry.label ?? entry.key : translate(labelKey)
            return (
              <option key={entry.key} value={entry.key}>
                {entry.configured ? label : `${label} — ${translate('imagine.settings.notConfigured')}`}
              </option>
            )
          })}
        </select>
      </label>
        {/*
          * The LoRA routes address a workflow by the key the inventory
          * knows it by — `generate`, `video` — not by the key of its
          * entry in `config.yaml` (`generateImage`). Passing the second
          * gave "workflow generateImage is not configured" and an empty
          * menu, which reads like "no LoRAs installed".
          */}
        {selected !== undefined && (
          <WorkflowLoras
            workflowKey={selected.listedKey ?? selected.key}
            enabled={selected.configured}
          />
        )}
      {/*
        * The picked action's cover. The file goes to `<data>/covers/` and
        * wins over the repo's, so changing it does not touch the code and
        * is not lost on an update.
        *
        * Since 4-11-2026 it can also be a short video (the covers
        * were animated with Grok): the server recognises the type from
        * the content, not from the file's prefix, and the card plays it
        * muted in a loop.
        *
        * The upload key is the one the card reads (`listedKey`:
        * `generate`, `video`, …), not the entry's key in `config.yaml`
        * (`generateImage`): sending the latter put the file on disk under
        * a name no card asks for, and the cover did not change.
        */}
      {workflowKey !== undefined && (
        <div className={css.field}>
          <span className={css.fieldLabel}>{translate('imagine.settings.cover')}</span>
          <label className={css.button} style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
          {translate('imagine.settings.coverPick')}
          <input
            hidden
            type="file"
            accept="image/*,video/*"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file === undefined) return
              const cardKey = listedKey ?? workflowKey
              void (async () => {
                try {
                  // The file itself is the body, sent as it is (no JSON).
                  const response = await request(`/comfy-cover/${encodeURIComponent(cardKey)}`, 'POST', undefined, { body: file })
                  if (!response.ok) {
                    // The server writes the reason, in the page's
                    // language: a bare "400" does not say what was wrong.
                    const failure = await failureOf(response, '')
                    setCoverNote(`${translate('imagine.settings.coverFailed')} ${failure.message.trim()}`)
                    return
                  }
                  setCoverNote(translate('imagine.settings.coverSaved'))
                  window.location.reload()
                } catch (failure: unknown) {
                  setCoverNote(`${translate('imagine.settings.coverFailed')} ${messageOf(failure)}`)
                }
              })()
            }}
          />
          </label>
          <span className={css.hint}>
            {translate('imagine.settings.coverHint', { max: `${String(Math.round(COVER_MAX_BYTES / (1024 * 1024)))} MB` })}
          </span>
        </div>
      )}
      {coverNote !== undefined && <p className={css.muted} role="status">{coverNote}</p>}
      {/*
        * A graph changed inside the app: the edit went into a copy in the data
        * folder, which wins over the one shipped with the program — updates
        * included. «Restore default» is the way back, and only a graph with a
        * copy offers it (a service writes the file itself, so there is no copy
        * and no need for one).
        */}
      {detail?.overridden === true && (
        <div className={css.field}>
          <span className={css.hint}>{translate('imagine.settings.overridden')}</span>
          <button
            type="button"
            className={css.button}
            style={{ alignSelf: 'flex-start' }}
            disabled={panel.applying}
            onClick={() => { void values.restoreDefault() }}
          >
            {translate('imagine.settings.restoreDefault')}
          </button>
        </div>
      )}
      {restoredNote === true && (
        <p className={css.ok} role="status">{translate('imagine.settings.restored')}</p>
      )}
      {detailError !== undefined && <p className={css.error} role="status">{detailError}</p>}
      {listedKey === undefined && (
        <p className={css.muted} role="status">{translate('imagine.settings.noGraph')}</p>
      )}
      {detail !== undefined && (
        <>
          {detail.warnings.length > 0 && (
            <div className={css.warn}>
              <strong>{translate('imagine.settings.warnings')}</strong>
              <ul className={css.list}>
                {detail.warnings.map(warning => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          )}
          {/*
            * One closed "Advanced" for everything that speaks the graph's
            * language (2026-11-13): before, an "Advanced" box and a "Graph
            * values" list of eleven nodes sat open one after the other, under
            * the LoRAs and the cover that are what one comes here for.
            */}
          <details className={css.more} open={filter.trim() === '' ? undefined : true}>
            <summary className={css.moreHead}>
              <span>{translate('imagine.settings.workflowAdvanced')}</span>
              <span className={css.moreHint}>{translate('imagine.settings.workflowAdvancedHint')}</span>
            </summary>
            {selected?.file !== undefined && (
              <p className={css.hint}>{translate('imagine.settings.workflowFile', { file: selected.file })}</p>
            )}
          <h4 className={css.subTitle}>{translate('imagine.settings.pins')}</h4>
          <p className={css.sectionHint}>{translate('imagine.settings.pinsHint')}</p>
          <div className={css.fields}>
            {rows.map(row => workflowControl(row))}
          </div>

          <h4 className={css.subTitle}>{translate('imagine.settings.values')}</h4>
          <p className={css.sectionHint}>{translate('imagine.settings.valuesHint')}</p>
          <input
            className={css.filter}
            value={filter}
            placeholder={translate('imagine.settings.filter')}
            aria-label={translate('imagine.settings.filter')}
            onChange={(event) => { setFilter(event.target.value) }}
          />
          {groups.length === 0 && <p className={css.muted}>{translate('imagine.settings.noFields')}</p>}
          {/*
            * One node per row, closed: a graph has sixteen nodes and some
            * forty fields, and all open together they were a wall of
            * boxes where nothing could be found. With a filter typed
            * they stay open, because that is where one is searching.
            */}
          {groups.map(group => (
            <details className={css.node} key={group.node} open={filter.trim() === '' ? undefined : true}>
              <summary className={css.nodeHead}>
                <code>{group.node}</code>
                <span className={css.nodeClass}>{group.classType}</span>
                <span className={css.nodeCount}>{group.fields.length}</span>
              </summary>
              {group.fields.map((field) => {
                const key = nodeFieldKey(field.node, field.field)
                const text = fieldDrafts[key] ?? String(field.value)
                const allowed = options[key]
                const choices = allowed !== undefined
                  ? [...new Set([text, ...allowed])]
                  : field.kind === 'boolean' ? ['false', 'true'] : undefined
                const stageHere = (next: string): void => { dispatch({ type: 'edited', key, text: next }) }
                return (
                  <div className={css.row} key={key}>
                    <label className={css.rowLabel} htmlFor={`imagine-node-${key}`}>{field.field}</label>
                    {choices === undefined
                      ? (
                        <input
                          id={`imagine-node-${key}`}
                          className={css.input}
                          value={text}
                          onChange={(event) => { stageHere(event.target.value) }}
                        />
                      )
                      : (
                        <select
                          id={`imagine-node-${key}`}
                          className={css.select}
                          value={text}
                          onChange={(event) => { stageHere(event.target.value) }}
                        >
                          {choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
                        </select>
                      )}
                    {allowed === undefined && field.kind === 'text' && (
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={translate('imagine.settings.options')}
                        title={translate('imagine.settings.options')}
                        onClick={() => { void readOptions(field) }}
                      >
                        ▾
                      </button>
                    )}
                    {invalidFields.has(key) && <span className={css.invalid}>{translate('imagine.settings.invalid')}</span>}
                  </div>
                )
              })}
            </details>
          ))}
          {optionsError !== undefined && (
            <p className={css.error} role="status">{translate('imagine.settings.optionsFailed')}: {optionsError}</p>
          )}
          {plan !== undefined && plan.errors.length > 0 && (
            <ul className={css.list}>
              {plan.errors.map(problem => <li key={problem} className={css.error}>{problem}</li>)}
            </ul>
          )}
          {/* The changes of the request in flight, then of the write that applied them. */}
          {(applied?.diff ?? plan?.diff ?? []).length > 0 && (
            <ul className={css.list}>
              {(applied?.diff ?? plan?.diff ?? []).map(change => (
                <li key={`${change.node}-${change.field}`} className={css.diff}>
                  <code>{change.node}</code>
                  {` ${change.field}: ${String(change.from)} → ${String(change.to)}`}
                </li>
              ))}
            </ul>
          )}
          {plan !== undefined && plan.diff.length === 0 && plan.errors.length === 0 && (
            <p className={css.muted}>{translate('imagine.settings.noChanges')}</p>
          )}
          {applied !== undefined && (
            <p className={css.ok} role="status">
              {translate('imagine.settings.applied', { count: String(applied.count), backup: applied.backup })}
            </p>
          )}
          {applyError !== undefined && <p className={css.error} role="status">{applyError}</p>}
          </details>
        </>
      )}
    </section>
  )
}
