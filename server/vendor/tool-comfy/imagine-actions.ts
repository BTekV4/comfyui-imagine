/**
 * The guard for a request's action, in a module with no imports from the job
 * runner. The list itself is shared with the page (`IMAGINE_ACTIONS` in
 * `shared/imagine-types.ts`), and is imported from there.
 * @module tool-comfy/imagine-actions
 */

import { IMAGINE_ACTIONS, type ImagineAction } from '../../../shared/imagine-types.ts'

/**
 * Whether a value names a studio action.
 * @param value - the untrusted value, e.g. a request's `action`.
 * @returns true when it is one of {@link IMAGINE_ACTIONS}.
 */
export function isImagineAction(value: unknown): value is ImagineAction {
  return typeof value === 'string' && (IMAGINE_ACTIONS as readonly string[]).includes(value)
}
