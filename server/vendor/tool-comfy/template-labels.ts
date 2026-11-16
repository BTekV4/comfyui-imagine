/**
 * The names of a template's fields in the language a server sentence is
 * written in.
 *
 * The catalog carries each field's English `label` and the locale key the
 * page translates (`labelKey`). The server's own sentences come in Italian or
 * English ({@link languageKind}), so a refusal written in Italian has to name
 * the field in Italian too, or it reads «Photo: servono da 1 a 1 foto». The
 * Italian names are the page's own: the language pack, read from where it is
 * installed (`<data>/locales/it.json`), else from the repository's copy
 * (`IMAGINE_LOCALES_SRC`, or `locales/` under the working directory). A pack
 * that cannot be read leaves the English label, which is still a name.
 * @module tool-comfy/template-labels
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TemplateField } from '../../../shared/imagine-templates.ts'
import { dataPath } from '../home-paths/index.ts'
import { currentLanguage, languageKind } from '../../src/messages.ts'

/** The Italian pack as last read, with the file and the stamp it was read at. */
let cached: { readonly file: string; readonly stamp: string; readonly data: Readonly<Record<string, string>> } | undefined

/**
 * Where the Italian pack may be, in the order it is looked for.
 * @returns the candidate files.
 */
function packFiles(): readonly string[] {
  const source = process.env['IMAGINE_LOCALES_SRC']?.trim()
  return [
    dataPath('locales', 'it.json'),
    ...source === undefined || source === '' ? [] : [join(source, 'it.json')],
    join(process.cwd(), 'locales', 'it.json'),
  ]
}

/**
 * The Italian pack, from the first place that has one; re-read only when the
 * file changed.
 * @returns the keys and texts; empty when no pack can be read.
 */
async function italianPack(): Promise<Readonly<Record<string, string>>> {
  for (const file of packFiles()) {
    const info = await stat(file).catch(() => undefined)
    if (info?.isFile() !== true) continue
    const stamp = `${String(info.mtimeMs)}/${String(info.size)}`
    if (cached?.file === file && cached.stamp === stamp) return cached.data
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const data = Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      cached = { file, stamp, data }
      return data
    } catch {
      continue
    }
  }
  return {}
}

/**
 * A field's name in the language of the request in progress.
 * @returns a function from field to its name: the pack's text in Italian, the
 *   English `label` otherwise or when the pack does not have it.
 */
export async function fieldLabels(): Promise<(field: TemplateField) => string> {
  if (languageKind(currentLanguage()) !== 'it') return field => field.label
  const pack = await italianPack()
  return field => pack[field.labelKey] ?? field.label
}
