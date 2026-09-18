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
  // Fail the build on a type error rather than shipping it. The default, stated
  // explicitly because turning it off is a common shortcut.
  typescript: { ignoreBuildErrors: false },

  async headers () {
    return [
      {
        /*
         * The response headers a browser uses to refuse things on the page's
         * behalf. A probe of the built app before release found none of them
         * set, which is the default and is wrong for a page that talks to a
         * screen capture and a serial port.
         *
         * What is deliberately NOT here:
         *
         * - A script Content-Security-Policy. The theme script in
         *   app/layout.tsx is inline by necessity (it has to run before first
         *   paint) and Next adds inline scripts of its own, so a policy that
         *   means anything needs a per-request nonce threaded through the
         *   layout. That is the right next step, and it is a change to how the
         *   page renders, not a header.
         * - A Permissions-Policy entry for display-capture, serial, usb, hid,
         *   bluetooth or microphone. The page host uses every one of them.
         * - Strict-Transport-Security. It is the host's decision: Vercel sends
         *   it for every *.vercel.app deployment already, and a self-hosted
         *   copy that is not yet on HTTPS would be locked out of itself.
         */
        source: '/(.*)',
        headers: [
          // The panel is never framed, and a page that holds a screen capture
          // must not be framed by someone else.
          { key: 'content-security-policy', value: "frame-ancestors 'none'" },
          { key: 'x-frame-options', value: 'DENY' },
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
          // The features this page has no use for, refused up front.
          { key: 'permissions-policy', value: 'camera=(), geolocation=(), payment=()' }
        ]
      },
      {
        // Liveness must not be answered from a CDN cache, or it stops meaning
        // anything about the deployment behind it.
        source: '/healthz',
        headers: [{ key: 'cache-control', value: 'no-store, max-age=0' }]
      }
    ]
  }
}

export default nextConfig
