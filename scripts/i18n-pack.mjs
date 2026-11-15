/**
 * The language packs: create them and check them against the English
 * dictionary. (`sync`, which wrote a `shared/locales/en.json` nothing read,
 * was removed on 2026-11-14.)
 *
 *   node scripts/i18n-pack.mjs new de          # create a German pack to translate
 *   node scripts/i18n-pack.mjs check de.json   # how many keys are missing, and which
 *
 * A pack is a JSON with the same keys as English: `{ "imagine.generate": "Erzeugen", ... }`.
 * It goes in <data>/locales/<code>.json and appears in the language picker,
 * without recompiling anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readDictionary } from './locale-dictionary.mjs'

const [command, argument] = process.argv.slice(2)

if (command === 'new') {
  if (argument === undefined) {
    console.error('a language code is needed, e.g. `new de`')
    process.exit(1)
  }
  const base = readDictionary()
  const target = resolve(argument.endsWith('.json') ? argument : `${argument}.json`)
  if (existsSync(target)) {
    console.error(`${target} already exists`)
    process.exit(1)
  }
  // Every key with its English text as the value: translate the value, not the key.
  // A value left in English is what the page would show anyway (English is the base).
  writeFileSync(target, `${JSON.stringify(base, null, 2)}\n`)
  console.log(`${target}: ${Object.keys(base).length} keys, with the English text to translate as each value`)
} else if (command === 'check') {
  if (argument === undefined) {
    console.error('the pack file is needed, e.g. `check de.json`')
    process.exit(1)
  }
  const base = readDictionary()
  const pack = JSON.parse(readFileSync(argument, 'utf8'))
  const missing = Object.keys(base).filter(key => typeof pack[key] !== 'string' || pack[key].trim() === '')
  const extra = Object.keys(pack).filter(key => base[key] === undefined)
  const percent = Math.round(((Object.keys(base).length - missing.length) / Object.keys(base).length) * 100)
  console.log(`${argument}: ${Object.keys(base).length - missing.length}/${Object.keys(base).length} (${percent}%)`)
  for (const key of missing) console.log(`  missing ${key}`)
  for (const key of extra) console.log(`  extra   ${key}`)
} else {
  console.log('usage: new <code> | check <file>')
}
