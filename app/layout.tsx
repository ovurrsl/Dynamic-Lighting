import type { Metadata } from 'next'

import './styles.css'

export const metadata: Metadata = {
  title: 'AmbiFlux',
  description: 'Ekranı takip eden açık kaynak ambilight kontrol paneli'
}

/**
 * Runs before first paint, which is the whole reason it is a string of
 * JavaScript in the markup rather than an effect.
 *
 * A React effect runs after the first paint, so a user who chose light on a dark
 * system would see a dark page flash first - and on this page, whose job is to
 * show colours accurately, a wrong-coloured flash is worse than on most. The
 * stored choice has to be applied before the browser draws anything, and the
 * only thing that runs that early is a blocking inline script.
 *
 * It is deliberately tiny and total: any throw (storage denied, no matchMedia)
 * leaves the markup's own default in place rather than breaking the page, which
 * is why the whole body sits in a try with an empty catch. `lib/theme.ts` holds
 * the same logic for the React side; the duplication is two lines and the
 * alternative is shipping a bundle before paint.
 */
const THEME_SCRIPT = `try{
var t=localStorage.getItem('ambiflux.theme')||'system';
var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
var r=document.documentElement;
r.classList.toggle('dark',d);
r.dataset.theme=d?'dark':'light';
r.style.colorScheme=d?'dark':'light';
var l=localStorage.getItem('ambiflux.locale');
if(l)r.lang=l;
}catch(e){}`

/**
 * Replaces the Vite index.html.
 *
 * `lang` and the dark class are the server's best guess and both are corrected
 * by the script above; `suppressHydrationWarning` is on `<html>` for exactly
 * that reason. It suppresses nothing else - it does not descend past this one
 * element's own attributes, so a real mismatch inside the page still warns.
 */
export default function RootLayout ({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning className="dark" data-theme="dark" lang="tr">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="bg-background text-foreground">{children}</body>
    </html>
  )
}
