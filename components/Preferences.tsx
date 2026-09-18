'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import {
  DEFAULT_LOCALE,
  isLocale,
  negotiateLocale,
  type Locale
} from '#lib/i18n/locales'
import { localiseEngineText } from '#lib/i18n/engine-text'
import { translate, type MessageKey } from '#lib/i18n/strings'
import {
  applyTheme,
  DEFAULT_THEME,
  isTheme,
  LOCALE_STORAGE_KEY,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type Theme
} from '#lib/theme'

/**
 * Language and theme, in one provider.
 *
 * One provider rather than two because the plumbing is identical - a stored
 * preference, a browser default when nothing is stored, and a write on change -
 * and because both have the same hydration problem, which is worth solving once.
 *
 * The hydration problem: the server cannot know either preference. It has no
 * access to localStorage, and `Accept-Language` would be a guess that disagrees
 * with the stored choice of anyone who has made one. So the first render uses
 * the declared defaults and the stored values are read in an effect, after
 * mount. For the theme that flash is eliminated by the inline script in
 * `app/layout.tsx`, which runs before first paint. For the text it is not
 * eliminated, and that is the honest trade: a user whose language is not the
 * default sees Turkish for one frame. The alternative - rendering nothing until
 * mount - trades one frame of the wrong language for a blank page, which is
 * worse, and it also costs the page its server-rendered markup.
 */

interface Preferences {
  locale: Locale
  setLocale: (locale: Locale) => void
  theme: Theme
  setTheme: (theme: Theme) => void
  /** What `theme` currently means, with "system" already resolved. */
  resolved: ResolvedTheme
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  /**
   * A sentence that came out of the engine, the extension or storage - an
   * error, a reason, a problem - in this language when it is one of ours,
   * and as it came otherwise (lib/i18n/engine-text.ts).
   */
  tx: (text: string) => string
}

const PreferencesContext = createContext<Preferences | null>(null)

function readStoredLocale (): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored !== null && isLocale(stored)) return stored
  } catch {
    // Storage can be denied outright (Safari private browsing, a blocked
    // third-party context). A denied preference is not an error worth showing.
  }
  return negotiateLocale(navigator.languages ?? [navigator.language])
}

function readStoredTheme (): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored !== null && isTheme(stored)) return stored
  } catch {
    // as above
  }
  return DEFAULT_THEME
}

function write (key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A preference that cannot be persisted still applies for this session.
  }
}

export function PreferencesProvider ({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME)
  const [systemDark, setSystemDark] = useState(true)
  /**
   * Whether the stored preference and the system query have been read.
   *
   * Until they have, `resolved` is the server's guess - "system", assumed
   * dark - and applying it to the document would undo what the inline script
   * in app/layout.tsx set from the real values before first paint: one frame
   * of dark on a light system, on every load, precisely the flash that script
   * exists to prevent. The theme is applied only once this is true.
   */
  const [ready, setReady] = useState(false)

  // After mount, and only then: see above.
  useEffect(() => {
    setLocaleState(readStoredLocale())
    setThemeState(readStoredTheme())
    setReady(true)
  }, [])

  /**
   * The system preference is watched, not merely read. Someone on "system" who
   * flips their OS to dark at sunset expects the panel to follow without a
   * reload - that is the entire difference between "system" and having picked
   * the light it resolved to.
   */
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(query.matches)
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const resolved = resolveTheme(theme, systemDark)

  useEffect(() => {
    if (ready) applyTheme(document.documentElement, resolved)
  }, [ready, resolved])

  // `lang` drives hyphenation, spell-check and what a screen reader's voice
  // sounds like, so it has to track the chosen language rather than stay on the
  // value the server rendered.
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    write(LOCALE_STORAGE_KEY, next)
  }, [])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    write(THEME_STORAGE_KEY, next)
  }, [])

  const value = useMemo<Preferences>(() => ({
    locale,
    setLocale,
    theme,
    setTheme,
    resolved,
    t: (key, values) => translate(locale, key, values),
    tx: (text) => localiseEngineText(text, (key, values) => translate(locale, key, values))
  }), [locale, setLocale, theme, setTheme, resolved])

  return <PreferencesContext value={value}>{children}</PreferencesContext>
}

export function usePreferences (): Preferences {
  const value = useContext(PreferencesContext)
  if (value === null) {
    throw new Error('usePreferences used outside PreferencesProvider')
  }
  return value
}

/** The common case: just the lookup function. */
export function useTranslate (): Preferences['t'] {
  return usePreferences().t
}

/** For the places that show an engine's sentence directly rather than inside a panel one. */
export function useEngineText (): Preferences['tx'] {
  return usePreferences().tx
}
