/**
 * The first run: a studio with no config.yaml writes one that boots, and never
 * touches a config the user already has.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ensureConfig, FIRST_RUN_DEFAULTS } from '../server/src/first-run.ts'

/** A folder with the example config, as a release ships it. */
function fresh(withExample = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-first-run-'))
  if (withExample) {
    writeFileSync(join(dir, 'config.example.yaml'), [
      'port: 3090',
      'host: 0.0.0.0',
      'comfy:',
      '  baseURL: http://example.invalid:9999',
      'tools:',
      '  keep: me',
      '',
    ].join('\n'))
  }
  return dir
}

test('with no config, one is written that a first run can boot on', () => {
  const dir = fresh()
  const result = ensureConfig(join(dir, 'config.yaml'), join(dir, 'config.example.yaml'))
  assert.equal(result.created, true)
  const config = parse(readFileSync(join(dir, 'config.yaml'), 'utf8')) as Record<string, any>
  assert.equal(config['port'], 3090)
  assert.equal(config['comfy']['baseURL'], FIRST_RUN_DEFAULTS.comfy)
  assert.deepEqual(config['defaultModel'], { provider: FIRST_RUN_DEFAULTS.provider, model: FIRST_RUN_DEFAULTS.model })
  assert.equal(config['providers'][FIRST_RUN_DEFAULTS.provider]['baseURL'], FIRST_RUN_DEFAULTS.endpoint)
  // The example's own keys are kept: it is the reference for everything else.
  assert.deepEqual(config['tools'], { keep: 'me' })
})

test('an existing config is never overwritten', () => {
  const dir = fresh()
  const mine = 'port: 4444\n# my own notes\n'
  writeFileSync(join(dir, 'config.yaml'), mine)
  const result = ensureConfig(join(dir, 'config.yaml'), join(dir, 'config.example.yaml'))
  assert.equal(result.created, false)
  assert.equal(readFileSync(join(dir, 'config.yaml'), 'utf8'), mine)
})

test('without the example it still writes a complete one', () => {
  const dir = fresh(false)
  const result = ensureConfig(join(dir, 'config.yaml'), join(dir, 'config.example.yaml'))
  assert.equal(result.created, true)
  assert.equal(result.from, undefined)
  const config = parse(readFileSync(join(dir, 'config.yaml'), 'utf8')) as Record<string, any>
  assert.equal(config['comfy']['baseURL'], FIRST_RUN_DEFAULTS.comfy)
  assert.equal(config['models'][0]['id'], FIRST_RUN_DEFAULTS.model)
})
