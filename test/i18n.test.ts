/**
 * Translations: no language loses a key, and no component asks for a key the
 * dictionary does not have.
 *
 * The second check is the one that was missing: until now a wrong key was
 * caught only by the typecheck, and only when written by hand in JSX.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const DIR = 'web/vendor-imagine/client'

/** A dictionary's keys, however they are quoted. */
function keysOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/^\s*['"](imagine\.[A-Za-z0-9._-]+)['"]\s*:/gm)].map(m => m[1]!)
}

test('the Italian pack covers every English key', () => {
  const base = new Set(keysOf(`${DIR}/locales.ts`))
  const pack = new Set(Object.keys(JSON.parse(readFileSync('locales/it.json', 'utf8'))))
  const missing = [...base].filter(key => !pack.has(key))
  assert.deepEqual(missing, [], `missing from the pack: ${missing.slice(0, 10).join(', ')}`)
  const extra = [...pack].filter(key => !base.has(key))
  assert.deepEqual(extra, [], `keys English does not have: ${extra.slice(0, 10).join(', ')}`)
})

test('no component uses a key that does not exist', () => {
  const known = new Set(keysOf(`${DIR}/locales.ts`))
  const unknown: string[] = []
  for (const name of readdirSync(DIR)) {
    if (!/\.tsx?$/.test(name) || /^locales|^locale-store|^dates/.test(name)) continue
    const source = readFileSync(`${DIR}/${name}`, 'utf8')
    for (const match of source.matchAll(/(?:translate|t)\('(imagine\.[A-Za-z0-9._-]+)'/g)) {
      if (!known.has(match[1]!)) unknown.push(`${name}: ${match[1]}`)
    }
  }
  assert.deepEqual(unknown, [], `unknown keys: ${unknown.slice(0, 10).join(', ')}`)
})

test('English is the only built-in language; the others are packs', () => {
  const store = readFileSync(`${DIR}/locale-store.ts`, 'utf8')
  const builtIn = [...store.matchAll(/\{ id: '([a-z]{2})', label:/g)].map(m => m[1])
  assert.deepEqual(builtIn, ['en'], 'the build compiles English only')
  assert.ok(readFileSync(`${DIR}/locales.ts`, 'utf8').includes('imagine.'), 'English has no dictionary')
  for (const name of readdirSync('locales')) {
    if (!name.endsWith('.json')) continue
    const pack = JSON.parse(readFileSync(`locales/${name}`, 'utf8'))
    assert.ok(typeof pack === 'object' && pack !== null, `${name} is not an object`)
  }
})

/** Strip comments: an Italian sentence in a comment is documentation. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1 ')
}

test('the bar and publishing surfaces have no hard-coded text', () => {
  /*
   * On 2026-11-04 these strings were written straight into the components: the
   * English page showed "Tutti / Apprezzati / Visualizza / Cerca nei media"
   * next to "Select", which comes from the dictionary. Translated text is
   * written only through `t`/`translate`.
   */
  const files: readonly (readonly [string, readonly string[]])[] = [
    [`${DIR}/MediaPage.tsx`, [
      'Tutti', 'Apprezzati', 'Scarica', 'Visualizza', 'Cerca nei media', 'Categoria', 'Piatto',
      'Raggruppato', 'Pieno', 'Compatto', 'In riproduzione', 'Fermo', 'Altri tag', 'Nome etichetta',
      'Cancella selezione', 'Togli dal Tag', 'Aggiungi al Tag', 'Indietro', 'Ti piace',
      'Rinomina «', 'Elimina «', 'Selezionato', 'Selezionati', 'file trovati',
    ]],
    [`${DIR}/LibraryPage.tsx`, ['Cerca nella libreria', 'Scarica']],
    [`${DIR}/media-actions.tsx`, ['Pubblica su Instagram']],
    [`${DIR}/PublishPanel.tsx`, [
      'Pubblica su Instagram', 'Tipo', 'Quando', 'Data e ora', 'Bozza', 'Pubblicato',
      'Errore sconosciuto', 'Vedi su Instagram', 'Avvio la pubblicazione',
    ]],
    [`${DIR}/labels.ts`, ['Bozza', 'Programmato', 'In pubblicazione', 'Pubblicato', 'In programma', 'In corso', 'Pubblicata']],
    ['web/src/HostSettings.tsx', [
      'Altro / indirizzo personalizzato', 'Filtra (es.', 'Leggo i modelli', 'Riavvio Imagine', 'Carico…',
    ]],
  ]
  const found: string[] = []
  for (const [file, words] of files) {
    const code = withoutComments(readFileSync(file, 'utf8'))
    for (const word of words) {
      const boundary = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^A-Za-zÀ-ù])${boundary}([^A-Za-zÀ-ù]|$)`, 'm').test(code)) found.push(`${file}: ${word}`)
    }
  }
  assert.deepEqual(found, [], `hard-coded text: ${found.join(', ')}`)
})

test('every workflow has its name in the dictionary', () => {
  /*
   * Workflow labels come from the server in Italian (`WORKFLOW_ROWS` in
   * `server/vendor/tool-comfy/workflow-fields.ts`) and the client translates
   * them by the config entry's key. The table was stuck on the runner names
   * (`generate`, `video`), which the server does not send: no row found its
   * translation and the page stayed Italian.
   */
  const rows = readFileSync('server/vendor/tool-comfy/workflow-fields.ts', 'utf8')
  const labelled = [...rows.matchAll(/\{\s*config: '([^']+)',\s*run: '[^']+',\s*key: '[^']+',\s*label:/g)]
    .map(match => match[1]!)
  assert.ok(labelled.length >= 15, `workflows read: ${String(labelled.length)}`)
  const settings = readFileSync(`${DIR}/ImagineSettings.tsx`, 'utf8')
  const block = settings.slice(settings.indexOf('const WORKFLOW_LABEL'))
  const table = block.slice(0, block.indexOf('\n}'))
  const mapped = new Map([...table.matchAll(/^\s*(\w+): '([^']+)'/gm)]
    .map(match => [match[1]!, match[2]!] as const))
  const missing = labelled.filter(name => !mapped.has(name))
  assert.deepEqual(missing, [], `workflows without a name: ${missing.join(', ')}`)
  const known = new Set(keysOf(`${DIR}/locales.ts`))
  const unknown = [...mapped.entries()].filter(([, key]) => !known.has(key)).map(([name, key]) => `${name}: ${key}`)
  assert.deepEqual(unknown, [], `unknown keys: ${unknown.join(', ')}`)
})
