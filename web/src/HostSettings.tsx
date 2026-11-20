/**
 * "General": the settings DSH used to hold for the studio — the LLM gateway
 * and its key, the models the chip offers, the Instagram scheduler, Telegram
 * notices, login and the resume at boot. One model for every pass since
 * 2026-10-31: chat, eyes and Instagram all read `defaultModel`.
 *
 * Saved to the studio host (`/api/host-settings`), which applies them at
 * once; only the resume sweep waits for a restart, offered here.
 */
import type { ComfyLocaleKey } from '../vendor-imagine/client/locales.ts'
import { messageOf } from '../vendor-imagine/client/message-of.ts'
import { translate } from '../vendor-imagine/client/locale-store.ts'
import { useEffect, useRef, useState } from 'react'
import { getJson, send } from '../vendor-imagine/client/http.ts'
import { restartImagine } from '../vendor-imagine/client/imagine-restart.ts'
import css from '../vendor-imagine/client/ImagineSettings.module.css'
import own from './HostSettings.module.css'
import { isThinkingLevel, THINKING_DEFAULT, THINKING_FALLBACK } from '../../shared/host-settings.ts'
import { AGENT_LIMITS_DEFAULT, isAgentChatMode, type AgentChatMode } from '../../shared/agent-chat.ts'
import type { HostSettingsPatch as Patch, HostSettingsView as View, LoraEntry, ThinkingLevel } from '../../shared/host-settings.ts'
import type { HostAccessView } from '../../shared/host-access.ts'
import type { ModelEntry, ModelRoute as Route } from '../../shared/imagine-types.ts'
import { presetFor, PROVIDER_PRESETS } from '../../shared/provider-presets.ts'

const keyOf = (route: Route): string => `${route.provider}\u001f${route.model}`
const routeOf = (key: string): Route => {
  const [provider = '', model = ''] = key.split('\u001f')
  return { provider, model }
}

/**
 * This half's changes not yet applied: the settings page has a single
 * "Apply" button for every tab (2026-11-07), and each part reports its
 * changes here instead of having its own "Save".
 */
export interface HostPending {
  readonly count: number
  /** Saves the draft; rejects if the server did not take it. */
  readonly apply: () => Promise<void>
  readonly reset: () => void
}

/**
 * The settings DSH used to own, in the two halves the settings page shows on
 * two separate tabs: the models it talks to, and who may use the studio.
 * @param props.sections - which half to render; `all` for both.
 * @param props.onPending - told whenever the draft changes, for the page's "Apply".
 * @returns the sections.
 */
export function HostSettings({ sections = 'all', onPending }: {
  readonly sections?: 'all' | 'models' | 'social'
  readonly onPending?: (pending: HostPending | undefined) => void
} = {}) {
  const [view, setView] = useState<View>()
  /**
   * What `/api/access` says: the Access card shows the open-studio warning as
   * hidden, and the button that puts it back. The page hides it from the strip
   * itself; this side reads the same state.
   */
  const [access, setAccess] = useState<HostAccessView>()
  const [draft, setDraft] = useState<Patch>({})
  const [catalog, setCatalog] = useState<string[]>()
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'muted'; text: string }>()
  const load = async (): Promise<void> => {
    try {
      setView(await getJson<View>('/api/host-settings', 'HTTP'))
    } catch (error: unknown) {
      setStatus({ kind: 'error', text: translate('imagine.settings.unread', { error: messageOf(error) }) })
    }
  }
  useEffect(() => { void load() }, [])
  /**
   * The access state, read again after the strip is hidden: the row only
   * exists while the warning is hidden, so a failure leaves it out.
   */
  useEffect(() => {
    const read = (): void => {
      void getJson<HostAccessView>('/api/access', 'HTTP').then(setAccess, () => undefined)
    }
    read()
    window.addEventListener('imagine:access-changed', read)
    return () => { window.removeEventListener('imagine:access-changed', read) }
  }, [])

  const value = <K extends keyof Patch>(key: K): Patch[K] | undefined =>
    (draft[key] ?? (view as Patch | undefined)?.[key])
  const set = (patch: Patch): void => { setDraft(current => ({ ...current, ...patch })) }
  const dirty = Object.keys(draft).length > 0
  const models = (value('models') ?? []) as ModelEntry[]
  /** The thinking level in force (draft, then saved, then default). */
  const thinking = (): ThinkingLevel => {
    const chosen = value('thinking')
    return isThinkingLevel(chosen) ? chosen : THINKING_DEFAULT
  }
  /** The agent switch in force (draft, then saved, then `auto`). */
  const agentMode = (): AgentChatMode => {
    const chosen = value('agentChat')
    return isAgentChatMode(chosen) ? chosen : 'auto'
  }
  /** The longest clip the agent may queue without asking (draft, then saved, then the default). */
  const confirmSeconds = (): number => {
    const chosen = value('agentConfirmSeconds')
    return typeof chosen === 'number' && Number.isInteger(chosen) && chosen > 0 ? chosen : AGENT_LIMITS_DEFAULT.confirmSeconds
  }
  /**
   * The seconds field as it is being typed.
   *
   * A number is already the draft while it is valid, so "Apply" never saves the
   * value the field showed a moment before; the text stays here until the field
   * is left, and then what the server would refuse is dropped instead of kept
   * on screen as if it had been taken.
   */
  /** The LoRA catalog in force: the draft, else what is saved. */
  const loras = (value('loraCatalog') ?? []) as readonly LoraEntry[]
  /**
   * Write one catalog row. An empty row is kept while the user types in it and
   * dropped on save (`save` sends the rows that say something), so "Add" cannot
   * make the save fail before a key is pressed.
   */
  const writeLora = (index: number, patch: Partial<LoraEntry>): void => {
    const next = loras.map((entry, at) => at === index ? { ...entry, ...patch } : entry)
    set({ loraCatalog: next })
  }
  const dropLora = (index: number): void => {
    set({ loraCatalog: loras.filter((_entry, at) => at !== index) })
  }
  const addLora = (): void => {
    set({ loraCatalog: [...loras, { file: '', purpose: '' }] })
  }
  const [confirmTyped, setConfirmTyped] = useState<string>()
  const typeConfirm = (typed: string): void => {
    setConfirmTyped(typed)
    const seconds = Number(typed)
    if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 3_600) set({ agentConfirmSeconds: seconds })
  }
  const commitConfirm = (typed: string): void => {
    setConfirmTyped(undefined)
    const seconds = Number(typed)
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3_600) return
    set({ agentConfirmSeconds: seconds })
  }
  /*
   * The levels the gateway declares for the model in force
   * (`capabilities.effort_tiers`): the page has no list of its own. Until the
   * answer arrives the select stays disabled; if the gateway does not answer
   * the fallback is shown, and the saved value is always there.
   */
  const [levels, setLevels] = useState<readonly ThinkingLevel[]>()
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const answer = await getJson<{ levels?: readonly string[] }>('/api/thinking-levels', 'HTTP')
        const listed = (answer.levels ?? []).filter(isThinkingLevel)
        if (alive) setLevels(listed.length > 0 ? listed : THINKING_FALLBACK)
      } catch {
        if (alive) setLevels(THINKING_FALLBACK)
      }
    })()
    return () => { alive = false }
  }, [])
  /** The select's options: the gateway's, plus the saved value if it is not listed. */
  const thinkingOptions = (() => {
    const listed = levels === undefined ? [] : [...levels]
    const current = thinking()
    return listed.includes(current) ? listed : [current, ...listed]
  })()
  // Which preset the configured address belongs to, so the picker can show it.
  const providerPreset = presetFor(typeof value('gatewayURL') === 'string' ? value('gatewayURL') as string : '')
  // Rebuilt each render: `models` is a new array whenever the draft or the
  // view is read again, so a memo keyed on it never held.
  const options = models.map(entry => ({ key: keyOf({ provider: entry.provider, model: entry.id }), label: entry.name ?? entry.id }))
  const picked = new Set(models.map(entry => entry.id))

  const save = async (): Promise<void> => {
    setStatus(undefined)
    try {
      // A row nobody filled in is not a LoRA: it is not sent, so an "Add" the
      // user changed their mind about does not refuse the whole save.
      const body = draft.loraCatalog === undefined
        ? draft
        : {
          ...draft,
          loraCatalog: draft.loraCatalog.filter(entry => entry.file.trim() !== '' || entry.purpose.trim() !== ''),
        }
      setView(await send<View>('/api/host-settings', 'POST', body, 'HTTP'))
      setDraft({})
      // The login switch and the password may have moved: the page's rail and
      // its warning read `/api/access` again.
      window.dispatchEvent(new Event('imagine:access-changed'))
    } catch (error: unknown) {
      setStatus({ kind: 'error', text: translate('imagine.settings.unsaved', { error: messageOf(error) }) })
      throw error
    }
  }
  /**
   * Put the open-studio warning back on every device. The hide is a click on
   * the strip itself, so there is nothing to apply here: this acts at once.
   */
  const showBanner = async (): Promise<void> => {
    setStatus(undefined)
    try {
      setAccess(await send<HostAccessView>('/api/access/banner/show', 'POST', {}, 'HTTP'))
      // The strip above the stage reads the same state.
      window.dispatchEvent(new Event('imagine:access-changed'))
      setStatus({ kind: 'ok', text: translate('imagine.access.shownAgain') })
    } catch (error: unknown) {
      setStatus({ kind: 'error', text: messageOf(error) })
    }
  }
  // The page's "Apply" always calls the current version, with the current draft.
  const saveRef = useRef(save)
  saveRef.current = save
  const pendingRef = useRef(onPending)
  pendingRef.current = onPending
  const draftCount = Object.keys(draft).length
  useEffect(() => {
    pendingRef.current?.(draftCount === 0
      ? undefined
      : { count: draftCount, apply: () => saveRef.current(), reset: () => { setDraft({}) } })
  }, [draft, draftCount])
  useEffect(() => () => { pendingRef.current?.(undefined) }, [])

  const readCatalog = async (): Promise<void> => {
    setStatus({ kind: 'muted', text: translate('imagine.host.readingCatalog') })
    try {
      const { ids } = await getJson<{ ids: string[] }>('/api/host-settings/catalog', 'HTTP')
      setCatalog(ids)
      setStatus({ kind: 'muted', text: translate('imagine.host.catalogLoaded', { count: ids.length }) })
    } catch (error: unknown) {
      setStatus({ kind: 'error', text: messageOf(error) })
    }
  }

  /*
   * The provider the config defines for this gateway (`gatewayProvider`, a
   * baseURL match done by the server): the catalog writes that name, not a
   * hard-coded one the config may not have.
   */
  const gatewayProvider = view?.gatewayProvider
  const toggleModel = (id: string, on: boolean): void => {
    if (gatewayProvider === undefined) return
    const picked = models.some(entry => entry.provider === gatewayProvider && entry.id === id)
    if (on === picked) return
    const next = on
      ? [...models, { provider: gatewayProvider, id, name: id.replace(/^[^/]+\//, '') }]
      : models.filter(entry => !(entry.provider === gatewayProvider && entry.id === id))
    set({ models: next })
  }

  const restart = async (): Promise<void> => {
    setStatus({ kind: 'muted', text: translate('imagine.host.restarting') })
    try {
      if (!(await restartImagine())) {
        setStatus({ kind: 'error', text: translate('imagine.imagineComingBack') })
        return
      }
      await load()
      setStatus({ kind: 'ok', text: translate('imagine.imagineUp') })
    } catch (error: unknown) {
      setStatus({ kind: 'error', text: messageOf(error) })
    }
  }

  if (view === undefined) {
    return (
      <section className={css.section}>
        <p className={status?.kind === 'error' ? css.error : css.muted} role="status">{status?.text ?? translate('imagine.loadingShort')}</p>
      </section>
    )
  }

  const routeSelect = (label: string, hint: string) => {
    const current = value('defaultModel') as Route
    const known = options.some(option => option.key === keyOf(current))
    return (
      <label className={own.row}>
        <span className={own.label}>{label}</span>
        <select
          className={css.select}
          value={keyOf(current)}
          onChange={(event) => { set({ defaultModel: routeOf(event.target.value) }) }}
        >
          {!known && <option value={keyOf(current)}>{translate('imagine.host.notInList', { model: current.model })}</option>}
          {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
        <span className={css.hint}>{hint}</span>
      </label>
    )
  }

  const toggle = (label: string, hint: string, key: 'resumeSweep' | 'requireLogin' | 'autoSetup') => (
    <label className={own.toggleRow}>
      <input
        type="checkbox"
        checked={value(key) === true}
        onChange={(event) => { set({ [key]: event.target.checked }) }}
      />
      <span>
        <span className={own.label}>{label}</span>
        <span className={css.hint}>{hint}</span>
      </span>
    </label>
  )

  const statusLine = status !== undefined && (
    <p className={status.kind === 'ok' ? css.ok : status.kind === 'error' ? css.error : css.muted} role="status">{status.text}</p>
  )

  return (
    <>
      {statusLine}
      {sections !== 'social' && <>

      {/*
        * Two cards since 2026-11-13: where the assistant is (provider,
        * address, key) and who it is (model, thinking, the selector). One card
        * with seven rows read as a single wall of fields.
        */}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.host.connection')}</h3>
        <p className={css.sectionHint}>{translate('imagine.host.connectionHint')}</p>
        <label className={own.row}>
          <span className={own.label}>Provider</span>
          <select
            className={own.input}
            value={providerPreset?.id ?? 'custom'}
            onChange={(event) => {
              const preset = PROVIDER_PRESETS.find(entry => entry.id === event.target.value)
              set(preset === undefined ? {} : { gatewayURL: preset.baseURL })
            }}
          >
            <option value="custom">{translate('imagine.host.providerCustom')}</option>
            {PROVIDER_PRESETS.map(preset => (
              <option key={preset.id} value={preset.id}>{preset.local === true ? `${preset.label} (${translate('imagine.preset.localTag')})` : preset.label}</option>
            ))}
          </select>
          <span className={css.hint}>
            {providerPreset === undefined
              ? translate('imagine.host.noPreset')
              : translate('imagine.host.presetKeyEnv', { note: translate(providerPreset.noteKey as ComfyLocaleKey), env: providerPreset.keyEnv })}
          </span>
        </label>
        <label className={own.row}>
          <span className={own.label}>{translate('imagine.host.9')}</span>
          <input
            className={own.input}
            value={value('gatewayURL') as string}
            onChange={(event) => { set({ gatewayURL: event.target.value }) }}
          />
        </label>
        <label className={own.row}>
          <span className={own.label}>{translate('imagine.host.keyLabel')}</span>
          <input
            className={own.input}
            type="password"
            autoComplete="off"
            placeholder={view.apiKeySet
              ? `${translate('imagine.host.keySet', { tail: view.apiKeyTail })}${view.apiKeyFromEnv ? translate('imagine.host.keyFromEnv') : ''}`
              : translate('imagine.host.keyNone')}
            value={draft.apiKey ?? ''}
            onChange={(event) => { set({ apiKey: event.target.value }) }}
          />
        </label>
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.host.loraSection')}</h3>
        <span className={css.hint}>{translate('imagine.host.loraHint')}</span>
        {loras.map((entry, index) => (
          <div className={own.row} key={`${entry.file}-${String(index)}`}>
            <input
              className={own.input}
              aria-label={translate('imagine.host.loraFile')}
              placeholder={translate('imagine.host.loraFile')}
              value={entry.file}
              onChange={(event) => { writeLora(index, { file: event.target.value }) }}
            />
            <input
              className={own.input}
              aria-label={translate('imagine.host.loraPurpose')}
              placeholder={translate('imagine.host.loraPurpose')}
              value={entry.purpose}
              onChange={(event) => { writeLora(index, { purpose: event.target.value }) }}
            />
            <input
              className={own.input}
              aria-label={translate('imagine.host.loraTrigger')}
              placeholder={translate('imagine.host.loraTrigger')}
              value={entry.trigger ?? ''}
              onChange={(event) => { writeLora(index, { trigger: event.target.value }) }}
            />
            <input
              className={own.input}
              type="number"
              min="0"
              max="2"
              step="0.05"
              aria-label={translate('imagine.host.loraWeight')}
              placeholder={translate('imagine.host.loraWeight')}
              value={entry.weight === undefined ? '' : String(entry.weight)}
              onChange={(event) => {
                const weight = Number(event.target.value)
                writeLora(index, { weight: event.target.value === '' || !Number.isFinite(weight) ? undefined : weight })
              }}
            />
            <button type="button" className={css.select} onClick={() => { dropLora(index) }}>
              {translate('imagine.host.loraRemove')}
            </button>
          </div>
        ))}
        <div className={own.row}>
          <button type="button" className={css.select} onClick={addLora}>
            {translate('imagine.host.loraAdd')}
          </button>
          <span className={css.hint}>{translate('imagine.host.loraTriggerHint')}</span>
        </div>
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.host.modelSection')}</h3>
        {routeSelect(translate('imagine.host.1'), translate('imagine.host.2'))}
        {/*
          * How much the model thinks, right below the model that thinks: it is
          * the same choice (who I talk to, and how long I let it reason).
          */}
        <label className={own.row}>
          <span className={own.label}>{translate('imagine.thinkingLevel')}</span>
          <select
            className={css.select}
            value={thinking()}
            disabled={levels === undefined}
            onChange={(event) => { set({ thinking: event.target.value }) }}
          >
            {/* The value as the gateway declares it: "none", "xhigh", no names of our own. */}
            {thinkingOptions.map(level => <option key={level} value={level}>{level}</option>)}
          </select>
          <span className={css.hint}>{translate('imagine.thinkingLevelHint')}</span>
        </label>
        <label className={own.row}>
          <span className={own.label}>{translate('imagine.agentChat')}</span>
          <select
            className={css.select}
            value={agentMode()}
            onChange={(event) => { set({ agentChat: event.target.value as AgentChatMode }) }}
          >
            <option value="auto">{translate('imagine.agentChatAuto')}</option>
            <option value="on">{translate('imagine.agentChatOn')}</option>
            <option value="off">{translate('imagine.agentChatOff')}</option>
          </select>
          <span className={css.hint}>{translate('imagine.agentChatHint')}</span>
        </label>
        {/*
          * The limit the confirmation reads, beside the switch that turns the
          * agent on: same subject, and the number is the one thing a power user
          * tunes when a clip he trusts keeps stopping for a yes.
          */}
        <label className={own.row}>
          <span className={own.label}>{translate('imagine.agentConfirmSeconds')}</span>
          <input
            className={own.input}
            type="number"
            min="1"
            max="3600"
            step="1"
            aria-label={translate('imagine.agentConfirmSeconds')}
            value={confirmTyped ?? String(confirmSeconds())}
            onChange={(event) => { typeConfirm(event.target.value) }}
            onBlur={(event) => { commitConfirm(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
          <span className={css.hint}>{translate('imagine.agentConfirmSecondsHint', { seconds: String(confirmSeconds()) })}</span>
        </label>
        <div className={own.row}>
          <span className={own.label}>{translate('imagine.host.selectorModels', { count: models.length })}</span>
          {/* Which ones, not only how many (2026-11-13). */}
          {models.length === 0
            ? <span className={css.hint}>{translate('imagine.host.selectorNone')}</span>
            : (
              <ul className={own.chips}>
                {models.map(entry => <li key={`${entry.provider}/${entry.id}`} className={own.chip} title={entry.id}>{entry.name ?? entry.id}</li>)}
              </ul>
            )}
          <div className={own.actions}>
            <button type="button" className={css.button} onClick={() => { void readCatalog() }}>{translate('imagine.host.refreshCatalog')}</button>
          </div>
          {catalog !== undefined && (
            <input
              className={own.input}
              type="search"
              placeholder={translate('imagine.host.modelFilter')}
              value={filter}
              onChange={(event) => { setFilter(event.target.value) }}
            />
          )}
          {catalog !== undefined && (
            <div className={own.catalog}>
              {catalog
                .filter(id => id.toLowerCase().includes(filter.trim().toLowerCase()))
                .sort((a, b) => Number(picked.has(b)) - Number(picked.has(a)))
                .map(id => (
                <label key={id} className={own.catalogItem}>
                  <input
                    type="checkbox"
                    checked={gatewayProvider !== undefined && models.some(entry => entry.provider === gatewayProvider && entry.id === id)}
                    onChange={(event) => { toggleModel(id, event.target.checked) }}
                  />
                  <span>{id}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </section>

      </>}
      {sections !== 'models' && <>
      {/*
        * Access, startup and the restart in three cards (2026-11-13): the
        * restart button used to sit right under the password field, as if it
        * were the way to save it.
        */}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.host.access')}</h3>
        {toggle(translate('imagine.host.7'), translate('imagine.host.8'), 'requireLogin')}
        <label className={own.row}>
          <span className={own.label}>{view.passwordSet ? translate('imagine.host.12') : translate('imagine.host.13')}</span>
          <input
            className={own.input}
            type="password"
            autoComplete="new-password"
            placeholder={view.passwordSet ? translate('imagine.host.14') : translate('imagine.host.15')}
            value={draft.password ?? ''}
            onChange={(event) => { set({ password: event.target.value }) }}
          />
        </label>
        {/*
          * The warning about an open studio can be hidden from the strip
          * itself; with the login on the strip is not drawn, so this is the
          * only place that says it is hidden and undoes it.
          */}
        {access?.bannerDismissed === true && !view.requireLogin && (
          <div className={own.row}>
            <span className={own.label}>{translate('imagine.access.hidden')}</span>
            <span className={css.hint}>{translate('imagine.access.hiddenHint')}</span>
            <div className={own.actions}>
              <button type="button" className={css.button} onClick={() => { void showBanner() }}>
                {translate('imagine.access.showAgain')}
              </button>
            </div>
          </div>
        )}
      </section>

      {/*
        * comfyui-imagine's setup (2026-11-15): what a request needs and ComfyUI
        * lacks is installed after a yes in the chat, or always with this on.
        */}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.host.setupTitle')}</h3>
        {toggle(translate('imagine.host.autoSetup'), translate('imagine.host.autoSetupHelp'), 'autoSetup')}
        <label className={own.row}>
          <span className={own.label}>{translate('imagine.host.hfToken')}</span>
          <input
            className={own.input}
            type="password"
            autoComplete="off"
            placeholder={view.hfTokenSet ? translate('imagine.host.hfTokenSet') : translate('imagine.host.hfTokenNone')}
            value={draft.hfToken ?? ''}
            onChange={(event) => { set({ hfToken: event.target.value }) }}
          />
        </label>
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.host.startupOnly')}</h3>
        {toggle(translate('imagine.host.5'), translate('imagine.host.6'), 'resumeSweep')}
        {view.bootResumeSweep !== (value('resumeSweep') === true) && !dirty && (
          <p className={css.notice} role="status">{translate('imagine.host.11')}</p>
        )}
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.host.restartTitle')}</h3>
        <div className={own.actions}>
          <button type="button" className={css.button} onClick={() => { void restart() }}>{translate('imagine.host.restart')}</button>
          <span className={css.hint}>{translate('imagine.host.restartHint')}</span>
        </div>
      </section>
      </>}
    </>
  )
}
