/**
 * The TypeScript plugins' build: a plugin is an `index.mjs` the loader imports
 * from `<data>/plugins/<id>/`, so the bundle must stand on its own — Node
 * builtins only, no relative imports that would not resolve there.
 *
 * The bundle is written to a temporary folder (`PLUGINS_OUT`), so running the
 * tests never rewrites files in the working tree. The build is shared with the
 * other test files that need a bundle (helpers/plugin-bundle.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { builtPlugins, bundleOf } from './helpers/plugin-bundle.ts'

const built = builtPlugins()
/** The Instagram bundle, once the build is done. */
const bundlePath = async (): Promise<string> => bundleOf(await built, 'instagram')

test('build:plugins builds the Instagram plugin bundle', async () => {
  const { stdout } = await built
  assert.match(stdout, /plugin instagram: index\.mjs/)
  const info = await stat(await bundlePath())
  assert.ok(info.size > 20_000, `bundle too small: ${String(info.size)} bytes`)
})

test('the bundle imports only Node builtins: the rest is inlined', async () => {
  const text = await readFile(await bundlePath(), 'utf8')
  const specifiers = [...text.matchAll(/(?:^|[;\s])import\s*(?:[^'"]*?from\s*)?["']([^"']+)["']/g)].map(match => match[1] ?? '')
  assert.ok(specifiers.length > 0, 'the bundle has its builtin imports')
  for (const specifier of specifiers) {
    assert.match(specifier, /^node:/, `non-builtin import: ${specifier}`)
  }
})

test('the bundle exports setup, as the contract requires', async () => {
  const module = await import(pathToFileURL(await bundlePath()).href) as { default?: unknown }
  assert.equal(typeof module.default, 'function')
})
