/**
 * How a string is chosen when languages are an external pack.
 *
 * English is compiled into the page; every other language is a JSON that can
 * be installed or removed at runtime. From here on a missing key is not an
 * error: English is read (and if that is missing too, the key itself, which
 * at least says where to look).
 *
 * It is a pure module, without React and without `window`, so the rule is
 * proven in tests instead of being inferred by looking at the page.
 */

/** Where the texts come from: the chosen language's pack, and English. */
export interface TextSources {
  /** The pack installed for the language in force, if any. */
  readonly pack?: Readonly<Record<string, string>>
  /** The compiled dictionary: the base language and the fallback. */
  readonly english: Readonly<Record<string, string>>
}

/**
 * A key's string: first the pack, then English, then the key.
 * @param key - the message key.
 * @param sources - the pack in force and the compiled English.
 * @returns the text; placeholders still in.
 */
export function resolveText(key: string, sources: TextSources): string {
  const fromPack = sources.pack?.[key]
  if (typeof fromPack === 'string' && fromPack !== '') return fromPack
  const fromEnglish = sources.english[key]
  if (typeof fromEnglish === 'string' && fromEnglish !== '') return fromEnglish
  return key
}
