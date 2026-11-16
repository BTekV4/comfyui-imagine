/**
 * The first-run report: can this installation do anything yet?
 *
 * A fresh copy of the studio has four ways of being useless without saying so
 * — a Node older than the build targets, no `ffmpeg`, a ComfyUI address that
 * answers nothing, no model configured — and until now each one surfaced as a
 * chat that "did not work". This module answers one question about each, in
 * the host's words (codes and versions, not sentences: the page translates
 * them), so `/setup-status` can be read by a person on their first minute.
 * @module setup-status
 */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { ComfyUi } from '../vendor/comfyui/index.ts'
import type { SetupCheck, SetupDevice, SetupStatus } from '../../shared/setup-status.ts'

const execFileAsync = promisify(execFile)

/** The oldest Node the build targets: `package.json` engines says the same. */
export const NODE_MINIMUM = 24
/** How long `ffmpeg -version` may take before it counts as missing. */
const FFMPEG_TIMEOUT_MS = 5_000
/** How long ComfyUI has to answer `/system_stats` and `/queue`. */
const COMFY_TIMEOUT_MS = 6_000

/** What `serverReport()` resolves to, without exporting ComfyUI's own type. */
type ComfyReport = Awaited<ReturnType<ComfyUi['serverReport']>>

/** The probes, injected: the tests answer them without a machine. */
export interface SetupProbes {
  /** The studio's own version, from `package.json`. */
  readonly version?: string
  /** `process.versions.node`. */
  readonly nodeVersion: string
  /** Resolves to the version ffmpeg prints, or throws when it is not there. */
  readonly ffmpeg: () => Promise<string>
  /** The address ComfyUI is configured with, reported as it is written. */
  readonly comfyURL: string
  /** The ComfyUI client's own status read. */
  readonly comfy: () => Promise<ComfyReport>
  /** The model in force, if any. */
  readonly model?: { readonly provider: string; readonly model: string }
  /** The providers `config.yaml` declares. */
  readonly providers: readonly string[]
  /** Where the media lands. */
  readonly outputDir: string
  /** Whether that folder can be written. */
  readonly outputWritable: () => Promise<boolean>
}

/** The message of a failure, one line: that is what fits under a row. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0] ?? text
}

/**
 * Ask every probe and compose the report.
 *
 * The three that can take real time (ffmpeg, ComfyUI, the output folder) run
 * together: the card waits for the slowest, not for the sum.
 * @param probes - the checks, injected so the tests need no machine.
 * @returns the report, with `ok` true only when every check passed.
 */
export async function readSetupStatus(probes: SetupProbes): Promise<SetupStatus> {
  const major = Number.parseInt(probes.nodeVersion.split('.')[0] ?? '', 10)
  const node: SetupStatus['node'] = {
    ok: Number.isFinite(major) && major >= NODE_MINIMUM,
    minimum: String(NODE_MINIMUM),
    found: probes.nodeVersion,
  }
  const [ffmpeg, comfy, output] = await Promise.all([
    checkFfmpeg(probes.ffmpeg),
    checkComfy(probes.comfyURL, probes.comfy),
    checkOutput(probes.outputDir, probes.outputWritable),
  ])
  const model = checkModel(probes.model, probes.providers)
  return {
    ok: node.ok && ffmpeg.ok && comfy.ok && model.ok && output.ok,
    ...probes.version === undefined ? {} : { version: probes.version },
    node: node.ok ? node : { ...node, problem: 'node-old' },
    ffmpeg,
    comfy,
    model,
    output,
  }
}

/** `ffmpeg -version`: it prints its version on the first line, or it is missing. */
async function checkFfmpeg(probe: () => Promise<string>): Promise<SetupCheck> {
  try {
    const version = await probe()
    return { ok: true, ...version === '' ? {} : { detail: version } }
  } catch (error: unknown) {
    return { ok: false, problem: 'ffmpeg-missing', detail: reasonOf(error) }
  }
}

/**
 * The ComfyUI report: a server that answers HTTP but with an error (404 on
 * `/system_stats`, usually an address pointing at something else) is told
 * apart from one that does not answer at all, because the fix differs.
 */
async function checkComfy(
  url: string,
  probe: () => Promise<ComfyReport>,
): Promise<SetupStatus['comfy']> {
  try {
    const report = await probe()
    const devices: SetupDevice[] = report.devices.map(device => ({
      name: device.name,
      ...device.vramTotal === undefined ? {} : { vramTotal: device.vramTotal },
    }))
    return {
      ok: true,
      url,
      ...report.version === undefined ? {} : { comfyVersion: report.version },
      ...devices.length === 0 ? {} : { devices },
    }
  } catch (error: unknown) {
    const detail = reasonOf(error)
    return {
      ok: false,
      url,
      problem: /HTTP \d/.test(detail) ? 'comfy-http' : 'comfy-unreachable',
      detail,
    }
  }
}

/** A model to talk to, and a provider that can reach it. */
function checkModel(
  model: SetupProbes['model'],
  providers: readonly string[],
): SetupStatus['model'] {
  if (model === undefined || model.model.trim() === '') return { ok: false, problem: 'no-model' }
  if (!providers.includes(model.provider)) {
    return { ok: false, problem: 'provider-missing', provider: model.provider, id: model.model }
  }
  return { ok: true, provider: model.provider, id: model.model }
}

/** The output folder: present and writable, or the first job will fail. */
async function checkOutput(dir: string, writable: () => Promise<boolean>): Promise<SetupStatus['output']> {
  try {
    return await writable() ? { ok: true, dir } : { ok: false, dir, problem: 'output-missing', detail: 'not writable' }
  } catch (error: unknown) {
    return { ok: false, dir, problem: 'output-missing', detail: reasonOf(error) }
  }
}

/**
 * The same report, with the machine's own probes: this is what the route uses.
 * @param where - the live halves: the ComfyUI client, the configured values.
 * @returns the report.
 */
export async function liveSetupStatus(where: {
  readonly version?: string
  readonly comfy: ComfyUi
  readonly comfyURL: string
  readonly model?: { readonly provider: string; readonly model: string }
  readonly providers: readonly string[]
  readonly outputDir: string
}): Promise<SetupStatus> {
  return await readSetupStatus({
    ...where.version === undefined ? {} : { version: where.version },
    nodeVersion: process.versions.node,
    ffmpeg: async () => {
      const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
      const line = stdout.split('\n')[0] ?? ''
      const match = /ffmpeg version (\S+)/.exec(line)
      return match?.[1] ?? line.trim()
    },
    comfyURL: where.comfyURL,
    comfy: async () => await where.comfy.serverReport(AbortSignal.timeout(COMFY_TIMEOUT_MS)),
    ...where.model === undefined ? {} : { model: where.model },
    providers: where.providers,
    outputDir: where.outputDir,
    outputWritable: async () => {
      await access(where.outputDir, constants.W_OK | constants.X_OK)
      return true
    },
  })
}
