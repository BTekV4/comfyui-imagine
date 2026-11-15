/**
 * The Italian text the server sends, split by recipient.
 *
 * Three families, and they need different treatment (the family names are
 * kept in Italian: they are the values `--dump` takes):
 *   utente  — user: errors and notices that end up on screen; the table in
 *             `server/src/messages.ts` must cover them all;
 *   prompt  — instructions for the model: the user does not see them, but the
 *             language they are written in decides the language the model
 *             answers in (captions, descriptions), so it matters just the same
 *             and is not touched;
 *   log     — lines read by whoever administers the server (`[imagine] …`);
 *             they stay as written, like the rest of the journal.
 *
 * A fourth group, `label`, are the action names in `workflow-fields.ts`: the
 * client already translates them (`WORKFLOW_LABEL`), so the server sends them
 * in Italian and nobody sees them that way; and the relight look names, which
 * are bilingual data (`name`, `nameEn`).
 *
 * A fifth, `dato` (data), are the regexes that read the user's sentence
 * (`FRAGMENTS`): they stay in Italian because the user writes in Italian, and
 * translating them would switch the recognition off.
 *
 * Coverage is measured against the table: a user string is covered when its
 * Italian text is a fixed entry of the table. Sentences with placeholders no
 * longer appear in the code — they became `message('key')` — so they do not
 * enter this count: their presence is guaranteed by the typecheck, which
 * accepts only existing keys.
 *
 *   node scripts/i18n-server.mjs
 *
 * Exits with 1 when a user string is not covered: so the audit is a check,
 * not a list to read.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { MESSAGES } from '../server/src/messages.ts'

/** The files that build instructions for the model. */
const PROMPTS = /(story|video-prompt|music-prompt|recreate-video|lookbook|imagine-chat|edit-prompt|imagine-sight|shot-order|project-title)\.ts$/
/**
 * Words that make a string an Italian sentence (and not an identifier).
 *
 * Only words English does not write: no `per`, `video` or `un`, and `non` does
 * not count before a hyphen ("non-diegetic"). They were in the list, and since
 * the model instructions are in English they made 17 lines out of 136 count
 * as Italian when they were already English.
 */
const WORD = /\b(il|lo|la|le|gli|un|una|di|del|dell|della|dei|che|con|non(?!-)|sono|questo|questa|hai|ho|ha|serve|manca|errore|nessun|senza|anche|dopo|prima|immagine|immagini|canzone|voce|personaggio|nella|nel|sulla|utente)\b/i
/**
 * The static text the client renders on its own: the action labels
 * (`workflow-fields.ts`, replaced by `WORKFLOW_LABEL`), the provider preset
 * notes (`provider-presets.ts`, interpolated into an already translated
 * sentence) and the relight look names (`relight-looks.ts`, which carry their
 * English beside them as `nameEn`).
 */
const LABELS = /(workflow-fields|provider-presets|relight-looks)\.ts$/

/**
 * Fragments that are not messages on their own: part of a prompt for the model
 * or of a log line. They are listed here by name, with the reason.
 */
const FRAGMENTS = new Map([
  /*
   * The regexes that read the user's sentence (`wantsVoice` in
   * `video-prompt.ts`): they are not instructions for the model and are not
   * translated, otherwise the server stops recognising «senza voce»,
   * «non canta» and «lip sync» written in Italian.
   */
  ["\\b(?:senza voce|senza voci|no voce|niente voce|muto|muta|silenzios\\w*|strumentale", 'dato'], // regex that reads the user's sentence
  ["(?:non|senza|does not|doesn't|no longer)(?:\\s+\\S+){0,3}?\\s+", 'dato'], // regex that reads the user's sentence
  ["\\b(cant\\w*|cantat\\w*|cantante|voce|vocal\\w*|lip.?sync|labiale|parla\\w*", 'dato'], // regex that reads the user's sentence
  ["|parlato|dialog\\w*|dice|pronuncia|sussurra|urla|testo della canzone|lyrics?", 'dato'], // regex that reads the user's sentence
])

/** The table, by Italian text: fixed entries only. */
const fixed = new Map()
for (const [key, entry] of Object.entries(MESSAGES)) {
  if (!entry.it.includes('{')) fixed.set(entry.it, key)
}

/**
 * The string literals of a file, with the line they start on.
 *
 * A `'` inside a double-quoted sentence does not open a string: the delimiter
 * decides, and quotes of the other kind stay inside the text. This was why
 * `dell'editor` split the sentence and made it look uncovered.
 * @param {string} code - the file's source.
 * @returns {{ text: string, line: number }[]} the literals, in order.
 */
function literals(code) {
  const out = []
  let index = 0
  let line = 1
  while (index < code.length) {
    const char = code[index]
    if (char === '\n') {
      line += 1
      index += 1
      continue
    }
    if (char === '/' && code[index + 1] === '/') {
      while (index < code.length && code[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && code[index + 1] === '*') {
      index += 2
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) {
        if (code[index] === '\n') line += 1
        index += 1
      }
      index += 2
      continue
    }
    if (char !== "'" && char !== '"' && char !== '`') {
      index += 1
      continue
    }
    const quote = char
    const startLine = line
    let cursor = index + 1
    let text = ''
    while (cursor < code.length) {
      const next = code[cursor]
      if (next === '\\') {
        text += code[cursor + 1] ?? ''
        cursor += 2
        continue
      }
      if (next === quote) break
      if (next === '\n') {
        if (quote !== '`') break
        line += 1
      }
      // A `${…}` inside a template stays in the text, braces included: so a
      // sentence still interpolated is recognised and reported.
      if (quote === '`' && next === '$' && code[cursor + 1] === '{') {
        let depth = 0
        let end = cursor + 1
        while (end < code.length) {
          if (code[end] === '\n') line += 1
          if (code[end] === '{') depth += 1
          else if (code[end] === '}') {
            depth -= 1
            if (depth === 0) {
              end += 1
              break
            }
          }
          end += 1
        }
        text += code.slice(cursor, end)
        cursor = end
        continue
      }
      text += next
      cursor += 1
    }
    out.push({ text, line: startLine })
    index = cursor + 1
  }
  return out
}

/** The literal's family, or undefined when it is not an Italian sentence. */
function kindOf(file, text, lineText) {
  if (!WORD.test(text) || /^[a-z0-9_.:/-]+$/i.test(text)) return undefined
  if (FRAGMENTS.has(text)) return FRAGMENTS.get(text)
  if (/\[imagine\]|\[social-publish\]/.test(text) || /console\.(warn|error)/.test(lineText)) return 'log'
  /*
   * A file that writes prompts can also refuse something: the sentence inside
   * `new Error` or in an `error:` field speaks to the user, not to the model.
   */
  if (/new \w*Error\(|error:|errors\.push\(/.test(lineText)) return 'utente'
  if (PROMPTS.test(file)) return 'prompt'
  if (LABELS.test(file)) return 'label'
  return 'utente'
}

const rows = []
for (const dir of ['server/src', 'server/vendor/tool-comfy', 'shared']) {
  let names
  try { names = readdirSync(dir, { recursive: true }) } catch { continue }
  for (const name of names) {
    if (!/\.ts$/.test(String(name))) continue
    const file = `${dir}/${name}`
    // The table is not a call site: its sentences are the translation.
    if (file.endsWith('src/messages.ts')) continue
    const source = readFileSync(file, 'utf8')
    const lines = source.split('\n')
    for (const { text, line } of literals(source)) {
      const kind = kindOf(file, text.trim(), lines[line - 1] ?? '')
      if (kind !== undefined) rows.push({ kind, file, line, text: text.trim() })
    }
  }
}

const utente = rows.filter(row => row.kind === 'utente')
const uncovered = utente.filter(row => !fixed.has(row.text))
const entries = Object.entries(MESSAGES)
const withArgs = entries.filter(([, entry]) => entry.it.includes('{')).length

const counts = { utente: 0, prompt: 0, log: 0, label: 0, dato: 0 }
for (const row of rows) counts[row.kind] += 1
console.log(`table: ${entries.length} entries (${entries.length - withArgs} fixed, ${withArgs} with placeholders)`)
console.log(`utente: ${counts.utente}   prompt: ${counts.prompt}   log: ${counts.log}   label: ${counts.label}   dato: ${counts.dato}`)
console.log(`\nuser coverage: ${utente.length - uncovered.length}/${utente.length} (${utente.length === 0 ? 100 : Math.round((utente.length - uncovered.length) / utente.length * 100)}%)`)

const byFile = new Map()
for (const row of utente) byFile.set(row.file, (byFile.get(row.file) ?? 0) + 1)
console.log('\n== utente (user) per file')
for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)} ${file.replace('server/vendor/tool-comfy/', '')}`)
}

if (uncovered.length > 0) {
  console.log(`\n== uncovered (${uncovered.length})`)
  for (const row of uncovered) {
    const why = row.text.includes('${') ? '  [still interpolated: needs message()]' : ''
    console.log(`  ${row.file}:${row.line}  ${row.text}${why}`)
  }
  process.exitCode = 1
} else {
  console.log('\nevery user sentence has an entry in the table.')
}

/*
 * `node scripts/i18n-server.mjs --dump prompt`
 *
 * The lines of one family with file and line: the count says how many there
 * are, not where. At the end of the report, set apart by the heading, so the
 * normal check stays readable.
 */
const dumpAt = process.argv.indexOf('--dump')
if (dumpAt >= 0) {
  const family = process.argv[dumpAt + 1]
  console.log(`\n== ${String(family)} (file:line)`)
  for (const row of rows.filter(entry => entry.kind === family)) {
    console.log(`${row.file}:${row.line}\t${row.text.replace(/\n/g, '\\n')}`)
  }
}
