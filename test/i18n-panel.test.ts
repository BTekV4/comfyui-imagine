/**
 * The card panel and the LoRA block must not go back to hard-coded Italian
 * text.
 *
 * On 2026-11-04 the "Modifica zona" panel showed "Carica foto", "Manca:
 * photo, prompt." and "Inserisci" in the middle of English: they were
 * hand-written strings, not dictionary keys. The audit caught them once it
 * learned to read text containing an expression and template literals; this
 * test runs it with `--strict`, so a regression fails the suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('no hard-coded Italian text in the panel surfaces', () => {
  const run = spawnSync(process.execPath, ['scripts/i18n-audit.mjs', '--strict'], {
    env: { ...process.env, I18N_AUDIT_DIRS: 'web/vendor-imagine/client' },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, `${run.stdout ?? ''}${run.stderr ?? ''}`)
})
