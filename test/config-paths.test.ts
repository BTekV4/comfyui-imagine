/**
 * The config's paths: anchored to the file, except the virtual prefixes.
 *
 * `custom:<id>` is not a file but the graph of a personal workflow, read by the
 * loader from `<data>/custom-workflows/<id>/graph.json`. Anchoring it like a
 * relative path turned it into `/data/imagine/custom:<id>` and the boot died
 * with ENOENT (2026-11-04, first personal entry migrated).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { absoluteFrom, anchoredToolComfy, isVirtualWorkflowPath, programAsset } from '../server/src/config-paths.ts'

/*
 * The config path is built with the platform's own rules: the point of these
 * tests is that a relative value is anchored to the config's folder, not that
 * the folder is spelled with `/` (on Windows it never is).
 */
const CONFIG = resolve('data', 'imagine', 'config.yaml')
const CONFIG_DIR = dirname(CONFIG)
const elsewhere = resolve('elsewhere', 'comfy', 'workflows', 'a.json')

test('a relative path is anchored to the config folder', () => {
  assert.equal(absoluteFrom(CONFIG, './workflows/a.json'), join(CONFIG_DIR, 'workflows', 'a.json'))
  assert.equal(absoluteFrom(CONFIG, elsewhere), elsewhere)
})

test('`custom:<id>` is not a file and stays as it is', () => {
  assert.equal(isVirtualWorkflowPath('custom:abc-123'), true)
  assert.equal(isVirtualWorkflowPath(join(elsewhere)), false)
  const block = anchoredToolComfy(CONFIG, {
    outputDir: 'media/outputs',
    persona: { path: 'persona/vera.json' },
    workflows: {
      genere: { path: elsewhere, outputExt: 'webp' },
      personale: { path: 'custom:3f1c2a00-0000-4000-8000-000000000000', outputExt: 'webp', promptNodeId: '73' },
      relativo: { path: './workflows/comfyui_x.json' },
      senzaPath: { outputExt: 'mp4' },
    },
  })
  assert.equal(block.outputDir, join(CONFIG_DIR, 'media', 'outputs'))
  assert.deepEqual(block.persona, { path: join(CONFIG_DIR, 'persona', 'vera.json') })
  const workflows = block.workflows as Record<string, { path?: string; outputExt?: string; promptNodeId?: string }>
  assert.equal(workflows.genere?.path, elsewhere)
  assert.equal(workflows.personale?.path, 'custom:3f1c2a00-0000-4000-8000-000000000000')
  // The entry's other fields stay as written.
  assert.equal(workflows.personale?.outputExt, 'webp')
  assert.equal(workflows.personale?.promptNodeId, '73')
  assert.equal(workflows.relativo?.path, join(CONFIG_DIR, 'workflows', 'comfyui_x.json'))
  assert.equal(workflows.senzaPath?.path, undefined)
})

/*
 * Inside the desktop app the config.yaml is in the user's data folder and the
 * program is read-only, somewhere else (the AppImage's mount point, which
 * changes on every launch). The program's files must be read from the program;
 * the media and the login files must stay in the user's folder.
 */
const PROGRAM = resolve('program', 'imagine')
const DATA_CONFIG = resolve('home', 'imagine', 'config.yaml')
const DATA_DIR = dirname(DATA_CONFIG)

test('packaged: the page, the graphs and the persona come from the program', () => {
  assert.equal(programAsset(PROGRAM, DATA_CONFIG, './dist/web'), join(PROGRAM, 'dist', 'web'))
  assert.equal(programAsset(PROGRAM, DATA_CONFIG, './workflows/comfyui_x.json'), join(PROGRAM, 'workflows', 'comfyui_x.json'))
  assert.equal(programAsset(PROGRAM, DATA_CONFIG, './persona/example.json'), join(PROGRAM, 'persona', 'example.json'))
  // A graph the user keeps elsewhere is theirs, not the program's.
  assert.equal(programAsset(PROGRAM, DATA_CONFIG, elsewhere), elsewhere)
})

test('packaged: not one write path follows the program', () => {
  const block = anchoredToolComfy(DATA_CONFIG, {
    outputDir: './data/outputs',
    persona: { path: './persona/example.json' },
    workflows: {
      immagine: { path: './workflows/krea2.json', outputExt: 'png' },
      personale: { path: 'custom:3f1c2a00-0000-4000-8000-000000000000', outputExt: 'webp', pathHigh: './workflows/krea2-high.json' },
    },
  }, PROGRAM)
  const workflows = block.workflows as Record<string, { path?: string; pathHigh?: string }>
  // The media folder is the user's data folder, beside the config.
  assert.equal(block.outputDir, join(DATA_DIR, 'data', 'outputs'))
  assert.deepEqual(block.persona, { path: join(PROGRAM, 'persona', 'example.json') })
  assert.equal(workflows.immagine?.path, join(PROGRAM, 'workflows', 'krea2.json'))
  assert.equal(workflows.personale?.path, 'custom:3f1c2a00-0000-4000-8000-000000000000')
  assert.equal(workflows.personale?.pathHigh, join(PROGRAM, 'workflows', 'krea2-high.json'))
})

test('the login files and the host settings stay in the data folder', () => {
  // `main.ts` anchors these with `absoluteFrom`, never with the program.
  assert.equal(absoluteFrom(DATA_CONFIG, './data/password.json'), join(DATA_DIR, 'data', 'password.json'))
  assert.equal(absoluteFrom(DATA_CONFIG, './data/cookie-secret'), join(DATA_DIR, 'data', 'cookie-secret'))
})

test('unpackaged: the same config resolves exactly as before', () => {
  assert.equal(programAsset(undefined, CONFIG, './dist/web'), join(CONFIG_DIR, 'dist', 'web'))
  const block = anchoredToolComfy(CONFIG, { outputDir: 'media/outputs', persona: { path: 'persona/vera.json' } })
  assert.equal(block.outputDir, join(CONFIG_DIR, 'media', 'outputs'))
  assert.deepEqual(block.persona, { path: join(CONFIG_DIR, 'persona', 'vera.json') })
})
