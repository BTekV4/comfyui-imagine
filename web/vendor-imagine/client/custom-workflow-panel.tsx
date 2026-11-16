/**
 * The panel of an uploaded card: the same shape as the built-in actions' —
 * cover, what it needs, file slots, prompt, options, LoRAs and one button —
 * with the "spec" derived from the graph (`custom-workflow-spec.ts`).
 *
 * It does not duplicate `WorkflowPanel`: it passes it a `WorkflowSpec` built
 * on the fly, with the texts already written (the card has its own title and
 * description) and the derived controls as props.
 * @module client/custom-workflow-panel
 */
import { useEffect, useMemo, useState } from 'react'
import { getJson } from './http.ts'
import { FrameScrubber } from './FrameScrubber.tsx'
import { LoraRows, useCustomLoras } from './custom-loras.tsx'
import { messageOf } from './message-of.ts'
import { uploadGalleryItem } from './gallery-api.ts'
import { WorkflowPanel } from './WorkflowPanel.tsx'
import type { WorkflowSpec } from './workflow-specs.ts'
import { deriveCustomWorkflowControls, type CustomGraph } from './custom-workflow-spec.ts'
import { IMAGE_RESOLUTIONS, IMAGINE_ASPECTS, type ImagineAspect, type ImagineResolution } from '../../../shared/imagine-media.ts'
import { sizeFor } from './imagine-settings.ts'
import type {
  GalleryItem, MediaKind,
} from '../../../shared/imagine-types.ts'
import type { CustomWorkflow } from './custom-workflows-view.tsx'
import own from './CustomWorkflows.module.css'
import { translate } from './locale-store.ts'
import { kindsLabel } from './labels.ts'

/** The batch the card's meta declares, if it declares a valid one. */
function controlsOfBatch(workflow: CustomWorkflow): { readonly node: string; readonly field: string } | undefined {
  const batch = (workflow as { readonly batchControl?: { readonly node?: unknown; readonly field?: unknown } }).batchControl
  if (batch === undefined || typeof batch.node !== 'string' || typeof batch.field !== 'string') return undefined
  return { node: batch.node, field: batch.field }
}

/** What the panel sends the page when the button is pressed. */
export interface CustomRunRequest {
  readonly prompt: string
  readonly customFields: Readonly<Record<string, unknown>>
  readonly customFiles: Readonly<Record<string, string>>
}

/** A batch: the field with N values and the chosen values, in order. */
export interface CustomBatchRequest {
  readonly field: { readonly node: string; readonly field: string }
  readonly values: readonly string[]
}

export interface CustomWorkflowPanelProps {
  readonly workflow: CustomWorkflow
  readonly items: readonly GalleryItem[]
  readonly busy: boolean
  readonly onBack: () => void
  readonly onRun: (request: CustomRunRequest) => void
  /** One run per value of the batch field, in the same project. */
  readonly onRunBatch: (request: CustomRunRequest, batch: CustomBatchRequest) => void
  readonly onGalleryAdd: (item: GalleryItem) => void
}

/**
 * The megapixels of a still canvas, for an image graph's
 * `ResolutionSelector`: the video ladder (`megapixelsFor`) caps the value at
 * 720p and on a photo would give 0.9 MP instead of the 2 the graph expects.
 * @param aspect - the chosen aspect ratio.
 * @param resolution - the chosen step.
 * @returns the area in megapixels.
 */
function stillMegapixels(aspect: ImagineAspect, resolution: ImagineResolution): number {
  const [width, height] = sizeFor(aspect, resolution).split('x').map(Number)
  if (width === undefined || height === undefined) return 0
  return Math.round(width * height / 10_000) / 100
}

export function CustomWorkflowPanel({ workflow, items, busy, onBack, onRun, onRunBatch, onGalleryAdd }: CustomWorkflowPanelProps) {
  const [graph, setGraph] = useState<CustomGraph | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const loras = useCustomLoras(`/comfy-custom-workflows/${workflow.id}`, setError)
  /** The chosen files, by slot key (which is the node id). */
  const [staged, setStaged] = useState<Record<string, GalleryItem | undefined>>({})
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState<ImagineAspect>('9:16')
  const [resolution, setResolution] = useState<ImagineResolution>('1080p')
  const [seconds, setSeconds] = useState(5)
  /** The values of the derived dropdowns (`<node>.<field>`). */
  const [controls, setControls] = useState<Record<string, string>>({})
  /** The values of the card's exposed inputs, by `<node>.<field>`. */
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const [comboOptions, setComboOptions] = useState<Record<string, readonly string[]>>({})

  const controlsOf = useMemo(() => graph === undefined
    ? undefined
    : deriveCustomWorkflowControls({
      ...workflow.promptNodeId === undefined ? {} : { promptNodeId: workflow.promptNodeId },
      ...workflow.promptField === undefined ? {} : { promptField: workflow.promptField },
      ...workflow.seedNodeId === undefined ? {} : { seedNodeId: workflow.seedNodeId },
      ...workflow.seedField === undefined ? {} : { seedField: workflow.seedField },
      ...controlsOfBatch(workflow) === undefined ? {} : { batchControl: controlsOfBatch(workflow) },
    }, graph), [graph, workflow])

  /*
   * The graph, which the panel cannot know before the card is opened (the
   * graph's LoRAs and the installed ones are `useCustomLoras`'s).
   */
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const graphBody = await getJson<{ graph?: CustomGraph }>(`/comfy-custom-workflows/${workflow.id}/graph`, 'workflow')
        if (!live) return
        if (graphBody.graph === undefined) throw new Error('graph')
        setGraph(graphBody.graph)
        // The options start from the graph's values.
        const aspectNode = Object.entries(graphBody.graph).find(([, node]) => node.class_type === 'ResolutionSelector')
        const saved = aspectNode?.[1].inputs?.['aspect_ratio']
        if (typeof saved === 'string') {
          const match = IMAGINE_ASPECTS.find(candidate => saved.startsWith(candidate))
          if (match !== undefined) setAspect(match)
        }
        const megapixels = aspectNode?.[1].inputs?.['megapixels']
        if (typeof megapixels === 'number') {
          const best = IMAGE_RESOLUTIONS.find(candidate => Math.abs(stillMegapixels('1:1', candidate) - megapixels) < 0.4)
          if (best !== undefined) setResolution(best)
        }
      } catch (failure: unknown) {
        if (live) setError(messageOf(failure))
      }
    })()
    return () => { live = false }
  }, [workflow.id])

  /*
   * The derived dropdowns (the lookbook: title and pose) ask ComfyUI for their
   * values, as the derivation module does: nothing is invented here.
   */
  useEffect(() => {
    if (controlsOf === undefined) return
    const fields = [...controlsOf.combos]
    const batch = controlsOf.batch
    if (batch !== undefined && !fields.some(combo => combo.node === batch.node && combo.field === batch.field)) {
      fields.push(
        batch.field === 'pose'
          ? { key: `${batch.node}.${batch.field}`, node: batch.node, field: batch.field, labelKey: 'imagine.custom.field.pose', options: [] }
          : { key: `${batch.node}.${batch.field}`, node: batch.node, field: batch.field, labelKey: 'imagine.custom.field.title', options: [] },
      )
    }
    /*
     * The exposed controls the card carries as a closed list: the graph's node
     * is the only one that knows its values, so they are asked of ComfyUI with
     * the same route the derived ones use.
     */
    for (const input of workflow.inputs) {
      if (input.kind !== 'combo') continue
      const key = `${input.node}.${input.field}`
      if (fields.some(combo => combo.key === key)) continue
      fields.push({ key, node: input.node, field: input.field, labelKey: 'imagine.custom.controls', options: [] })
    }
    if (fields.length === 0) return
    let live = true
    void (async () => {
      // The lists do not depend on each other: ask for all of them at once
      // instead of one round trip to ComfyUI after the other.
      const lists = await Promise.all(fields.map(async (combo) => {
        try {
          const body = await getJson<{ options: readonly string[] }>(
            `/comfy-custom-workflows/${workflow.id}/options?node=${encodeURIComponent(combo.node)}&field=${encodeURIComponent(combo.field)}`,
            'workflow',
          )
          return [combo.key, body.options] as const
        } catch {
          return [combo.key, [] as readonly string[]] as const
        }
      }))
      const known: Record<string, readonly string[]> = Object.fromEntries(lists)
      if (live) setComboOptions(known)
    })()
    return () => { live = false }
  }, [controlsOf, workflow.id, workflow.inputs])

  /*
   * The exposed controls start on the value the graph holds now: the card
   * sends it back only when the user changes it, and the graph's own value is
   * what the card shows.
   */
  useEffect(() => {
    const next: Record<string, string> = {}
    for (const input of workflow.inputs) {
      next[`${input.node}.${input.field}`] = input.value === undefined ? '' : String(input.value)
    }
    setInputValues(next)
  }, [workflow])

  const onUpload = async (slotKey: string, kinds: readonly MediaKind[], file: File): Promise<void> => {
    try {
      const item = await uploadGalleryItem(file)
      if (!kinds.includes(item.kind)) {
        setError(translate('imagine.slotWants', {
          kinds: kindsLabel(kinds),
          kind: item.kind,
        }))
        return
      }
      onGalleryAdd(item)
      setStaged(current => ({ ...current, [slotKey]: item }))
    } catch (failure: unknown) {
      setError(messageOf(failure))
    }
  }

  /** The clip-or-photo pair of this card, when it has one. */
  const either = workflow.either
  /** The clip staged for this run, which the frame control scrubs. */
  const stagedClip = Object.values(staged).find(item => item?.kind === 'video')
  const spec: WorkflowSpec | undefined = controlsOf === undefined
    ? undefined
    : {
      id: workflow.id,
      // The card has its own title and description: the keys stay the
      // dictionary's for the shared texts, the texts win when present.
      titleKey: 'imagine.customWorkflows',
      titleText: workflow.title,
      summaryKey: 'imagine.customWorkflows',
      summaryText: workflow.description,
      canKeys: [],
      notesKeys: [],
      slots: controlsOf.slots.map(slot => ({
        key: slot.key,
        labelKey: slot.labelKey,
        hintKey: slot.hintKey,
        // Two slots of which one is enough: the label has to say so, or both
        // read as required and the card looks like it wants two files.
        labelText: either?.slots.includes(slot.node) === true
          ? translate(slot.kind === 'video' ? 'imagine.custom.slot.videoOrPhoto' : 'imagine.custom.slot.photoOrVideo')
          : translate(slot.labelKey),
        hintText: translate(slot.hintKey),
        kinds: [slot.kind],
        required: slot.required,
      })),
      ...either === undefined ? {} : { eitherGroups: [either.slots] },
      promptText: controlsOf.prompt === undefined
        ? undefined
        : { label: translate('imagine.custom.prompt'), required: controlsOf.prompt.required },
      options: [...controlsOf.options],
      actionKey: 'imagine.custom.run',
      actionText: translate('imagine.custom.run'),
    }

  if (spec === undefined || controlsOf === undefined) {
    return (
      <div className={own.wrap}>
        <button type="button" className={own.add} onClick={onBack}>{translate('imagine.allTools')}</button>
        <p className={own.desc}>{error ?? translate('imagine.loading')}</p>
      </div>
    )
  }

  const stagedById: Record<string, GalleryItem | undefined> = {}
  for (const slot of controlsOf.slots) stagedById[slot.key] = staged[slot.key]

  const panelControls = controlsOf.combos.map(combo => ({
    key: combo.key,
    label: translate(combo.labelKey),
    options: comboOptions[combo.key] ?? [],
  }))

  const request = (): CustomRunRequest => {
    const fields: Record<string, unknown> = {}
    if (controlsOf.aspect !== undefined) {
      const label = controlsOf.aspect.labels[aspect]
      if (label !== undefined) fields[`${controlsOf.aspect.node}.${controlsOf.aspect.field}`] = label
    }
    if (controlsOf.resolution !== undefined) {
      // An image graph's `ResolutionSelector` wants the canvas megapixels,
      // not the video ladder's: they are derived from `sizeFor`.
      fields[`${controlsOf.resolution.node}.${controlsOf.resolution.field}`] = stillMegapixels(aspect, resolution)
    }
    if (controlsOf.seconds !== undefined) fields[`${controlsOf.seconds.node}.${controlsOf.seconds.field}`] = seconds
    for (const [key, value] of Object.entries(controls)) if (value !== '') fields[key] = value
    for (const input of workflow.inputs) {
      const key = `${input.node}.${input.field}`
      const raw = inputValues[key] ?? ''
      if (input.kind === 'boolean') fields[key] = raw === 'true'
      else if (input.kind === 'number' || input.kind === 'frame') {
        const number = Number(raw)
        if (raw.trim() !== '' && Number.isFinite(number)) fields[key] = number
      } else if (raw !== '') fields[key] = raw
    }
    /*
     * Which of the two slots carries the file: the panel is the only one that
     * knows, and the graph's other branch is lazy, so it never runs.
     */
    if (either !== undefined) {
      fields[`${either.switch.node}.${either.switch.field}`] = staged[either.switch.video] !== undefined
    }
    const files: Record<string, string> = {}
    for (const slot of controlsOf.slots) {
      const item = staged[slot.key]
      if (item !== undefined) files[slot.node] = item.name
    }
    return { prompt, customFields: fields, customFiles: files }
  }

  const run = (): void => { onRun(request()) }

  /*
   * "All poses": one run per value of the batch field, in the same project.
   * The confirmation is there because N runs are N renders, and the first one
   * that fails drags the others down with it.
   */
  const batchValues = controlsOf.batch === undefined
    ? []
    : (comboOptions[`${controlsOf.batch.node}.${controlsOf.batch.field}`] ?? [])
      .filter(value => !value.trim().startsWith('('))
  const batchLabel = controlsOf.batch !== undefined && controlsOf.batch.field === 'pose'
    ? translate('imagine.allPoses')
    : translate('imagine.batchAll')
  const runBatch = (): void => {
    if (controlsOf.batch === undefined || batchValues.length < 2) return
    if (!window.confirm(translate('imagine.batchConfirm', { count: batchValues.length }))) return
    onRunBatch(request(), { field: controlsOf.batch, values: batchValues })
  }

  const inputBody = workflow.inputs.length === 0 ? undefined : (
    <div className={own.inputs}>
      <h3 className={own.inputTitle}>{translate('imagine.custom.controls')}</h3>
      {workflow.inputs.map(input => {
        const key = `${input.node}.${input.field}`
        const value = inputValues[key] ?? ''
        // The frame only exists once a clip is staged: with a photo the
        // control would ask for something the run cannot use.
        if (input.kind === 'frame' && stagedClip === undefined) return null
        return (
          <label className={own.inputField} key={key}>
            <span className={own.inputLabel}>{input.label}</span>
            {input.kind === 'frame'
              ? (
                /*
                 * The scrubber «Extract frames» shows, shorter here among
                 * the other fields. The value sent is the time, in seconds;
                 * the graph turns it into the frame index with the clip's
                 * own fps.
                 */
                <div className={own.frame}>
                  <FrameScrubber
                    compact
                    clip={stagedClip as GalleryItem}
                    time={Number(value) || 0}
                    onChange={(seconds) => { setInputValues(current => ({ ...current, [key]: String(seconds) })) }}
                  />
                </div>
              )
              : input.kind === 'boolean'
                ? (
                <input
                  type="checkbox"
                  checked={value === 'true'}
                  onChange={(event) => { setInputValues(current => ({ ...current, [key]: event.target.checked ? 'true' : 'false' })) }}
                />
              )
              : input.kind === 'combo'
                ? (
                  <select
                    className={own.inputBox}
                    value={value}
                    onChange={(event) => { setInputValues(current => ({ ...current, [key]: event.target.value })) }}
                  >
                    <option value="">—</option>
                    {(comboOptions[key] ?? []).map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                )
                : (
                  <input
                    className={own.inputBox}
                    type={input.kind === 'number' ? 'number' : 'text'}
                    value={value}
                    onChange={(event) => { setInputValues(current => ({ ...current, [key]: event.target.value })) }}
                  />
                )}
          </label>
        )
      })}
    </div>
  )

  const loraBody = (
    <div className={own.loraBlock}>
      {inputBody}
      <LoraRows state={loras} look="card" />
    </div>
  )

  return (
    <WorkflowPanel
      spec={spec}
      cover={workflow.hasCover ? `/comfy-custom-cover/${workflow.id}` : ''}
      coverKind={workflow.hasCover ? (workflow.coverKind ?? 'image') : undefined}
      extra={{ title: translate('imagine.graphLoras'), body: loraBody }}
      items={items}
      staged={stagedById}
      prompt={prompt}
      aspect={aspect}
      resolution={resolution}
      seconds={seconds}
      busy={busy}
      note={error}
      onBack={onBack}
      onStage={(slot, item) => { setStaged(current => ({ ...current, [slot.key]: item })) }}
      onUpload={(slot, file) => onUpload(slot.key, slot.kinds, file)}
      onPrompt={setPrompt}
      onAspect={setAspect}
      onResolution={setResolution}
      onSeconds={setSeconds}
      onRun={run}
      batch={controlsOf.batch === undefined || batchValues.length < 2
        ? undefined
        : { count: batchValues.length, label: batchLabel, onRun: runBatch }}
      controls={panelControls}
      controlValues={controls}
      onControl={(key, value) => { setControls(current => ({ ...current, [key]: value })) }}
    />
  )
}
