/**
 * The gallery listing is kept while the media folder does not change, and is
 * read again when a file is added, removed, or still growing.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'imagine-gallery-listing-'))
after(async () => { await rm(dir, { recursive: true, force: true }) })
process.env.IMAGINE_HOME = dir
const { listGallery } = await import('../server/vendor/tool-comfy/gallery.ts')

test('a new file, a file that grew and a removed file all show in the next listing', async () => {
  await writeFile(join(dir, 'a.mp3'), Buffer.alloc(10))
  assert.deepEqual((await listGallery(dir)).map(item => item.name), ['a.mp3'])
  // Same folder, same files: the kept listing.
  assert.equal((await listGallery(dir))[0]?.size, 10)
  // A file written after it was created: the folder's mtime does not move.
  await appendFile(join(dir, 'a.mp3'), Buffer.alloc(5))
  assert.equal((await listGallery(dir))[0]?.size, 15)
  await writeFile(join(dir, 'b.mp3'), Buffer.alloc(3))
  assert.deepEqual((await listGallery(dir)).map(item => item.name).sort(), ['a.mp3', 'b.mp3'])
  await unlink(join(dir, 'a.mp3'))
  assert.deepEqual((await listGallery(dir)).map(item => item.name), ['b.mp3'])
})
