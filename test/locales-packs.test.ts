/**
 * Language packs: the count the page shows must be the one of the INSTALLED
 * pack, not the one of the source.
 *
 * The 2026-11-06 defect: the page said "Italiano — 1084/1084 keys —
 * Installed" while the pack in `<data>/locales` had 1059, and the client fell
 * back to English for the missing keys. Nobody noticed because `available()`
 * counted the source for installed packs too; and there was no "Update":
 * `install` only covered the "not installed" case.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalePacks, LocaleError } from '../server/src/locales.ts'

/** A pack of `count` keys, as the repository would write it. */
function packOf(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`imagine.test${String(index)}`, `testo ${String(index)}`]),
  )
}

/** Source and data folders, each with the packs given. */
async function folders(source: Record<string, Record<string, string>>, installed: Record<string, Record<string, string>>): Promise<{ dir: string; srcDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'imagine-locales-'))
  const srcDir = join(root, 'locales')
  const dir = join(root, 'data', 'locales')
  await mkdir(srcDir, { recursive: true })
  await mkdir(dir, { recursive: true })
  for (const [code, pack] of Object.entries(source)) await writeFile(join(srcDir, `${code}.json`), JSON.stringify(pack))
  for (const [code, pack] of Object.entries(installed)) await writeFile(join(dir, `${code}.json`), JSON.stringify(pack))
  return { dir, srcDir }
}

test('an older installed pack shows: installed keys and "behind"', async () => {
  const { dir, srcDir } = await folders({ it: packOf(5) }, { it: packOf(3) })
  const packs = await createLocalePacks({ dir, srcDir })
  const [italian] = await packs.available()
  assert.equal(italian?.code, 'it')
  assert.equal(italian?.installed, true)
  assert.equal(italian?.covers, 5, 'the source covers 5 keys')
  assert.equal(italian?.installedCovers, 3, 'the installed pack has 3')
  assert.equal(italian?.behind, true)
})

test('an up-to-date installed pack is not "behind"', async () => {
  const { dir, srcDir } = await folders({ it: packOf(4) }, { it: packOf(4) })
  const packs = await createLocalePacks({ dir, srcDir })
  const [italian] = await packs.available()
  assert.equal(italian?.installedCovers, 4)
  assert.equal(italian?.behind, false)
})

test('a pack that is not installed reports the source keys', async () => {
  const { dir, srcDir } = await folders({ it: packOf(6) }, {})
  const packs = await createLocalePacks({ dir, srcDir })
  const [italian] = await packs.available()
  assert.equal(italian?.installed, false)
  assert.equal(italian?.covers, 6)
  assert.equal(italian?.installedCovers, undefined)
})

test('updating copies the source over the installed pack, and keeps the old one', async () => {
  const { dir, srcDir } = await folders({ it: packOf(5) }, { it: packOf(3) })
  const packs = await createLocalePacks({ dir, srcDir })
  const updated = await packs.install('it')
  assert.equal(updated.installed, true)
  assert.equal(updated.installedCovers, 5)
  assert.equal(updated.covers, 5)
  assert.equal(updated.behind, false)
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, 'it.json'), 'utf8'))).length, 5)
  // The replaced pack is not lost: it sits alongside, dated.
  const saved = await readdir(join(dir, '..', 'locales-indietro'))
  assert.equal(saved.length, 1)
  assert.match(saved[0] ?? '', /^it-.*\.json$/)
  assert.equal(Object.keys(JSON.parse(await readFile(join(dir, '..', 'locales-indietro', saved[0] ?? ''), 'utf8'))).length, 3)
})

test('installing a pack that was not there creates no backup', async () => {
  const { dir, srcDir } = await folders({ it: packOf(2) }, {})
  const packs = await createLocalePacks({ dir, srcDir })
  const installed = await packs.install('it')
  assert.equal(installed.installed, true)
  await assert.rejects(readdir(join(dir, '..', 'locales-indietro')), /ENOENT/)
})

test('a broken installed pack counts zero keys and stays in the list', async () => {
  const { dir, srcDir } = await folders({ it: packOf(5) }, {})
  await writeFile(join(dir, 'it.json'), '{ rotto')
  const packs = await createLocalePacks({ dir, srcDir })
  const [italian] = await packs.available()
  assert.equal(italian?.installed, true)
  assert.equal(italian?.installedCovers, 0)
  assert.equal(italian?.behind, true)
})

test('the base language cannot be installed and a malformed code is rejected', async () => {
  const { dir, srcDir } = await folders({ it: packOf(2) }, {})
  const packs = await createLocalePacks({ dir, srcDir })
  await assert.rejects(packs.install('en'), (error: unknown) => error instanceof LocaleError && error.status === 400)
  await assert.rejects(packs.install('../it'), (error: unknown) => error instanceof LocaleError && error.status === 400)
})

test('a removed pack goes to locales-rimossi', async () => {
  const { dir, srcDir } = await folders({ it: packOf(2) }, { it: packOf(2) })
  const packs = await createLocalePacks({ dir, srcDir })
  const { movedTo } = await packs.remove('it')
  assert.match(movedTo, /locales-rimossi\/it-.*\.json$/)
  const [italian] = await packs.available()
  assert.equal(italian?.installed, false)
})
