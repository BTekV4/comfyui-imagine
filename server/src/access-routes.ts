/**
 * `/api/access` and the two routes that hide and show the warning about an
 * open studio.
 *
 * The GET needs no login: the page reads it before drawing the form, and the
 * desktop app reads it to know whether the login is on. The two POSTs change
 * state, so they go through the studio's origin check; `main.ts` already runs
 * that check on every state-changing request, and the check is repeated here
 * so the rule stays beside the route (and can be tested on its own).
 * @module access-routes
 */

import { message } from './messages.ts'
import { sendJson } from './route-kit.ts'
import { stateChangeAllowed } from './security.ts'
import type { Handler, WebRoute } from './host.ts'
import type { AccessBanner } from './access-banner.ts'
import type { HostAccessView } from '../../shared/host-access.ts'

/** The page's whole view of who may enter. */
export const ACCESS_PATH = '/api/access'
/** Hide the warning for the studio's listening address. */
export const HIDE_BANNER_PATH = '/api/access/banner/hide'
/** Show the warning again, on every device. */
export const SHOW_BANNER_PATH = '/api/access/banner/show'

/** What the routes read: the live settings and the store of the dismissal. */
export interface AccessRouteOptions {
  readonly banner: AccessBanner
  /** The address in force (`config.host`, or `IMAGINE_HOST`). */
  readonly listenHost: string
  /** Whether that address is reachable from beyond the machine. */
  readonly exposed: boolean
  readonly loginRequired: () => boolean
  readonly passwordSet: () => boolean
}

/**
 * Build the three routes.
 * @param options - the studio's address and the live settings the answer reads.
 * @returns the route table entries.
 */
export function createAccessRoutes(options: AccessRouteOptions): WebRoute[] {
  const view = (): HostAccessView => ({
    loginRequired: options.loginRequired(),
    passwordSet: options.passwordSet(),
    exposed: options.exposed,
    listenHost: options.listenHost,
    bannerDismissed: options.banner.hiddenFor() === options.listenHost,
  })
  /** Refuse a cross-site change before it touches the file. */
  const guarded = (handler: Handler): Handler => async (req, res) => {
    if (!stateChangeAllowed(req)) {
      sendJson(res, 403, { error: message('security.crossSite') })
      return
    }
    await handler(req, res)
  }
  return [
    { kind: 'exact', path: ACCESS_PATH, handler: (_req, res) => { sendJson(res, 200, view()) } },
    {
      kind: 'exact',
      path: HIDE_BANNER_PATH,
      handler: guarded(async (req, res) => {
        // Nothing to read: the click carries no more than the address in force.
        req.resume()
        /*
         * With the login on the strip is not drawn, so there is nothing to
         * hide: a stale tab must not leave a dismissal for when it is off.
         */
        if (!options.loginRequired()) await options.banner.hide(options.listenHost)
        sendJson(res, 200, view())
      }),
    },
    {
      kind: 'exact',
      path: SHOW_BANNER_PATH,
      handler: guarded(async (req, res) => {
        req.resume()
        await options.banner.show()
        sendJson(res, 200, view())
      }),
    },
  ]
}
