/**
 * The Windows lock retry every media step uses.
 *
 * A virus scanner or the search indexer holds a file open for a moment, and
 * the rename/delete answers EPERM or EBUSY. The retry must wait that moment
 * out, give up with the real error after a bound, and change nothing where
 * the code does not exist (POSIX, and every error that is not that lock).
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FILE_RETRY_ATTEMPTS, retryFileOperation, renameWithRetry, rmWithRetry, unlinkWithRetry,
} from '../server/vendor/retry-fs/index.ts'

const root = await mkdtemp(join(tmpdir(), 'imagine-retry-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

/** The error Windows gives while another process holds the file. */
function locked(): NodeJS.ErrnoException {
  return Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
}

test('a rename blocked twice by a scanner is retried and succeeds', async () => {
  let calls = 0
  const moved = await retryFileOperation(async () => {
    calls += 1
    if (calls <= 2) throw locked()
    return 'moved'
  }, { platform: 'win32', attempts: 5, backoffMs: 1 })
  assert.equal(moved, 'moved')
  assert.equal(calls, 3)
})

test('a rename that stays blocked fails after the attempts, with its own error', async () => {
  let calls = 0
  await assert.rejects(
    retryFileOperation(async () => {
      calls += 1
      throw locked()
    }, { platform: 'win32', attempts: 3, backoffMs: 1 }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EPERM',
  )
  assert.equal(calls, 3)
})

test('the default gives a scanner a real number of tries', () => {
  assert.ok(FILE_RETRY_ATTEMPTS >= 2)
})

test('on a platform without that lock the same error is thrown at once', async () => {
  let calls = 0
  await assert.rejects(
    retryFileOperation(async () => {
      calls += 1
      throw locked()
    }, { platform: 'linux', attempts: 5, backoffMs: 1 }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EPERM',
  )
  assert.equal(calls, 1)
})

test('a real failure is not retried, even on Windows', async () => {
  let calls = 0
  await assert.rejects(
    retryFileOperation(async () => {
      calls += 1
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    }, { platform: 'win32', attempts: 5, backoffMs: 1 }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
  assert.equal(calls, 1)
})

test('the wrappers move and remove real media files', async () => {
  const dir = join(root, 'files')
  await mkdir(dir, { recursive: true })
  const from = join(dir, 'clip.mp4')
  const to = join(dir, 'clipped.mp4')
  await writeFile(from, 'media bytes')
  await renameWithRetry(from, to)
  assert.equal(await readFile(to, 'utf8'), 'media bytes')
  await unlinkWithRetry(to)
  await assert.rejects(stat(to), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')

  const scratch = join(dir, 'scratch')
  await mkdir(scratch, { recursive: true })
  await writeFile(join(scratch, 'tile.png'), 'png')
  await rmWithRetry(scratch, { recursive: true, force: true })
  await assert.rejects(stat(scratch), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
})
