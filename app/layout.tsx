import type { Metadata } from 'next'

import './styles.css'

export const metadata: Metadata = {
  title: 'AmbiFlux',
  description: 'Ekranı takip eden monitör arkası ambilight kontrol paneli'
}

/**
 * Replaces the Vite index.html.
 *
 * Dark by default. HeroUI v3 puts the light palette on :root, so dark needs the
 * class and the data attribute; the CSS variables do not follow
 * prefers-color-scheme on their own. An RGB control panel is used in a dim room,
 * so light-by-default would be the wrong first impression.
 */
export default function RootLayout ({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr" className="dark" data-theme="dark">
      <body className="bg-background text-foreground">{children}</body>
    </html>
  )
}
