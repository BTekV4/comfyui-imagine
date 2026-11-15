/**
 * The base language: what the server writes in when nothing declares one.
 * English by default; Italian when the installation says so (IMAGINE_LANGUAGE,
 * which main.ts sets from `language:` in config.yaml). A declared language
 * always wins over it.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { baseLanguage, languageKind, messageIn } from '../server/src/messages.ts'

const saved = process.env['IMAGINE_LANGUAGE']
afterEach(() => {
  if (saved === undefined) delete process.env['IMAGINE_LANGUAGE']
  else process.env['IMAGINE_LANGUAGE'] = saved
})

test('with nothing set the base is English', () => {
  delete process.env['IMAGINE_LANGUAGE']
  assert.equal(baseLanguage(), 'en')
  assert.equal(languageKind(undefined), 'en')
  assert.equal(languageKind(''), 'en')
  assert.equal(messageIn(undefined, 'app.unreachableTitle', { name: 'X' }), 'X does not answer')
})

test('IMAGINE_LANGUAGE=it makes the base Italian, read at every call', () => {
  process.env['IMAGINE_LANGUAGE'] = 'it'
  assert.equal(languageKind(undefined), 'it')
  assert.equal(messageIn(undefined, 'app.unreachableTitle', { name: 'X' }), 'X non risponde')
  process.env['IMAGINE_LANGUAGE'] = 'en'
  assert.equal(languageKind(undefined), 'en')
})

test('a declared language wins over the base: French and German read English', () => {
  process.env['IMAGINE_LANGUAGE'] = 'it'
  assert.equal(languageKind('fr'), 'en')
  assert.equal(languageKind('de-DE'), 'en')
  assert.equal(languageKind('it-IT'), 'it')
})
