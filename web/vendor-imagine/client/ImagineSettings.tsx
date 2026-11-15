/**
 * The Imagine settings page: the ComfyUI server, the live state of that
 * server, the workflow behind every action, and where produced files land.
 *
 * Two kinds of change live here. A configuration edit goes to a file beside
 * the studio's own state, which the host merges over the profile at the next
 * restart — the page says so while a saved change is pending. A node value is
 * written straight into the workflow JSON, so it applies at once and keeps the
 * previous file.
 *
 * The page keeps what its one "Apply" writes (the host's drafts, the
 * configuration drafts, the graph's values) and the tabs draw it: Models and
 * General here, Studio in `settings-studio-tab.tsx`, Workflow in
 * `settings-workflow-tab.tsx` (split 2026-11-07: one 816-line component).
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchImagineJobs, fetchImagineSettings, saveImagineSettingOps, type ImagineSettingsView } from './gallery-api.ts'
import { messageOf } from './message-of.ts'
import { restartImagine } from './imagine-restart.ts'
import type { HostPending } from '../../src/HostSettings.tsx'
import { availableLocales, setLocale, translate, useLocale, useLocaleFallback } from './locale-store.ts'
import { draftOf, hasInvalidDraft, stagedOps, type FieldKind, type SettingDraft } from './imagine-settings-view.ts'
import type { ComfyLocaleKey } from './locales.ts'
import type { ControlContext } from './settings-controls.tsx'
import { StudioTab, useComfyServer } from './settings-studio-tab.tsx'
import { WorkflowTab, useWorkflowValues } from './settings-workflow-tab.tsx'
import css from './ImagineSettings.module.css'

/** Props for the settings page. */
export interface ImagineSettingsProps {
  /**
   * The two halves of the host's own settings, one per tab. Each gets the hook
   * through which it announces its unsaved draft to the page's "Apply".
   */
  readonly lead?: {
    readonly models: (onPending: (pending: HostPending | undefined) => void) => ReactNode
    readonly access: (onPending: (pending: HostPending | undefined) => void) => ReactNode
  }
  /** Leads to the plugins page, which is not a section of the settings. */
  readonly onOpenPlugins?: () => void
}

/**
 * The settings page's tabs. One page held every control the studio has — the
 * models, the access, ComfyUI, the folder, twenty graphs — and finding one
 * meant scrolling through the rest.
 */
const TABS = [
  // General first since 2026-11-13: "Models" opened on the chat's LLM, which
  // read like the image models; it is now "Assistant", and Studio "ComfyUI".
  { id: 'access', label: 'imagine.settings.tabGeneral' },
  { id: 'models', label: 'imagine.settings.tabModels' },
  { id: 'studio', label: 'imagine.settings.tabStudio' },
  { id: 'workflow', label: 'imagine.settings.tabWorkflow' },
] as const

type SettingsTab = typeof TABS[number]['id']

/**
 * The name the actions have on the page, by the key of the configuration
 * entry: `/comfy-imagine/settings` lists the workflows this way (see
 * `WORKFLOW_ROWS` in `server/vendor/tool-comfy/workflow-fields.ts`).
 *
 * `label` comes from the server, written in Italian in the configuration: with
 * this table the workflow picker speaks the chosen language, and an action the
 * dictionary does not know falls back to the server's label. The keys used to
 * be the *runner*'s names (`generate`, `video`, ...), which the server does not
 * send: no row found its translation and the page stayed in Italian
 * (4-11-2026).
 */
const WORKFLOW_LABEL: Readonly<Record<string, ComfyLocaleKey>> = {
  generateImage: 'imagine.generate',
  recreateFrame: 'imagine.workflowRecreateFrame',
  editImage: 'imagine.remix',
  composeRefs: 'imagine.compose',
  editImageRegion: 'imagine.workflowEditRegion',
  createVideo: 'imagine.makeVideo',
  recreateVideo: 'imagine.workflowRecreateVideo',
  loopVideo: 'imagine.makeLoop',
  extendVideo: 'imagine.workflowExtend',
  objectSwap: 'imagine.workflowObjectSwap',
  objectSwapRemove: 'imagine.workflowObjectSwapRemove',
  objectSwapBackground: 'imagine.workflowObjectSwapBackground',
  objectSwapAdd: 'imagine.workflowObjectSwapAdd',
  objectSwapAddPhoto: 'imagine.workflowObjectSwapAddPhoto',
  swapPerson: 'imagine.swapPerson',
  swapPersonNoLipSync: 'imagine.workflowSwapPersonNoLipSync',
  createVideoChain: 'imagine.workflowVideoChain',
  extendVideoChain: 'imagine.workflowExtendChain',
  loopVideoChain: 'imagine.workflowLoopChain',
  relight: 'imagine.workflowRelight',
  videoOnSong: 'imagine.workflowVideoSong',
  upscaleImage: 'imagine.workflowUpscaleImage',
  upscaleVideo: 'imagine.workflowUpscaleVideo',
  upscaleVideoLong: 'imagine.workflowUpscaleVideoLong',
  regenerateDetail: 'imagine.regenerateDetail',
  removeBackground: 'imagine.bgRemoval',
  generateMusic: 'imagine.makeMusic',
  changeVoice: 'imagine.changeVoice',
}

/**
 * The "General" tab: the page's language, the host's access settings, and the
 * way to the plugins (moved here from Studio on 2026-11-13).
 * @param props.children - the host's half of the tab.
 * @param props.onOpenPlugins - leads to the plugins page.
 */
function GeneralTab({ children, onOpenPlugins }: { children: ReactNode; onOpenPlugins: (() => void) | undefined }) {
  const activeLocale = useLocale()
  const languages = availableLocales()
  const missingPack = useLocaleFallback()
  return (
    <>
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.language')}</h3>
        <div className={css.localeRow}>
          <label className={css.localeLabel}>
            <select
              className={css.select}
              value={activeLocale}
              onChange={(event) => {
                // Constants translated at module load are only rebuilt by reloading.
                setLocale(event.target.value)
                window.location.reload()
              }}
            >
              {languages.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          {missingPack !== undefined && (
            <p className={css.localeFallback} role="status">
              {translate('imagine.localePackMissing', { language: missingPack.toUpperCase() })}
            </p>
          )}
        </div>
      </section>
      {children}
      {/*
        * The plugins are not set up here: they have a page of their own,
        * reached from the rail. Only the pointer stays, because whoever looks
        * for the Instagram settings the first time comes through the settings.
        */}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.plugins.title')}</h3>
        <p className={css.sectionHint}>{translate('imagine.plugins.settingsHint')}</p>
        <div className={css.actions}>
          <button type="button" className={css.button} onClick={() => { onOpenPlugins?.() }}>
            {translate('imagine.plugins.openFromSettings')}
          </button>
        </div>
      </section>
    </>
  )
}

/**
 * The Imagine settings page.
 * @param props - the host's halves and the way to the plugins.
 * @returns the page.
 */
export function ImagineSettings({ lead, onOpenPlugins }: ImagineSettingsProps) {
  const [tab, setTab] = useState<SettingsTab>('access')
  const [view, setView] = useState<ImagineSettingsView>()
  const [loadError, setLoadError] = useState<string>()
  const [drafts, setDrafts] = useState<Record<string, SettingDraft>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  /** The drafts of the host's two halves, per tab: the same button applies them. */
  const [hostPending, setHostPending] = useState<Readonly<Record<'models' | 'access', HostPending | undefined>>>({ models: undefined, access: undefined })
  const pendingModels = useCallback((pending: HostPending | undefined) => { setHostPending(current => ({ ...current, models: pending })) }, [])
  const pendingAccess = useCallback((pending: HostPending | undefined) => { setHostPending(current => ({ ...current, access: pending })) }, [])
  /** Outcome of the last "Apply". */
  const [applyNote, setApplyNote] = useState<{ readonly kind: 'ok' | 'error' | 'muted'; readonly text: string }>()

  const comfy = useComfyServer(view?.server.running.restartReadyMs)
  const values = useWorkflowValues(view)
  const { staged, applyValues, dispatch } = values

  const load = useCallback(async (): Promise<void> => {
    try {
      setView(await fetchImagineSettings())
      setLoadError(undefined)
    } catch (error: unknown) {
      setLoadError(messageOf(error))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const ops = useMemo(() => stagedOps(drafts), [drafts])
  const invalidDrafts = hasInvalidDraft(drafts)

  const stage = useCallback((path: readonly string[], kind: FieldKind, text: string): void => {
    setDrafts(previous => ({ ...previous, [path.join('.')]: draftOf(kind, text) }))
  }, [])
  const context: ControlContext = { drafts, saving, onStage: stage }

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    setSaveError(undefined)
    try {
      const next = await saveImagineSettingOps(ops)
      setView(next)
      setDrafts({})
    } catch (error: unknown) {
      setSaveError(messageOf(error))
      throw error
    } finally {
      setSaving(false)
    }
  }, [ops])

  /*
   * A single "Apply" for the whole page (2026-11-07): before there were a
   * "Save" for Models, one for Access, a bar for Studio/Workflow that applied
   * "at the next restart", and "Preview"/"Apply" for the graph's values. Here
   * everything is saved, and when the configuration asks for it Imagine
   * restarts by itself and the page reloads its data.
   */
  const pendingCount = (hostPending.models?.count ?? 0) + (hostPending.access?.count ?? 0)
    + ops.length + staged.changes.length
  const [applyingAll, setApplyingAll] = useState(false)
  const applyAll = useCallback(async (): Promise<void> => {
    setApplyingAll(true)
    setApplyNote({ kind: 'muted', text: translate('imagine.settings.applyingAll') })
    try {
      for (const pending of [hostPending.models, hostPending.access]) {
        if (pending !== undefined) await pending.apply()
      }
      if (staged.changes.length > 0) await applyValues()
      let restart = false
      if (ops.length > 0) {
        await save()
        restart = (await fetchImagineSettings()).pendingRestart
      }
      /*
       * A restart empties the job queue (it lives in memory), so it never
       * happens under running or queued work: the change is saved and takes
       * effect at the next restart, and the page says so.
       */
      const busy = restart
        ? (await fetchImagineJobs()).filter(job => job.status === 'queued' || job.status === 'running').length
        : 0
      if (restart && busy > 0) {
        await load()
        setApplyNote({ kind: 'muted', text: translate('imagine.settings.appliedLater', { count: String(busy) }) })
        return
      }
      if (restart) {
        setApplyNote({ kind: 'muted', text: translate('imagine.settings.restartingImagine') })
        if (!(await restartImagine())) throw new Error(translate('imagine.imagineComingBack'))
        await load()
      }
      setApplyNote({ kind: 'ok', text: restart ? translate('imagine.settings.appliedRestarted') : translate('imagine.settings.appliedAll') })
    } catch (error: unknown) {
      setApplyNote({ kind: 'error', text: `${translate('imagine.saveFailed')}: ${messageOf(error)}` })
    } finally {
      setApplyingAll(false)
    }
  }, [hostPending, staged, ops, applyValues, save, load])
  const resetAll = useCallback((): void => {
    hostPending.models?.reset()
    hostPending.access?.reset()
    setDrafts({})
    dispatch({ type: 'discarded' })
    setApplyNote(undefined)
  }, [hostPending])

  if (loadError !== undefined) {
    return (
      <div className={css.root}>
        <div className={css.body}>
          <p className={css.error} role="status">{translate('imagine.error')}: {loadError}</p>
          <button type="button" className={css.button} onClick={() => { void load() }}>{translate('imagine.refresh')}</button>
        </div>
      </div>
    )
  }

  if (view === undefined) {
    return (
      <div className={css.root}>
        <div className={css.body}>
          <p className={css.muted} role="status">{translate('imagine.loading')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={css.root}>
      <div className={css.body}>
        <header className={css.head}>
          <h2 className={css.title}>{translate('imagine.settings.title')}</h2>
          <p className={css.subtitle}>{translate('imagine.settings.subtitle')}</p>
          {view.pendingRestart && <p className={css.notice} role="status">{translate('imagine.settings.pendingRestart')}</p>}
          {view.appliedProblem !== undefined && (
            <p className={css.warn} role="status">{translate('imagine.settings.appliedProblem', { problem: view.appliedProblem })}</p>
          )}
          {view.fileProblem !== undefined && (
            <p className={css.warn} role="status">{translate('imagine.settings.fileProblem', { problem: view.fileProblem })}</p>
          )}
          {saveError !== undefined && <p className={css.error} role="status">{translate('imagine.saveFailed')}: {saveError}</p>}
        </header>

        <nav className={css.tabBar} role="tablist">
          {TABS.map(entry => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? css.tabBarOn : css.tabBarButton}
              onClick={() => { setTab(entry.id) }}
            >
              {translate(entry.label)}
            </button>
          ))}
        </nav>
        <div className={css.pane} hidden={tab !== 'models'}>{lead?.models(pendingModels)}</div>
        <div className={css.pane} hidden={tab !== 'access'}>
          <GeneralTab onOpenPlugins={onOpenPlugins}>{lead?.access(pendingAccess)}</GeneralTab>
        </div>
        {tab === 'studio' && <StudioTab view={view} comfy={comfy} context={context} />}
        {tab === 'workflow' && <WorkflowTab view={view} values={values} context={context} labels={WORKFLOW_LABEL} />}
      </div>

      <div className={css.footer}>
        <span className={applyNote?.kind === 'error' ? css.error : applyNote?.kind === 'ok' ? css.ok : css.muted} role="status">
          {applyNote?.text ?? (pendingCount === 0
            ? translate('imagine.settings.noChanges')
            : translate('imagine.settings.changesToApply', { count: String(pendingCount) }))}
        </span>
        <button type="button" className={css.button} disabled={applyingAll || pendingCount === 0} onClick={resetAll}>
          {translate('imagine.workflowCancel')}
        </button>
        <button
          type="button"
          className={css.buttonPrimary}
          disabled={applyingAll || saving || pendingCount === 0 || invalidDrafts || staged.invalid.length > 0}
          onClick={() => { void applyAll() }}
        >
          {applyingAll ? translate('imagine.settings.applying') : translate('imagine.settings.applyAll')}
        </button>
      </div>
    </div>
  )
}
