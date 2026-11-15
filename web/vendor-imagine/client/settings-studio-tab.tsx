/**
 * The settings page's "ComfyUI" tab (it was "Studio"): how the server is doing
 * and its restart, where it listens, and the output folder. Since 2026-11-13
 * the status comes first, the waits, the restart command and the path style
 * sit in a closed "Advanced", and the plugins' pointer moved to General.
 * Split from ImagineSettings (2026-11-07, D17); the server's state lives in
 * the page through `useComfyServer`, so a restart keeps being watched when
 * another tab is open.
 * @module client/settings-studio-tab
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IconRefreshOutlineRegular } from '../../shims/primitives/index.ts'
import { fetchComfyServer, restartComfyServer, type ComfyServerStatus, type ImagineSettingsView } from './gallery-api.ts'
import { OUTPUT_FIELDS, SERVER_FIELDS, type SettingField } from './imagine-settings-view.ts'
import { sizeLabel } from './labels.ts'
import { messageOf } from './message-of.ts'
import { useVisibleInterval } from './use-visible-interval.ts'
import { ConfigControl, type ControlContext } from './settings-controls.tsx'
import css from './ImagineSettings.module.css'
import { translate } from './locale-store.ts'

/** How often a restart in progress asks the server whether it is back. */
const RESTART_POLL_MS = 3000

/** Longest a restart may be waited for when the connection declares no window. */
const RESTART_FALLBACK_MS = 300_000

/** The server field everyone needs; the others go under "Advanced". */
const SERVER_MAIN = SERVER_FIELDS.filter(field => field.path.join('.') === 'server.baseURL')
const SERVER_ADVANCED = SERVER_FIELDS.filter(field => field.path.join('.') !== 'server.baseURL')

/** One labelled fact of the status panel. */
interface Fact {
  readonly label: string
  readonly value: string
}

/** The ComfyUI server as the page knows it, and what can be done to it. */
export interface ComfyServer {
  readonly server: ComfyServerStatus | undefined
  readonly serverError: string | undefined
  readonly readingServer: boolean
  readonly readServer: () => Promise<void>
  readonly restarting: boolean
  readonly restartError: string | undefined
  readonly restart: () => Promise<void>
}

/**
 * The server's status, read when the page opens, and its restart.
 * @param restartReadyMs - the window the connection declares for a restart.
 * @returns the status and the two actions.
 */
export function useComfyServer(restartReadyMs: number | undefined): ComfyServer {
  const [server, setServer] = useState<ComfyServerStatus>()
  const [serverError, setServerError] = useState<string>()
  const [readingServer, setReadingServer] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string>()
  const restartStartedAt = useRef(0)

  // The restart poll outlives the render that started it, so it reads the
  // window in force through a ref rather than restarting on them.
  const restartWindowRef = useRef(RESTART_FALLBACK_MS)
  restartWindowRef.current = restartReadyMs ?? RESTART_FALLBACK_MS

  const readServer = useCallback(async (): Promise<void> => {
    setReadingServer(true)
    try {
      setServer(await fetchComfyServer())
      setServerError(undefined)
    } catch (error: unknown) {
      setServerError(messageOf(error))
    } finally {
      setReadingServer(false)
    }
  }, [])

  useEffect(() => { void readServer() }, [readServer])

  /*
   * A restart is over when the server answers again. The window is the one the
   * connection declares: loading H3's reference pipeline keeps ComfyUI mute for
   * minutes, and a page that gave up on the default would call that a failure.
   */
  // While the tab is visible only: a hidden one is polled again as it comes back.
  useVisibleInterval(() => {
    void (async (): Promise<void> => {
      if (Date.now() - restartStartedAt.current > restartWindowRef.current) {
        setRestarting(false)
        setRestartError(translate('imagine.settings.restartTimeout'))
        return
      }
      try {
        const status = await fetchComfyServer()
        setServer(status)
        setServerError(undefined)
        if (status.ok) {
          setRestarting(false)
          setRestartError(undefined)
        }
      } catch (error: unknown) {
        setServerError(messageOf(error))
      }
    })()
  }, restarting ? RESTART_POLL_MS : null)

  const restart = useCallback(async (): Promise<void> => {
    if (!globalThis.confirm(translate('imagine.settings.restartConfirm'))) return
    setRestarting(true)
    setRestartError(undefined)
    restartStartedAt.current = Date.now()
    try {
      await restartComfyServer()
    } catch (error: unknown) {
      setRestarting(false)
      setRestartError(translate('imagine.settings.restartFailed', { problem: messageOf(error) }))
    }
  }, [])

  return { server, serverError, readingServer, readServer, restarting, restartError, restart }
}

/**
 * The "Studio" tab.
 * @param props.comfy - the server's state, from `useComfyServer`.
 * @param props.context - the staged configuration drafts.
 * @returns the tab's sections.
 */
export function StudioTab({ view, comfy, context }: {
  view: ImagineSettingsView
  comfy: ComfyServer
  context: ControlContext
}) {
  /** One server or folder control, read over its section's layers. */
  const control = (field: SettingField, layers: { readonly composed: unknown; readonly override?: unknown }, label = translate(field.label), hint = translate(field.hint)) => (
    <ConfigControl
      key={field.path.join('.')}
      spec={{ label, hint, path: field.path, kind: field.kind, composed: layers.composed, override: layers.override }}
      context={context}
    />
  )
  const { server } = comfy
  const facts: readonly Fact[] = server?.ok === true
    ? [
      ...server.version === undefined
        ? []
        : [{
          label: translate('imagine.settings.version'),
          value: server.os === undefined ? server.version : `${server.version} · ${server.os}`,
        }],
      ...server.devices.length === 0
        ? []
        : [{
          label: translate('imagine.settings.vram'),
          value: server.devices.map((device) => {
            const total = device.vramTotal === undefined ? '' : ` / ${sizeLabel(device.vramTotal)}`
            const free = device.vramFree === undefined ? '' : sizeLabel(device.vramFree)
            return `${device.name}: ${free}${total}`
          }).join(' · '),
        }],
      {
        label: translate('imagine.settings.queue'),
        value: translate('imagine.settings.queueValue', {
          running: String(server.queue.running),
          pending: String(server.queue.pending),
        }),
      },
    ]
    : []

  return (
    <>
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.settings.status')}</h3>
        <p className={css.sectionHint}>{translate('imagine.settings.statusHint')}</p>
        <div className={css.statusHead}>
          <span className={server?.ok === true ? css.dotOn : css.dotOff} aria-hidden="true" />
          <span className={css.statusWord}>
            {server === undefined
              ? translate('imagine.loading')
              : server.ok ? translate('imagine.settings.reachable') : translate('imagine.settings.unreachable')}
          </span>
          <code className={css.endpoint}>{server?.endpoint ?? view.server.running.baseURL}</code>
          <button type="button" className={css.button} disabled={comfy.readingServer} onClick={() => { void comfy.readServer() }}>
            <IconRefreshOutlineRegular size={13} />
            {translate('imagine.refresh')}
          </button>
        </div>
        {comfy.serverError !== undefined && <p className={css.error} role="status">{comfy.serverError}</p>}
        {server?.ok === false && server.error !== undefined && <p className={css.error} role="status">{server.error}</p>}
        {facts.length > 0 && (
          <dl className={css.facts}>
            {facts.map(fact => (
              <div className={css.fact} key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className={css.actions}>
          <button
            type="button"
            className={css.button}
            disabled={comfy.restarting || !view.server.canRestart}
            onClick={() => { void comfy.restart() }}
          >
            {comfy.restarting ? translate('imagine.settings.restarting') : translate('imagine.settings.restart')}
          </button>
          {!view.server.canRestart && <span className={css.muted}>{translate('imagine.settings.restartUnavailable')}</span>}
          {comfy.restartError !== undefined && <span className={css.error} role="status">{comfy.restartError}</span>}
        </div>
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.settings.server')}</h3>
        <p className={css.sectionHint}>{translate('imagine.settings.serverHint')}</p>
        <div className={css.fieldsOne}>
          {SERVER_MAIN.map(field => control(field, view.server))}
        </div>
        <details className={css.more}>
          <summary className={css.moreHead}>
            <span>{translate('imagine.settings.serverAdvanced')}</span>
            <span className={css.moreHint}>{translate('imagine.settings.serverAdvancedHint')}</span>
          </summary>
          <div className={css.fields}>
            {SERVER_ADVANCED.map(field => control(field, view.server))}
          </div>
        </details>
      </section>

      {/* The section says what the folder is; the field does not repeat it. */}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{translate('imagine.settings.output')}</h3>
        <p className={css.sectionHint}>{translate('imagine.settings.outputHint')}</p>
        <div className={css.fieldsOne}>
          {OUTPUT_FIELDS.map(field => control(field, view.output, translate('imagine.settings.outputPath'), ''))}
        </div>
        {view.output.running !== (view.output.override ?? view.output.composed) && (
          <p className={css.running}>{translate('imagine.settings.running', { value: view.output.running })}</p>
        )}
      </section>
    </>
  )
}
