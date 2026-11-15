/**
 * The model chip's backend: the studio host lists its models at `/api/models`
 * and the choice is kept per browser, in localStorage.
 * @module models
 */

import { getJson } from './http.ts'
import type { ModelEntry, ModelRoute } from '../../../shared/imagine-types.ts'

const PICK_KEY = 'imagine.model.v1'

/** What `/api/models` answers. */
interface ModelList { readonly models: readonly ModelEntry[]; readonly default: ModelRoute }

/** The one request per page load; dropped on failure so the next open retries. */
let listing: Promise<ModelList | undefined> | undefined

/**
 * The host's models, fetched once and shared by every chip.
 * @returns the list, or undefined when the host did not answer.
 */
export function fetchModels(): Promise<ModelList | undefined> {
  listing ??= getJson<ModelList>('/api/models', 'models')
    .catch(() => undefined)
    .then((list) => {
      if (list === undefined) listing = undefined
      return list
    })
  return listing
}

function stored(): ModelRoute | undefined {
  try {
    const raw = localStorage.getItem(PICK_KEY)
    return raw === null ? undefined : JSON.parse(raw) as ModelRoute
  } catch {
    return undefined
  }
}

/**
 * The model a chip opens on: this browser's last pick while the host still
 * lists it, the host default otherwise. Read at each open, so a pick made in
 * one chip is what the next one shows.
 * @param list - the host's models.
 * @returns the route to show.
 */
export function chosenModel(list: ModelList): ModelRoute {
  const pick = stored()
  const known = pick !== undefined && list.models.some(entry => entry.provider === pick.provider && entry.id === pick.model)
  return known ? pick : list.default
}

/**
 * Keep a pick for this browser. Nothing is sent to the host: the route
 * travels with each request that needs it.
 * @param route - the model picked.
 */
export function selectModel(route: ModelRoute): void {
  try { localStorage.setItem(PICK_KEY, JSON.stringify({ provider: route.provider, model: route.model })) } catch { /* private mode */ }
}
