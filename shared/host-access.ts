/**
 * What `/api/access` tells the page: who may open the studio, and whether the
 * owner hid the warning about a studio open to the network.
 *
 * Read by the server route and by the page before it draws the login form, so
 * the answer needs no login. The warning's dismissal is one choice for the
 * studio, kept on the host: a browser that hides it hides it on every device.
 * @module host-access
 */

/** The studio's access state, as the page reads it. */
export interface HostAccessView {
  /** Whether a password is asked for before the studio opens. */
  readonly loginRequired: boolean
  /** Whether a password exists, even with the login switched off. */
  readonly passwordSet: boolean
  /** Whether the studio listens beyond loopback. */
  readonly exposed: boolean
  /** The address in the configuration (`0.0.0.0`, `127.0.0.1`, a LAN name…). */
  readonly listenHost: string
  /** The owner hid the warning for this address; it is hidden on every device. */
  readonly bannerDismissed: boolean
}
