#!/usr/bin/env node
/**
 * The agent chat's bench: a repeatable run of the requests a person actually
 * writes, against a real model and a real ComfyUI, on a studio of its own.
 *
 * The bench starts a server on its own port, with its own data root, media
 * folder, settings and plugin copy: it never writes into the demo's outputs or
 * into the checkout. A small recording proxy sits in front of the model
 * gateway, so every tool call and its arguments are kept exactly as the model
 * wrote them, without a test hook in the server.
 *
 * Every case records what the studio ran (tool, arguments, the prompt that
 * reached the drawing model), what it produced (real width, height, ratio and
 * duration), whether that matches the line, the reply's language, the elapsed
 * time and any error. The report is written as Markdown and JSON.
 *
 *   node scripts/agent-bench.mjs \
 *     --gateway http://127.0.0.1:8080/v1 \
 *     --comfy   http://127.0.0.1:8188 \
 *     --model   qwen3.8-flash-next \
 *     --dir     /path/to/a/scratch/folder \
 *     --report  /path/to/report.md \
 *     --json    /path/to/report.json
 *
 * The requests are Italian on purpose: that is the studio's own language and
 * the one the owner writes in. The code and the report are English.
 *
 * The bench is destructive only inside `--dir`. It does not delete anything
 * outside it, and `--clean` removes just that folder after writing the report.
 * @module scripts/agent-bench
 */

import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO = resolve(HERE, '..')

/** The prompt fixtures are drawn with: neutral, owned by the bench. */
const STILL_PROMPT = 'una tazza di ceramica bianca su un tavolo di legno chiaro, una parete grigia sullo sfondo, luce naturale del giorno'
const STILL_SIZE = '1080x720'

/** How long a job may render before the bench stops waiting for it. */
const JOB_TIMEOUT_MS = 15 * 60_000
/** How long one agent turn may take before the bench gives up on it. */
const TURN_TIMEOUT_MS = 25 * 60_000
/** How long the server may take to answer at boot. */
const BOOT_TIMEOUT_MS = 90_000
/** How often a job's state is read. */
const POLL_MS = 2_000

const sleep = ms => new Promise((resolve) => { setTimeout(resolve, ms) })

/** A string cut to a length, with the ellipsis saying so. */
function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** One line of progress on the console. */
function log(message) {
  console.log(`[bench] ${message}`)
}

/** The arguments, as `--key value`, `--key=value` and `--flag`. */
function parseArgs(argv) {
  const args = new Map()
  for (let at = 0; at < argv.length; at++) {
    const raw = argv[at]
    if (!raw?.startsWith('--')) continue
    const body = raw.slice(2)
    const equals = body.indexOf('=')
    if (equals >= 0) {
      args.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = argv[at + 1]
    if (next === undefined || next.startsWith('--')) args.set(body, true)
    else {
      args.set(body, next)
      at += 1
    }
  }
  return args
}

const cli = parseArgs(process.argv.slice(2))
const arg = (key, fallback) => {
  const value = cli.get(key)
  return value === undefined || value === true ? fallback : String(value)
}
const flag = key => cli.get(key) === true || cli.get(key) === 'true'

if (flag('help')) {
  console.log(`agent-bench: ${DEFAULT_REPO}\n\n` +
    'Required: --gateway <url> (the OpenAI-compatible model endpoint) and --comfy <url>.\n' +
    'Optional: --model, --port, --dir, --server-dir, --report, --json, --only, --no-build, --clean, --keep-server.')
  process.exit(0)
}

const repoDir = resolve(arg('repo', DEFAULT_REPO))
const serverDir = resolve(arg('server-dir', repoDir))
const gateway = arg('gateway', process.env['IMAGINE_BENCH_GATEWAY'] ?? '')
const comfy = arg('comfy', process.env['IMAGINE_BENCH_COMFY'] ?? '')
const modelId = arg('model', process.env['IMAGINE_BENCH_MODEL'] ?? 'qwen3.8-flash-next')
const iopaint = arg('iopaint', process.env['IMAGINE_BENCH_IOPAINT'] ?? '')
const providerName = arg('provider', 'bench')
const language = arg('language', 'it')
const port = Number(arg('port', '3091'))
const only = arg('only', '').split(',').map(part => part.trim()).filter(part => part !== '')
const noBuild = flag('no-build')
const clean = flag('clean')
const keepServer = flag('keep-server')

if (gateway === '' || comfy === '') {
  console.error('[bench] --gateway and --comfy are required: the bench never guesses an endpoint.')
  process.exit(2)
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[bench] --port must be a port number, not "${String(port)}"`)
  process.exit(2)
}

const runDir = resolve(arg('dir', await mkdtemp(join(tmpdir(), 'imagine-agent-bench-'))))
const homeDir = join(runDir, 'home')
const dataDir = join(homeDir, 'data')
const mediaDir = join(dataDir, 'outputs')
const reportPath = resolve(arg('report', join(runDir, 'report.md')))
const jsonPath = resolve(arg('json', join(runDir, 'report.json')))
const caseDir = join(runDir, 'cases')
const logPath = join(runDir, 'server.log')

await mkdir(mediaDir, { recursive: true })
await mkdir(caseDir, { recursive: true })
await mkdir(join(runDir, 'tmp'), { recursive: true })

/* ------------------------------------------------------------------ HTTP --- */

/** One request with a JSON body; a non-2xx answer is an error with its text. */
async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body)
    throw new Error(`${options.method ?? 'GET'} ${url} answered ${String(response.status)}: ${detail.slice(0, 500)}`)
  }
  return body
}

/* --------------------------------------------------------------- proxy ---- */

/**
 * A pass-through in front of the model gateway that keeps what each call said.
 *
 * It speaks plain HTTP to an upstream that may be plain too: the bench is run
 * on a LAN, and wrapping TLS here would add a certificate to install for no
 * information. It forwards every path under `/v1` and records chat completions
 * (the tool calls, the text, the system and tool messages) and vision calls
 * (the instruction that reached the eyes). Bodies are captured after the
 * client has read them, so a slow model call is not slowed by the recorder.
 */
function createRecordingProxy(upstreamURL) {
  const upstream = new URL(upstreamURL)
  const agent = upstream.protocol === 'https:' ? httpsRequest : httpRequest
  const basePath = upstream.pathname.replace(/\/+$/, '')
  let current = { label: 'startup', calls: [] }
  // A model call is put in the group it started in, even when its stream ends
  // after the bench has moved on: the answer is read before the proxy's own
  // end event, and the last call used to be filed under the next case (or
  // lost) by that race.
  let inFlight = 0
  let listening
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const group = current
      inFlight += 1
      const settle = () => { inFlight = Math.max(0, inFlight - 1) }
      const body = Buffer.concat(chunks)
      const incoming = new URL(req.url ?? '/', 'http://bench')
      let targetPath
      if (basePath === '') targetPath = incoming.pathname
      else if (basePath.endsWith('/v1')) targetPath = `${basePath}${incoming.pathname.replace(/^\/v1/, '')}`
      else targetPath = `${basePath}${incoming.pathname}`
      targetPath += incoming.search
      const headers = { ...req.headers, host: upstream.host, 'accept-encoding': 'identity' }
      delete headers['content-length']
      if (body.length > 0) headers['content-length'] = String(body.length)
      const call = {
        at: new Date().toISOString(),
        method: req.method,
        path: incoming.pathname,
        label: group.label,
        request: undefined,
        response: undefined,
      }
      let responseBuffer = ''
      let responseType = ''
      let status = 0
      const forward = agent({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: targetPath,
        headers,
      }, (answer) => {
        status = answer.statusCode ?? 0
        responseType = String(answer.headers['content-type'] ?? '')
        const outHeaders = { ...answer.headers }
        delete outHeaders['content-encoding']
        delete outHeaders['transfer-encoding']
        res.writeHead(status, outHeaders)
        answer.setEncoding('utf8')
        answer.on('data', (piece) => {
          responseBuffer += piece
          res.write(piece)
        })
        answer.on('end', () => {
          res.end()
          call.status = status
          call.request = summarizeRequest(body, req.method)
          call.response = summarizeResponse(responseBuffer, responseType)
          if (callLabelRelevant(call)) group.calls.push(call)
          settle()
        })
      })
      forward.on('error', (error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`bench proxy: ${error instanceof Error ? error.message : String(error)}`)
        call.status = 502
        call.error = error instanceof Error ? error.message : String(error)
        group.calls.push(call)
        settle()
      })
      if (body.length > 0) forward.write(body)
      forward.end()
    })
  })
  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      listening = server.address()
      return `http://127.0.0.1:${String(listening.port)}`
    },
    begin(label) { current = { label, calls: [] } },
    async end() {
      const done = current
      current = { label: 'idle', calls: [] }
      // Let a stream that the server has already read finish being filed.
      const deadline = Date.now() + 5_000
      while (inFlight > 0 && Date.now() < deadline) await sleep(25)
      return done
    },
    async stop() {
      const deadline = Date.now() + 5_000
      while (inFlight > 0 && Date.now() < deadline) await sleep(25)
      await new Promise((resolve) => { server.close(() => resolve()) })
    },
  }
}

/** Whether a recorded call is worth keeping: the model calls, not the probes. */
function callLabelRelevant(call) {
  return typeof call.path === 'string' && (call.path.includes('/chat/completions') || call.path.endsWith('/models'))
}

/** The request in the small shape the report needs, with images reduced. */
function summarizeRequest(body, method) {
  if (method !== 'POST' || body.length === 0) return undefined
  let parsed
  try { parsed = JSON.parse(body.toString('utf8')) } catch { return { note: 'not JSON' } }
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages.map(message => ({
      role: message.role,
      content: summarizeContent(message.content),
      ...message.tool_call_id === undefined ? {} : { toolCallId: message.tool_call_id },
      ...Array.isArray(message.tool_calls) ? { toolCalls: message.tool_calls.map(call => call.function?.name) } : {},
    }))
    : []
  return {
    model: parsed.model,
    stream: parsed.stream === true,
    toolChoice: parsed.tool_choice,
    tools: Array.isArray(parsed.tools) ? parsed.tools.map(tool => tool.function?.name).filter(Boolean) : [],
    messages,
  }
}

/** One message's content: text kept, each image replaced by its size. */
function summarizeContent(content) {
  if (typeof content === 'string') return clip(content, 6_000)
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (part?.type === 'text') return part.text ?? ''
    if (part?.type === 'image_url') {
      const data = part.image_url?.url ?? ''
      return `[image ${String(Math.round(String(data).length / 1024))} KB]`
    }
    return `[${String(part?.type ?? 'part')}]`
  }).join('\n')
}

/** What a streamed or whole chat completion said. */
function summarizeResponse(raw, contentType) {
  if (raw.trim() === '') return undefined
  if (!contentType.includes('event-stream') && !raw.startsWith('data:')) {
    try {
      const parsed = JSON.parse(raw)
      const choice = parsed.choices?.[0]
      return {
        kind: 'json',
        model: parsed.model,
        content: clip(String(choice?.message?.content ?? ''), 20_000),
        toolCalls: (choice?.message?.tool_calls ?? []).map(call => ({
          name: call.function?.name,
          arguments: call.function?.arguments,
        })),
        finish: choice?.finish_reason,
      }
    } catch {
      return { kind: 'text', text: clip(raw, 2_000) }
    }
  }
  const calls = new Map()
  let content = ''
  let finish
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') break
    let parsed
    try { parsed = JSON.parse(data) } catch { continue }
    const choice = parsed.choices?.[0]
    const delta = choice?.delta
    if (typeof delta?.content === 'string') content += delta.content
    for (const fragment of delta?.tool_calls ?? []) {
      const at = typeof fragment.index === 'number' ? fragment.index : 0
      const call = calls.get(at) ?? { name: '', arguments: '' }
      if (typeof fragment.id === 'string') call.id = fragment.id
      if (typeof fragment.function?.name === 'string') call.name += fragment.function.name
      if (typeof fragment.function?.arguments === 'string') call.arguments += fragment.function.arguments
      calls.set(at, call)
    }
    if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason
  }
  return {
    kind: 'stream',
    content: clip(content, 20_000),
    toolCalls: [...calls.values()].map(call => ({ name: call.name, arguments: call.arguments })),
    finish,
  }
}

/* ----------------------------------------------------------------- run ---- */

/** Run one command and wait, collecting both streams. */
async function run(command, options = {}) {
  return await new Promise((resolveDone, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd ?? repoDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk; if (options.echo === true) process.stdout.write(chunk) })
    child.stderr.on('data', (chunk) => { output += chunk; if (options.echo === true) process.stderr.write(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure === true) resolveDone({ code, output })
      else reject(new Error(`${command.join(' ')} exited ${String(code)}:\n${output.slice(-4_000)}`))
    })
  })
}

/** The configuration the bench instance boots with. */
async function writeConfig(proxyBase) {
  const example = parseYaml(await readFile(join(serverDir, 'config.example.yaml'), 'utf8'))
  const config = {
    ...example,
    port,
    host: '127.0.0.1',
    language,
    webDir: join(serverDir, 'dist', 'web'),
    passwordFile: join(dataDir, 'password.json'),
    secretFile: join(dataDir, 'cookie-secret'),
    providers: {
      [providerName]: {
        baseURL: `${proxyBase}/v1`,
        timeoutMs: 600_000,
      },
    },
    models: [{ provider: providerName, id: modelId, name: modelId, vision: true }],
    defaultModel: { provider: providerName, model: modelId },
    comfy: { ...(example.comfy ?? {}), baseURL: comfy, timeoutMs: 2_700_000 },
    toolComfy: { ...(example.toolComfy ?? {}), outputDir: mediaDir },
  }
  if (typeof config.toolComfy.persona?.path === 'string') {
    config.toolComfy.persona = { ...config.toolComfy.persona, path: join(serverDir, config.toolComfy.persona.path) }
  }
  if (config.toolComfy.workflows !== undefined && config.toolComfy.workflows !== null) {
    config.toolComfy.workflows = Object.fromEntries(Object.entries(config.toolComfy.workflows).map(([key, entry]) => {
      if (typeof entry !== 'object' || entry === null) return [key, entry]
      const next = { ...entry }
      for (const field of ['path', 'pathHigh']) {
        const value = next[field]
        if (typeof value === 'string' && value !== '' && !isAbsolute(value) && !value.startsWith('custom:')) {
          next[field] = join(serverDir, value)
        }
      }
      return [key, next]
    }))
  }
  await writeFile(join(homeDir, 'config.yaml'), stringifyYaml(config))
  await writeFile(join(dataDir, 'host-settings.json'), `${JSON.stringify({
    agentChat: 'on',
    agentMaxSteps: 10,
    agentMaxJobs: 8,
    agentWaitSeconds: 300,
    agentTurnSeconds: 1_200,
    agentConfirmSeconds: 15,
  }, null, 2)}\n`)
  return config
}

/** Build the server and the one plugin the erase case needs. */
async function build(pluginsOut) {
  if (!noBuild) {
    log('building the server bundle')
    await run([process.execPath, join(serverDir, 'scripts', 'build.mjs'), 'server'], { cwd: serverDir })
  }
  await mkdir(join(pluginsOut, 'iopaint'), { recursive: true })
  await run([process.execPath, join(serverDir, 'scripts', 'build.mjs'), 'plugins'], {
    cwd: serverDir,
    env: { PLUGINS_OUT: pluginsOut },
  })
  const installed = join(dataDir, 'plugins', 'iopaint')
  await mkdir(installed, { recursive: true })
  await copyFile(join(pluginsOut, 'iopaint', 'index.mjs'), join(installed, 'index.mjs'))
  await copyFile(join(serverDir, 'plugins', 'iopaint', 'manifest.json'), join(installed, 'manifest.json'))
  if (iopaint !== '') {
    await writeFile(join(installed, 'config.json'), `${JSON.stringify({ url: iopaint }, null, 2)}\n`)
  }
}

/** Start the studio and wait until it answers. */
async function startServer() {
  const logFile = await import('node:fs').then(fs => fs.createWriteStream(logPath))
  const child = spawn(process.execPath, ['--enable-source-maps', join(serverDir, 'dist', 'server.mjs')], {
    cwd: serverDir,
    env: {
      ...process.env,
      IMAGINE_CONFIG: join(homeDir, 'config.yaml'),
      IMAGINE_HOME: dataDir,
      IMAGINE_LANGUAGE: language,
      TMPDIR: join(runDir, 'tmp'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(logFile)
  child.stderr.pipe(logFile)
  const base = `http://127.0.0.1:${String(port)}`
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null) {
      const text = await readFile(logPath, 'utf8').catch(() => '')
      throw new Error(`the studio exited (${String(child.exitCode)}) before answering:\n${text.slice(-4_000)}`)
    }
    try {
      const health = await requestJSON(`${base}/api/health`, { timeoutMs: 2_000 })
      if (health?.ok === true) return { child, base }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      const text = await readFile(logPath, 'utf8').catch(() => '')
      throw new Error(`the studio did not answer ${base} in ${String(BOOT_TIMEOUT_MS)} ms:\n${text.slice(-4_000)}`)
    }
    await sleep(500)
  }
}

/** Stop the studio, giving it the graceful path first. */
async function stopServer(child) {
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  const deadline = Date.now() + 10_000
  while (child.exitCode === null && Date.now() < deadline) await sleep(200)
  if (child.exitCode === null) child.kill('SIGKILL')
}

/* ------------------------------------------------------------ fixtures ---- */

/** Poll one run until it stops moving. */
async function waitJob(base, id) {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  for (;;) {
    const job = await requestJSON(`${base}/comfy-imagine/${encodeURIComponent(id)}`, { timeoutMs: 10_000 })
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return job
    if (Date.now() > deadline) throw new Error(`run ${id} did not settle in ${String(JOB_TIMEOUT_MS)} ms`)
    await sleep(POLL_MS)
  }
}

/** Start one run through the studio's own job route and wait for it. */
async function directJob(base, body) {
  const started = await requestJSON(`${base}/comfy-imagine`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 60_000,
  })
  return await waitJob(base, started.id)
}

/** The gallery as the studio lists it, by name. */
async function gallery(base) {
  const listed = await requestJSON(`${base}/comfy-media`, { timeoutMs: 20_000 })
  return new Map((listed.items ?? []).map(item => [item.name, item]))
}

/** The media folder's file of one run. */
function fileOf(job) {
  return job.files?.[0]?.name
}

/** ffprobe's reading of one media file, or undefined when it cannot read it. */
async function probeMedia(path) {
  return await new Promise((resolveDone) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', path], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.on('error', () => resolveDone(undefined))
    child.on('close', (code) => {
      if (code !== 0) { resolveDone(undefined); return }
      try {
        const parsed = JSON.parse(output)
        const stream = (parsed.streams ?? []).find(entry => entry.width !== undefined && entry.height !== undefined)
        const duration = Number(parsed.format?.duration)
        resolveDone({
          ...stream?.width === undefined ? {} : { width: stream.width, height: stream.height },
          ...Number.isFinite(duration) && duration > 0 ? { duration } : {},
        })
      } catch {
        resolveDone(undefined)
      }
    })
  })
}

/**
 * Build the neutral fixtures: one drawn still and the same photo with a printed
 * word, so the erase case has writing that was put there on purpose.
 */
async function makeFixtures(base) {
  log('drawing the neutral fixture (a still life)')
  const stillJob = await directJob(base, {
    action: 'generate',
    prompt: STILL_PROMPT,
    size: STILL_SIZE,
    aspectRatio: '3:2',
    canvasAsked: true,
  })
  if (stillJob.status !== 'done') throw new Error(`the fixture run ended ${stillJob.status}: ${stillJob.error ?? ''}`)
  const still = fileOf(stillJob)
  if (still === undefined) throw new Error('the fixture run made no file')

  const sign = `bench-sign-${Date.now()}.png`
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
  log('putting a printed word on a copy of the fixture')
  await run(['ffmpeg', '-y', '-v', 'error', '-i', join(mediaDir, still), '-vf',
    `drawtext=fontfile=${font}:text='SALE':fontcolor=black:fontsize=72:box=1:boxcolor=white@0.92:boxborderw=22:x=60:y=60`,
    join(mediaDir, sign)])
  return { still, sign }
}

/* --------------------------------------------------------------- cases ---- */

/** The studio's own word for a ratio, nearest common shape. */
const SHAPES = ['1:1', '9:16', '16:9', '3:4', '4:3', '2:3', '3:2', '4:5', '5:4', '21:9']
function ratioOf(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return undefined
  const value = width / height
  let best = SHAPES[0]
  for (const shape of SHAPES) {
    const [w, h] = shape.split(':').map(Number)
    const target = (w ?? 1) / (h ?? 1)
    const bestParts = best.split(':').map(Number)
    const bestValue = (bestParts[0] ?? 1) / (bestParts[1] ?? 1)
    if (Math.abs(Math.log(value / target)) < Math.abs(Math.log(value / bestValue))) best = shape
  }
  return best
}

/** Whether a measured file has the asked shape, within 4%. */
function shapeMatches(width, height, asked) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) return false
  const [w, h] = String(asked).split(':').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h) || (h ?? 0) <= 0) return false
  return Math.abs(Math.log((width / height) / ((w ?? 1) / (h ?? 1)))) < 0.04
}

const ITALIAN = /\b(il|lo|la|i|gli|le|un|una|uno|di|del|della|che|per|con|non|sono|è|ecco|fatto|fatte|fatti|due|tre|quattro|varianti|versioni|questa|questo|foto|immagine|tazza|tavolo|luce|colore|sfondo|scuro|più|anche|come|prima|nella|sulla|della|dal|al|alle|agli)\b/gi
const ENGLISH = /\b(the|a|an|is|are|was|were|of|and|with|this|that|these|those|has|have|had|image|photo|done|here|your|it|its|but|from|into|more|darker|background|light|color|picture)\b/gi

/** The language a reply is written in, from the words it uses. */
function languageOf(text) {
  const italian = (text.match(ITALIAN) ?? []).length + (text.match(/[àèéìòù]/gi) ?? []).length
  const english = (text.match(ENGLISH) ?? []).length
  if (italian + english < 4) return 'unknown'
  if (italian >= english * 1.15) return 'it'
  if (english >= italian * 1.15) return 'en'
  return 'unknown'
}

/** A check's line in the report. */
function check(name, ok, detail = '') {
  return { name, ok, detail }
}

/** The arguments of one recorded tool call, as an object. */
function argumentsOf(call) {
  try {
    const parsed = JSON.parse(call.arguments ?? '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** All the tool calls a recording holds, flattened, with parsed arguments. */
function toolCallsOf(recording) {
  const calls = []
  for (const call of recording.calls) {
    for (const tool of call.response?.toolCalls ?? []) {
      calls.push({ name: tool.name, arguments: tool.arguments, args: argumentsOf(tool), model: call.request?.model })
    }
  }
  return calls
}

/** The tool results the model read: role `tool` messages of the calls made. */
function toolResultsOf(recording) {
  const results = []
  for (const call of recording.calls) {
    for (const message of call.request?.messages ?? []) {
      if (message.role !== 'tool' || typeof message.content !== 'string') continue
      try {
        results.push(JSON.parse(message.content))
      } catch {
        results.push(message.content)
      }
    }
  }
  return results
}

/** The vision instructions this turn reached, with the images removed. */
function visionInstructionsOf(recording) {
  const instructions = []
  for (const call of recording.calls) {
    if (!call.path?.includes('/chat/completions')) continue
    const hasImage = (call.request?.messages ?? []).some(message => String(message.content ?? '').includes('[image '))
    if (!hasImage) continue
    const text = (call.request?.messages ?? []).map(message => String(message.content ?? '')).join('\n')
    instructions.push(text)
  }
  return instructions
}

/** The files a set of runs made, with their real measures. */
async function measurementsOf(base, jobs, extraFiles) {
  const items = await gallery(base)
  const names = []
  for (const job of jobs) for (const file of job.files ?? []) names.push(file.name)
  for (const file of extraFiles ?? []) names.push(file.name)
  const unique = [...new Set(names)]
  return await Promise.all(unique.map(async (name) => {
    const item = items.get(name)
    const probed = await probeMedia(join(mediaDir, name))
    const width = item?.width ?? probed?.width
    const height = item?.height ?? probed?.height
    const duration = item?.duration ?? probed?.duration
    return {
      name,
      kind: item?.kind ?? name.split('.').pop(),
      ...width === undefined ? {} : { width },
      ...height === undefined ? {} : { height },
      ...width === undefined || height === undefined ? {} : { ratio: ratioOf(width, height) },
      ...duration === undefined ? {} : { duration },
      ...item?.size === undefined ? {} : { bytes: item.size },
    }
  }))
}

/** The cases, in the order a person would ask for them. */
function casesOf(fixtures) {
  const still = { name: fixtures.still, kind: 'image' }
  const sign = { name: fixtures.sign, kind: 'image' }
  const base = {
    eraseTool: true,
    history: [],
    staged: [],
    recent: [still],
    model: { provider: providerName, model: modelId },
  }
  const cases = [
    {
      id: 'generate-landscape',
      text: 'genera una foto di una tazza di ceramica bianca su un tavolo di legno chiaro, formato 16:9 a 720p',
      expectedTools: ['generate_image'],
      body: { ...base },
      check: ({ tools, files, jobs }) => {
        const call = tools.find(tool => tool.name === 'generate_image')
        const args = call?.args ?? {}
        const made = files.filter(file => file.kind === 'image')
        return [
          check('tool is generate_image', call !== undefined),
          check('aspect argument is 16:9', String(args.aspect ?? '') === '16:9', JSON.stringify(args)),
          check('resolution argument is 720p', String(args.resolution ?? '') === '720p', JSON.stringify(args)),
          check('one picture', jobs.length === 1 && made.length === 1, `${String(jobs.length)} runs, ${String(made.length)} files`),
          check('real shape is 16:9', made.every(file => shapeMatches(file.width, file.height, '16:9')), JSON.stringify(made)),
          check('short side is 720', made.every(file => Math.min(file.width ?? 0, file.height ?? 0) === 720), JSON.stringify(made)),
          promptIsClean(call, ['formato', '16:9', '720p'], ['tazza', 'tavolo']),
        ].flat()
      },
    },
    {
      id: 'generate-variants',
      text: 'genera due foto in formato 9:16 di una sedia di legno contro una parete bianca',
      expectedTools: ['generate_image'],
      body: { ...base, recent: [] },
      check: ({ tools, files }) => {
        const call = tools.find(tool => tool.name === 'generate_image')
        const args = call?.args ?? {}
        const made = files.filter(file => file.kind === 'image')
        return [
          check('tool is generate_image', call !== undefined),
          check('count argument is 2', Number(args.count) === 2, JSON.stringify(args)),
          check('aspect argument is 9:16', String(args.aspect ?? '') === '9:16', JSON.stringify(args)),
          check('two pictures', made.length === 2, `${String(made.length)} files`),
          check('both are 9:16', made.every(file => shapeMatches(file.width, file.height, '9:16')), JSON.stringify(made)),
          promptIsClean(call, ['due foto', '9:16'], ['sedia', 'parete']),
        ].flat()
      },
    },
    {
      id: 'edit-global',
      text: 'rendi la luce più calda e dorata',
      expectedTools: ['edit_image'],
      body: { ...base, staged: [still] },
      keep: true,
      check: ({ tools, files, jobs }) => {
        const edit = tools.find(tool => tool.name === 'edit_image')
        const relight = tools.find(tool => tool.name === 'run_action' && String(tool.args.action ?? '') === 'relight')
        const call = edit ?? relight
        const args = call?.args ?? {}
        const made = files.filter(file => file.kind === 'image')
        return [
          // A global light change is either the whole-photo edit or the
          // studio's own relight: both are the right work, and relight is the
          // better one when the scene must stay the same.
          check('tool is edit_image or relight', call !== undefined, JSON.stringify(tools.map(tool => tool.name))),
          check('source is the staged photo', args.source === fixtures.still, String(args.source ?? '')),
          check('one edit', jobs.length === 1 && made.length === 1, `${String(jobs.length)} runs`),
          check('result is not the source', made.every(file => file.name !== fixtures.still), JSON.stringify(made.map(file => file.name))),
          check('the change is the light', /luce|calda|dorat|light|warm/i.test(String(args.prompt ?? '')), String(args.prompt ?? '')),
        ].flat()
      },
    },
    {
      id: 'edit-object',
      text: 'cambia il colore della tazza da bianco a blu',
      expectedTools: ['edit_image'],
      body: { ...base, staged: [still] },
      check: ({ tools, files }) => {
        const call = tools.find(tool => tool.name === 'edit_image')
        const args = call?.args ?? {}
        const made = files.filter(file => file.kind === 'image')
        return [
          check('tool is edit_image', call !== undefined),
          check('source is the staged photo', args.source === fixtures.still, String(args.source ?? '')),
          check('the cup is named', `${String(args.target ?? '')} ${String(args.prompt ?? '')}`.toLowerCase().includes('tazza'), JSON.stringify(args)),
          check('the result exists', made.length === 1 && made[0].name !== fixtures.still, JSON.stringify(made)),
        ].flat()
      },
    },
    {
      id: 'edit-background',
      text: 'cambia lo sfondo: metti la tazza davanti a una parete blu',
      expectedTools: ['edit_image'],
      body: { ...base, staged: [still] },
      check: ({ tools, files }) => {
        const call = tools.find(tool => tool.name === 'edit_image')
        const args = call?.args ?? {}
        const made = files.filter(file => file.kind === 'image')
        return [
          check('tool is edit_image', call !== undefined),
          check('source is the staged photo', args.source === fixtures.still, String(args.source ?? '')),
          check('the change is the background', /sfondo|parete|background/i.test(String(args.prompt ?? '')), String(args.prompt ?? '')),
          check('the result exists', made.length === 1 && made[0].name !== fixtures.still, JSON.stringify(made)),
        ].flat()
      },
    },
    {
      id: 'edit-shape',
      text: 'falla 9:16 a 720p',
      expectedTools: ['edit_image'],
      body: { ...base, staged: [still] },
      check: ({ tools, files }) => {
        const call = tools.find(tool => tool.name === 'edit_image')
        const args = call?.args ?? {}
        const made = files.filter(file => file.kind === 'image')
        return [
          check('tool is edit_image', call !== undefined),
          check('aspect argument is 9:16', String(args.aspect ?? '') === '9:16', JSON.stringify(args)),
          check('resolution argument is 720p', String(args.resolution ?? '') === '720p', JSON.stringify(args)),
          check('real shape is 9:16', made.length === 1 && shapeMatches(made[0].width, made[0].height, '9:16'), JSON.stringify(made)),
        ].flat()
      },
    },
    {
      id: 'erase-label',
      text: 'togli la scritta SALE dal cartello',
      expectedTools: ['erase'],
      body: { ...base, staged: [sign] },
      check: ({ tools, files, jobs }) => {
        const call = tools.find(tool => tool.name === 'erase')
        const args = call?.args ?? {}
        return [
          check('tool is erase', call !== undefined),
          check('source is the staged photo', args.source === fixtures.sign, String(args.source ?? '')),
          check('the eraser made a file', jobs.length === 0 && files.length === 1, `${String(jobs.length)} runs, ${String(files.length)} files`),
          check('the result is not the source', files.every(file => file.name !== fixtures.sign)),
        ].flat()
      },
    },
    {
      id: 'animate',
      text: 'anima questa foto a 480p: la luce del mattino si muove lentamente sulla tazza, 5 secondi',
      expectedTools: ['make_video'],
      body: { ...base, staged: [still] },
      keep: true,
      check: ({ tools, files, confirmations }) => {
        const call = tools.find(tool => tool.name === 'make_video')
        const args = call?.args ?? {}
        const clip = files.find(file => file.kind === 'video')
        return [
          check('tool is make_video', call !== undefined),
          check('source is the staged photo', args.source === fixtures.still, String(args.source ?? '')),
          check('five seconds', Number(args.seconds) === 5, JSON.stringify(args)),
          check('no confirmation under the limit', confirmations.length === 0),
          check('a clip exists', clip !== undefined, JSON.stringify(files)),
          check('the clip lasts about 5 s', clip?.duration !== undefined && Math.abs(clip.duration - 5) <= 2, `${String(clip?.duration)} s`),
          check('the clip is 480p', clip?.width !== undefined && Math.min(clip.width, clip.height ?? 0) <= 720, JSON.stringify(clip)),
        ].flat()
      },
    },
    {
      id: 'extend',
      text: 'estendi il video di altri 5 secondi, la luce continua a muoversi',
      expectedTools: ['extend_video'],
      body: null,
      check: ({ tools, files }) => {
        const call = tools.find(tool => tool.name === 'extend_video')
        const args = call?.args ?? {}
        const clip = files.find(file => file.kind === 'video')
        const sourceDuration = extendSource()?.duration
        return [
          check('tool is extend_video', call !== undefined),
          check('source is the clip just made', args.source === extendSource()?.name, String(args.source ?? '')),
          check('five more seconds', Number(args.seconds) === 5, JSON.stringify(args)),
          check('a clip exists', clip !== undefined, JSON.stringify(files)),
          check('the clip is longer than the source', clip?.duration !== undefined && sourceDuration !== undefined && clip.duration > sourceDuration + 2,
            `${String(sourceDuration)} s → ${String(clip?.duration)} s`),
        ].flat()
      },
    },
    {
      id: 'music',
      text: 'fai una musica ambient calma con pianoforte, trenta secondi',
      expectedTools: ['make_music'],
      body: { ...base, recent: [] },
      confirm: true,
      check: ({ tools, files, confirmations, jobs, reply }) => {
        const call = tools.find(tool => tool.name === 'make_music')
        const args = call?.args ?? {}
        const track = files.find(file => file.kind === 'audio')
        return [
          check('tool is make_music', call !== undefined),
          check('the user is asked before the render', confirmations.length > 0),
          check('one audio job', jobs.length === 1, `${String(jobs.length)} runs`),
          check('the style is the user\'s', /ambient|pianoforte/i.test(String(args.prompt ?? '')), String(args.prompt ?? '')),
          check('a track exists', track !== undefined, JSON.stringify(files)),
          check('the track is real audio', track?.duration !== undefined && track.duration > 10, `${String(track?.duration)} s`),
          // The studio asked for 30 s; if the render came back shorter, the
          // reply has to say the measured length, not repeat the request.
          check('the reply reports the length it got',
            track?.duration !== undefined && (Math.abs(track.duration - 30) <= 3
              || new RegExp(String(Math.round(track.duration))).test(reply)
              || /più cort|shorter|non .*30|invece di 30|meno di 30/i.test(reply)),
            `${String(track?.duration)} s — ${reply}`),
        ].flat()
      },
    },
    {
      id: 'memory-darker',
      text: 'come prima ma più scuro',
      expectedTools: ['edit_image'],
      body: null,
      check: ({ tools, files }) => {
        const call = tools.find(tool => tool.name === 'edit_image')
        const args = call?.args ?? {}
        const made = files.filter(file => file.kind === 'image')
        return [
          check('tool is edit_image', call !== undefined),
          check('it edits the previous result', args.source === previousResult('edit-global'), `${String(args.source ?? '')} vs ${String(previousResult('edit-global'))}`),
          check('the change is darker', /scur/i.test(String(args.prompt ?? '')), String(args.prompt ?? '')),
          check('a result exists', made.length === 1, JSON.stringify(made)),
        ].flat()
      },
    },
    {
      id: 'ask-content',
      text: 'cosa c\'è in questa foto?',
      expectedTools: ['look'],
      body: { ...base, staged: [still] },
      check: ({ tools, jobs, files, reply, visions }) => {
        return [
          check('no run was queued', jobs.length === 0 && files.length === 0, `${String(jobs.length)} runs`),
          check('the look tool was used', tools.some(tool => tool.name === 'look'), JSON.stringify(tools.map(tool => tool.name))),
          check('the reply names the cup and the table', /tazza/i.test(reply) && /tavolo/i.test(reply), reply),
          check('no invented marks', !/bande? scur[ae]|watermark|marchio/i.test(reply), reply),
          check('the eyes were asked a targeted question', visions.some(text => /Answer only this question|The user asked:/.test(text)), visions.join('\n').slice(0, 500)),
        ]
      },
    },
    {
      id: 'ask-shape',
      text: 'che formato ha questa foto?',
      expectedTools: ['look', 'project_files', 'job_status'],
      body: { ...base, staged: [still] },
      check: ({ tools, jobs, toolsResults, reply }) => {
        const measured = toolsResults.some((result) => {
          const text = JSON.stringify(result)
          return text.includes('"width"') && text.includes('"height"')
        })
        return [
          check('no run was queued', jobs.length === 0),
          check('a read tool was used', tools.some(tool => ['look', 'project_files', 'job_status'].includes(tool.name)), JSON.stringify(tools.map(tool => tool.name))),
          check('the measurements reached the model', measured, JSON.stringify(toolsResults).slice(0, 600)),
          check('the reply states the measured pixels', /1080/.test(reply) && /720/.test(reply), reply),
          check('the reply does not invent pixels', !/1200|800\s*(px|pixel)/i.test(reply), reply),
          check('the reply does not invent a shape', !/quadrat|vertical|9:16|1:1/i.test(reply), reply),
        ]
      },
    },
    {
      id: 'ambiguous',
      text: 'rendila più bella',
      expectedTools: [],
      body: { ...base, staged: [still] },
      check: ({ tools, jobs, files, reply }) => {
        const writes = tools.filter(tool => ['generate_image', 'edit_image', 'erase', 'run_action'].includes(tool.name))
        return [
          check('nothing was run', jobs.length === 0 && files.length === 0, `${String(jobs.length)} runs`),
          check('no writing tool was called', writes.length === 0, JSON.stringify(writes.map(tool => tool.name))),
          check('the reply asks what to change', /\?|dimmi|cosa vorresti|quale|what would you like|which/i.test(reply), reply),
        ]
      },
    },
    {
      id: 'two-requests',
      text: 'genera una foto di un vaso di fiori gialli su un tavolo bianco a 720p e cambia lo sfondo della tazza in verde',
      expectedTools: ['generate_image', 'edit_image'],
      body: { ...base, staged: [still] },
      check: ({ tools, jobs, actionNames, reply, language, files }) => {
        const calls = tools.filter(tool => ['generate_image', 'edit_image'].includes(tool.name))
        return [
          check('both requests were understood', calls.length >= 2, JSON.stringify(tools.map(tool => tool.name))),
          check('a new picture was drawn', actionNames.includes('generate'), actionNames.join(',')),
          check('the staged photo was edited', actionNames.includes('remix'), actionNames.join(',')),
          check('two runs settled', jobs.length >= 2 && jobs.every(job => job.status === 'done'), jobs.map(job => job.status).join(',')),
          check('the new picture is 720p', files.some(file => file.kind === 'image' && Math.min(file.width ?? 0, file.height ?? 0) === 720), JSON.stringify(files)),
          check('the reply is in Italian', language === 'it', language),
          check('the reply says both happened', /vaso|fiori/i.test(reply) && /sfondo|verde/i.test(reply), reply),
        ]
      },
    },
  ]

  /** The result file a previous case made, for "come prima". */
  function previousResult(id) {
    return results.get(id)?.files?.[0]?.name
  }
  /** The clip the animate case made, for the extend case. */
  function extendSource() {
    return results.get('animate')?.files?.find(file => file.kind === 'video')
  }

  // The two cases that depend on earlier ones are filled here, where the
  // results map exists.
  const extendCase = cases.find(c => c.id === 'extend')
  const memoryCase = cases.find(c => c.id === 'memory-darker')
  if (extendCase !== undefined) {
    extendCase.body = () => ({
      ...base,
      staged: extendSource() === undefined ? [] : [extendSource()],
      recent: [still, ...(extendSource() === undefined ? [] : [extendSource()])],
    })
  }
  if (memoryCase !== undefined) {
    // The history and the file are read when the case runs: they are the
    // previous case's own answer, not what was known when the list was built.
    memoryCase.body = () => {
      const edit = results.get('edit-global')
      const history = edit === undefined
        ? []
        : [
          { role: 'user', text: 'rendi la luce più calda e dorata' },
          { role: 'assistant', text: edit.reply },
        ]
      const previous = previousResult('edit-global')
      return {
        ...base,
        staged: previous === undefined ? [] : [{ name: previous, kind: 'image' }],
        history,
      }
    }
  }
  return cases
}

/** The prompt checks: no studio order in the drawn words, the subject kept. */
function promptIsClean(call, forbidden, mustInclude) {
  if (call === undefined) return [check('prompt is the user\'s words', false, 'no call')]
  const prompt = String(call.args.prompt ?? '')
  const leaked = forbidden.filter(word => prompt.toLowerCase().includes(word.toLowerCase()))
  const missing = mustInclude.filter(word => !prompt.toLowerCase().includes(word.toLowerCase()))
  return [
    check('prompt keeps the subject', missing.length === 0, `missing: ${missing.join(', ')} — prompt: ${prompt}`),
    check('prompt has no studio order', leaked.length === 0 && !/^(genera|crea|fammi|modifica|anima|estendi|rendi|cambia|togli)\b/i.test(prompt),
      `leaked: ${leaked.join(', ')} — prompt: ${prompt}`),
  ]
}

/* --------------------------------------------------------------- report --- */

const results = new Map()

/** Run the whole bench and write both reports. */
async function main() {
  log(`run folder: ${runDir}`)
  const proxy = createRecordingProxy(gateway)
  const proxyBase = await proxy.start()
  log(`recording proxy: ${proxyBase} → ${gateway}`)
  let server
  try {
    await build(join(runDir, 'plugins-built'))
    await writeConfig(proxyBase)
    server = await startServer()
    log(`studio: ${server.base}`)
    const setup = await requestJSON(`${server.base}/setup-status`, { timeoutMs: 20_000 })
    if (setup.comfy?.ok !== true) log(`warning: ComfyUI is not answering (${JSON.stringify(setup.comfy)})`)
    if (setup.output?.ok !== true) log(`warning: the media folder is not writable (${JSON.stringify(setup.output)})`)

    const fixtures = await makeFixtures(server.base)
    log(`fixtures: ${fixtures.still}, ${fixtures.sign}`)
    log('the cases start now; a slower render is normal')

    const all = casesOf(fixtures)
    const selected = only.length === 0 ? all : all.filter(entry => only.includes(entry.id))
    for (const entry of selected) {
      const started = Date.now()
      log(`${entry.id}: "${entry.text}"`)
      proxy.begin(entry.id)
      let answer
      const confirmations = []
      let error
      try {
        const body = { ...(typeof entry.body === 'function' ? entry.body() : entry.body), text: entry.text }
        answer = await ask(server.base, body)
        if (answer.pending !== undefined && entry.confirm !== false) {
          confirmations.push({ tool: answer.pending.tool, summary: answer.pending.summary })
          answer = await ask(server.base, {
            confirmation: { token: answer.pending.token, accept: true },
            history: [],
            staged: [],
            recent: [],
            model: { provider: providerName, model: modelId },
          })
          if (answer.pending !== undefined) confirmations.push({ tool: answer.pending.tool, summary: answer.pending.summary, unanswered: true })
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
        answer = undefined
      }
      const recording = await proxy.end()
      const elapsedMs = Date.now() - started
      const tools = toolCallsOf(recording)
      const toolResults = toolResultsOf(recording)
      const visions = visionInstructionsOf(recording)
      const jobIds = [...new Set([...(answer?.jobIds ?? []), ...confirmations.flatMap(entry => entry.jobIds ?? [])])]
      const jobs = []
      for (const id of jobIds) {
        try {
          jobs.push(await waitJob(server.base, id))
        } catch (caught) {
          jobs.push({ id, status: 'error', error: caught instanceof Error ? caught.message : String(caught) })
        }
      }
      const files = await measurementsOf(server.base, jobs, answer?.files ?? [])
      const reply = answer?.reply ?? ''
      const languageSeen = languageOf(reply)
      const data = {
        id: entry.id,
        text: entry.text,
        expectedTools: entry.expectedTools,
        reply,
        language: languageSeen,
        languageOk: languageSeen === language,
        elapsedMs,
        mode: answer?.mode,
        jobIds,
        jobs: jobs.map(job => ({
          id: job.id,
          action: job.action,
          status: job.status,
          prompt: job.prompt,
          source: job.source,
          ...job.seconds === undefined ? {} : { seconds: job.seconds },
          ...job.aspectRatio === undefined ? {} : { aspectRatio: job.aspectRatio },
          ...job.size === undefined ? {} : { size: job.size },
          ...job.error === undefined ? {} : { error: job.error },
        })),
        files,
        tools: tools.map(tool => ({ name: tool.name, args: tool.args })),
        confirmations,
        checks: [],
        error,
        trace: join(caseDir, `${entry.id}.trace.json`),
      }
      try {
        const checks = entry.check({
          tools,
          jobs,
          files,
          actionNames: jobs.map(job => job.action),
          reply,
          language: languageSeen,
          confirmations,
          toolsResults: toolResults,
          visions,
        })
        data.checks = checks
        data.pass = error === undefined && checks.every(item => item.ok) && (languageSeen === language || languageSeen === 'unknown')
      } catch (caught) {
        data.checks = [check('the automatic checks ran', false, caught instanceof Error ? caught.message : String(caught))]
        data.pass = false
      }
      results.set(entry.id, data)
      await writeFile(data.trace, JSON.stringify({ calls: recording.calls }, null, 2))
      log(`${entry.id}: ${data.pass ? 'PASS' : 'FAIL'} in ${(elapsedMs / 1000).toFixed(1)} s — ${tools.map(tool => tool.name).join(', ') || 'no tool'}`)
    }
  } finally {
    if (server !== undefined && !keepServer) await stopServer(server.child)
    await proxy.stop()
    const report = reportOf()
    await writeFile(reportPath, report)
    await writeFile(jsonPath, JSON.stringify({ run: runInfo(), cases: [...results.values()] }, null, 2))
    log(`report: ${reportPath}`)
    log(`json:   ${jsonPath}`)
    if (clean) await rm(runDir, { recursive: true, force: true })
  }
}

/** One agent turn, with the interface language and the model the composer shows. */
async function ask(base, body) {
  return await requestJSON(`${base}/comfy-imagine/agent`, {
    method: 'POST',
    headers: { 'x-app-language': language },
    body: JSON.stringify({
      ...body,
      model: body.model ?? { provider: providerName, model: modelId },
    }),
    timeoutMs: TURN_TIMEOUT_MS,
  })
}

/** What the report says the run was. */
function runInfo() {
  return {
    startedAt: new Date().toISOString(),
    gateway,
    comfy,
    model: modelId,
    language,
    serverDir,
    runDir,
  }
}

/** The Markdown report: one table and the detail of every case. */
function reportOf() {
  const cases = [...results.values()]
  const passed = cases.filter(entry => entry.pass).length
  const lines = []
  lines.push('# Agent chat bench', '')
  lines.push(`Model \`${modelId}\` through \`${gateway}\`, ComfyUI \`${comfy}\`, language \`${language}\`.`)
  lines.push(`Cases: **${String(cases.length)}**, passed: **${String(passed)}**, failed: **${String(cases.length - passed)}**.`)
  lines.push('', '| # | Case | Expected | Tool(s) | Reply language | Result | Time |', '|---|---|---|---|---|---|---|')
  cases.forEach((entry, index) => {
    const tools = [...new Set(entry.tools.map(tool => tool.name))].join(', ') || '—'
    const outcome = entry.error === undefined
      ? entry.files.map(file => `${file.name}${file.ratio === undefined ? '' : ` ${file.ratio}`}${file.duration === undefined ? '' : ` ${file.duration.toFixed(1)} s`}`).join('<br>') || '—'
      : entry.error
    lines.push(`| ${String(index + 1)} | ${entry.id} | ${entry.expectedTools.join(', ') || 'none'} | ${tools} | ${entry.language}${entry.languageOk ? '' : ' ✗'} | ${entry.pass ? 'PASS' : 'FAIL'} — ${outcome} | ${(entry.elapsedMs / 1000).toFixed(1)} s |`)
  })
  for (const entry of cases) {
    lines.push('', `## ${entry.id}`, '', `> ${entry.text}`, '')
    lines.push(`- Expected: ${entry.expectedTools.join(', ') || 'no tool'}`)
    lines.push(`- Reply (${entry.language}): ${entry.reply || '—'}`)
    lines.push(`- Time: ${(entry.elapsedMs / 1000).toFixed(1)} s`)
    if (entry.error !== undefined) lines.push(`- Error: ${entry.error}`)
    if (entry.confirmations.length > 0) lines.push(`- Confirmations: ${entry.confirmations.map(item => item.summary).join('; ')}`)
    if (entry.tools.length > 0) {
      lines.push('', 'Calls:', '')
      for (const tool of entry.tools) {
        lines.push(`- \`${tool.name}\` ${JSON.stringify(tool.args)}`)
      }
    }
    if (entry.files.length > 0) {
      lines.push('', 'Made:', '')
      for (const file of entry.files) {
        lines.push(`- \`${file.name}\` ${file.kind} ${file.width ?? '?'}×${file.height ?? '?'}${file.ratio === undefined ? '' : ` (${file.ratio})`}${file.duration === undefined ? '' : `, ${file.duration.toFixed(2)} s`}`)
      }
    }
    lines.push('', 'Checks:', '')
    for (const item of entry.checks) {
      lines.push(`- ${item.ok ? '✓' : '✗'} ${item.name}${item.detail === '' ? '' : ` — ${item.detail}`}`)
    }
    lines.push('', `Trace: \`${entry.trace}\``)
  }
  lines.push('', '## What the run did not prove', '')
  lines.push('- The language check is a word heuristic, not a language detector.')
  lines.push('- A rendered file is judged by its real shape and duration, not by looking at its pixels.')
  lines.push('- The erase case checks that a new file exists and differs; it does not prove the word is gone.')
  return `${lines.join('\n')}\n`
}

try {
  await main()
} catch (error) {
  console.error(`[bench] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
}
