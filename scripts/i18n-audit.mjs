/**
 * Find the Italian text left hard-coded in the components, in every form it
 * hides in.
 *
 * The earlier detectors saw only one: isolated strings in JSX, and only if
 * they contained a word from a short list. On 4/11/2026 four clearly visible
 * Italian texts («Tutti», «Apprezzati», «Visualizza», «Cerca nei media») did
 * not appear in the report: single words were discarded as "identifiers", and
 * `placeholder`/`title`/`aria-label` were not read at all.
 *
 * This one looks at (1) the text between tags, single words included, (2) the
 * text attributes, (3) the literals — and recognises Italian if the text has
 * an accent, contains an Italian interface word, or is already the Italian
 * translation of a key (then it is text that should have gone through `t`). A
 * word spelled the same in English and Italian is not a leftover to translate.
 *
 *   node scripts/i18n-audit.mjs            report
 *   node scripts/i18n-audit.mjs --strict   exit 1 if anything is found
 *
 * Comments are not interface; only the folders listed in `I18N_AUDIT_DIRS`
 * (comma-separated) are read, so the detector can be tried on a copy.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readDictionary } from './locale-dictionary.mjs'

const DIRS = (process.env.I18N_AUDIT_DIRS ?? 'web/vendor-imagine/client,web/src')
  .split(',')
  .map(entry => entry.trim())
  .filter(entry => entry !== '')
const STRICT = process.argv.includes('--strict')
const SKIP = /^(node_modules|dist|\.)/
/* file-origin.ts holds the prompts of the wordless actions: they are data to
 * recognise in old rows, not interface text. */
const SKIP_FILE = /locales|locale-store|^dates\.ts$|file-origin\.ts$/

/** The words that recur in an Italian interface and not in an English one. */
const WORDS = new RegExp(
  '\\b(' + [
    'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'di', 'del', 'della', 'dei', 'delle', 'che', 'per', 'con',
    'non', 'sono', 'questo', 'questa', 'questi', 'come', 'piu', 'più', 'gia', 'già', 'oggi', 'ieri',
    'tutto', 'tutti', 'tutte', 'immagine', 'immagini', 'mese', 'settimana', 'giorno', 'giorni', 'adesso',
    'prima', 'dopo', 'nuovo', 'nuova', 'salva', 'annulla', 'elimina', 'carica', 'scegli', 'apri', 'chiudi',
    'dentro', 'fuori', 'senza', 'anche', 'solo', 'dove', 'quando', 'quale', 'cosa', 'quanto',
    'apprezzati', 'scarica', 'visualizza', 'cerca', 'categoria', 'piatto', 'raggruppato', 'pieno',
    'compatto', 'fermo', 'riproduzione', 'indietro', 'cancella', 'seleziona', 'selezionato', 'selezionati',
    'aggiungi', 'togli', 'rinomina', 'pubblica', 'tipo', 'bozza', 'carico', 'leggo', 'offre', 'spunta',
    'riavvio', 'filtra', 'indirizzo', 'personalizzato', 'elenco', 'didascalia', 'avvio', 'pubblicazione',
    'errore', 'vedi', 'nome', 'etichetta', 'altro', 'altri', 'altra', 'minuti', 'prossimo', 'controllo',
    'modelli', 'modello', 'impostazioni', 'strumenti', 'azione', 'azioni', 'fotogramma', 'fotogrammi',
    'modifica', 'modifiche', 'schermo', 'intero', 'zona', 'copia', 'taglia', 'ritaglia', 'ritaglio', 'foto',
    'avviso', 'vuota', 'vuoto', 'attesa', 'bozze', 'facoltativo', 'produce', 'estensione',
    'forza', 'colore', 'opzioni', 'rimuovi', 'scrivi', 'barra', 'laterale', 'personalizzati', 'sposta',
    'mostra', 'nascondi', 'tela', 'rifai', 'invia',
    // 4/11/2026: forms left hard-coded in the card panel and the LoRA block.
    'manca', 'mancano', 'pronto', 'pronta', 'inserisci', 'opzionale', 'porta',
    'titolo', 'descrizione', 'grafo', 'copertina', 'controlli', 'anteprima',
  ].join('|') + ')\\b',
  'i',
)

/** The English dictionary, by key. */
const EN = new Map(Object.entries(readDictionary()))
const PACK = 'locales/it.json'
/* Only the translations that say something different from English: «Lookbook»
 * or «Audio» are spelled the same in both languages and are not leftovers. */
const IT = existsSync(PACK)
  ? new Map(Object.entries(JSON.parse(readFileSync(PACK, 'utf8'))))
  : new Map()
const TRANSLATED = new Set([...IT.entries()].filter(([key, value]) => EN.get(key) !== value).map(([, value]) => value))

/* The pack's coverage: every English key must have its own entry. */
const MISSING_IN_PACK = [...EN.keys()].filter(key => !IT.has(key))

/** A text is Italian: an accent, an interface word, or already translated text. */
function italian(text) {
  if (/[àèéìòù]/i.test(text)) return true
  if (WORDS.test(text)) return true
  return TRANSLATED.has(text)
}

/** Strip comments: an Italian sentence in a comment is documentation, not UI. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1 ')
}

/** Looks like an identifier, a path or a piece of code, not a sentence. */
function looksLikeCode(text) {
  if (/^[a-z0-9_.:${}/#?=&%@-]+$/i.test(text)) return true
  return /(?:^|[^:])\/\*|=>|\bclassName\b|\bcss\.|\$\{|\/\^|\\[a-z]|\.(?:tsx?|css|mjs|json|webp|png|mp4)$/i.test(text)
}

const files = DIRS.flatMap(dir => readdirSync(dir, { recursive: true })
  .filter(name => /\.(ts|tsx)$/.test(String(name)) && !SKIP.test(String(name)))
  .map(name => `${dir}/${String(name)}`))
  .filter(name => !SKIP_FILE.test(name))

const found = []
const seen = new Set()
for (const file of files) {
  const code = stripComments(readFileSync(file, 'utf8'))
  /*
   * The text between tags can carry an expression («Carica {kinds}»): the
   * braces are removed before reading it, otherwise those strings did not
   * appear in the report (measured on 4/11/2026 on «Carica foto» and
   * «Manca: …»).
   */
  const withoutBraces = (text) => text
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/\$\{[^{}]*\}/g, ' ')
  const candidates = [
    // (1) the text between tags, even alone between two newlines, even a single
    // word: the identifier filter does not apply here, «Tutti» is interface
    ...[...code.matchAll(/>([^<>]{2,200})</g)].map(match => ({ text: withoutBraces(match[1]), kind: 'jsx' })),
    // (2) the texts visible in an attribute (a tooltip, a pill), or read by the
    // screen reader — also written as template literals
    ...[...code.matchAll(/\b(?:placeholder|title|aria-label|label|alt)="([^"]{2,160})"/g)].map(match => ({ text: match[1], kind: 'attr' })),
    ...[...code.matchAll(/\b(?:placeholder|title|aria-label|label|alt)=\{\s*`([^`]{2,160})`/g)].map(match => ({ text: withoutBraces(match[1]), kind: 'attr' })),
    // (3) the literals, still useful for the branches inside braces; also the
    // template literals with an expression inside
    ...[...code.matchAll(/['"`]([^'"`\n]{2,160})['"`]/g)].map(match => ({ text: match[1], kind: 'literal' })),
    ...[...code.matchAll(/`([^`]{2,200})`/g)].map(match => ({ text: withoutBraces(match[1]), kind: 'literal' })),
  ]
  for (const candidate of candidates) {
    const text = candidate.text.replace(/\s+/g, ' ').trim()
    if (text === '' || text.startsWith('imagine.')) continue
    /*
     * Between two tags the JSX text can land by mistake on a piece of code
     * (the `>` of a comparison and the `<` of another expression): an
     * interface sentence carries no parentheses, equals signs or semicolons.
     */
    if (candidate.kind === 'jsx' && /[()=;`"]/.test(text)) continue
    // A literal can be an identifier; the text between tags cannot.
    if (candidate.kind === 'literal' && looksLikeCode(text)) continue
    if (!italian(text)) continue
    const name = file.replace(/^.*\//, '')
    const id = `${name}\u001f${text}`
    if (seen.has(id)) continue
    seen.add(id)
    found.push({ file: name, text })
  }
}

const byFile = new Map()
for (const hit of found) byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit.text])
for (const [file, texts] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${file} (${texts.length})`)
  for (const text of texts.slice(0, 8)) console.log(`   ${text.slice(0, 90)}`)
}
console.log(`# ${found.length}\thard-coded Italian texts in ${byFile.size} files`)
if (STRICT) process.exit(found.length === 0 ? 0 : 1)
