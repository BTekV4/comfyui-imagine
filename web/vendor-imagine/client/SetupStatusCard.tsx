/**
 * The card a fresh installation needs: what is missing before it can do
 * anything, and the command that fixes it.
 *
 * It draws nothing on a working studio — the report is one request at mount —
 * and otherwise one row per failed check, with the host's own words (the
 * address it tried, `ENOENT`) under the sentence. Before it existed, a wrong
 * ComfyUI address or a missing ffmpeg looked like a chat that did not answer.
 * @module client/SetupStatusCard
 */
import { useCallback, useEffect, useState } from 'react'
import { getJson } from './http.ts'
import { translate } from './locale-store.ts'
import type { SetupCheck, SetupStatus } from '../../../shared/setup-status.ts'
import own from './SetupStatusCard.module.css'

/** One failed check, as a sentence and the command that fixes it. */
interface Row {
  readonly title: string
  readonly fix: string
  readonly detail?: string
}

/**
 * The row of each failed check. Written out instead of a table by problem,
 * because the sentence needs the check's own fields (the URL, the folder).
 * @param status - the host's report.
 * @returns the rows to draw, in the order the studio needs them.
 */
function rowsOf(status: SetupStatus): Row[] {
  const rows: Row[] = []
  const add = (check: SetupCheck, title: string, fix: string): void => {
    if (check.ok) return
    rows.push({ title, fix, ...check.detail === undefined ? {} : { detail: check.detail } })
  }
  add(
    status.node,
    translate('imagine.setup.nodeOld', { found: status.node.found, minimum: status.node.minimum }),
    translate('imagine.setup.hintNode'),
  )
  add(status.ffmpeg, translate('imagine.setup.ffmpegMissing'), translate('imagine.setup.hintFfmpeg'))
  const notComfy = status.comfy.problem === 'comfy-http'
  add(
    status.comfy,
    translate(notComfy ? 'imagine.setup.comfyHttp' : 'imagine.setup.comfyUnreachable', { url: status.comfy.url }),
    translate(notComfy ? 'imagine.setup.hintComfyHttp' : 'imagine.setup.hintComfy'),
  )
  add(
    status.model,
    status.model.problem === 'provider-missing'
      ? translate('imagine.setup.providerMissing', { provider: status.model.provider ?? '' })
      : translate('imagine.setup.noModel'),
    translate('imagine.setup.hintModel'),
  )
  add(
    status.output,
    translate('imagine.setup.outputMissing', { dir: status.output.dir }),
    translate('imagine.setup.hintOutput'),
  )
  return rows
}

/**
 * The first-run card.
 * @returns nothing while the check is in flight, nothing on a ready studio,
 * and the card otherwise.
 */
export function SetupStatusCard() {
  const [status, setStatus] = useState<SetupStatus>()
  const [asking, setAsking] = useState(false)
  const load = useCallback(async (): Promise<void> => {
    setAsking(true)
    try {
      setStatus(await getJson<SetupStatus>('/setup-status', 'setup'))
    } catch {
      // An older host has no such route: there is nothing to say about it.
      setStatus(undefined)
    } finally {
      setAsking(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  if (status === undefined || status.ok) return undefined
  const rows = rowsOf(status)
  if (rows.length === 0) return undefined
  return (
    <section className={own.card} aria-label={translate('imagine.setup.title')}>
      <div className={own.head}>
        <h2 className={own.title}>{translate('imagine.setup.title')}</h2>
        {status.version !== undefined && (
          <span className={own.version}>{translate('imagine.setup.version', { version: status.version })}</span>
        )}
      </div>
      <p className={own.lead}>{translate('imagine.setup.lead')}</p>
      <ul className={own.rows}>
        {rows.map(row => (
          <li key={row.title} className={own.row}>
            <span className={own.dot} aria-hidden="true" />
            <div className={own.body}>
              <p className={own.sentence}>{row.title}</p>
              <code className={own.fix}>{row.fix}</code>
              {row.detail !== undefined && <p className={own.detail}>{row.detail}</p>}
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className={own.recheck} onClick={() => { void load() }} disabled={asking}>
        {translate(asking ? 'imagine.setup.checking' : 'imagine.setup.recheck')}
      </button>
    </section>
  )
}
