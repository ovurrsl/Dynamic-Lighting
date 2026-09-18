'use client'

import { Label, ListBox, Select } from '@heroui/react'

import { usePreferences } from '#components/Preferences'
import { LOCALES, type Locale } from '#lib/i18n/locales'
import { completeness } from '#lib/i18n/strings'
import { THEMES, type Theme } from '#lib/theme'

/**
 * Language and theme, in the header.
 *
 * The language list shows each language's own name, not its English one: someone
 * looking for their language is looking for the word they would write, and a
 * list that says "German" is useless to the person who only reads Deutsch. The
 * percentage next to the partly-done ones is deliberate too - offering a
 * language and then showing English is worse than saying up front how much of it
 * exists, and it turns a complaint into a contribution.
 */
export function PreferencesMenu () {
  const { locale, setLocale, theme, setTheme, t } = usePreferences()

  const themeLabel: Record<Theme, string> = {
    system: t('theme.system'),
    light: t('theme.light'),
    dark: t('theme.dark')
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Select
        className="w-48"
        value={locale}
        onChange={(value) => setLocale(value as Locale)}
      >
        <Label>{t('app.language')}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {LOCALES.map((entry) => {
              const done = completeness(entry.code)
              return (
                <ListBox.Item key={entry.code} id={entry.code} textValue={entry.name}>
                  {entry.name}
                  {done < 100 && <span className="ms-2 text-xs text-muted">{done}%</span>}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              )
            })}
          </ListBox>
        </Select.Popover>
      </Select>

      <Select
        className="w-40"
        value={theme}
        onChange={(value) => setTheme(value as Theme)}
      >
        <Label>{t('app.theme')}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {THEMES.map((entry) => (
              <ListBox.Item key={entry} id={entry} textValue={themeLabel[entry]}>
                {themeLabel[entry]}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  )
}
