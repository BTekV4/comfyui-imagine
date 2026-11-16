/**
 * The first run: a studio with no `config.yaml` writes itself one.
 *
 * Until now the server died on a missing file (`readFileSync` at boot), so the
 * only way in was `install.sh` asking three questions in a terminal — fine on
 * Linux, unusable in a Windows zip where there is no bash. The portable
 * packages carry `config.example.yaml`; this turns it into a `config.yaml`
 * that works out of the box (ComfyUI on the same machine, a local text
 * endpoint, a model id that the first-run card lets you change), and the page
 * already knows how to ask for whatever is still wrong.
 * @module first-run
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** What a fresh config.yaml says when it has to invent one. */
export const FIRST_RUN_DEFAULTS = {
  port: 3090,
  host: '0.0.0.0',
  comfy: 'http://127.0.0.1:8188',
  provider: 'local',
  endpoint: 'http://127.0.0.1:11434/v1',
  model: 'qwen3-vl:8b',
} as const

/** What {@link ensureConfig} did, for the boot log. */
export interface EnsureConfigResult {
  /** Whether a config.yaml was written. */
  readonly created: boolean
  /** The path that was read or written. */
  readonly path: string
  /** The file it was copied from, when there was one. */
  readonly from?: string
}

/** One config, from the example with the few keys a first run must have right. */
function configFrom(example: Record<string, unknown> | undefined): string {
  const base = example ?? {}
  const config: Record<string, unknown> = {
    ...base,
    port: base['port'] ?? FIRST_RUN_DEFAULTS.port,
    host: base['host'] ?? FIRST_RUN_DEFAULTS.host,
  }
  const comfy = typeof base['comfy'] === 'object' && base['comfy'] !== null ? base['comfy'] : {}
  config['comfy'] = { ...comfy, baseURL: FIRST_RUN_DEFAULTS.comfy }
  /*
   * One provider and one model: a fresh install should not need a key it does
   * not have, and the page's first-run card says what is still missing (a
   * local endpoint that does not answer, or no model at all).
   */
  config['providers'] = { [FIRST_RUN_DEFAULTS.provider]: { baseURL: FIRST_RUN_DEFAULTS.endpoint, apiKeyEnv: 'LOCAL_API_KEY', timeoutMs: 600000 } }
  config['models'] = [{ provider: FIRST_RUN_DEFAULTS.provider, id: FIRST_RUN_DEFAULTS.model, name: FIRST_RUN_DEFAULTS.model }]
  config['defaultModel'] = { provider: FIRST_RUN_DEFAULTS.provider, model: FIRST_RUN_DEFAULTS.model }
  return stringifyYaml(config)
}

/**
 * Make sure a config.yaml exists, writing one from the example when it does not.
 *
 * Never overwrites: a config the user edited (or the studio wrote) is theirs.
 * @param path - the config the boot is about to read (`IMAGINE_CONFIG`).
 * @param examplePath - `config.example.yaml`, shipped beside the app.
 * @returns what happened, for the boot log.
 * @throws {Error} when the file cannot be written — the boot cannot go on.
 */
export function ensureConfig(path: string, examplePath: string): EnsureConfigResult {
  if (existsSync(path)) return { created: false, path }
  let example: Record<string, unknown> | undefined
  let from: string | undefined
  if (existsSync(examplePath)) {
    from = examplePath
    const parsed: unknown = parseYaml(readFileSync(examplePath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) example = parsed as Record<string, unknown>
  }
  try {
    writeFileSync(path, configFrom(example))
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Imagine cannot write its first configuration to ${path}: ${reason}. ` +
      'Set IMAGINE_CONFIG to a writable path, or copy config.example.yaml there yourself.',
    )
  }
  return { created: true, path, ...from === undefined ? {} : { from } }
}
