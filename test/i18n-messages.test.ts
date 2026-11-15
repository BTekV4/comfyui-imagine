/**
 * The server's messages: the table is complete and well formed, and the two
 * paths (exact string and placeholders) speak the right language.
 *
 * The check that matters is the first: an entry without a translation, or
 * translated with itself, must not get in. The others check that the
 * request's language really reaches the place where the sentence is built.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MESSAGES, message, translateMessage, withLanguage } from '../server/src/messages.ts'

/** The placeholders of a sentence. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]!).sort()
}

test('every entry has a translation that is not empty and differs from the Italian', () => {
  const empty: string[] = []
  const same: string[] = []
  for (const [key, entry] of Object.entries(MESSAGES)) {
    if (entry.en.trim() === '') empty.push(key)
    // Widened to string: the table's literal types never overlap, the values might.
    else if ((entry.en as string) === entry.it) same.push(key)
  }
  assert.deepEqual(empty, [], `without a translation: ${empty.join(', ')}`)
  assert.deepEqual(same, [], `translated with themselves: ${same.join(', ')}`)
})

test('the placeholders are the same in both languages', () => {
  const wrong: string[] = []
  for (const [key, entry] of Object.entries(MESSAGES)) {
    const it = placeholders(entry.it)
    const en = placeholders(entry.en)
    if (it.join(',') !== en.join(',')) wrong.push(`${key}: it [${it.join(', ')}] / en [${en.join(', ')}]`)
  }
  assert.deepEqual(wrong, [], `different placeholders:\n${wrong.join('\n')}`)
})

test('no two fixed entries share the same Italian', () => {
  const seen = new Map<string, string>()
  const doubled: string[] = []
  for (const [key, entry] of Object.entries(MESSAGES)) {
    if (entry.it.includes('{')) continue
    const other = seen.get(entry.it)
    if (other !== undefined) doubled.push(`${entry.it} (${other}, ${key})`)
    else seen.set(entry.it, key)
  }
  assert.deepEqual(doubled, [], `same Italian text: ${doubled.join('; ')}`)
})

test('fixed sentences go through the exact-match path', () => {
  for (const entry of Object.values(MESSAGES)) {
    if (entry.it.includes('{')) continue
    assert.equal(translateMessage(entry.it, 'en'), entry.en, entry.it)
    assert.equal(translateMessage(entry.it, 'en-GB'), entry.en, entry.it)
    assert.equal(translateMessage(entry.it, 'it'), entry.it)
    assert.equal(translateMessage(entry.it, undefined), entry.it)
  }
  assert.equal(translateMessage('a sentence that does not exist', 'en'), 'a sentence that does not exist')
})

test('sentences with placeholders are built in the request\'s language', async () => {
  const args = { method: 'GET', path: '/api/nulla' }
  const english = await withLanguage('en', async () => {
    await Promise.resolve()
    return message('route.unknown', args)
  })
  assert.equal(english, 'unknown route: GET /api/nulla')
  assert.equal(await withLanguage('it', async () => message('route.unknown', args)), 'rotta sconosciuta: GET /api/nulla')
  // Outside a request there is no language: Italian, the base, applies.
  assert.equal(message('route.unknown', args), 'rotta sconosciuta: GET /api/nulla')
})

test('a sentence with placeholders composed in Italian is read back in English', () => {
  // A job's reason is stored in Italian by the worker and translated when read.
  const stored = message('custom.batchTooFewValues', { field: 'sampler', count: 1 })
  assert.equal(stored, 'il campo sampler ha 1 valori veri: un batch ne vuole almeno due')
  assert.equal(translateMessage(stored, 'en'), 'the field sampler has 1 real values: a batch needs at least two')
  assert.equal(translateMessage(stored, 'it'), stored)
  // The longer fixed text wins when two shapes could read the same sentence.
  assert.equal(translateMessage('x deve essere testo non vuoto', 'en'), 'x must be non-empty text')
  assert.equal(translateMessage('x deve essere testo', 'en'), 'x must be text')
  // A text the table does not know goes out as it is.
  assert.equal(translateMessage('Python script failed: boom', 'en'), 'Python script failed: boom')
})

test('every sentence with placeholders is read back from its own Italian', () => {
  const wrong: string[] = []
  for (const [key, entry] of Object.entries(MESSAGES)) {
    if (!entry.it.includes('{')) continue
    const args = Object.fromEntries(placeholders(entry.it).map((name, index) => [name, `v${String(index)}`]))
    const it = entry.it.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_whole, name: string) => args[name]!)
    const en = entry.en.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_whole, name: string) => args[name]!)
    if (translateMessage(it, 'en') !== en) wrong.push(`${key}: ${translateMessage(it, 'en')}`)
  }
  assert.deepEqual(wrong, [], `read back wrong:\n${wrong.join('\n')}`)
})
