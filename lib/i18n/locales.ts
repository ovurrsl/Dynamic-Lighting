/**
 * The languages AmbiFlux speaks.
 *
 * The list is not guesswork: Hyperion ships 26 translations and the ones its
 * users actually maintain are visible in how complete they are (`en` 1248
 * strings, `de` and `sv` 1246, `es`/`hu`/`uk` 1243, `fr` 1229, `tr` 1212,
 * `pl` 1143, `zh-CN` 1128, `ru` 1082, `it` 1074, `pt-br` 1045; everything below
 * that trails off). That is the same audience we are building for, so it is a
 * better signal than a list of the world's largest languages - German is not
 * in the world's top ten and is Hyperion's second language.
 *
 * Turkish is first because it is the project's own language, and `en` is the
 * fallback because every key is guaranteed to exist there.
 */

export const LOCALES = [
  { code: 'tr', name: 'Türkçe', english: 'Turkish' },
  { code: 'en', name: 'English', english: 'English' },
  { code: 'de', name: 'Deutsch', english: 'German' },
  { code: 'zh-CN', name: '简体中文', english: 'Chinese (Simplified)' },
  { code: 'es', name: 'Español', english: 'Spanish' },
  { code: 'fr', name: 'Français', english: 'French' },
  { code: 'ru', name: 'Русский', english: 'Russian' },
  { code: 'pt-BR', name: 'Português (Brasil)', english: 'Portuguese (Brazil)' },
  { code: 'it', name: 'Italiano', english: 'Italian' },
  { code: 'pl', name: 'Polski', english: 'Polish' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch' },
  { code: 'ja', name: '日本語', english: 'Japanese' }
] as const

export type Locale = (typeof LOCALES)[number]['code']

export const DEFAULT_LOCALE: Locale = 'tr'
/** Every key exists here, so a missing translation falls back to a real string. */
export const FALLBACK_LOCALE: Locale = 'en'

export function isLocale (value: string): value is Locale {
  return LOCALES.some((locale) => locale.code === value)
}

/**
 * The best of `preferred` that we speak.
 *
 * Matches the language subtag as well as the full tag, so a browser asking for
 * `de-AT` gets German rather than the default - which is the whole reason this
 * is not a straight lookup. Regional variants we ship separately (`pt-BR`,
 * `zh-CN`) still win when they are named exactly.
 */
export function negotiateLocale (preferred: readonly string[]): Locale {
  for (const raw of preferred) {
    const tag = raw.trim()
    if (tag === '') continue
    const exact = LOCALES.find((locale) => locale.code.toLowerCase() === tag.toLowerCase())
    if (exact) return exact.code
    const base = (tag.split('-')[0] ?? '').toLowerCase()
    const loose = LOCALES.find((locale) => locale.code.toLowerCase().split('-')[0] === base)
    if (loose) return loose.code
  }
  return DEFAULT_LOCALE
}
