import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * HeroUI v3 needs Tailwind 4 via the Vite plugin, not PostCSS: its shipped CSS
 * is source (it uses @apply, @utility, @custom-variant) rather than a compiled
 * bundle, so the Tailwind build has to process it.
 *
 * outDir is web/dist because the Hono server serves exactly that directory. One
 * build, one start command, one thing for the host to deploy.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    // Left on Vite 8's default minifier (Oxc). Asking for 'esbuild' here fails:
    // Vite 8 moved off esbuild, so that path now needs esbuild installed as a
    // separate dependency for no benefit.
    sourcemap: true
  },
  server: {
    // In development the API runs separately; proxy so the frontend can call
    // relative paths in both dev and production without branching on env.
    proxy: {
      '/v1': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000'
    }
  }
})
