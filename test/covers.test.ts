/**
 * Covers: the content decides the type, and a key has a single file.
 *
 * An upload writes `<data>/covers/<key>.<extension>`; since 2026-11-04 it can be
 * a short video, and the case that matters is replacement: an mp4 put in place
 * of a webp must not leave the two files competing for the name.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { COVER_MAX_BYTES, COVER_TYPES, coverTypeOfBytes, coverTypeOfName } from '../shared/cover-kinds.ts'
import { coverFileOf, coverIndex, coverKeyOf, listCoverFiles, removeCoverFiles, storeCover } from '../server/src/covers.ts'
import { message } from '../server/src/messages.ts'

/** A fake mp4: the box and the `ftyp` every player looks at are enough. */
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom', 'ascii'), Buffer.from('rest of the file', 'ascii')])
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake webm', 'ascii')])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png', 'ascii')])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg', 'ascii')])
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ', 'ascii'), Buffer.from('fake webp', 'ascii')])

const root = await mkdtemp(join(tmpdir(), 'imagine-covers-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

test('the cover type is recognised from the first bytes', () => {
  assert.deepEqual(coverTypeOfBytes(MP4), { ext: '.mp4', kind: 'video', mime: 'video/mp4' })
  assert.deepEqual(coverTypeOfBytes(WEBM), { ext: '.webm', kind: 'video', mime: 'video/webm' })
  assert.deepEqual(coverTypeOfBytes(PNG), { ext: '.png', kind: 'image', mime: 'image/png' })
  assert.deepEqual(coverTypeOfBytes(JPEG), { ext: '.jpg', kind: 'image', mime: 'image/jpeg' })
  assert.deepEqual(coverTypeOfBytes(WEBP), { ext: '.webp', kind: 'image', mime: 'image/webp' })
})

test('a file that is neither image nor video has no type', () => {
  assert.equal(coverTypeOfBytes(Buffer.from('plain text, no signature')), undefined)
  assert.equal(coverTypeOfBytes(Buffer.alloc(0)), undefined)
  // A PNG with a wrong first byte does not pass as PNG.
  assert.equal(coverTypeOfBytes(Buffer.concat([Buffer.from([0x88]), PNG.subarray(1)])), undefined)
})

test('the upload cap is the declared one', () => {
  assert.equal(COVER_MAX_BYTES, 20 * 1024 * 1024)
  assert.equal(COVER_TYPES.length, 5)
})

test('a name\'s extension tells the type, a key does not', () => {
  assert.equal(coverTypeOfName('video.mp4')?.kind, 'video')
  assert.equal(coverTypeOfName('generate.WEBP')?.kind, 'image')
  assert.equal(coverTypeOfName('no-extension'), undefined)
  assert.equal(coverKeyOf('video'), 'video')
  assert.equal(coverKeyOf('../outside'), undefined)
  assert.equal(coverKeyOf('Video'), undefined)
})

test('an upload is saved with the content\'s extension', async () => {
  const dir = join(root, 'save')
  const stored = await storeCover(dir, 'video', MP4)
  assert.equal(stored.ok, true)
  if (!stored.ok) return
  assert.equal(stored.type.ext, '.mp4')
  assert.equal(stored.file, join(dir, 'video.mp4'))
  const found = await listCoverFiles(dir)
  assert.deepEqual(found.map(entry => entry.key), ['video'])
  assert.equal(found[0]?.type.kind, 'video')
})

test('a video replaces the image of the same key, without leaving two', async () => {
  const dir = join(root, 'replace')
  assert.equal((await storeCover(dir, 'clip', WEBP)).ok, true)
  assert.equal((await storeCover(dir, 'clip', MP4)).ok, true)
  const names = (await listCoverFiles(dir)).map(entry => basename(entry.file))
  assert.deepEqual(names, ['clip.mp4'])
})

test('a foreign file is rejected, with the message table entry as the reason', async () => {
  const dir = join(root, 'reject')
  const stored = await storeCover(dir, 'clip', Buffer.from('some random file'))
  assert.equal(stored.ok, false)
  if (stored.ok) return
  assert.equal(stored.status, 400)
  assert.equal(stored.error, message('cover.notMedia'))
  assert.deepEqual(await listCoverFiles(dir), [])
})

test('an empty file is rejected', async () => {
  const stored = await storeCover(join(root, 'empty'), 'clip', Buffer.alloc(0))
  assert.equal(stored.ok, false)
  if (stored.ok) return
  assert.equal(stored.status, 400)
})

test('with several files for one key the newest wins', async () => {
  const dir = join(root, 'duplicates')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'clip.webp'), WEBP)
  await writeFile(join(dir, 'clip.mp4'), MP4)
  const old = new Date('2020-01-01T00:00:00Z')
  await utimes(join(dir, 'clip.webp'), old, old)
  const newest = new Date('2026-11-04T00:00:00Z')
  await utimes(join(dir, 'clip.mp4'), newest, newest)
  const found = await coverFileOf(dir, 'clip')
  assert.equal(found?.type.kind, 'video')
  assert.deepEqual(await coverIndex(dir), { clip: { kind: 'video', ext: '.mp4' } })
  await removeCoverFiles(dir, 'clip')
  assert.deepEqual(await listCoverFiles(dir), [])
  assert.equal(await coverFileOf(dir, 'clip'), undefined)
})
