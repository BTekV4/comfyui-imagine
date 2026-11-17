/**
 * The user's own records are private to the account running the studio: likes,
 * tags, the Instagram queues and comment record, custom workflows, the prompts
 * filed with a clip and the notes beside a file are written 0600, like the
 * plugin configs. On Windows the mode is ignored, which is expected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonList } from '../server/src/json-list.ts'
import { recordFile } from '../plugins/instagram/src/context.ts'

/** File modes do not exist on Windows: the writer ignores the mode there. */
const WINDOWS = process.platform === 'win32'

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

test('a like or a tag list is written 0600, even over a file that was wider', { skip: WINDOWS && 'file modes are not meaningful on Windows' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagine-perm-'))
  try {
    const file = join(dir, 'likes.json')
    await writeFile(file, '[]', { mode: 0o644 })
    assert.equal(await modeOf(file), 0o644)
    const list = jsonList(file)
    await list.update(async () => ({ answer: null, next: ['a.webp'] }))
    assert.equal(await modeOf(file), 0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an Instagram queue or comment record is written 0600', { skip: WINDOWS && 'file modes are not meaningful on Windows' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagine-perm-'))
  try {
    const file = join(dir, 'comments.json')
    const record = recordFile(file, 'comments', () => ({ comments: [] }))
    await record.save()
    assert.equal(await modeOf(file), 0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
