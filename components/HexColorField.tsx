'use client'

import { useEffect, useState } from 'react'
import { Input, Label, TextField } from '@heroui/react'

/**
 * A colour typed as hex.
 *
 * The field keeps its own TEXT while it is being edited. The two cards that
 * used to render `value={hex(color)}` straight from the parsed colour and only
 * accepted a keystroke once the whole string parsed could not be typed into at
 * all: every intermediate state - `#ff`, `#ffb4` - was rejected and the field
 * snapped back to the last valid colour, so the only way to change one was to
 * paste six characters in one go. Here the text is the user's until it parses,
 * and the parsed colour is what the caller gets.
 */
export function HexColorField ({ label, value, placeholder, isDisabled, className, onChange }: {
  label: string
  value: { r: number, g: number, b: number }
  placeholder?: string
  isDisabled?: boolean
  className?: string
  onChange: (color: { r: number, g: number, b: number }) => void
}) {
  const [text, setText] = useState(() => hexOf(value))
  const [invalid, setInvalid] = useState(false)

  // A colour changed from outside - a reload, a switch of strip, a reset -
  // replaces what is typed, unless what is typed already IS that colour.
  const shown = hexOf(value)
  useEffect(() => {
    setText((current) => {
      const parsed = fromHex(current)
      return parsed !== null && hexOf(parsed) === shown ? current : shown
    })
    setInvalid(false)
  }, [shown])

  return (
    <TextField
      className={className}
      isDisabled={isDisabled}
      isInvalid={invalid}
      value={text}
      variant="secondary"
      onChange={(next) => {
        setText(next)
        const parsed = fromHex(next)
        setInvalid(parsed === null && next.trim() !== '')
        if (parsed !== null) onChange(parsed)
      }}
    >
      <Label>{label}</Label>
      <Input placeholder={placeholder ?? '#ffb43c'} spellCheck={false} />
    </TextField>
  )
}

/** `#rrggbb`, lower case, from sRGB bytes. */
export const hexOf = (color: { r: number, g: number, b: number }): string =>
  `#${[color.r, color.g, color.b].map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')).join('')}`

/** `#rrggbb` or `rrggbb`, either case, to sRGB bytes; null for anything else. */
export function fromHex (text: string): { r: number, g: number, b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim())
  if (match === null) return null
  const value = Number.parseInt(match[1] as string, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}
