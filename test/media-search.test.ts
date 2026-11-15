/**
 * «Cerca nei media»: the index follows the notes and the media folder, and a
 * rebuild reads again only the notes that are new or changed.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'imagine-media-search-'))
after(async () => { await rm(home, { recursive: true, force: true }) })
process.env.IMAGINE_HOME = home
const notes = join(home, 'comfy', 'notes')
const media = join(home, 'media')
await mkdir(notes, { recursive: true })
await mkdir(media, { recursive: true })
const { createMediaSearchRoute } = await import('../server/src/media-search.ts')
const route = createMediaSearchRoute(media)

/** One search, answered as the route's JSON. */
async function search(query: string): Promise<{ names: string[]; indexed: number }> {
  let text = ''
  const req = { method: 'GET', url: `/api/media-search?q=${encodeURIComponent(query)}`, headers: {} } as IncomingMessage
  const res = { req, writeHead: () => res, end: (body?: string) => { text = body ?? '' } } as unknown as ServerResponse
  await route(req, res)
  return JSON.parse(text) as { names: string[]; indexed: number }
}

/** A media file with its note; `at` sets the note's mtime, so two writes in one tick still differ. */
async function file(name: string, prompt: string, at?: number): Promise<void> {
  await writeFile(join(media, name), Buffer.alloc(4))
  await writeFile(join(notes, `${name}.json`), JSON.stringify({ origin: { prompt } }))
  if (at !== undefined) await utimes(join(notes, `${name}.json`), at, at)
}

test('new, rewritten and deleted files all show in the next search', async () => {
  await file('a.png', 'a red cat on a sofa', 1000)
  await file('b.png', 'a blue dog', 1000)
  assert.deepEqual((await search('cat')).names, ['a.png'])

  // A new file and its note: found, the others kept.
  await file('c.png', 'another cat, sleeping', 2000)
  assert.deepEqual((await search('cat')).names.sort(), ['a.png', 'c.png'])

  // A note rewritten (the vision pass arrives later), by rename as imagine-notes.ts writes: its new words are found.
  const temp = join(notes, '.b.png.json.tmp')
  await writeFile(temp, JSON.stringify({ origin: { prompt: 'a blue dog' }, sight: 'a dog chasing a cat' }))
  await utimes(temp, 3000, 3000)
  await rename(temp, join(notes, 'b.png.json'))
  assert.deepEqual((await search('cat')).names.sort(), ['a.png', 'b.png', 'c.png'])

  // A deleted file does not come back, though its note is still there.
  await unlink(join(media, 'a.png'))
  assert.deepEqual((await search('cat')).names.sort(), ['b.png', 'c.png'])

  // A note removed: its file has nothing left to be found by.
  await unlink(join(notes, 'c.png.json'))
  const after = await search('cat')
  assert.deepEqual(after.names, ['b.png'])
  assert.equal(after.indexed, 1)
})
