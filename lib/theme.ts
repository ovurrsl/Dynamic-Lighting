/**
 * The theme choice, as a value rather than a class name.
 *
 * Three states, not two: "system" is a distinct choice from the light or dark
 * it currently resolves to. A user who picks "system" in a dark room at night
 * expects the panel to turn light in the morning; one who picks "dark"
 * expects it not to. Collapsing the two - storing whatever dark/light the
 * system happened to say at the time - silently converts the first user into
 * the second, and it is the usual bug in this feature.
 */

export const THEMES = ['system', 'light', 'dark'] as const

export type Theme = (typeof THEMES)[number]

/** What a theme resolves to once the system preference is known. */
export type ResolvedTheme = 'light' | 'dark'

export const DEFAULT_THEME: Theme = 'system'

export function isTheme (value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

export function resolveTheme (theme: Theme, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light'
  return theme
}

export const THEME_STORAGE_KEY = 'ambiflux.theme'
export const LOCALE_STORAGE_KEY = 'ambiflux.locale'

/**
 * Applies a resolved theme to the document element.
 *
 * Three things, and all three are needed. HeroUI v3's `dark` variant matches
 * the `dark` class, `[data-theme="dark"]` AND `prefers-color-scheme`, so a user
 * who overrides a dark system to light needs `data-theme="light"` present to
 * beat the media query - adding the `dark` class alone would work one way and
 * not the other. `color-scheme` is what makes the browser's own widgets
 * (scrollbars, form controls, the canvas behind the page) match; without it a
 * light page on a dark system keeps dark scrollbars.
 */
export function applyTheme (root: HTMLElement, resolved: ResolvedTheme): void {
  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
}
