/**
 * The LoRAs a graph carries, edited in place: the settings page's block for a
 * configured workflow, a personal card's panel, and the card form under the
 * home cards. They were three copies of the same four requests (two of them
 * line for line, with twin types); the requests live in `useCustomLoras` and
 * the rows in `LoraRows`, drawn in the look of the place they sit in.
 *
 * Both routes answer the same shape under their own root:
 * `/comfy-imagine/workflows/<key>` for a configured workflow and
 * `/comfy-custom-workflows/<id>` for a personal one.
 * @module client/custom-loras
 */

import { useEffect, useRef, useState } from 'react'
import { getJson, send } from './http.ts'
import { translate } from './locale-store.ts'
import { messageOf } from './message-of.ts'
import cardCss from './CustomWorkflows.module.css'
import settingsCss from './WorkflowLoras.module.css'
import pageCss from './ImagineSettings.module.css'

/** One LoRA the graph carries, as the host reports it. */
export interface GraphLora {
  readonly node: string
  readonly loraName: string
  readonly strength: number
}

/** A graph's LoRAs, the ones ComfyUI has installed, and the edits. */
export interface GraphLoras {
  readonly loras: readonly GraphLora[]
  /** The installed LoRAs, for the add menu. */
  readonly options: readonly string[]
  /** The add row: the LoRA picked and the strength typed. */
  readonly name: string
  readonly setName: (name: string) => void
  readonly strength: string
  readonly setStrength: (strength: string) => void
  /** A request is in flight. */
  readonly busy: boolean
  readonly error: string | undefined
  readonly add: () => Promise<void>
  readonly drop: (lora: GraphLora) => Promise<void>
  /** Writes a new strength; the same value, or no number, writes nothing. */
  readonly tune: (lora: GraphLora, strength: number) => Promise<void>
}

/**
 * A graph's LoRAs, read when the route changes and rewritten by each edit.
 * @param base - the workflow's route root; undefined while nothing is open.
 * @param onError - where a failure is reported too (the panel's own note).
 * @returns the list, the add row and the edits.
 */
export function useCustomLoras(base: string | undefined, onError?: (message: string | undefined) => void): GraphLoras {
  const [loras, setLoras] = useState<readonly GraphLora[]>([])
  const [options, setOptions] = useState<readonly string[]>([])
  const [name, setName] = useState('')
  const [strength, setStrength] = useState('1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // Callers pass a fresh closure every render; the requests read the latest.
  const reportTo = useRef(onError)
  reportTo.current = onError
  const report = (message: string | undefined): void => {
    setError(message)
    reportTo.current?.(message)
  }

  useEffect(() => {
    setLoras([])
    setOptions([])
    setName('')
    setError(undefined)
    if (base === undefined) return
    let live = true
    void (async () => {
      try {
        const [current, installed] = await Promise.all([
          getJson<{ loras: readonly GraphLora[] }>(`${base}/loras`, 'workflow'),
          // No menu is not a broken graph: the list still shows.
          getJson<{ options: readonly string[] }>(`${base}/options?class=LoraLoaderModelOnly&field=lora_name`, 'workflow')
            .catch(() => ({ options: [] as readonly string[] })),
        ])
        if (!live) return
        setLoras(current.loras)
        setOptions(installed.options)
        setName(installed.options[0] ?? '')
      } catch (failure: unknown) {
        if (live) report(messageOf(failure))
      }
    })()
    return () => { live = false }
    // Deliberately keyed on `base`: `report` only reaches setters and a ref.
  }, [base])

  const write = async (path: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown): Promise<void> => {
    if (base === undefined) return
    setBusy(true)
    report(undefined)
    try {
      setLoras((await send<{ loras: readonly GraphLora[] }>(`${base}/loras${path}`, method, body, 'workflow')).loras)
    } catch (failure: unknown) {
      report(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  return {
    loras,
    options,
    name,
    setName,
    strength,
    setStrength,
    busy,
    error,
    add: () => name === '' ? Promise.resolve() : write('', 'POST', { loraName: name, strength: Number(strength) || 1 }),
    drop: lora => write(`/${encodeURIComponent(lora.node)}`, 'DELETE', {}),
    tune: (lora, next) => !Number.isFinite(next) || next === lora.strength
      ? Promise.resolve()
      : write(`/${encodeURIComponent(lora.node)}`, 'PATCH', { strength: next }),
  }
}

/**
 * The rows of a graph's LoRAs and the row that adds one.
 *
 * The strength is written on blur (or Enter), not on every keystroke: each
 * write rewrites the graph file and copies it to a backup, and typing "0.65"
 * would do that four times.
 * @param props.state - what `useCustomLoras` returned.
 * @param props.look - `settings` for the settings page, `card` for a personal card.
 */
export function LoraRows({ state, look }: { state: GraphLoras; look: 'settings' | 'card' }) {
  /** What is typed in each row's strength box, before it is written. */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const card = look === 'card'
  // A card's strength stays in 0-2, as its add row; the settings rows take -5..5.
  const [min, max] = card ? [0, 2] : [-5, 5]
  const commit = (lora: GraphLora, typed: string): void => {
    setDrafts((current) => {
      const { [lora.node]: _dropped, ...rest } = current
      return rest
    })
    const value = Number(typed)
    if (value < min || value > max) return
    void state.tune(lora, value)
  }
  const rows = state.loras.map(lora => (
    <div className={card ? cardCss.loraRow : settingsCss.row} key={lora.node}>
      <code className={card ? cardCss.loraName : settingsCss.name}>{lora.loraName}</code>
      <input
        className={card ? cardCss.loraStrength : settingsCss.number}
        type="number"
        step="0.05"
        min={String(min)}
        max={String(max)}
        aria-label={card ? `${translate('imagine.strength')} ${lora.loraName}` : translate('imagine.loraStrength', { name: lora.loraName })}
        value={drafts[lora.node] ?? String(lora.strength)}
        onChange={(event) => { const typed = event.target.value; setDrafts(current => ({ ...current, [lora.node]: typed })) }}
        onBlur={(event) => { commit(lora, event.target.value) }}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
      <button type="button" className={card ? cardCss.remove : settingsCss.drop} disabled={state.busy} title={translate('imagine.remove')} onClick={() => { void state.drop(lora) }}>×</button>
    </div>
  ))
  const nameSelect = (
    <select className={card ? undefined : settingsCss.select} value={state.name} onChange={(event) => { state.setName(event.target.value) }} aria-label={card ? undefined : 'LoRA'}>
      {state.options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  )
  const strengthInput = (
    <input
      className={card ? undefined : settingsCss.number}
      type="number"
      step="0.05"
      min="0"
      max="2"
      value={state.strength}
      aria-label={card ? undefined : translate('imagine.strength')}
      onChange={(event) => { state.setStrength(event.target.value) }}
    />
  )
  const cannotAdd = state.busy || state.options.length === 0
  if (card) {
    return (
      <>
        {state.loras.length === 0 && <span className={cardCss.desc}>{translate('imagine.noLoras')}</span>}
        {rows}
        <div className={cardCss.row}>
          <label className={cardCss.field}>
            <span>{translate('imagine.add')}</span>
            {nameSelect}
          </label>
          <label className={cardCss.field}>
            <span>{translate('imagine.strength')}</span>
            {strengthInput}
          </label>
          <button type="button" className={cardCss.add} disabled={cannotAdd} onClick={() => { void state.add() }}>{translate('imagine.insert')}</button>
        </div>
      </>
    )
  }
  return (
    <>
      {state.loras.length === 0 && <span className={settingsCss.none}>{translate('imagine.loraNone')}</span>}
      {rows}
      <div className={settingsCss.addRow}>
        {nameSelect}
        {strengthInput}
        <button type="button" className={pageCss.button} disabled={cannotAdd} onClick={() => { void state.add() }}>
          + LoRA
        </button>
      </div>
    </>
  )
}
