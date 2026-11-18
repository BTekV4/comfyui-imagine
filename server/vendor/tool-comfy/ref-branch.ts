/**
 * The reference-photo branch of an edit graph, found from the graph itself.
 *
 * `refImageNodeId` / `refEncodeNodeId` arrived on 2026-11-15, with the «+»
 * photo of an edit. A `config.yaml` written before that has neither key, while
 * the shipped Krea 2 edit graph still carries a `reference.png` loader: the
 * edit was submitted with the branch in it and ComfyUI refused a file nobody
 * had uploaded. The graph already says which branch it is — the second-image
 * inputs (`source_latent_b`, `image_b`) are fed by a `LoadImage` that is not
 * the photo being edited, through a `VAEEncode` when the latent is encoded.
 *
 * Finding it here means an installation with an old config keeps editing, and
 * a reference photo it is given still lands in the right loader.
 * @module tool-comfy/ref-branch
 */

import type { ComfyGraph } from '../comfyui/types.ts'

/** The two nodes of an edit's reference photo, as far as the graph shows them. */
export interface RefBranch {
  /** The `LoadImage` node the reference photo is uploaded into. */
  readonly refImageNodeId: string
  /** The encoder between that loader and `source_latent_b`, when there is one. */
  readonly refEncodeNodeId?: string
}

/** A link (`[node, output]`), as the API format writes it. */
function linkOf(value: unknown): readonly [string, number] | undefined {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'string' && typeof value[1] === 'number'
    ? [value[0], value[1]]
    : undefined
}

/**
 * The first `LoadImage` upstream of `start`.
 *
 * Walks every linked input, not only the conventional `pixels` one: a graph
 * may scale or otherwise prepare the reference before encoding it.
 * @param graph - the workflow graph.
 * @param start - the node to walk up from.
 * @param seen - node ids already visited, so a cycle ends.
 * @returns the loader's node id, or undefined.
 */
function loaderUpstream(graph: ComfyGraph, start: string, seen = new Set<string>()): string | undefined {
  if (seen.has(start)) return undefined
  seen.add(start)
  const node = graph[start]
  if (node === undefined) return undefined
  if (node.class_type === 'LoadImage') return start
  for (const value of Object.values(node.inputs)) {
    const link = linkOf(value)
    if (link === undefined) continue
    const found = loaderUpstream(graph, link[0], seen)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Find the reference-photo branch of an edit graph.
 *
 * `source_latent_b` wins over `image_b`: it is the encoded second image, and
 * the node that feeds it is the encoder the run has to drop with the loader.
 * The photo being edited (`mainImageNodeId`, else the graph's first
 * `LoadImage`) is never the reference: a graph whose only loader feeds both
 * sides has no separate branch.
 * @param graph - the API-format graph.
 * @param mainImageNodeId - the loader the source photo goes into, when the
 *   entry pins one.
 * @returns the reference loader and its encoder, or undefined when the graph
 *   has no second-image branch.
 */
export function detectRefBranch(graph: ComfyGraph, mainImageNodeId?: string): RefBranch | undefined {
  const main = mainImageNodeId ?? Object.entries(graph)
    .find(([, node]) => node.class_type === 'LoadImage')?.[0]
  for (const input of ['source_latent_b', 'image_b'] as const) {
    for (const node of Object.values(graph)) {
      const link = linkOf(node.inputs[input])
      if (link === undefined) continue
      const feed = graph[link[0]]
      if (feed === undefined) continue
      /*
       * A `source_latent_b` that names a `LoadImage` directly has no encoder;
       * one naming a `VAEEncode` keeps it as the node to remove with the
       * loader. `image_b` is always the photo itself.
       */
      const loader = feed.class_type === 'LoadImage' ? link[0] : loaderUpstream(graph, link[0])
      if (loader === undefined || loader === main) continue
      const encode = input === 'source_latent_b' && feed.class_type !== 'LoadImage' ? link[0] : undefined
      return {
        refImageNodeId: loader,
        ...encode === undefined ? {} : { refEncodeNodeId: encode },
      }
    }
  }
  return undefined
}

/**
 * Take the reference branch out of a parameterized graph: both nodes and every
 * link that pointed into them.
 *
 * The graph a run is handed is a copy, so this never touches the loaded one.
 * @param graph - the run's graph, edited in place.
 * @param refImageNodeId - the reference loader.
 * @param refEncodeNodeId - its encoder, when the branch has one.
 */
export function dropRefBranch(graph: ComfyGraph, refImageNodeId: string, refEncodeNodeId?: string): void {
  const gone = new Set([refImageNodeId, ...refEncodeNodeId === undefined ? [] : [refEncodeNodeId]])
  for (const id of gone) delete graph[id]
  for (const node of Object.values(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      const link = linkOf(value)
      if (link !== undefined && gone.has(link[0])) delete node.inputs[field]
    }
  }
}
