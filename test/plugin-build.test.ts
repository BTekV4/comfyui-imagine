/**
 * The TypeScript plugins' build: a plugin is an `index.mjs` the loader imports
 * from `<data>/plugins/<id>/`, so the bundle must stand on its own — Node
 * builtins only, no relative imports that would not resolve there.
 *
 * The bundle is written to a temporary folder (`PLUGINS_OUT`), so running the
 * tests never rewrites files in the working tree.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const out = await mkdtemp(join(tmpdir(), 'imagine-plugins-'))
const bundle = join(out, 'instagram', 'index.mjs')

after(async () => { await rm(out, { recursive: true, force: true }) })

test('build:plugins builds the Instagram plugin bundle', async () => {
  const { stdout } = await run(process.execPath, ['scripts/build.mjs', 'plugins'], {
    timeout: 60_000,
    env: { ...process.env, PLUGINS_OUT: out },
  })
  assert.match(stdout, /plugin instagram: index\.mjs/)
  const info = await stat(bundle)
  assert.ok(info.size > 20_000, `bundle too small: ${String(info.size)} bytes`)
})

test('the bundle imports only Node builtins: the rest is inlined', async () => {
  const text = await readFile(bundle, 'utf8')
  const specifiers = [...text.matchAll(/(?:^|[;\s])import\s*(?:[^'"]*?from\s*)?["']([^"']+)["']/g)].map(match => match[1] ?? '')
  assert.ok(specifiers.length > 0, 'the bundle has its builtin imports')
  for (const specifier of specifiers) {
    assert.match(specifier, /^node:/, `non-builtin import: ${specifier}`)
  }
})

test('the bundle exports setup, as the contract requires', async () => {
  const module = await import(pathToFileURL(bundle).href) as { default?: unknown }
  assert.equal(typeof module.default, 'function')
})
