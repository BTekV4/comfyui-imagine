/**
 * Merging the local copy with the server's: chat lines are not lost.
 *
 * The case behind the empty column (2026-11-04): the server had the user's
 * line and a job's status, this browser had the assistant's prose. The server
 * copy won on `jobIds` and the prose vanished at the first poll, while the
 * run went on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { absorbJobFiles, mergeProjects } from '../web/vendor-imagine/client/imagine-projects.ts'
import type { ImagineMessage, ImagineProject } from '../shared/imagine-projects.ts'

/** A minimal project with the given lines. */
function project(
  id: string,
  messages: readonly ImagineMessage[],
  jobIds: readonly string[] = [],
  itemNames: readonly string[] = [],
): ImagineProject {
  return { id, title: id, createdAt: 1, itemNames, jobIds, messages, autoTitle: false }
}

const USER: ImagineMessage = { id: 'u', role: 'user', text: 'crea 3 foto di un faro', createdAt: 10 }
const PROSE: ImagineMessage = {
  id: 'a', role: 'assistant', text: 'Preparo tre foto di un faro al tramonto.', createdAt: 11,
}
const DONE: ImagineMessage = {
  id: 'ok-j1', role: 'status', text: 'Ho generato un\u2019immagine.', createdAt: 12, jobId: 'j1',
  files: [{ name: 'generate_image-1.webp', kind: 'image' }],
}

test('the assistant\'s prose survives the merge with the job status', () => {
  const local = project('p', [USER, PROSE])
  const remote = project('p', [USER, DONE], ['j1'], ['generate_image-1.webp'])
  const [merged] = mergeProjects([local], [remote])
  assert.ok(merged)
  assert.deepEqual(merged.messages.map(message => message.id), ['u', 'a', 'ok-j1'])
  assert.equal(merged.messages[1]?.text, PROSE.text)
  assert.deepEqual(merged.jobIds, ['j1'])
  assert.deepEqual(merged.itemNames, ['generate_image-1.webp'])
})

test('lines stay in time order, each id once', () => {
  const local = project('p', [USER, PROSE, DONE])
  const remote = project('p', [USER, DONE])
  const [merged] = mergeProjects([local], [remote])
  assert.ok(merged)
  assert.deepEqual(merged.messages.map(message => message.id), ['u', 'a', 'ok-j1'])
  assert.equal(new Set(merged.messages.map(message => message.id)).size, merged.messages.length)
})

test('the winning copy keeps its text for an id both have', () => {
  const local = project('p', [USER, { ...PROSE, text: 'testo locale' }])
  const remote = project('p', [USER, { ...PROSE, text: 'testo del server' }], ['j1'])
  const [merged] = mergeProjects([local], [remote])
  assert.ok(merged)
  const line = merged.messages.find(message => message.id === 'a')
  assert.equal(line?.text, 'testo del server')
})


test('runs attached to a line survive even when the server copy wins', () => {
  const local = project('p', [USER, { ...PROSE, jobIds: ['j1', 'j2'] }])
  const remote = project('p', [USER, { ...PROSE }], ['j1', 'j2'])
  const [merged] = mergeProjects([local], [remote])
  assert.ok(merged)
  const line = merged.messages.find(message => message.id === 'a')
  assert.equal(line?.text, PROSE.text)
  assert.deepEqual(line?.jobIds, ['j1', 'j2'])
})

/** One finished picture of a batch, as the queue reports it. */
function landed(id: string, batchId: string, index: number) {
  return {
    id,
    action: 'generate' as const,
    status: 'done' as const,
    createdAt: 100 + index,
    prompt: 'un faro',
    batchId,
    batchIndex: index,
    files: [{ name: `generate_image-${id}.webp`, kind: 'image' as const }],
  }
}

test('a batch speaks once, with the number that has landed, and grows', () => {
  const jobs = [landed('j1', 'b1', 0), landed('j2', 'b1', 1), landed('j3', 'b1', 2)]
  const confirm = (_job: unknown, count = 1): string => `${String(count)} images`
  let board = absorbJobFiles(
    project('p', [], jobs.map(job => job.id)),
    jobs as never,
    confirm as never,
  )
  const lines = board.messages.filter(message => message.role === 'status')
  assert.equal(lines.length, 1, 'one line for the batch, not three')
  assert.equal(lines[0]?.id, 'ok-batch-b1')
  assert.equal(lines[0]?.text, '3 images')
  assert.equal(lines[0]?.files?.length, 3)

  // The same queue again is not a second line and no new write.
  assert.equal(absorbJobFiles(board, jobs as never, confirm as never), board)

  // One more run of the batch — the page attached it when it was queued, as
  // it now does — is the same line, one number further.
  const later = [...jobs, landed('j4', 'b1', 3)]
  board = absorbJobFiles({ ...board, jobIds: [...board.jobIds, 'j4'] }, later as never, confirm as never)
  const grown = board.messages.filter(message => message.role === 'status')
  assert.equal(grown.length, 1)
  assert.equal(grown[0]?.text, '4 images')
  assert.equal(grown[0]?.files?.length, 4)
})

test('a run outside a batch keeps its own line, as before', () => {
  const job = {
    id: 'solo', action: 'generate' as const, status: 'done' as const, createdAt: 2,
    files: [{ name: 'generate_image-solo.webp', kind: 'image' as const }],
  }
  const board = absorbJobFiles(project('p', [], ['solo']), [job] as never, (() => 'one image') as never)
  const lines = board.messages.filter(message => message.role === 'status')
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.id, 'ok-solo')
  assert.equal(lines[0]?.jobId, 'solo')
})
