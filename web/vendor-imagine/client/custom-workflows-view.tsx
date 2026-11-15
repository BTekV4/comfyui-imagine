/**
 * The workflows the user added: a tile each, and the form that adds one.
 *
 * They are not built-in actions — the deployment ships twenty of those and
 * their graphs are in the repo — so they get their own strip under the home
 * cards: a cover, a title, one line of description, and a panel to run them
 * with a prompt. Adding one is a form here rather than an edit to `config.yaml`
 * because the whole point is doing it without touching the studio.
 * @module client/custom-workflows-view
 */

import { translate } from './locale-store.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
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

const coverOf = (workflow: CustomWorkflow): string | undefined =>
  workflow.hasCover ? `/comfy-custom-cover/${workflow.id}` : undefined

/** The file a graph is picked from, read as text. */
async function readText(file: File): Promise<string> {
  return await file.text()
}

/** A cover picked from disk, as the data URL the host stores. */
async function readDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result ?? '')) }
    reader.onerror = () => { reject(new Error(translate('imagine.coverNotRead'))) }
    reader.readAsDataURL(file)
  })
}

export interface CustomWorkflowsProps {
  /** Opens the card's full panel (`CustomWorkflowPanel`), as for the built-in actions. */
  readonly onOpen: (workflow: CustomWorkflow) => void
}

/**
 * The strip of uploaded workflows, and the form that adds one.
 * @param props - how to open a card's panel.
 * @returns the section.
 */
export function CustomWorkflows({ onOpen }: CustomWorkflowsProps) {
  const [list, setList] = useState<readonly CustomWorkflow[]>([])
  const [error, setError] = useState<string>()
  const [adding, setAdding] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  /*
   * The inputs of the graph just picked, so the user can choose which ones the
   * card offers — the App Builder step, without leaving the page.
   */
  const [picked, setPicked] = useState<readonly Picked[]>([])
  const load = useCallback(async (): Promise<void> => {
    try {
      const body = await getJson<{ workflows: readonly CustomWorkflow[] }>('/comfy-custom-workflows', 'workflow')
      setList(body.workflows)
    } catch (failure: unknown) {
      setError(messageOf(failure))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  /*
   * A graph dropped in the form is read here, in the browser: the list of what
   * can be exposed comes from the file itself, so nothing has to be uploaded
   * first to find out. Links are left out — a value is what a control can set.
   */
  const readGraph = async (file: File | undefined): Promise<void> => {
    setError(undefined)
    setPicked([])
    if (file === undefined) return
    try {
      const graph = JSON.parse(await readText(file)) as Record<string, { inputs?: Record<string, unknown> }>
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
      setError(messageOf(failure))
    }
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setError(undefined)
    try {
      const graphFile = data.get('graph')
      if (!(graphFile instanceof File) || graphFile.size === 0) throw new Error(translate('imagine.pickGraphFile'))
      const graph: unknown = JSON.parse(await readText(graphFile))
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
      setAdding(false)
      await load()
    } catch (failure: unknown) {
      setError(messageOf(failure))
    }
  }

  const remove = async (workflow: CustomWorkflow): Promise<void> => {
    setError(undefined)
    try {
      await send(`/comfy-custom-workflows/${workflow.id}`, 'DELETE', {}, 'workflow')
      await load()
    } catch (failure: unknown) {
      setError(messageOf(failure))
    }
  }

  return (
    <section className={own.wrap} aria-label={translate('imagine.customWorkflows')}>
      <div className={own.head}>
        <h2 className={own.title}>{translate('imagine.custom.yours')}</h2>
        <button type="button" className={own.add} onClick={() => { setAdding(value => !value) }}>
          {adding ? translate('imagine.custom.close') : translate('imagine.custom.add')}
        </button>
      </div>

      {adding && (
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
      )}

      {error !== undefined && <p className={own.error} role="status">{error}</p>}

      {list.length === 0 && !adding && (
        <p className={own.empty}>
          {translate('imagine.custom.emptyState')}
        </p>
      )}

      <div className={own.grid}>
        {list.map(workflow => {
          const cover = coverOf(workflow)
          return (
            <article key={workflow.id} className={own.card}>
              <button type="button" className={own.face} onClick={() => { onOpen(workflow) }}>
                {cover === undefined
                  ? <span className={own.blank} aria-hidden="true" />
                  : workflow.coverKind === 'video'
                    ? (
                      <video
                        className={own.cover}
                        src={cover}
                        autoPlay
                        muted
                        loop
                        playsInline
                        aria-hidden="true"
                      />
                    )
                    : <img className={own.cover} src={cover} alt="" />}
                <span className={own.shade} aria-hidden="true" />
                <span className={own.copy}>
                  <span className={own.name}>{workflow.title}</span>
                  <span className={own.desc}>{workflow.description}</span>
                </span>
              </button>
              <button type="button" className={own.remove} title={translate('imagine.remove')} onClick={() => { void remove(workflow) }}>×</button>
            </article>
          )
        })}
      </div>

    </section>
  )
}
