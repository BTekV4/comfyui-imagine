/**
 * Wire shapes of the ComfyUI REST API (`/prompt`, `/history`, `/view`,
 * `/upload/image`) and of API-format workflow graphs, and the error every
 * part of the client throws.
 * @module comfyui/types
 */

/** Closed set of {@link ComfyError} codes. */
export type ComfyErrorCode =
  | 'COMFY_UNREACHABLE'
  | 'COMFY_SUBMIT_FAILED'
  | 'COMFY_GRAPH_REJECTED'
  | 'COMFY_WAIT_FAILED'
  | 'COMFY_OUT_OF_MEMORY'
  | 'COMFY_TIMEOUT'
  | 'COMFY_FETCH_FAILED'
  | 'COMFY_UPLOAD_FAILED'
  | 'COMFY_INPUT_IMAGE_INVALID'

/** A ComfyUI client failure with a stable code for tool and UI consumers. */
export class ComfyError extends Error {
  constructor(message: string, readonly code: ComfyErrorCode, options?: ErrorOptions) {
    super(message, options)
  }
}

/** One node in an API-format workflow: class type plus its inputs. */
interface ComfyNode {
  readonly class_type: string
  readonly inputs: Record<string, unknown>
}

/** An API-format workflow graph: node id → node. */
export type ComfyGraph = Record<string, ComfyNode>

/** A media file an output node produced, addressed on the ComfyUI host. */
export interface ComfyMediaRef {
  readonly filename: string
  readonly subfolder: string
  readonly type: string
  /** Media extension without the dot, when the node reported one. */
  readonly format?: string
}

/** The media an output node produced (SaveImage → images, VHS → gifs/videos). */
export interface ComfyNodeOutput {
  readonly images?: readonly ComfyMediaRef[]
  readonly gifs?: readonly ComfyMediaRef[]
  readonly videos?: readonly ComfyMediaRef[]
  readonly audio?: readonly ComfyMediaRef[]
}

/** `POST /prompt` acceptance response. */
export interface ComfySubmitResult {
  readonly prompt_id: string
  /** Queue number. */
  readonly number: number
  /** Per-node errors when the graph failed validation; absent when accepted. */
  readonly node_errors?: Record<string, unknown>
}

/** The ordered media list of one completed run. */
export interface ComfyRunResult {
  readonly promptId: string
  readonly media: readonly ComfyMediaRef[]
}
