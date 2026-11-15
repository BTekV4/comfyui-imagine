/**
 * Compact Imagine model picker: the host's models (`fetchModels`), opened on
 * this browser's last pick and keeping each new one (`models.ts`).
 */

import { useEffect, useState } from 'react'
import { chosenModel, fetchModels, selectModel } from './models.ts'
import type { ModelEntry, ModelRoute } from '../../../shared/imagine-types.ts'
import css from './ImagineModelSelect.module.css'

/** One selectable row: opaque provider/model key. */
interface ModelOption {
  readonly id: string
  readonly label: string
}

/** Props for the Imagine model chip. */
export interface ImagineModelSelectProps {
  readonly label: string
  /**
   * Called with the route this chip is showing, whenever it changes.
   *
   * Inside a project the chat is read by a model, and the one the chip shows
   * is the one the user picked: without this the selection stayed inside the
   * component and the reading ran on the auxiliary override instead, so the
   * chip promised a choice it did not make.
   */
  readonly onPick?: (route: ModelRoute) => void
}

function optionId(provider: string, model: string): string {
  return `${provider}\u001f${model}`
}

function parseOption(id: string): ModelRoute | undefined {
  const index = id.indexOf('\u001f')
  if (index <= 0) return undefined
  return { provider: id.slice(0, index), model: id.slice(index + 1) }
}

/**
 * The rows, each provider's models together in the order the providers first
 * appear in the list.
 */
function optionsOf(models: readonly ModelEntry[]): readonly ModelOption[] {
  const groups = new Map<string, ModelOption[]>()
  for (const entry of models) {
    const group = groups.get(entry.provider) ?? []
    group.push({ id: optionId(entry.provider, entry.id), label: entry.name ?? entry.id })
    groups.set(entry.provider, group)
  }
  return [...groups.values()].flat()
}

/**
 * Render a native select of the host's models.
 * @param props - accessible label and the pick listener.
 * @returns the select.
 */
export function ImagineModelSelect({ label, onPick }: ImagineModelSelectProps) {
  const [options, setOptions] = useState<readonly ModelOption[]>([])
  const [value, setValue] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetchModels().then((list) => {
      // A failed load leaves the last good list.
      if (cancelled || list === undefined) return
      setOptions(optionsOf(list.models))
      const opened = chosenModel(list)
      setValue(optionId(opened.provider, opened.model))
      onPick?.({ provider: opened.provider, model: opened.model })
    })
    return () => { cancelled = true }
  }, [onPick])

  return (
    <select
      className={css.modelPick}
      aria-label={label}
      value={value}
      disabled={options.length === 0}
      onChange={(event) => {
        const next = parseOption(event.target.value)
        if (next === undefined) return
        setValue(event.target.value)
        onPick?.(next)
        selectModel(next)
      }}
    >
      {options.map(option => (
        <option key={option.id} value={option.id}>{option.label}</option>
      ))}
    </select>
  )
}
