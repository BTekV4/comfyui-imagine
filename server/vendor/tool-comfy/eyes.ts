/**
 * The vision service and the route a pass looks with, or nothing.
 *
 * Six passes spelt the same two lookups and the same check (2026-10-21).
 * @module tool-comfy/eyes
 */

import type { ImagineHost } from '../../src/host.ts'
import { visionOf, visionRoute, type VisionCapable } from './imagine-models.ts'
import type { ModelRoute } from '../../../shared/imagine-types.ts'

/**
 * What a pass looks with.
 * @param ctx - the host context, which may carry the vision service.
 * @param chosen - the model the composer's chip was showing, when known.
 * @returns the service and the route, or undefined when nothing can look.
 */
export function eyesOf(ctx: ImagineHost, chosen?: ModelRoute): { vision: VisionCapable; route: ModelRoute } | undefined {
  const vision = visionOf(ctx)
  const route = visionRoute(chosen)
  return vision === undefined || route === undefined ? undefined : { vision, route }
}
