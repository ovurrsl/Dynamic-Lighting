import type { NextConfig } from 'next'

/**
 * Deliberately minimal, because the deployment targets disagree about
 * everything except the defaults.
 *
 * No `output: 'standalone'`. It produces a self-contained `.next/standalone`
 * tree aimed at container images, and neither host wants that: Hostinger runs
 * `next start` against a normal `.next`, and Vercel ignores the setting and
 * builds its own bundles. Setting it would only add a directory nobody reads.
 *
 * The previous Fastify + Vite layout failed on Hostinger with "No output
 * directory found after build" because the build landed in `web/dist`, nested
 * inside an npm workspace. Next.js writes `.next/` at the repo root, which is
 * what the host's framework detection looks for. That is the structural reason
 * this app is a single root-level Next project and not a workspace.
 */
const nextConfig: NextConfig = {
  // Fail the build on a type error rather than shipping it. This is the default,
  // stated explicitly because turning it off is a common shortcut and this is a
  // licensing service.
  typescript: { ignoreBuildErrors: false },

  // The licence API must never be cached by a CDN: a token response is specific
  // to one machine fingerprint and one moment.
  async headers () {
    return [
      {
        source: '/v1/licence/:path*',
        headers: [{ key: 'cache-control', value: 'no-store, max-age=0' }]
      },
      {
        source: '/healthz',
        headers: [{ key: 'cache-control', value: 'no-store, max-age=0' }]
      },
      {
        source: '/readyz',
        headers: [{ key: 'cache-control', value: 'no-store, max-age=0' }]
      }
    ]
  }
}

export default nextConfig
