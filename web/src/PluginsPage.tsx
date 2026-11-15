/**
 * "Plugin": the page that installs, switches and configures the studio's
 * plugins.
 *
 * It is a page of its own, reached from the rail, because the plugins are not
 * a setting of the studio but what the studio becomes: two of them are how this
 * deployment publishes and how it gets its alerts. Nothing here knows any
 * plugin by name — the cards, the fields, the buttons and the status lines all
 * come from the manifests and from `GET /comfy-plugins`.
 *
 * The page has three groups: what is installed (with a switch per plugin), what
 * could not load (with the reason), and what the repository ships and the data
 * folder does not have yet (with an Install button). A card opens the detail:
 * status, settings, actions and the way out.
 * @module PluginsPage
 */
import { messageOf } from '../vendor-imagine/client/message-of.ts'
import { useEffect, useState, type ReactNode } from 'react'
import { getJson, send } from '../vendor-imagine/client/http.ts'
import { en } from '../vendor-imagine/client/locales.ts'
import { loadPacks } from '../vendor-imagine/client/locale-store.ts'
import { translate, useLocale } from '../vendor-imagine/client/locale-store.ts'
import { PluginMark } from '../vendor-imagine/client/plugin-mark.tsx'
import { notePlugins } from '../vendor-imagine/client/plugin-presence.ts'
import { IconRefreshOutlineRegular } from '../shims/primitives/index.ts'
import css from './PluginsPage.module.css'
import type {
  LocalePacksData,
  LocalePackView,
  PluginAction,
  PluginsData,
  PluginSettingView,
  PluginText,
  PluginTone,
  PluginView,
} from '../../shared/plugin-types.ts'

/** A note under a card: what a button just did. */
interface Note {
  readonly kind: 'ok' | 'error' | 'muted'
  readonly text: string
}

/** The text of a plugin in the language the page is in, English when it has only one. */
function pick(text: PluginText | undefined, locale: string): string {
  if (text === undefined) return ''
  return locale.toLowerCase().startsWith('it') ? text.it : text.en
}

/** Whether a plugin needs the "Problems" group instead of the installed one. */
function broken(plugin: PluginView): boolean {
  return !plugin.compatible || plugin.error !== null
}

/** The dot's colour for a plugin: what its status says, or the fact that it is off. */
function toneOf(plugin: PluginView): PluginTone {
  if (broken(plugin)) return 'bad'
  if (!plugin.enabled) return 'muted'
  return plugin.status?.ok === false ? 'warn' : 'ok'
}

/** One switch: 36×20, a knob that travels, the same on every card. */
function Switch({ checked, disabled, label, onChange }: {
  readonly checked: boolean
  readonly disabled?: boolean
  readonly label: string
  readonly onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={css.switch}
      data-on={checked || undefined}
      disabled={disabled}
      onClick={() => { onChange(!checked) }}
    >
      <span className={css.knob} aria-hidden="true" />
    </button>
  )
}

/** The icon of a card: the manifest's glyph, or a neutral one. */
function Glyph({ icon }: { readonly icon: string | null }) {
  return (
    <span className={css.cardIcon} aria-hidden="true">
      {icon ?? <PluginMark size={20} />}
    </span>
  )
}

/**
 * The page's data and every request it makes: the list, the switches, the
 * installs, the settings, the actions and the language packs. The drafts and
 * notes live here, not in the detail, so going back to the list keeps them.
 * @returns the state and the actions the page's parts draw and call.
 */
function usePlugins() {
  const [data, setData] = useState<PluginsData>()
  const [error, setError] = useState<string>()
  const [openId, setOpenId] = useState<string>()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, Note>>({})
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [settingDrafts, setSettingDrafts] = useState<Record<string, Record<string, string | boolean>>>({})
  const [actionDrafts, setActionDrafts] = useState<Record<string, Record<string, string>>>({})
  const [languages, setLanguages] = useState<readonly LocalePackView[]>([])
  /** A note under the language cards, where the plugin cards already have one. */
  const [languageNote, setLanguageNote] = useState<Note>()

  const load = async (): Promise<void> => {
    // The two lists do not depend on each other: ask for both at once and
    // let each settle into its own state.
    const [plugins, packs] = await Promise.allSettled([
      getJson<PluginsData>('/comfy-plugins', 'HTTP'),
      getJson<LocalePacksData>('/comfy-locales-available', 'HTTP'),
    ])
    if (plugins.status === 'fulfilled') {
      // The studio hides a plugin's UI while it is off: tell it what is on now.
      notePlugins(plugins.value.plugins)
      setData(plugins.value)
      setError(undefined)
    } else {
      setError(messageOf(plugins.reason))
    }
    // Without the language list the page is still useful: the plugins are there.
    setLanguages(packs.status === 'fulfilled' ? packs.value.packs : [])
  }
  useEffect(() => { void load() }, [])

  const setBusyFor = (id: string, value: boolean): void => {
    setBusy(current => ({ ...current, [id]: value }))
  }
  const setNote = (id: string, note: Note): void => {
    setNotes(current => ({ ...current, [id]: note }))
  }

  const reloadAll = async (): Promise<void> => {
    setReloading(true)
    try {
      await send<{ ok: boolean }>('/comfy-plugins/reload', 'POST', undefined, 'HTTP')
      await load()
      setNotes(current => ({ ...current, '': { kind: 'ok', text: translate('imagine.plugins.reloaded') } }))
    } catch (failure: unknown) {
      setNotes(current => ({ ...current, '': { kind: 'error', text: messageOf(failure) } }))
    } finally {
      setReloading(false)
    }
  }

  const toggle = async (plugin: PluginView, enabled: boolean): Promise<void> => {
    setBusyFor(plugin.id, true)
    try {
      await send<{ ok: boolean }>(`/comfy-plugins/${plugin.id}/enabled`, 'POST', { enabled }, 'HTTP')
      await load()
      setNote(plugin.id, { kind: 'muted', text: enabled ? translate('imagine.plugins.switchedOn') : translate('imagine.plugins.switchedOff') })
    } catch (failure: unknown) {
      setNote(plugin.id, { kind: 'error', text: messageOf(failure) })
    } finally {
      setBusyFor(plugin.id, false)
    }
  }

  const install = async (id: string): Promise<void> => {
    setBusyFor(id, true)
    try {
      await send<{ ok: boolean }>('/comfy-plugins/install', 'POST', { id }, 'HTTP')
      setAdding(false)
      await load()
      setOpenId(id)
      setNote(id, { kind: 'ok', text: translate('imagine.plugins.installed') })
    } catch (failure: unknown) {
      setNote(id, { kind: 'error', text: messageOf(failure) })
    } finally {
      setBusyFor(id, false)
    }
  }

  const remove = async (plugin: PluginView): Promise<void> => {
    setBusyFor(plugin.id, true)
    try {
      const answer = await send<{ ok: boolean; movedTo: string }>(`/comfy-plugins/${plugin.id}/remove`, 'POST', undefined, 'HTTP')
      setConfirmingRemove(false)
      setOpenId(undefined)
      await load()
      setNotes(current => ({ ...current, '': { kind: 'ok', text: translate('imagine.plugins.removed', { folder: answer.movedTo }) } }))
    } catch (failure: unknown) {
      setNote(plugin.id, { kind: 'error', text: messageOf(failure) })
    } finally {
      setBusyFor(plugin.id, false)
    }
  }

  const saveSettings = async (plugin: PluginView): Promise<void> => {
    const values = settingDrafts[plugin.id] ?? {}
    if (Object.keys(values).length === 0) return
    setBusyFor(plugin.id, true)
    try {
      const answer = await send<{ ok: boolean; backup: string | null }>(`/comfy-plugins/${plugin.id}/settings`, 'POST', { values }, 'HTTP')
      setSettingDrafts(current => { const next = { ...current }; delete next[plugin.id]; return next })
      await load()
      setNote(plugin.id, {
        kind: 'ok',
        text: answer.backup === null
          ? translate('imagine.plugins.savedNoBackup')
          : translate('imagine.plugins.saved', { file: answer.backup.replace(/^.*\//, '') }),
      })
    } catch (failure: unknown) {
      setNote(plugin.id, { kind: 'error', text: messageOf(failure) })
    } finally {
      setBusyFor(plugin.id, false)
    }
  }

  const runAction = async (plugin: PluginView, action: PluginAction): Promise<void> => {
    const key = `${plugin.id}:${action.key}`
    const body = action.fields === undefined
      ? {}
      : Object.fromEntries(Object.entries(actionDrafts[key] ?? {}).filter(([, value]) => value !== ''))
    setBusyFor(key, true)
    setNote(key, { kind: 'muted', text: translate('imagine.plugins.actionRunning') })
    try {
      const answer = await send<unknown>(action.path, action.method, action.method === 'GET' ? undefined : body, 'HTTP')
      setActionDrafts(current => { const next = { ...current }; delete next[key]; return next })
      const shown = JSON.stringify(answer)
      setNote(key, { kind: 'ok', text: translate('imagine.plugins.actionResult', { answer: shown.length > 240 ? `${shown.slice(0, 240)}…` : shown }) })
    } catch (failure: unknown) {
      setNote(key, { kind: 'error', text: translate('imagine.plugins.actionFailed', { error: messageOf(failure) }) })
    } finally {
      setBusyFor(key, false)
    }
  }

  /**
   * Install, update or remove a language pack, and re-read the languages in
   * force.
   *
   * "Update" is the same copy as the install (the source over the installed
   * pack): before 2026-11-06 an old installed pack counted as complete and
   * there was no way to bring it back in line from the page.
   */
  const changeLanguage = async (code: string, action: 'install' | 'update' | 'remove'): Promise<void> => {
    setBusyFor(`locale:${code}`, true)
    setLanguageNote(undefined)
    try {
      if (action === 'install' || action === 'update') {
        await send<{ ok: boolean }>('/comfy-locales/install', 'POST', { code }, 'HTTP')
        setLanguageNote({
          kind: 'ok',
          text: translate(action === 'update' ? 'imagine.plugins.langUpdated' : 'imagine.plugins.langInstalled', { language: code.toUpperCase() }),
        })
      } else {
        const answer = await send<{ ok: boolean; movedTo: string }>('/comfy-locales/remove', 'POST', { code }, 'HTTP')
        setLanguageNote({ kind: 'ok', text: translate('imagine.plugins.langRemoved', { folder: answer.movedTo }) })
      }
      await load()
      // The picker and `text()` read the installed list: it must be re-read at once.
      await loadPacks()
    } catch (failure: unknown) {
      setLanguageNote({ kind: 'error', text: messageOf(failure) })
    } finally {
      setBusyFor(`locale:${code}`, false)
    }
  }

  return {
    data, error, openId, setOpenId, query, setQuery, busy, notes, confirmingRemove, setConfirmingRemove,
    reloading, adding, setAdding, settingDrafts, setSettingDrafts, actionDrafts, setActionDrafts, languages, languageNote,
    reloadAll, toggle, install, remove, saveSettings, runAction, changeLanguage,
  }
}

/** What `usePlugins` hands the page's parts. */
type Plugins = ReturnType<typeof usePlugins>

/**
 * One card of the list: a plugin installed, broken or on offer, or a language
 * pack. The four groups drew the same shell four times.
 * @param props.icon - the glyph (or a language's code) on the left.
 * @param props.onOpen - opens the detail; a card without one is not a button.
 * @param props.end - the status, switch or buttons on the right.
 */
function PluginCard({ icon, name, badges, description, onOpen, end, problem, off, available }: {
  readonly icon: ReactNode
  readonly name: string
  readonly badges: readonly string[]
  readonly description: ReactNode
  readonly onOpen?: () => void
  readonly end?: ReactNode
  readonly problem?: boolean
  readonly off?: boolean
  readonly available?: boolean
}) {
  const main = (
    <>
      {icon}
      <span className={css.cardBody}>
        <span className={css.titleRow}>
          <span className={css.cardTitle}>{name}</span>
          {badges.map((badge, index) => <span key={String(index)} className={css.badge}>{badge}</span>)}
        </span>
        <span className={css.cardDesc}>{description}</span>
      </span>
    </>
  )
  return (
    <li className={problem === true ? `${css.card} ${css.cardProblem}` : css.card} data-off={off === true || undefined} data-available={available === true || undefined}>
      {onOpen === undefined
        ? <span className={css.cardMain}>{main}</span>
        : <button type="button" className={css.cardMain} onClick={onOpen}>{main}</button>}
      {end !== undefined && <span className={css.cardEnd}>{end}</span>}
    </li>
  )
}

/**
 * The "Add" button and its menu: the plugins the repository ships and the data
 * folder does not have yet, each with its Install.
 */
function PluginStore({ plugins, locale }: { plugins: Plugins; locale: string }) {
  const { data, adding, setAdding, busy, install } = plugins
  if (data === undefined) return null
  return (
    <div className={css.addWrap}>
      <button
        type="button"
        className={css.primary}
        aria-expanded={adding}
        onClick={() => { setAdding(current => !current) }}
      >
        {translate('imagine.plugins.add')}
      </button>
      {adding && (
        <div className={css.menu} role="menu">
          {data.available.length === 0
            ? <p className={css.menuEmpty}>{translate('imagine.plugins.addEmpty')}</p>
            : data.available.map(entry => (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                className={css.menuItem}
                disabled={!entry.compatible || busy[entry.id] === true}
                onClick={() => { void install(entry.id) }}
              >
                <span className={css.menuIcon}>{entry.icon ?? <PluginMark size={16} />}</span>
                <span className={css.menuMain}>
                  <span>{entry.name}</span>
                  <span className={css.menuDesc}>{pick(entry.description, locale)}</span>
                </span>
                <span className={css.menuAction}>
                  {busy[entry.id] === true ? translate('imagine.plugins.installing') : translate('imagine.plugins.install')}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

/**
 * One plugin, opened: its status, settings, actions and the way out.
 * @param props.open - the plugin.
 * @param props.plugins - the page's state and actions.
 */
function PluginDetail({ open, plugins, locale }: { open: PluginView; plugins: Plugins; locale: string }) {
  const {
    notes, busy, settingDrafts, setSettingDrafts, actionDrafts, setActionDrafts, confirmingRemove, setConfirmingRemove,
    setOpenId, toggle, saveSettings, runAction, remove,
  } = plugins
  const note = notes[open.id]
  const working = busy[open.id] === true
  const dirty = Object.keys(settingDrafts[open.id] ?? {}).length > 0
  const shownValue = (setting: PluginSettingView): string | boolean => {
    const draft = settingDrafts[open.id]?.[setting.key]
    if (draft !== undefined) return draft
    if (setting.value !== null) return setting.value
    return setting.kind === 'toggle' ? false : ''
  }
  return (
    <div className={css.page}>
      <nav className={css.crumbs} aria-label="breadcrumb">
        <button type="button" className={css.crumb} onClick={() => { setOpenId(undefined); setConfirmingRemove(false) }}>
          {translate('imagine.plugins.title')}
        </button>
        <span className={css.crumbSep} aria-hidden="true">›</span>
        <span className={css.crumbHere}>{open.name}</span>
      </nav>

      <header className={css.detailHead}>
        <Glyph icon={open.icon} />
        <div className={css.heading}>
          <h1 className={css.title}>{open.name}</h1>
          <p className={css.subtitle}>
            {`${translate('imagine.plugins.metaVersion', { version: open.version })} · ${translate('imagine.plugins.metaApi', { api: open.api })}`}
          </p>
        </div>
        {open.installed && (
          <Switch
            checked={open.enabled}
            disabled={working}
            label={open.enabled ? translate('imagine.plugins.switchOff') : translate('imagine.plugins.switchOn')}
            onChange={(next) => { void toggle(open, next) }}
          />
        )}
      </header>

      {broken(open) && (
        <p className={css.problem} role="status">
          {open.compatible
            ? translate('imagine.plugins.error', { reason: open.error ?? '' })
            : translate('imagine.plugins.incompatible', { api: open.api, expected: 1 })}
        </p>
      )}

      {open.status !== null && (
        <section className={css.section}>
          <h2 className={css.sectionTitle}>{translate('imagine.plugins.status')}</h2>
          <ul className={css.lines}>
            {(open.status.lines ?? []).map((line, index) => (
              <li key={`${String(index)}-${line.text.en}`} className={css[`line${cap(line.tone ?? 'ok')}` as keyof typeof css] as string}>
                <span className={css.lineDot} data-tone={line.tone ?? 'ok'} aria-hidden="true" />
                {pick(line.text, locale)}
              </li>
            ))}
          </ul>
          {open.status.detail !== undefined && <p className={css.muted}>{pick(open.status.detail, locale)}</p>}
        </section>
      )}

      {open.settings.length > 0 && (
        <section className={css.section}>
          <h2 className={css.sectionTitle}>{translate('imagine.plugins.settingsTitle')}</h2>
          <div className={css.fields}>
            {open.settings.map((setting) => (
              <label key={setting.key} className={css.field}>
                <span className={css.fieldLabel}>{pick(setting.label, locale)}</span>
                {setting.kind === 'toggle'
                  ? (
                    <span className={css.toggleRow}>
                      <input
                        type="checkbox"
                        checked={Boolean(shownValue(setting))}
                        onChange={(event) => {
                          const next = event.target.checked
                          setSettingDrafts(current => ({ ...current, [open.id]: { ...current[open.id], [setting.key]: next } }))
                        }}
                      />
                      {setting.help !== undefined && <span className={css.help}>{pick(setting.help, locale)}</span>}
                    </span>
                    )
                  : setting.kind === 'select'
                    ? (
                      <select
                        className={css.input}
                        value={String(shownValue(setting))}
                        onChange={(event) => {
                          const next = event.target.value
                          setSettingDrafts(current => ({ ...current, [open.id]: { ...current[open.id], [setting.key]: next } }))
                        }}
                      >
                        {(setting.options ?? []).map(option => (
                          <option key={option.value} value={option.value}>{pick(option.label, locale)}</option>
                        ))}
                      </select>
                      )
                    : (
                      <input
                        className={css.input}
                        type={setting.kind === 'password' ? 'password' : 'text'}
                        autoComplete={setting.kind === 'password' ? 'new-password' : 'off'}
                        spellCheck={false}
                        placeholder={setting.kind === 'password'
                          ? (setting.isSet === true ? translate('imagine.plugins.passwordSet') : translate('imagine.plugins.passwordEmpty'))
                          : setting.placeholder ?? ''}
                        value={String(shownValue(setting))}
                        onChange={(event) => {
                          const next = event.target.value
                          setSettingDrafts(current => ({ ...current, [open.id]: { ...current[open.id], [setting.key]: next } }))
                        }}
                      />
                      )}
                {setting.help !== undefined && setting.kind !== 'toggle' && (
                  <span className={css.help}>{pick(setting.help, locale)}</span>
                )}
              </label>
            ))}
          </div>
          <div className={css.row}>
            <button type="button" className={css.button} disabled={working || !dirty} onClick={() => { void saveSettings(open) }}>
              {working ? translate('imagine.plugins.saving') : translate('imagine.plugins.save')}
            </button>
            {note !== undefined && <span className={note.kind === 'error' ? css.error : css.muted} role="status">{note.text}</span>}
          </div>
        </section>
      )}

      {open.actions.length > 0 && (
        <section className={css.section}>
          <h2 className={css.sectionTitle}>{translate('imagine.plugins.actionsTitle')}</h2>
          {open.actions.map((action) => {
            const key = `${open.id}:${action.key}`
            const actionNote = notes[key]
            return (
              <div key={action.key} className={css.actionBlock}>
                {(action.fields ?? []).length > 0 && (
                  <div className={css.fields}>
                    {(action.fields ?? []).map((field) => {
                      const value = actionDrafts[key]?.[field.key] ?? ''
                      return (
                        <label key={field.key} className={css.field}>
                          <span className={css.fieldLabel}>{pick(field.label, locale)}</span>
                          <input
                            className={css.input}
                            type={field.kind === 'password' ? 'password' : 'text'}
                            autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
                            spellCheck={false}
                            placeholder={field.placeholder ?? ''}
                            value={value}
                            onChange={(event) => {
                              const typed = event.target.value
                              setActionDrafts(current => ({ ...current, [key]: { ...current[key], [field.key]: typed } }))
                            }}
                          />
                        </label>
                      )
                    })}
                  </div>
                )}
                <div className={css.row}>
                  <button
                    type="button"
                    className={css.button}
                    disabled={busy[key] === true}
                    onClick={() => { void runAction(open, action) }}
                  >
                    {pick(action.label, locale)}
                  </button>
                  {actionNote !== undefined && (
                    <span className={actionNote.kind === 'error' ? css.error : css.muted} role="status">{actionNote.text}</span>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      )}

      <section className={css.section}>
        <h2 className={css.sectionTitle}>{translate('imagine.plugins.about')}</h2>
        <dl className={css.facts}>
          {open.dir !== null && (
            <div className={css.fact}>
              <dt>{translate('imagine.plugins.folder')}</dt>
              <dd className={css.mono}>{open.dir}</dd>
            </div>
          )}
          <div className={css.fact}>
            <dt>{translate('imagine.plugins.versionLabel')}</dt>
            <dd>{open.version}</dd>
          </div>
          <div className={css.fact}>
            <dt>{translate('imagine.plugins.apiLabel')}</dt>
            <dd>{open.api}</dd>
          </div>
          {open.installedAt !== null && (
            <div className={css.fact}>
              <dt>{translate('imagine.plugins.installedOn')}</dt>
              <dd>{new Date(open.installedAt).toLocaleString(locale)}</dd>
            </div>
          )}
        </dl>
        {!confirmingRemove
          ? (
            <div className={css.row}>
              <button type="button" className={css.danger} disabled={working} onClick={() => { setConfirmingRemove(true) }}>
                {translate('imagine.plugins.remove')}
              </button>
              {note !== undefined && <span className={note.kind === 'error' ? css.error : css.muted} role="status">{note.text}</span>}
            </div>
            )
          : (
            <div className={css.confirm} role="alertdialog">
              <p>{translate('imagine.plugins.removeConfirm', { name: open.name, folder: 'plugins-rimossi' })}</p>
              <div className={css.row}>
                <button type="button" className={css.danger} disabled={working} onClick={() => { void remove(open) }}>
                  {translate('imagine.plugins.removeYes')}
                </button>
                <button type="button" className={css.button} onClick={() => { setConfirmingRemove(false) }}>
                  {translate('imagine.cancel')}
                </button>
              </div>
            </div>
            )}
      </section>
    </div>
  )
}

/**
 * The language packs, at the foot of the list: English is compiled in and is
 * not a pack; every other language installs and goes away like a plugin. The
 * cards have the same shape, because they are the same kind of thing.
 */
function LanguageCards({ plugins }: { plugins: Plugins }) {
  const { languages, languageNote, busy, changeLanguage } = plugins
  /** The keys a language pack must cover: the English ones. */
  const totalKeys = Object.keys(en).length
  return (
    <section className={css.group}>
      <h2 className={css.groupTitle}>{translate('imagine.plugins.groupLanguages')}</h2>
      {languages.length === 0 && <p className={css.empty}>{translate('imagine.plugins.langEmpty')}</p>}
      <ul className={css.cards}>
        <PluginCard
          icon={<span className={css.cardIcon} data-code aria-hidden="true">EN</span>}
          name="English"
          badges={['en', translate('imagine.plugins.langBase')]}
          description={translate('imagine.plugins.langCoverage', { done: totalKeys, total: totalKeys })}
        />
        {languages.map(entry => {
          /*
           * The count is the one of the pack the client REALLY reads: with an
           * old one installed the page said "1084/1084 — Installed" while the
           * fallback went back to English for the missing keys (6/11/2026).
           * With `behind` the card says how many the installed one has and
           * offers "Update".
           */
          const done = entry.installed ? entry.installedCovers ?? entry.covers : entry.covers
          const outdated = entry.installed && entry.behind === true
          const working = busy[`locale:${entry.code}`] === true
          return (
            <PluginCard
              key={entry.code}
              available={!entry.installed}
              icon={<span className={css.cardIcon} data-code aria-hidden="true">{entry.code.toUpperCase()}</span>}
              name={entry.name}
              badges={[entry.code, translate('imagine.plugins.langCoverage', { done, total: totalKeys })]}
              description={outdated
                ? translate('imagine.plugins.langOutdatedState')
                : entry.installed
                  ? translate('imagine.plugins.langInstalledState')
                  : translate('imagine.plugins.langAvailableState')}
              end={(
                <>
                  {entry.installed && (
                    <button type="button" className={css.button} disabled={working} onClick={() => { void changeLanguage(entry.code, 'remove') }}>
                      {translate('imagine.plugins.remove')}
                    </button>
                  )}
                  {outdated && (
                    <button type="button" className={css.primary} disabled={working} onClick={() => { void changeLanguage(entry.code, 'update') }}>
                      {translate('imagine.plugins.langUpdate')}
                    </button>
                  )}
                  {!entry.installed && (
                    <button type="button" className={css.primary} disabled={working} onClick={() => { void changeLanguage(entry.code, 'install') }}>
                      {translate('imagine.plugins.install')}
                    </button>
                  )}
                </>
              )}
            />
          )
        })}
      </ul>
      {languageNote !== undefined && (
        <p className={languageNote.kind === 'error' ? css.problem : css.muted} role="status">{languageNote.text}</p>
      )}
    </section>
  )
}

/**
 * The page's title and subtitle, with what goes at their end (the reload and
 * the store) once the list is there.
 */
function PageHead({ children }: { readonly children?: ReactNode }) {
  return (
    <header className={css.head}>
      <div className={css.heading}>
        <h1 className={css.title}>{translate('imagine.plugins.title')}</h1>
        <p className={css.subtitle}>{translate('imagine.plugins.subtitle')}</p>
      </div>
      {children}
    </header>
  )
}

/**
 * The page.
 * @returns the page, list or detail.
 */
export function PluginsPage() {
  const locale = useLocale()
  const plugins = usePlugins()
  const { data, error, openId, setOpenId, query, setQuery, busy, notes, reloading, reloadAll, toggle, install } = plugins
  const open = data?.plugins.find(plugin => plugin.id === openId)

  // First load: four fake cards, so the page does not jump when the list lands.
  if (data === undefined) {
    return (
      <div className={css.page}>
        <PageHead />
        <div className={css.skeletonList}>
          {[0, 1, 2, 3].map(index => (
            <div key={String(index)} className={css.skeletonCard}>
              <span className={`${css.skeletonIcon} ${css.skeleton}`} />
              <span className={css.skeletonMain}>
                <span className={`${css.skeletonTitle} ${css.skeleton}`} />
                <span className={`${css.skeletonLine} ${css.skeleton}`} />
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (open !== undefined) return <PluginDetail open={open} plugins={plugins} locale={locale} />

  /* ------------------------------------------------------------------ list */

  const problems = data.plugins.filter(broken)
  const installed = data.plugins.filter(plugin => !broken(plugin))
  const needle = query.trim().toLowerCase()
  const matches = (name: string, description: PluginText | undefined): boolean =>
    needle === '' || name.toLowerCase().includes(needle) || pick(description, locale).toLowerCase().includes(needle)
  const shownInstalled = installed.filter(plugin => matches(plugin.name, plugin.description))
  const shownProblems = problems.filter(plugin => matches(plugin.name, plugin.description))
  const shownAvailable = data.available.filter(plugin => matches(plugin.name, plugin.description))
  const total = data.plugins.length + data.available.length

  return (
    <div className={css.page}>
      <PageHead>
        <div className={css.headEnd}>
          <button type="button" className={css.button} disabled={reloading} onClick={() => { void reloadAll() }}>
            <IconRefreshOutlineRegular size={14} />
            {reloading ? translate('imagine.plugins.reloading') : translate('imagine.plugins.reload')}
          </button>
          <PluginStore plugins={plugins} locale={locale} />
        </div>
      </PageHead>

      {error !== undefined && <p className={css.problem} role="status">{translate('imagine.plugins.readError', { error })}</p>}
      {notes[''] !== undefined && (
        <p className={notes[''].kind === 'error' ? css.problem : css.muted} role="status">{notes[''].text}</p>
      )}

      {total > 5 && (
        <input
          className={`${css.input} ${css.search}`}
          type="search"
          placeholder={translate('imagine.plugins.search')}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      )}

      {data.plugins.length === 0 && data.available.length === 0 && (
        <p className={css.empty}>{translate('imagine.plugins.emptyNone')}</p>
      )}
      {data.plugins.length === 0 && data.available.length > 0 && (
        <p className={css.empty}>{translate('imagine.plugins.emptyNothingInstalled')}</p>
      )}
      {installed.length === 0 && shownInstalled.length === 0 && data.plugins.length > 0 && (
        <p className={css.empty}>{translate('imagine.plugins.emptyInstalled')}</p>
      )}

      {shownInstalled.length > 0 && (
        <section className={css.group}>
          <h2 className={css.groupTitle}>{translate('imagine.plugins.groupInstalled')}</h2>
          <ul className={css.cards}>
            {shownInstalled.map(plugin => (
              <PluginCard
                key={plugin.id}
                off={!plugin.enabled}
                icon={<Glyph icon={plugin.icon} />}
                name={plugin.name}
                badges={[plugin.version, `API ${String(plugin.api)}`]}
                description={pick(plugin.description, locale)}
                onOpen={() => { setOpenId(plugin.id) }}
                end={(
                  <>
                    <span className={css.statusText}>
                      <span className={css.dot} data-tone={toneOf(plugin)} aria-hidden="true" />
                      {plugin.enabled
                        ? pick(plugin.status?.summary, locale) || translate('imagine.plugins.statusOk')
                        : translate('imagine.plugins.off')}
                    </span>
                    <Switch
                      checked={plugin.enabled}
                      disabled={busy[plugin.id] === true}
                      label={plugin.enabled ? translate('imagine.plugins.switchOff') : translate('imagine.plugins.switchOn')}
                      onChange={(next) => { void toggle(plugin, next) }}
                    />
                  </>
                )}
              />
            ))}
          </ul>
        </section>
      )}

      {shownProblems.length > 0 && (
        <section className={css.group}>
          <h2 className={css.groupTitle}>{translate('imagine.plugins.groupProblems')}</h2>
          <ul className={css.cards}>
            {shownProblems.map(plugin => (
              <PluginCard
                key={plugin.id}
                problem
                icon={<Glyph icon={plugin.icon} />}
                name={plugin.name}
                badges={[plugin.version || plugin.id]}
                description={plugin.compatible
                  ? translate('imagine.plugins.error', { reason: plugin.error ?? '' })
                  : translate('imagine.plugins.incompatible', { api: plugin.api, expected: 1 })}
                onOpen={() => { setOpenId(plugin.id) }}
                end={(
                  <button type="button" className={css.button} disabled={busy[plugin.id] === true} onClick={() => { setOpenId(plugin.id) }}>
                    {translate('imagine.plugins.openDetail')}
                  </button>
                )}
              />
            ))}
          </ul>
        </section>
      )}

      {shownAvailable.length > 0 && (
        <section className={css.group}>
          <h2 className={css.groupTitle}>{translate('imagine.plugins.groupAvailable')}</h2>
          <ul className={css.cards}>
            {shownAvailable.map(entry => (
              <PluginCard
                key={entry.id}
                available
                icon={<Glyph icon={entry.icon} />}
                name={entry.name}
                badges={[entry.version]}
                description={pick(entry.description, locale)}
                end={(
                  <button
                    type="button"
                    className={css.primary}
                    disabled={!entry.compatible || busy[entry.id] === true}
                    onClick={() => { void install(entry.id) }}
                  >
                    {busy[entry.id] === true ? translate('imagine.plugins.installing') : translate('imagine.plugins.install')}
                  </button>
                )}
              />
            ))}
          </ul>
        </section>
      )}

      <LanguageCards plugins={plugins} />

      {needle !== '' && shownInstalled.length + shownProblems.length + shownAvailable.length === 0 && (
        <p className={css.empty}>{translate('imagine.plugins.noMatch', { query: query.trim() })}</p>
      )}
    </div>
  )
}

/** `bad` → `Bad`, for the line class names. */
function cap(tone: string): string {
  return `${tone.charAt(0).toUpperCase()}${tone.slice(1)}`
}
