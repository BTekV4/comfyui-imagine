/**
 * The LoRAs a configured workflow carries, added and removed from the
 * settings page.
 *
 * A LoRA is a node in the model chain, not a value in a field, so it does not
 * belong in the list of inputs above: the studio writes the whole graph when
 * one goes in or comes out, and this block is the only place that says so.
 * The requests and the rows are the personal cards' too (`custom-loras.tsx`).
 * @module client/workflow-loras
 */

import { translate } from './locale-store.ts'
import { LoraRows, useCustomLoras } from './custom-loras.tsx'
import css from './ImagineSettings.module.css'
import own from './WorkflowLoras.module.css'

export interface WorkflowLorasProps {
  /** The workflow being edited; the block reloads when it changes. */
  readonly workflowKey: string
  /** Whether a graph is open at all. */
  readonly enabled: boolean
}

/**
 * The LoRA block of one workflow.
 * @param props - which workflow, and whether it can be edited.
 * @returns the block.
 */
export function WorkflowLoras({ workflowKey, enabled }: WorkflowLorasProps) {
  const state = useCustomLoras(enabled ? `/comfy-imagine/workflows/${workflowKey}` : undefined)

  if (!enabled) return null

  return (
    <div className={own.block}>
      <div className={own.head}>
        <span className={own.title}>LoRA</span>
        <span className={own.hint}>{translate('imagine.loraChain')}</span>
      </div>
      <LoraRows state={state} look="settings" />
      {state.error !== undefined && <p className={css.error} role="status">{state.error}</p>}
    </div>
  )
}
