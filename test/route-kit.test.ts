/**
 * The route helpers every handler shares: the rest of a prefix route's path,
 * the client's language, and the data root's environment variables.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { languageOf, restOf } from '../server/src/route-kit.ts'

const run = promisify(execFile)

/** A request with a URL and headers, and a response that records its status. */
function fake(url: string, headers: Record<string, string> = {}): { req: IncomingMessage; res: ServerResponse; sent: () => number | undefined } {
  let status: number | undefined
  const req = { url, headers, method: 'GET' } as unknown as IncomingMessage
  const res = {
    req,
    writeHead(code: number) { status = code; return this },
    end() { return this },
  } as unknown as ServerResponse
  return { req, res, sent: () => status }
}

test('restOf decodes the path after the prefix, without the leading slash', () => {
  assert.equal(restOf(fake('/comfy-imagine').req, fake('/').res, '/comfy-imagine'), '')
  const { req, res, sent } = fake('/comfy-imagine/workflows/a%20b?x=1')
  assert.equal(restOf(req, res, '/comfy-imagine'), 'workflows/a b')
  assert.equal(sent(), undefined)
})

test('restOf answers 400 for a path that cannot be decoded', () => {
  const { req, res, sent } = fake('/comfy-imagine/%E0%A4%A')
  assert.equal(restOf(req, res, '/comfy-imagine'), undefined)
  assert.equal(sent(), 400)
})

test('languageOf reads a well-formed x-app-language and nothing else', () => {
  assert.equal(languageOf(fake('/', { 'x-app-language': 'en' }).req), 'en')
  assert.equal(languageOf(fake('/', { 'x-app-language': 'pt-BR' }).req), 'pt-BR')
  assert.equal(languageOf(fake('/', { 'x-app-language': 'english' }).req), undefined)
  assert.equal(languageOf(fake('/').req), undefined)
})

/**
 * The variables `os.homedir()` reads: `HOME` on POSIX, `USERPROFILE` on
 * Windows. A test that sets only `HOME` reads the runner's real profile there,
 * because the child process inherits `USERPROFILE`.
 * @param home - the folder the test wants to be the home.
 * @returns the environment entries for this platform.
 */
function homeEnv(home: string): Record<string, string> {
  return process.platform === 'win32' ? { HOME: home, USERPROFILE: home } : { HOME: home }
}

/** The data root a fresh process resolves under this environment. */
async function rootUnder(env: Record<string, string | undefined>): Promise<string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, IMAGINE_HOME: undefined, DSH_HOME: undefined, ...env })) {
    if (value !== undefined) clean[key] = value
  }
  const { stdout } = await run(process.execPath, [
    '--experimental-transform-types', '--input-type=module', '-e',
    "const { dataPath } = await import('./server/vendor/home-paths/index.ts'); process.stdout.write(dataPath())",
  ], { env: clean })
  return stdout
}

test('the data root: IMAGINE_HOME, else ~/.imagine', async () => {
  const home = await mkdtemp(join(tmpdir(), 'imagine-home-'))
  try {
    // An absolute path of this platform: `/srv/a` is not one on Windows.
    const srvA = join(home, 'srv-a')
    const srvB = join(home, 'srv-b')
    assert.equal(await rootUnder({ ...homeEnv(home), IMAGINE_HOME: srvA }), srvA)
    // A blank variable is unset, not the working directory.
    assert.equal(await rootUnder({ ...homeEnv(home), IMAGINE_HOME: '  ' }), join(home, '.imagine'))
    assert.equal(await rootUnder(homeEnv(home)), join(home, '.imagine'))
    // The DSH names are gone: neither the variable nor an old ~/.dsh is read.
    await mkdir(join(home, '.dsh'))
    assert.equal(await rootUnder({ ...homeEnv(home), DSH_HOME: srvB }), join(home, '.imagine'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
