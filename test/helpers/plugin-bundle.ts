/**
 * The TypeScript plugins built once per test run, for every test file that
 * needs a bundle.
 *
 * Three files (plugin-build, example-plugin, instagram-plugin) each ran
 * `node scripts/build.mjs plugins` into their own temporary folder until
 * 2026-11-15, so one `npm test` bundled every plugin three times. node:test
 * runs each file in its own process, at the same time, so the build is shared
 * through the file system:
 *
 * - the folder is keyed by the test runner (the parent process), so every
 *   file of one run finds the same folder and a new run never reuses an old
 *   build;
 * - the first process to create `lock/` builds; the others wait for
 *   `done.json` (the build's stdout) or `failed.json` (its error);
 * - folders left by runners that have exited are removed when a later run
 *   starts.
 *
 * Outside the test runner (a file run with plain `node`) there is no run to
 * share, and the build goes to a private temporary folder, as before.
 *
 * The bundles are written under the OS temporary folder (`PLUGINS_OUT`), so
 * running the tests never rewrites files in the working tree.
 * @module test/helpers/plugin-bundle
 */
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

const PREFIX = 'imagine-test-plugins-'
/** The build's own limit, as each file had it. */
const BUILD_TIMEOUT_MS = 60_000
/** How long a waiting file gives the building one, past the build's own limit. */
const WAIT_MS = BUILD_TIMEOUT_MS + 30_000

/** Where the bundles are, and what the build printed. */
export interface PluginBundles {
  /** `<out>/<id>/index.mjs` for every TypeScript plugin. */
  readonly out: string
  readonly stdout: string
}

/**
 * The bundle of one plugin.
 * @param bundles - the build.
 * @param id - the plugin's id.
 * @returns the path of its `index.mjs`.
 */
export function bundleOf(bundles: PluginBundles, id: string): string {
  return join(bundles.out, id, 'index.mjs')
}

/**
 * Whether a process is still running.
 * @param pid - the process id.
 * @returns false only when the process is known to be gone.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * The test runner's identity: its pid, and on Linux its start time, so a
 * reused pid is not mistaken for the same run.
 * @returns a name part, or undefined outside the test runner.
 */
async function runnerKey(): Promise<string | undefined> {
  if (process.env.NODE_TEST_CONTEXT === undefined) return undefined
  const pid = process.ppid
  const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => undefined)
  // Field 22 is the start time; the command name (field 2) may hold spaces, so count after its ')'.
  const started = stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  return started === undefined ? String(pid) : `${String(pid)}-${started}`
}

/** Removes the shared folders of runners that have exited. */
async function sweep(): Promise<void> {
  const names = await readdir(tmpdir()).catch(() => [] as string[])
  await Promise.all(names.filter(name => name.startsWith(PREFIX)).map(async name => {
    const pid = Number(name.slice(PREFIX.length).split('-')[0])
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) {
      await rm(join(tmpdir(), name), { recursive: true, force: true }).catch(() => undefined)
    }
  }))
}

/**
 * Writes a marker whole: a reader polling for it never sees half a file.
 * @param path - the marker.
 * @param content - what it says.
 * @returns nothing.
 */
async function writeMarker(path: string, content: unknown): Promise<void> {
  await writeFile(`${path}.${String(process.pid)}.tmp`, JSON.stringify(content))
  await rename(`${path}.${String(process.pid)}.tmp`, path)
}

/**
 * Runs the plugins build into `out`.
 * @param out - the folder the bundles go to.
 * @returns what the build printed.
 */
async function build(out: string): Promise<string> {
  const { stdout } = await run(process.execPath, ['scripts/build.mjs', 'plugins'], {
    timeout: BUILD_TIMEOUT_MS,
    env: { ...process.env, PLUGINS_OUT: out },
  })
  return stdout
}

/**
 * Builds the plugins, or waits for the file of this run that does.
 * @returns the bundles.
 */
async function buildOnce(): Promise<PluginBundles> {
  const key = await runnerKey()
  if (key === undefined) {
    const out = await mkdtemp(join(tmpdir(), 'imagine-plugins-'))
    process.once('exit', () => { rmSync(out, { recursive: true, force: true }) })
    return { out, stdout: await build(out) }
  }
  await sweep()
  const shared = join(tmpdir(), `${PREFIX}${key}`)
  const out = join(shared, 'build')
  const done = join(shared, 'done.json')
  const failed = join(shared, 'failed.json')
  await mkdir(shared, { recursive: true })
  const builder = await mkdir(join(shared, 'lock')).then(() => true, (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  })
  if (builder) {
    try {
      const stdout = await build(out)
      await writeMarker(done, { stdout })
      return { out, stdout }
    } catch (error: unknown) {
      await writeMarker(failed, { message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    const finished = await readFile(done, 'utf8').catch(() => undefined)
    if (finished !== undefined) return { out, stdout: (JSON.parse(finished) as { stdout: string }).stdout }
    const broken = await readFile(failed, 'utf8').catch(() => undefined)
    if (broken !== undefined) throw new Error(`plugins build failed: ${(JSON.parse(broken) as { message: string }).message}`)
    await sleep(100)
  }
  throw new Error(`plugins build not finished after ${String(WAIT_MS / 1000)} s (${shared})`)
}

let pending: Promise<PluginBundles> | undefined

/**
 * The plugins built for this test run. The first call starts (or joins) the
 * build; later calls in the same file get the same promise.
 * @returns the bundles.
 */
export function builtPlugins(): Promise<PluginBundles> {
  if (pending === undefined) {
    pending = buildOnce()
    // Observed here so a failed build is reported by the first test that awaits it, not as an unhandled rejection.
    pending.catch(() => undefined)
  }
  return pending
}
