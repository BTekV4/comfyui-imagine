/**
 * The studio's covers: the one the user set wins over the repo's.
 *
 * The personal file lives in `<data>/covers/<key>.webp`, that is OUTSIDE the
 * served folder (webDir): the check that a path does not leave the served
 * folder must be made against the folder being searched, otherwise it drops
 * the override and the page's `index.html` arrives instead of the image, typed
 * `text/html`. That is what happened on 2026-11-04: the personal covers were
 * in place but were not served.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const root = await mkdtemp(join(tmpdir(), 'imagine-static-'))
const webDir = join(root, 'web')
const dataDir = join(root, 'data')
const personalCover = Buffer.from('the cover the user chose, this one wins')
const repoCover = Buffer.from('the repo cover')
const page = '<!doctype html><title>Imagine</title>'
/*
 * A video cover: it must win over the repo image even at an address ending in
 * `.webp` (the name the repo uses for the same action), be served in ranges,
 * and leave the repo image as the poster when asked for with `?repo=1`.
 */
const repoReel = Buffer.from('the repo cover, which stays the poster')
const personalReel = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from('isomiso2avc1mp41', 'ascii'),
  Buffer.from('fake video bytes', 'ascii'),
])
/** The personal poster of a video cover: a webp with the RIFF signature. */
const personalPoster = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'ascii'),
  Buffer.from('fake poster', 'ascii'),
])
const personalPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake png', 'ascii'),
])

await mkdir(join(webDir, 'imagine'), { recursive: true })
await mkdir(join(webDir, 'assets'), { recursive: true })
await mkdir(join(dataDir, 'covers'), { recursive: true })
await writeFile(join(webDir, 'index.html'), page)
await writeFile(join(webDir, 'imagine', 'video.webp'), repoCover)
await writeFile(join(webDir, 'imagine', 'recreate.webp'), Buffer.from('only in the repo'))
await writeFile(join(dataDir, 'covers', 'video.webp'), personalCover)
await writeFile(join(webDir, 'imagine', 'reel.webp'), repoReel)
await writeFile(join(webDir, 'imagine', 'eyes.webp'), Buffer.from('the repo eyes'))
await writeFile(join(dataDir, 'covers', 'reel.mp4'), personalReel)
await writeFile(join(dataDir, 'covers', 'reel.poster.webp'), personalPoster)
await writeFile(join(dataDir, 'covers', 'eyes.png'), personalPng)

// `dataPath` reads the data root when the module loads, so it is set first.
process.env.IMAGINE_HOME = dataDir
const { serveStatic } = await import('../server/src/static.ts')

const server = createServer((req, res) => {
  void serveStatic(webDir, req, res, new URL(req.url ?? '/', 'http://x').pathname)
})
await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const port = (server.address() as AddressInfo).port
const get = (path: string): Promise<Response> => fetch(`http://127.0.0.1:${String(port)}${path}`)

after(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  await rm(root, { recursive: true, force: true })
})

test('the personal cover, which lives in the data folder, is served', async () => {
  const response = await get('/imagine/video.webp')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/webp')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), personalCover)
})

test('a cover that is in the repo but not in the data stays the repo one', async () => {
  const response = await get('/imagine/recreate.webp')
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from('only in the repo'))
})

test('a cover that exists nowhere is a 404, not the page', async () => {
  // The page under a .webp address went out with the covers' day of cache:
  // the browser kept a broken image for 24 hours (2026-11-15).
  const response = await get('/imagine/never-existed.webp')
  assert.equal(response.status, 404)
})

test('/imagine/post/<id> is still a route of the page', async () => {
  const response = await get('/imagine/post/abc123')
  assert.equal(response.status, 200)
  assert.equal(await response.text(), page)
})

test('a missing build asset is a 404, not the page', async () => {
  const response = await get('/assets/never-existed.js')
  assert.equal(response.status, 404)
})

test('a video cover wins over the repo image, even at a .webp address', async () => {
  const response = await get('/imagine/reel.webp')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'video/mp4')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), personalReel)
})

test('the same cover is also served when asked for with its own extension', async () => {
  const response = await get('/imagine/reel.mp4')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'video/mp4')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), personalReel)
})

test('a video is served in ranges: 206, content-range and accept-ranges', async () => {
  const response = await fetch(`http://127.0.0.1:${String(port)}/imagine/reel.webp`, { headers: { range: 'bytes=0-7' } })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), `bytes 0-7/${String(personalReel.length)}`)
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.headers.get('content-length'), '8')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), personalReel.subarray(0, 8))
})

test('a range starting past the end is a 416', async () => {
  const response = await fetch(`http://127.0.0.1:${String(port)}/imagine/reel.webp`, { headers: { range: 'bytes=999999-' } })
  assert.equal(response.status, 416)
  assert.equal(response.headers.get('content-range'), `bytes */${String(personalReel.length)}`)
})

test('?repo=1 serves the repo image: it is the card\'s fallback poster', async () => {
  const response = await get('/imagine/reel.webp?repo=1')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/webp')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), repoReel)
})

test('a PNG cover is served by key, with its type', async () => {
  const response = await get('/imagine/eyes.webp')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), personalPng)
})

test('?poster=1 serves the personal poster of the video cover', async () => {
  const response = await get('/imagine/reel.webp?poster=1')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/webp')
  assert.equal(response.headers.get('cache-control'), 'no-cache')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), personalPoster)
})

test('?poster=1 without a personal poster falls back to the repo image', async () => {
  // The "video" key has a personal cover but no poster: the answer is the
  // repo image, as the old `?repo=1` did.
  const response = await get('/imagine/video.webp?poster=1')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/webp')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), repoCover)
})

test('the personal poster is not a cover: the key stays a single one', async () => {
  // `reel` keeps serving the video: the `.poster.webp` file is not part of the
  // lookup by key (`reel.poster` does not have the shape of a key).
  const cover = await get('/imagine/reel.webp')
  assert.equal(cover.headers.get('content-type'), 'video/mp4')
  const poster = await get('/imagine/reel.poster.webp')
  assert.equal(poster.status, 404)
})
