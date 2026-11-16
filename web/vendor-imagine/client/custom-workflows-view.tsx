/**
 * The workflows the user added: their list, and the form that adds one.
 *
 * They are not built-in actions — the deployment ships twenty of those and
 * their graphs are in the repo — but since 2026-11-16 their cards sit in the
 * home's one grid with the others (HomeView.tsx, `home-groups.ts`): a cover,
 * a title, one line of description, and a panel to run them with a prompt.
 * What stays here is the list itself ({@link useCustomWorkflowList}, shared by
 * the grid and the address that names one) and the strip under the grid that
 * adds one. Adding one is a form here rather than an edit to `config.yaml`
 * because the whole point is doing it without touching the studio.
 * @module client/custom-workflows-view
 */

import { translate } from './locale-store.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, send } from './http.ts'
import { messageOf } from './message-of.ts'
import type { CustomWorkflowMeta } from '../../../shared/custom-workflows.ts'
import own from './CustomWorkflows.module.css'

/** One uploaded workflow, as the host reports it: the server's own type. */
export type CustomWorkflow = CustomWorkflowMeta

/** One input picked in the form, before it is saved. */
interface Picked {
  readonly key: string
  readonly label: string
  readonly on: boolean
  readonly kind: 'text' | 'number' | 'boolean'
  readonly value: string | number | boolean
}

/** The cover a card of the grid shows, when the user gave one. */
export const coverOf = (workflow: CustomWorkflow): string | undefined =>
  workflow.hasCover ? `/comfy-custom-cover/${workflow.id}` : undefined

/** A cover picked from disk, as the data URL the host stores. */
async function readDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result ?? '')) }
    reader.onerror = () => { reject(new Error(translate('imagine.coverNotRead'))) }
    reader.readAsDataURL(file)
  })
}

/** The uploaded workflows, as the host lists them, and what changes them. */
export interface CustomWorkflowList {
  readonly list: readonly CustomWorkflow[]
  /** Whether the host has answered once: before that an id cannot be judged. */
  readonly loaded: boolean
  /** The last failure to read or delete, if any. */
  readonly error: string | undefined
  readonly reload: () => Promise<void>
  readonly remove: (workflow: CustomWorkflow) => Promise<void>
}

/**
 * The list of uploaded workflows, read once when the page opens.
 * @returns the list and its two actions.
 */
export function useCustomWorkflowList(): CustomWorkflowList {
  const [list, setList] = useState<readonly CustomWorkflow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  const reload = useCallback(async (): Promise<void> => {
    try {
      const body = await getJson<{ workflows: readonly CustomWorkflow[] }>('/comfy-custom-workflows', 'workflow')
      setList(body.workflows)
      setError(undefined)
    } catch (failure: unknown) {
      setError(messageOf(failure))
    } finally {
      setLoaded(true)
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const remove = useCallback(async (workflow: CustomWorkflow): Promise<void> => {
    try {
      await send(`/comfy-custom-workflows/${workflow.id}`, 'DELETE', {}, 'workflow')
      await reload()
    } catch (failure: unknown) {
      setError(messageOf(failure))
    }
  }, [reload])
  return useMemo(() => ({ list, loaded, error, reload, remove }), [list, loaded, error, reload, remove])
}

export interface AddWorkflowPanelProps {
  /** The list the grid shows too: adding one reads it again. */
  readonly workflows: CustomWorkflowList
  /** Back to the grid of cards. */
  readonly onBack: () => void
}

/**
 * The form that adds an uploaded workflow: it stands where the grid was, so
 * adding one is a card of the grid and not a strip under it. Its card lands
 * in the grid like any other, and the panel goes back to it.
 * @param props - the shared list and the way back.
 * @returns the panel.
 */
export function AddWorkflowPanel({ workflows, onBack }: AddWorkflowPanelProps) {
  const { list, reload: load } = workflows
  const [formError, setFormError] = useState<string>()
  const error = formError ?? workflows.error
  const form = useRef<HTMLFormElement>(null)
  /*
   * The inputs of the graph just picked, so the user can choose which ones the
   * card offers — the App Builder step, without leaving the page.
   */
  const [picked, setPicked] = useState<readonly Picked[]>([])

  /*
   * A graph dropped in the form is read here, in the browser: the list of what
   * can be exposed comes from the file itself, so nothing has to be uploaded
   * first to find out. Links are left out — a value is what a control can set.
   */
  const readGraph = async (file: File | undefined): Promise<void> => {
    setFormError(undefined)
    setPicked([])
    if (file === undefined) return
    try {
      const graph = JSON.parse(await file.text()) as Record<string, { inputs?: Record<string, unknown> }>
      const rows: Picked[] = []
      for (const [node, entry] of Object.entries(graph)) {
        for (const [field, value] of Object.entries(entry.inputs ?? {})) {
          const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          if (!scalar) continue
          rows.push({
            key: `${node}.${field}`,
            label: field,
            on: false,
            kind: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text',
            value,
          })
        }
      }
      if (rows.length === 0) throw new Error(translate('imagine.noValuesToExpose'))
      setPicked(rows)
    } catch (failure: unknown) {
      setFormError(messageOf(failure))
    }
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setFormError(undefined)
    try {
      const graphFile = data.get('graph')
      if (!(graphFile instanceof File) || graphFile.size === 0) throw new Error(translate('imagine.pickGraphFile'))
      const graph: unknown = JSON.parse(await graphFile.text())
      const coverFile = data.get('cover')
      await send('/comfy-custom-workflows', 'POST', {
        title: String(data.get('title') ?? ''),
        description: String(data.get('description') ?? ''),
        graph,
        output: data.get('output') === 'video' ? 'video' : 'image',
        outputExt: String(data.get('outputExt') ?? 'png'),
        promptNodeId: String(data.get('promptNodeId') ?? ''),
        seedNodeId: String(data.get('seedNodeId') ?? ''),
        imageNodeId: String(data.get('imageNodeId') ?? ''),
        ...coverFile instanceof File && coverFile.size > 0 ? { cover: await readDataUrl(coverFile) } : {},
        inputs: picked.filter(entry => entry.on && entry.label.trim().length > 0).map(entry => {
          const [node = '', field = ''] = entry.key.split('.')
          return { node, field, label: entry.label.trim(), kind: entry.kind, value: entry.value }
        }),
      }, 'workflow')
      form.current?.reset()
      await load()
      onBack()
    } catch (failure: unknown) {
      setFormError(messageOf(failure))
    }
  }

  return (
    <section className={own.wrap} aria-label={translate('imagine.customWorkflows')}>
      <div className={own.head}>
        <button type="button" className={own.add} onClick={onBack}>{translate('imagine.allTools')}</button>
        <h2 className={own.title}>{translate('imagine.custom.new')}</h2>
      </div>

      <form ref={form} className={own.form} onSubmit={(event) => { void submit(event) }}>
          <label className={own.field}>
            <span>{translate('imagine.custom.formTitle')}</span>
            <input name="title" required placeholder="Lookbook" />
          </label>
          <label className={own.field}>
            <span>{translate('imagine.custom.formDescription')}</span>
            <textarea name="description" rows={2} placeholder={translate('imagine.descriptionPlaceholder')} />
          </label>
          <label className={own.field}>
            <span>{translate('imagine.custom.formGraph')}</span>
            <input
              name="graph"
              type="file"
              accept=".json,application/json"
              required
              onChange={(event) => { void readGraph(event.target.files?.[0]) }}
            />
          </label>
          {picked.length > 0 && (
            <div className={own.pick}>
              <span className={own.blockTitle}>{translate('imagine.cardShows')}</span>
              <span className={own.desc}>
                {translate('imagine.customPickHint')}
              </span>
              {picked.map((entry, index) => (
                <div className={own.pickRow} key={entry.key}>
                  <input
                    type="checkbox"
                    checked={entry.on}
                    aria-label={entry.key}
                    onChange={(event) => {
                      const next = [...picked]
                      next[index] = { ...entry, on: event.target.checked }
                      setPicked(next)
                    }}
                  />
                  <code className={own.pickKey}>{entry.key}</code>
                  <input
                    className={own.pickLabel}
                    type="text"
                    value={entry.label}
                    placeholder={translate('imagine.controlName')}
                    onChange={(event) => {
                      const next = [...picked]
                      next[index] = { ...entry, label: event.target.value }
                      setPicked(next)
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          <label className={own.field}>
            <span>{translate('imagine.custom.formCover')}</span>
            <input name="cover" type="file" accept="image/*,video/*" />
          </label>
          <div className={own.row}>
            <label className={own.field}>
              <span>{translate('imagine.promptNode')}</span>
              <input name="promptNodeId" placeholder={translate('imagine.exampleNodeId')} />
            </label>
            <label className={own.field}>
              <span>{translate('imagine.seedNode')}</span>
              <input name="seedNodeId" placeholder={translate('imagine.optional')} />
            </label>
            <label className={own.field}>
              <span>{translate('imagine.custom.imageNode')}</span>
              <input name="imageNodeId" placeholder={translate('imagine.optional')} />
            </label>
          </div>
          <div className={own.row}>
            <label className={own.field}>
              <span>{translate('imagine.customProduce')}</span>
              <select name="output" defaultValue="image">
                <option value="image">{translate('imagine.kindImage')}</option>
                <option value="video">video</option>
              </select>
            </label>
            <label className={own.field}>
              <span>{translate('imagine.customExtension')}</span>
              <input name="outputExt" defaultValue="png" />
            </label>
          </div>
        <button type="submit" className={own.save}>{translate('imagine.save')}</button>
      </form>

      {error !== undefined && <p className={own.error} role="status">{error}</p>}

      {list.length === 0 && (
        <p className={own.empty}>{translate('imagine.custom.emptyState')}</p>
      )}
    </section>
  )
}
