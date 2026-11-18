/**
 * The studio PUT accepts a partial payload: only the projects it names, only
 * the tiles it sends, and the tombstones the disk already carries.
 *
 * The client saves only what changed (C12); this pins the server half of
 * that contract (`saveImagineStore` → `mergeStore`).
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = await mkdtemp(join(tmpdir(), 'imagine-store-partial-'))
after(async () => { await rm(dataDir, { recursive: true, force: true }) })

// `dataPath` reads the root when the module loads: set it first.
process.env.IMAGINE_HOME = dataDir
const { saveImagineStore, loadImagineStore } = await import('../server/vendor/tool-comfy/imagine-store.ts')

const project = (id: string, title: string, itemNames: string[] = []) => ({
  id, title, createdAt: 1, itemNames, jobIds: [], messages: [],
})
const rect = (id: string, x: number) => ({ id, x, y: 0, w: 100, h: 100 })

test('a partial PUT replaces only what it names and keeps everything else', async () => {
  await saveImagineStore({
    projects: [project('a', 'Alpha', ['one.png']), project('b', 'Beta', ['two.png'])],
    placed: { 'one.png': rect('one.png', 0), 'two.png': rect('two.png', 10) },
    deleted: { gone: 5 },
    renamed: { 'old.png': 'new.png' },
  })
  // Only project `a`, retitled, and only one tile moved; no tombstones sent.
  await saveImagineStore({ projects: [project('a', 'Alpha 2')], placed: { 'one.png': rect('one.png', 50) } })
  const store = await loadImagineStore()
  const byId = new Map(store.projects.map(entry => [entry.id, entry]))
  assert.equal(byId.get('a')?.title, 'Alpha 2')
  // The file only the disk copy listed stays in the named project.
  assert.deepEqual(byId.get('a')?.itemNames, ['one.png'])
  // The project the payload did not name is kept as stored.
  assert.equal(byId.get('b')?.title, 'Beta')
  assert.equal(store.placed['one.png']?.x, 50)
  assert.equal(store.placed['two.png']?.x, 10)
  assert.deepEqual(store.deleted, { gone: 5 })
  assert.deepEqual(store.renamed, { 'old.png': 'new.png' })
})

test('a partial PUT cannot resurrect a deleted project, and drops a tile only when asked', async () => {
  await saveImagineStore({ deleted: { b: 9 } })
  await saveImagineStore({ projects: [project('b', 'Beta again')] })
  let store = await loadImagineStore()
  assert.equal(store.projects.some(entry => entry.id === 'b'), false)
  assert.equal(store.projects.some(entry => entry.id === 'a'), true)
  assert.equal(store.deleted.b, 9)
  assert.ok(store.placed['two.png'] !== undefined)
  await saveImagineStore({ unplaced: ['two.png'] })
  store = await loadImagineStore()
  assert.equal(store.placed['two.png'], undefined)
  assert.ok(store.placed['one.png'] !== undefined)
})

test('a deleted project takes its removals and adoptions with it', async () => {
  await saveImagineStore({
    projects: [project('keep', 'Keep'), project('drop', 'Drop')],
    removed: { keep: { 'x.png': 1 }, drop: { 'y.png': 1 } },
    adopted: { keep: { job1: 1 }, drop: { job2: 1 } },
  })
  await saveImagineStore({ deleted: { drop: 9 } })
  const store = await loadImagineStore()
  assert.deepEqual(Object.keys(store.removed), ['keep'])
  assert.deepEqual(Object.keys(store.adopted), ['keep'])
})

test('an assistant line with no text is not kept', async () => {
  await saveImagineStore({
    projects: [{
      ...project('m', 'Messages'),
      messages: [
        { id: 'u1', role: 'user', text: 'ciao', createdAt: 1 },
        { id: 'a0', role: 'assistant', text: '', createdAt: 2, thinking: 'reasoning only' },
        { id: 'a1', role: 'assistant', text: 'Ecco.', createdAt: 3 },
      ],
    }],
  })
  const store = await loadImagineStore()
  const saved = store.projects.find(entry => entry.id === 'm')
  assert.deepEqual(saved?.messages.map(message => message.id), ['u1', 'a1'])
})

test('a store that does not parse is moved aside, not overwritten by the next save', async () => {
  const { readdir, writeFile, readFile } = await import('node:fs/promises')
  const file = join(dataDir, 'comfy', 'imagine.json')
  await writeFile(file, '{"projects": [ broken')
  const store = await loadImagineStore()
  assert.equal(store.projects.length, 0)
  const aside = (await readdir(join(dataDir, 'comfy'))).filter(name => name.startsWith('imagine.json.corrupt-'))
  assert.equal(aside.length, 1)
  assert.equal(await readFile(join(dataDir, 'comfy', aside[0] ?? ''), 'utf8'), '{"projects": [ broken')
})
