/**
 * What the environment says over the configuration at boot.
 *
 * The desktop app (Electron) starts the studio from a **read-only** program
 * folder and keeps `config.yaml`, the media and the plugins in the user's data
 * folder. It cannot rewrite the config on every start — the AppImage mount
 * point changes each launch — so it says where the program is and which port
 * it picked through the environment, once per start:
 *
 * - `IMAGINE_PROGRAM_DIR`: the read-only folder holding `dist/`, `locales/`,
 *   `plugins/`, `workflows/`, `persona/` and `config.example.yaml`;
 * - `IMAGINE_PORT`: the free loopback port the app reserved for this window;
 * - `IMAGINE_HOST`: `127.0.0.1` — a desktop window is not a server on the LAN.
 *
 * All three are optional and fall back to `config.yaml`, so every existing
 * installation (the Linux services, Docker, the portable packages) boots
 * exactly as before.
 * @module boot-env
 */

import { resolve } from 'node:path'

/**
 * The read-only folder the program was installed in.
 * @param env - the environment to read (`process.env` by default).
 * @returns the absolute folder, or undefined when the studio runs as it always
 *   did (program and data in one writable tree).
 */
export function programDirFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env['IMAGINE_PROGRAM_DIR']?.trim()
  return value === undefined || value === '' ? undefined : resolve(value)
}

/** The port a server may listen on: a whole number in 1..65535. */
function portOf(value: string | number | undefined): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt((value ?? '').trim(), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return undefined
  return parsed
}

/**
 * The port to listen on: `IMAGINE_PORT` when it holds a usable port, else the
 * config's, else the studio's own 3090.
 * @param configPort - `port:` as written in the config file.
 * @param env - the environment to read.
 * @returns the port for `server.listen`.
 */
export function listenPort(configPort: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const override = env['IMAGINE_PORT']?.trim()
  return (override === undefined || override === '' ? undefined : portOf(override)) ?? portOf(configPort) ?? 3090
}

/**
 * Whether an address is reachable from beyond this machine.
 *
 * The page warns when the studio listens on one of these with no password: the
 * desktop app always passes `127.0.0.1`, so it never warns. `0.0.0.0`, `::`
 * and every LAN address count as exposed; the whole `127.0.0.0/8` block and
 * IPv6's `::1` do not.
 * @param host - the address passed to `server.listen`.
 * @returns true when a visitor on the network could reach it.
 */
export function listensBeyondLoopback(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (value === '' || value === 'localhost' || value === '::1' || value === '::ffff:127.0.0.1') return false
  return !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

/**
 * The address to listen on: `IMAGINE_HOST` when set, else the config's, else
 * `0.0.0.0` (what every installation so far expects).
 * @param configHost - `host:` as written in the config file.
 * @param env - the environment to read.
 * @returns the address for `server.listen`.
 */
export function listenHost(configHost: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const override = env['IMAGINE_HOST']?.trim()
  if (override !== undefined && override !== '') return override
  const configured = configHost?.trim()
  return configured === undefined || configured === '' ? '0.0.0.0' : configured
}
