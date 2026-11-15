/**
 * Host-separator rewrite for ComfyUI model and output paths.
 *
 * Workflow JSON on disk stays POSIX (`krea2/model.safetensors`). On submit,
 * string inputs that look like relative filesystem paths are rewritten to
 * match `GET /system_stats` `system.os` (`nt` → `\`, anything else → `/`).
 * Prompt text, URLs, and Windows drive letters are left unchanged.
 * @module comfyui/paths
 */

import type { ComfyGraph } from './types.ts'

/** Closed set of ComfyUI host families `GET /system_stats` reports. */
export type ComfyHostOs = 'posix' | 'nt'

/**
 * Node input keys that name files or folders on the ComfyUI host.
 *
 * `model` is deliberately absent. On the nodes that declare it, the key is a
 * choice off a list the node publishes with `/` separators — `VocalRemovalNode`
 * advertises `MELBAND/MelBandRoformer_fp16.safetensors` — and an `nt` host
 * rejects the rewritten `MELBAND\MelBandRoformer_fp16.safetensors` as "Value not
 * in list". Everywhere else `model` names a model id, not a file: `model_name`
 * carries the file-path uses. Measured on the AUTUNNO story, 2026-09-26: the
 * rejected separator left every shot singing the full mix instead of the vocal.
 */
const PATH_INPUT_KEYS = new Set([
  'unet_name',
  'ckpt_name',
  'lora_name',
  'vae_name',
  'clip_name',
  'clip_vision_name',
  'control_net_name',
  'style_model_name',
  'gligen_name',
  'model_name',
  'bg_removal_name',
  'filename_prefix',
])

/**
 * Classify `system.os` from ComfyUI `/system_stats`.
 * `nt` (and Windows aliases) are NT; every other reported value is POSIX.
 * @param os - the raw `system.os` string, when present.
 * @returns the host family, or `undefined` when the field is missing or empty.
 */
export function hostOsOf(os: string | undefined): ComfyHostOs | undefined {
  if (os === undefined) return undefined
  const normalized = os.trim().toLowerCase()
  if (normalized.length === 0) return undefined
  if (normalized === 'nt' || normalized === 'win32' || normalized === 'windows') return 'nt'
  return 'posix'
}

/**
 * Whether a string is a relative ComfyUI path that should follow the host
 * separator. Rejects URLs, Windows drive letters, and values that contain
 * neither `/` nor `\`.
 * @param value - a node input string.
 * @returns whether the value is rewritten.
 */
function isRelativeHostPath(value: string): boolean {
  if (value.length === 0) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false
  return value.includes('/') || value.includes('\\')
}

/**
 * Rewrite one relative path to the host separator. Mixed separators become
 * the host's; a lone matching separator is left as-is.
 * @param value - a relative host path.
 * @param hostOs - the live ComfyUI host family.
 * @returns the rewritten path.
 */
function rewriteHostPath(value: string, hostOs: ComfyHostOs): string {
  const sep = hostOs === 'nt' ? '\\' : '/'
  const other = hostOs === 'nt' ? '/' : '\\'
  if (!value.includes(other)) return value
  return value.split(/[/\\]/).join(sep)
}

/**
 * Rewrite every recognized path input on a graph to the live host separator.
 * Nodes and keys outside {@link PATH_INPUT_KEYS} are left unchanged.
 * @param graph - an API-format graph (already parameterized).
 * @param hostOs - the live ComfyUI host family.
 * @returns a new graph; the input is not mutated.
 */
export function rewriteGraphPaths(graph: ComfyGraph, hostOs: ComfyHostOs): ComfyGraph {
  const next: ComfyGraph = {}
  for (const [id, node] of Object.entries(graph)) {
    let inputs = node.inputs
    let copied = false
    for (const [key, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'string' || !PATH_INPUT_KEYS.has(key) || !isRelativeHostPath(value)) continue
      const rewritten = rewriteHostPath(value, hostOs)
      if (rewritten === value) continue
      if (!copied) {
        inputs = { ...node.inputs }
        copied = true
      }
      inputs[key] = rewritten
    }
    next[id] = copied ? { class_type: node.class_type, inputs } : node
  }
  return next
}
