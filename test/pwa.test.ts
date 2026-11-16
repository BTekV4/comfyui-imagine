/**
 * The installed-app side: the manifest the browser reads, the icons it draws,
 * and the one rule the service worker must not break — the studio's data is
 * never served from a cache.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PUBLIC = 'web/public'

interface Icon { readonly src: string; readonly sizes: string; readonly purpose?: string }
interface Manifest {
  readonly name: string
  readonly short_name: string
  readonly start_url: string
  readonly scope: string
  readonly display: string
  readonly background_color: string
  readonly theme_color: string
  readonly icons: readonly Icon[]
  readonly shortcuts?: readonly { readonly name: string; readonly url: string }[]
}

const manifest = (): Manifest =>
  JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as Manifest

/** Width and height from a PNG's IHDR, so a renamed file cannot pass a size test. */
function pngSize(path: string): { width: number; height: number } {
  const data = readFileSync(path)
  assert.equal(data.subarray(1, 4).toString('ascii'), 'PNG', `${path} is not a PNG`)
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

test('the manifest says what an install needs', () => {
  const m = manifest()
  assert.equal(m.start_url, '/')
  assert.equal(m.scope, '/')
  assert.equal(m.display, 'standalone')
  assert.ok(m.name.length > 0 && m.short_name.length <= 12, 'a short name fits under an icon')
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i)
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i)
})

test('every icon it names exists, at the size it claims', () => {
  const m = manifest()
  for (const icon of m.icons) {
    const file = join(PUBLIC, icon.src.replace(/^\//, ''))
    assert.ok(existsSync(file), `${icon.src} is missing`)
    const { width, height } = pngSize(file)
    assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} is ${width}x${height}`)
  }
  assert.ok(m.icons.some(icon => icon.sizes === '192x192'), 'the phone icon is the 192')
  assert.ok(m.icons.some(icon => icon.sizes === '512x512'), 'the store icon is the 512')
  // Android crops what it is given: without a maskable icon the launch screen
  // puts the mark in a letterboxed square.
  assert.ok(m.icons.some(icon => icon.purpose === 'maskable'), 'no maskable icon')
})

test('the shortcuts go where the pages actually are', () => {
  for (const shortcut of manifest().shortcuts ?? []) {
    assert.match(shortcut.url, /^\/([a-z-]+)?$/, `${shortcut.url} is not a page path`)
  }
})

test('the page declares the manifest and the platform meta', () => {
  const html = readFileSync('web/index.html', 'utf8')
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/)
  assert.match(html, /apple-mobile-web-app-capable/)
  assert.match(html, /rel="icon"[^>]*sizes="192x192"/)
})

test('the service worker is registered in the built page only', () => {
  const main = readFileSync('web/src/main.tsx', 'utf8')
  assert.match(main, /import\.meta\.env\.PROD/, 'a dev server has no sw.js to register')
  assert.match(main, /serviceWorker\.register\('\/sw\.js'\)/)
})

test("the worker never answers the studio's own data from the cache", () => {
  const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8')
  // The worker's own regex, read from the file: a list of paths in a test
  // would stop matching the day someone adds one to the worker and not here.
  const literal = /const LIVE = (\/(?:[^/\\]|\\.)+\/)/.exec(sw)?.[1]
  assert.ok(literal, 'the worker has no LIVE pattern')
  const isLive = (path: string): boolean => new RegExp(literal.slice(1, -1)).test(path)
  for (const path of [
    '/comfy-imagine',
    '/comfy-media/photo.png',
    '/api/thinking-levels',
    '/setup-status',
    '/plugins',
    '/plugin/instagram/status',
    '/sw.js',
    '/manifest.webmanifest',
  ]) {
    assert.ok(isLive(path), `${path} would be answered from the cache`)
  }
  for (const path of ['/', '/assets/index-abc123.js', '/icon-192.png', '/library', '/media']) {
    assert.ok(!isLive(path), `${path} would not be cached`)
  }
  // And the shell it precaches holds no data either.
  const shell = /const SHELL = \[([\s\S]*?)\]/.exec(sw)?.[1] ?? ''
  assert.ok(shell.includes("'/'"), 'the shell caches the page')
  assert.ok(!/comfy-|setup-status|plugins/.test(shell), 'the shell caches data')
})
