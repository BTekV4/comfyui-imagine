#!/usr/bin/env node
/**
 * Start the built studio, wait until it answers, then stop it.
 *
 * `npm test` imports the server's modules and injects their halves: it never
 * boots `dist/server.mjs`, so the places where config, data folders, the web
 * build and the operating system meet are not exercised there. The Windows CI
 * job runs this script instead of trusting the unit tests, because that is
 * where a POSIX-only assumption in the boot shows up as a server that never
 * answers.
 *
 * The configuration is the example one, with every path made absolute into a
 * fresh temporary folder: the test must not leave a config, media or plugin
 * behind in the checkout, and the data root must be its own.
 *
 *   node scripts/smoke-server.mjs
 *
 * Environment:
 * - `IMAGINE_SMOKE_PORT`: the port to listen on (3095 by default).
 * - `IMAGINE_SMOKE_REQUIRE_FFMPEG=1`: a missing ffmpeg fails the check. CI
 *   installs it, so there it must be found; a developer without ffmpeg can
 *   still run the boot check.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.IMAGINE_SMOKE_PORT ?? 3095)
const requireFfmpeg = process.env.IMAGINE_SMOKE_REQUIRE_FFMPEG === '1'
const base = `http://127.0.0.1:${String(port)}`

/** How long the server may take to answer before the boot counts as failed. */
const BOOT_TIMEOUT_MS = 60_000
/** How long a clean stop may take after the request. */
const STOP_TIMEOUT_MS = 10_000

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * One HTTP request with a short clock of its own: a server that accepts the
 * connection and never answers must not hang the check.
 * @param {string} path - the path on the local server.
 * @returns {Promise<{ status: number, body: string }>}
 */
async function get(path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) })
  return { status: response.status, body: await response.text() }
}

/** Make every config path absolute under the project, the config or the scratch folder. */
function absolutize(example, dataDir) {
  const config = { ...example }
  config.port = port
  config.host = '127.0.0.1'
  config.webDir = join(projectRoot, 'dist', 'web')
  config.passwordFile = join(dataDir, 'password.json')
  config.secretFile = join(dataDir, 'cookie-secret')
  const tool = { ...(config.toolComfy ?? {}) }
  tool.outputDir = join(dataDir, 'outputs')
  if (typeof tool.persona?.path === 'string') {
    tool.persona = { ...tool.persona, path: join(projectRoot, tool.persona.path) }
  }
  const anchored = value => (typeof value !== 'string' || value === '' || value.startsWith('custom:') || isAbsolute(value)
    ? value
    : join(projectRoot, value))
  if (tool.workflows !== undefined && tool.workflows !== null) {
    tool.workflows = Object.fromEntries(Object.entries(tool.workflows).map(([name, entry]) => {
      if (typeof entry !== 'object' || entry === null) return [name, entry]
      const next = { ...entry }
      for (const field of ['path', 'pathHigh']) {
        if (typeof next[field] === 'string' && next[field] !== '') next[field] = anchored(next[field])
      }
      return [name, next]
    }))
  }
  config.toolComfy = tool
  return config
}

/** Wait until `/` answers, or fail with the server's own output. */
async function waitForPage(child, logs) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the server exited (${String(child.exitCode ?? child.signalCode)}) before answering:\n${logs()}`)
    }
    try {
      const page = await get('/')
      if (page.status === 200 && page.body.includes('<title>Imagine</title>')) return
    } catch {
      // Not listening yet: keep waiting until the deadline.
    }
    if (Date.now() > deadline) throw new Error(`the server did not answer ${base}/ within ${String(BOOT_TIMEOUT_MS)} ms:\n${logs()}`)
    await sleep(500)
  }
}

/** Ask the child to stop and wait for its exit. */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  // SIGTERM is a real request on POSIX; on Windows Node maps it to a terminate,
  // which is the best the platform offers from another process.
  child.kill('SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error('the server did not stop within the shutdown window')
    }
    await sleep(100)
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'imagine-smoke-'))
const dataDir = join(scratch, 'data')
const configPath = join(scratch, 'config.yaml')
let child
let output = ''
try {
  const example = parseYaml(await readFile(join(projectRoot, 'config.example.yaml'), 'utf8'))
  await writeFile(configPath, stringifyYaml(absolutize(example, dataDir)))
  child = spawn(process.execPath, [join(projectRoot, 'dist', 'server.mjs')], {
    cwd: projectRoot,
    env: { ...process.env, IMAGINE_CONFIG: configPath, IMAGINE_HOME: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = () => output
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })

  await waitForPage(child, logs)

  const health = await get('/api/health')
  if (health.status !== 200) throw new Error(`GET /api/health answered ${String(health.status)}: ${health.body}`)
  const parsed = JSON.parse(health.body)
  if (parsed.ok !== true) throw new Error(`GET /api/health did not say ok: ${health.body}`)

  const setup = await get('/setup-status')
  if (setup.status !== 200) throw new Error(`GET /setup-status answered ${String(setup.status)}: ${setup.body}`)
  const reported = JSON.parse(setup.body)
  if (reported.node?.ok !== true) throw new Error(`/setup-status says the Node is unusable: ${setup.body}`)
  if (reported.output?.ok !== true) throw new Error(`/setup-status says the media folder is not writable: ${setup.body}`)
  if (requireFfmpeg && reported.ffmpeg?.ok !== true) throw new Error(`/setup-status does not find ffmpeg: ${setup.body}`)
  if (!requireFfmpeg && reported.ffmpeg?.ok !== true) {
    console.log('[smoke] ffmpeg is not on PATH: the boot is fine, the media actions will say so')
  }

  await stop(child)
  if (child.exitCode === null && child.signalCode === null) throw new Error('the server stopped without reporting an exit')
  const ended = child.exitCode ?? child.signalCode
  // The port must be free: a server that "stops" but keeps listening is a
  // second launch that cannot bind.
  let stillThere = false
  try {
    await get('/')
    stillThere = true
  } catch {
    // Connection refused: the expected outcome.
  }
  if (stillThere) throw new Error('the server still answers after the shutdown request')
  if (process.platform !== 'win32' && child.exitCode !== 0) {
    throw new Error(`the server exited with ${String(child.exitCode)} after SIGTERM:\n${logs()}`)
  }
  console.log(`[smoke] the studio answered on ${base}, reported its setup, and stopped (${String(ended)})`)
} catch (error) {
  console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`)
  if (output !== '') console.error(output)
  process.exitCode = 1
} finally {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
}
