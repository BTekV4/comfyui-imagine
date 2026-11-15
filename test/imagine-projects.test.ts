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
import { mergeProjects } from '../web/vendor-imagine/client/imagine-projects.ts'
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
