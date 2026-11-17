/**
 * Where a configured graph is read from, and where an edit to it lands.
 *
 * A service writes the file `config.yaml` names, in place. A packaged app has
 * a read-only program: the first edit copies that one graph into the data
 * folder, the copy wins from then on (updates included), and «Restore default»
 * deletes it. These tests are the rule, without a window in the way.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWorkflowOverlay, programRelative, writableOverlay } from '../server/vendor/tool-comfy/workflow-overlay.ts'
import { editWorkflowFile } from '../server/vendor/tool-comfy/workflow-edit.ts'
import { loadWorkflows } from '../server/vendor/tool-comfy/workflow-load.ts'
import { graphEditor, workflowInventory } from '../server/vendor/tool-comfy/workflow-inventory.ts'

/** One node whose prompt is the value the tests change. */
const graph = (prompt: string): string => JSON.stringify({
  '3': { class_type: 'KSampler', inputs: { seed: 7, steps: 8, positive: ['6', 0] } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt } },
}, null, 2)

/** A program folder with one bundled graph, and an empty data folder. */
function layout(): { program: string; data: string; file: string; copy: string } {
  const root = mkdtempSync(join(tmpdir(), 'imagine-workflow-overlay-'))
  const program = join(root, 'program')
  const data = join(root, 'data')
  const file = join(program, 'workflows', 'krea2.json')
  mkdirSync(join(program, 'workflows'), { recursive: true })
  writeFileSync(file, graph('the program prompt'))
  return { program, data, file, copy: join(data, 'workflows', 'workflows', 'krea2.json') }
}

/** The prompt a graph file carries. */
function promptOf(file: string): string {
  return (JSON.parse(readFileSync(file, 'utf8')) as Record<string, { inputs: { text?: string } }>)['6']!.inputs.text!
}

test('a bundled graph is read from the program until somebody changes it', () => {
  const { program, data, file } = layout()
  const overlay = createWorkflowOverlay({ programDir: program, dir: join(data, 'workflows') })
  assert.equal(overlay.active(file), file)
  assert.equal(overlay.overridden(file), false)
  assert.equal(promptOf(overlay.active(file)), 'the program prompt')
})

test('the first edit copies that one file into the data folder', async () => {
  const { program, data, file, copy } = layout()
  const overlay = createWorkflowOverlay({ programDir: program, dir: join(data, 'workflows') })
  const target = await overlay.ensureWritable(file)
  assert.equal(target, copy)
  assert.equal(existsSync(copy), true)
  // The copy is the program's file, byte for byte, until the edit rewrites it.
  assert.equal(readFileSync(copy, 'utf8'), readFileSync(file, 'utf8'))
  // The program's file is not touched.
  assert.equal(promptOf(file), 'the program prompt')
  assert.equal(overlay.overridden(file), true)
  assert.equal(overlay.active(file), copy)
})

test('the copy wins over the program: an edit lands there and is what is loaded', async () => {
  const { program, data, file, copy } = layout()
  const overlay = createWorkflowOverlay({ programDir: program, dir: join(data, 'workflows') })
  await editWorkflowFile(await overlay.ensureWritable(file), stored => {
    stored['6']!.inputs['text'] = 'edited inside the app'
    return stored
  })
  assert.equal(promptOf(copy), 'edited inside the app')
  assert.equal(promptOf(file), 'the program prompt')

  // A new boot reads the copy through the overlay — a new version of the
  // program included, which changes the file it ships.
  writeFileSync(file, graph('the program prompt, next version'))
  const loaded = loadWorkflows({ generateImage: { path: file } } as never, overlay)
  const graphOf = (loaded.byRun as unknown as Record<string, { graph: Record<string, { inputs: { text?: string } }> }>)['generate']!
  assert.equal(graphOf.graph['6']!.inputs.text, 'edited inside the app')

  // A second edit writes the same copy again instead of copying a second time.
  assert.equal(await overlay.ensureWritable(file), copy)
})

test('restore throws the copy away, and the program file is in use again', async () => {
  const { program, data, file, copy } = layout()
  const overlay = createWorkflowOverlay({ programDir: program, dir: join(data, 'workflows') })
  await editWorkflowFile(await overlay.ensureWritable(file), stored => {
    stored['6']!.inputs['text'] = 'edited inside the app'
    return stored
  })
  assert.equal(existsSync(copy), true)

  assert.equal(await overlay.restore(file), true)
  assert.equal(existsSync(copy), false)
  assert.equal(overlay.overridden(file), false)
  assert.equal(overlay.active(file), file)
  const loaded = loadWorkflows({ generateImage: { path: file } } as never, overlay)
  const loadedGraph = (loaded.byRun as unknown as Record<string, { graph: Record<string, { inputs: { text?: string } }> }>)['generate']!
  assert.equal(loadedGraph.graph['6']!.inputs.text, 'the program prompt')

  // Nothing left to restore: the answer says so instead of failing.
  assert.equal(await overlay.restore(file), false)
})

test('restore takes the backups of the copy with it', async () => {
  const { program, data, file, copy } = layout()
  const overlay = createWorkflowOverlay({ programDir: program, dir: join(data, 'workflows') })
  const target = await overlay.ensureWritable(file)
  await editWorkflowFile(target, stored => {
    stored['3']!.inputs['steps'] = 16
    return stored
  })
  const backup = `${target}.bak-2026-11-17T10-00-00-000Z`
  writeFileSync(backup, readFileSync(target, 'utf8'))
  assert.equal(await overlay.restore(file), true)
  assert.equal(existsSync(copy), false)
  assert.equal(existsSync(backup), false)
})

test('an installation whose program is writable behaves exactly as before', async () => {
  const { file } = layout()
  for (const overlay of [writableOverlay, createWorkflowOverlay({})]) {
    assert.equal(overlay.active(file), file)
    assert.equal(overlay.overridden(file), false)
    // The edit goes to the file itself: no copy is made anywhere.
    assert.equal(await overlay.ensureWritable(file), file)
    assert.equal(await overlay.restore(file), false)
  }
})

test('a graph the program does not own is written where it is', async () => {
  const { program, data } = layout()
  const mine = join(resolve(data), 'elsewhere', 'mine.json')
  mkdirSync(join(data, 'elsewhere'), { recursive: true })
  writeFileSync(mine, graph('mine'))
  const overlay = createWorkflowOverlay({ programDir: program, dir: join(data, 'workflows') })
  assert.equal(overlay.active(mine), mine)
  assert.equal(await overlay.ensureWritable(mine), mine)
  assert.equal(overlay.overridden(mine), false)
  assert.equal(await overlay.restore(mine), false)
})

test('a path that leaves the program is not the program\u2019s', () => {
  const { program, file } = layout()
  assert.equal(programRelative(program, file), 'workflows/krea2.json')
  assert.equal(programRelative(program, join(program, '..', 'outside.json')), undefined)
  assert.equal(programRelative(undefined, file), undefined)
})

test('a copy wins even when the program file is the same file twice', async () => {
  // Two config rows can name one graph; the copy is one file, and both rows
  // read and write it (`graphEditor` finds the loaded copies by the
  // configured file, which never changes).
  const { program, data, file, copy } = layout()
  const overlay = createWorkflowOverlay({ programDir: program, dir: join(data, 'workflows') })
  await editWorkflowFile(await overlay.ensureWritable(file), stored => {
    stored['3']!.inputs['seed'] = 99
    return stored
  })
  const loaded = loadWorkflows(
    { generateImage: { path: file }, editImage: { path: file } } as never,
    overlay,
  )
  const seedOf = (name: string): number =>
    (loaded.byRun as unknown as Record<string, { graph: Record<string, { inputs: { seed: number } }> }>)[name]!.graph['3']!.inputs.seed
  assert.equal(seedOf('generate'), 99)
  assert.equal(seedOf('edit'), 99)
  assert.equal(existsSync(copy), true)
})

test('the settings path itself: an edit copies, the copy is used, restore goes back', async () => {
  const { program, data, file, copy } = layout()
  const overlay = createWorkflowOverlay({ programDir: program, dir: join(data, 'workflows') })
  const { rows, holders } = loadWorkflows({ generateImage: { path: file } } as never, overlay)
  const editor = graphEditor(() => holders, overlay)
  // The routes only ask ComfyUI for the values an input accepts; nothing here
  // does, so the client can be the smallest thing that answers.
  const ctx = { comfy: { nodeOptions: async () => [] as string[] } } as never
  const { inventory, applyKeyed, overridden, restoreDefault } = workflowInventory(ctx, rows, editor, overlay)

  /** The step count the studio would send with a run, read off the loaded graph. */
  const steps = (): number => (rows[0]!.loaded!.graph['3']!.inputs['steps'] as number)

  assert.equal(inventory.overridden('generate'), false)
  assert.equal(steps(), 8)
  await applyKeyed('generate', [{ node: '3', field: 'steps', value: 16 }])
  assert.equal(inventory.overridden('generate'), true)
  assert.equal(overridden('generate'), true)
  assert.equal(existsSync(copy), true)
  // The graph in memory is the edited one: the next run uses it without a restart.
  assert.equal(steps(), 16)
  assert.equal(promptOf(file), 'the program prompt')

  const done = await restoreDefault('generate')
  assert.equal(done.restored, true)
  assert.equal(existsSync(copy), false)
  assert.equal(inventory.overridden('generate'), false)
  // And back to the program's values in memory, again without a restart.
  assert.equal(steps(), 8)
})
