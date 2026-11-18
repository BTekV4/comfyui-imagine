/**
 * Two rules about editing a photo: the canvas the graph is sent, and telling
 * an edit that changed nothing from one that did.
 *
 * The canvas is a pure decision (`shared/imagine-sizing.ts`); the "nothing
 * changed" check runs real ffmpeg over two tiny stills, one of them a copy.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { editSizeFor } from '../shared/imagine-sizing.ts'
import { samePicture } from '../server/vendor/tool-comfy/media-tools.ts'

const run = promisify(execFile)
const dir = await mkdtemp(join(tmpdir(), 'imagine-edit-canvas-'))
after(async () => { await rm(dir, { recursive: true, force: true }) })

test('an edit sends no canvas unless the sentence named a ratio', () => {
  assert.equal(editSizeFor(false, '16:9', '1080p'), undefined)
  assert.equal(editSizeFor(true, '1:1', '1080p'), '1080x1080')
  assert.equal(editSizeFor(true, '9:16', '720p'), '720x1280')
})

test('the same picture is recognised, a real change is not', async () => {
  const red = join(dir, 'red.png')
  const copy = join(dir, 'copy.png')
  const blue = join(dir, 'blue.png')
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', red])
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', red, copy])
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48', '-frames:v', '1', blue])
  assert.equal(await samePicture(red, copy), true)
  assert.equal(await samePicture(red, blue), false)
})

test('a comparison that cannot run never claims a change', async () => {
  assert.equal(await samePicture(join(dir, 'missing.png'), join(dir, 'missing.png')), false)
})
