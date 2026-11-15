/**
 * How a language calls itself, for the selector and the language cards.
 *
 * A pack is a flat map of keys and texts, so it cannot carry its own name: the
 * name would be a key the page has to know anyway. This table is the one place
 * that knows them, and both sides read it — the server to answer
 * `/comfy-locales-available`, the page to label the selector.
 *
 * A language that is not here falls back to its code in capitals: a pack for
 * something nobody listed still installs and still appears.
 */

/** The languages the studio knows the name of, by code. */
export const LOCALE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  it: 'Italiano',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  nl: 'Nederlands',
  ca: 'Català',
  gl: 'Galego',
  eu: 'Euskara',
  sv: 'Svenska',
  da: 'Dansk',
  nb: 'Norsk bokmål',
  fi: 'Suomi',
  is: 'Íslenska',
  pl: 'Polski',
  cs: 'Čeština',
  sk: 'Slovenčina',
  hu: 'Magyar',
  ro: 'Română',
  bg: 'Български',
  hr: 'Hrvatski',
  sr: 'Српски',
  sl: 'Slovenščina',
  el: 'Ελληνικά',
  tr: 'Türkçe',
  ru: 'Русский',
  uk: 'Українська',
  ar: 'العربية',
  fa: 'فارسی',
  he: 'עברית',
  hi: 'हिन्दी',
  bn: 'বাংলা',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  af: 'Afrikaans',
  sw: 'Kiswahili',
  ka: 'ქართული',
  hy: 'Հայերեն',
  az: 'Azərbaycanca',
  kk: 'Қазақша',
  uz: 'Oʻzbekcha',
  mn: 'Монгол',
}

/**
 * The name of a language, or its code when this table does not know it.
 * @param code - the language code, e.g. `it`.
 * @returns the name in that language.
 */
export function localeName(code: string): string {
  return LOCALE_NAMES[code] ?? code.toUpperCase()
}

/**
 * The name of an interface language to write into a model's prompt.
 *
 * The model reads a name, not a code: `en` alone tells it little, `English`
 * or `Italiano` does. The image descriptions, the chat and the project names
 * all take it from here. The fallback is English, which is also the page's
 * default when the client sends no header.
 * @param language - the code that arrived with `x-app-language` (`it`, `pt-BR`…).
 * @returns the language's name.
 */
export function languageName(language?: string): string {
  return LOCALE_NAMES[(language ?? 'en').slice(0, 2).toLowerCase()] ?? 'English'
}
