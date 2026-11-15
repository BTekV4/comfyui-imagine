/**
 * The English dictionary of the page (`web/vendor-imagine/client/locales.ts`),
 * read by the build tools: one reader for `i18n-pack.mjs` and
 * `i18n-audit.mjs`, which until 2026-11-14 had one each (the audit's line
 * regex depended on every entry being one line ending in a comma).
 * @module locale-dictionary
 */
import { readFileSync } from 'node:fs'

/** Where the compiled English dictionary lives. */
export const ENGLISH_DICTIONARY = 'web/vendor-imagine/client/locales.ts'

/**
 * The entries of a TypeScript dictionary (`export const en = { ... } as const`).
 * @param file - the TypeScript file.
 * @returns key → text, every entry of the literal.
 */
export function readDictionary(file = ENGLISH_DICTIONARY) {
  const source = readFileSync(file, 'utf8')
  const head = /^export const \w+ = \{$/m.exec(source)
  const end = head === null ? -1 : source.indexOf('\n} as const', head.index)
  if (head === null || end < 0) throw new Error(`${file}: dictionary not recognised`)
  const literal = source.slice(head.index + head[0].length - 1, end + 2)
  // The literal is already valid JavaScript: no parser, no dependencies.
  return Function(`"use strict"; return (${literal})`)()
}
