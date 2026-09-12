const DAY_SECONDS = 86400

export interface AppConfig {
  nodeEnv: string
  isProduction: boolean
  logLevel: string
  corsOrigins: string[]
  licence: {
    signingKey: string
    ttlSeconds: number
    graceSeconds: number
  }
  storage: {
    driver: 'memory' | 'supabase'
    supabase: { url: string, serviceRoleKey: string }
  }
  rateLimit: { max: number, windowMs: number }
}

function int (value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`expected a number, got "${value}"`)
  return parsed
}

function list (value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

/**
 * Reads configuration from the environment and collects every problem before
 * complaining, so a misconfigured deploy sees the whole list at once instead of
 * fixing one variable per attempt.
 */
export type EnvLike = Record<string, string | undefined>

export function loadConfig (env: EnvLike = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development'
  const isProduction = nodeEnv === 'production'
  const errors: string[] = []

  const signingKey = env.LICENCE_SIGNING_KEY ?? ''
  if (isProduction && !signingKey) {
    errors.push('LICENCE_SIGNING_KEY is required in production (run `npm run keygen`)')
  }
  // A private key that can mint licences must never be readable by the browser,
  // and Next.js inlines anything prefixed NEXT_PUBLIC_ into the client bundle.
  // Catching the mistake here is cheap; finding it after a deploy is not.
  for (const key of Object.keys(env)) {
    if (key.startsWith('NEXT_PUBLIC_') && /SIGNING|SECRET|SERVICE_ROLE|PRIVATE/i.test(key)) {
      errors.push(`${key} is public: NEXT_PUBLIC_ variables are inlined into the browser bundle, so a secret must not use that prefix`)
    }
  }

  // Storage defaults to supabase as soon as a project URL is configured, so a
  // real deployment cannot silently run on a throwaway in-memory store.
  const supabaseUrl = env.SUPABASE_URL ?? ''
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const driver = (env.STORAGE ?? (supabaseUrl ? 'supabase' : 'memory')) as 'memory' | 'supabase'

  if (!['memory', 'supabase'].includes(driver)) {
    errors.push(`STORAGE must be "memory" or "supabase", got "${driver}"`)
  }
  if (driver === 'supabase') {
    if (!supabaseUrl) errors.push('SUPABASE_URL is required when STORAGE=supabase')
    if (!serviceRoleKey) errors.push('SUPABASE_SERVICE_ROLE_KEY is required when STORAGE=supabase')
    if (serviceRoleKey && /^eyJ/.test(serviceRoleKey) === false && serviceRoleKey.startsWith('sb_') === false) {
      errors.push('SUPABASE_SERVICE_ROLE_KEY does not look like a Supabase key; check you did not paste the anon key or the database password')
    }
  }
  if (isProduction && driver === 'memory') {
    errors.push('STORAGE=memory loses all data when the process is stopped; configure Supabase for production')
  }

  let config: AppConfig | undefined
  try {
    config = {
      nodeEnv,
      isProduction,
      logLevel: env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
      corsOrigins: list(env.CORS_ORIGINS),
      licence: {
        signingKey,
        ttlSeconds: int(env.LICENCE_TTL_DAYS, 30) * DAY_SECONDS,
        graceSeconds: int(env.LICENCE_GRACE_DAYS, 14) * DAY_SECONDS
      },
      storage: {
        driver,
        supabase: { url: supabaseUrl, serviceRoleKey }
      },
      rateLimit: {
        max: int(env.RATE_LIMIT_MAX, 60),
        windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60_000)
      }
    }
  } catch (error) {
    errors.push((error as Error).message)
  }

  if (config && config.licence.graceSeconds < 0) {
    errors.push('LICENCE_GRACE_DAYS must not be negative')
  }
  if (config && config.licence.ttlSeconds <= 0) {
    errors.push('LICENCE_TTL_DAYS must be positive')
  }

  if (errors.length > 0 || !config) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`)
  }

  return config
}

/**
 * Cached config for request handlers.
 *
 * The Fastify app validated configuration once at boot and refused to start if
 * it was wrong. Serverless has no boot: there is no single moment at which to
 * fail, and a thrown error in one function instance says nothing about the next.
 *
 * So the failure is cached instead of retried. The first request on an instance
 * validates, and if configuration is broken every later request on that instance
 * gets the same error with the same list of problems - loudly and in the logs -
 * rather than a different partial failure each time. /readyz reports it directly
 * so an operator can see what is wrong without reading a stack trace, and
 * scripts/check-env.mjs catches it at build time on both hosts.
 */
let cached: { config: AppConfig } | { error: Error } | null = null

export function getConfig (): AppConfig {
  if (cached === null) {
    try {
      cached = { config: loadConfig() }
    } catch (error) {
      cached = { error: error as Error }
    }
  }
  if ('error' in cached) throw cached.error
  return cached.config
}

/** Returns the configuration problems as a list, or null when valid. */
export function configProblems (): string[] | null {
  try {
    getConfig()
    return null
  } catch (error) {
    return String((error as Error).message)
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/, '').trim())
      .filter((line) => line.length > 0 && !line.startsWith('Invalid configuration'))
  }
}

/** Test seam: clears the cache so a test can load a different environment. */
export function resetConfigCache (): void {
  cached = null
}
