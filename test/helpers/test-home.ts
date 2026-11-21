/**
 * The data root of a test file: a temporary folder, never the user's studio.
 *
 * Imported first, before any module that reads `IMAGINE_HOME` at load, so the
 * studio's per-file records (notes, written prompts, edit state) land in a
 * throwaway folder. A test that files state must never write into the data
 * folder of the machine it runs on.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env['IMAGINE_HOME'] === undefined || process.env['IMAGINE_HOME'].trim() === '') {
  const home = mkdtempSync(join(tmpdir(), 'imagine-test-home-'))
  process.env['IMAGINE_HOME'] = home
  process.on('exit', () => {
    rmSync(home, { recursive: true, force: true })
  })
}
