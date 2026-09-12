import process from 'node:process'

const DAY_SECONDS = 86400

function int (value, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`expected a number, got "${value}"`)
  return parsed
}

function bool (value, fallback) {
  if (value === undefined || value === '') return fallback
  return value === 'true' || value === '1'
}

function list (value) {
  if (!value) return []
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

/**
 * Reads configuration from the environment and fails loudly at boot rather
 * than at first request. Hostinger stops an idle Node process and restarts it
 * on the next request, so a misconfiguration that only surfaced under load
 * would be very hard to see from their dashboard.
 */
export function loadConfig (env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development'
  const isProduction = nodeEnv === 'production'
  const errors = []

  const signingKey = env.LICENCE_SIGNING_KEY ?? ''
  if (isProduction && !signingKey) {
    errors.push('LICENCE_SIGNING_KEY is required in production (run `npm run keygen`)')
  }

  // Storage defaults to mysql as soon as a database host is configured, so a
  // Hostinger deployment cannot silently run on a throwaway in-memory store.
  const storageDriver = env.STORAGE ?? (env.DB_HOST ? 'mysql' : 'memory')
  if (!['memory', 'mysql'].includes(storageDriver)) {
    errors.push(`STORAGE must be "memory" or "mysql", got "${storageDriver}"`)
  }
  if (storageDriver === 'mysql') {
    for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME']) {
      if (!env[key]) errors.push(`${key} is required when STORAGE=mysql`)
    }
  }
  if (isProduction && storageDriver === 'memory') {
    errors.push('STORAGE=memory loses all data when the process is stopped; configure MySQL for production')
  }

  let config
  try {
    config = {
      nodeEnv,
      isProduction,
      host: env.HOST ?? '0.0.0.0',
      port: int(env.PORT, 3000),
      // Hostinger terminates TLS in front of the app, so client addresses only
      // arrive via X-Forwarded-For. Rate limiting is useless without this.
      trustProxy: bool(env.TRUST_PROXY, true),
      logLevel: env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
      corsOrigins: list(env.CORS_ORIGINS),
      webDir: env.WEB_DIR ?? 'web/dist',
      licence: {
        signingKey,
        ttlSeconds: int(env.LICENCE_TTL_DAYS, 30) * DAY_SECONDS,
        graceSeconds: int(env.LICENCE_GRACE_DAYS, 14) * DAY_SECONDS
      },
      storage: {
        driver: storageDriver,
        mysql: {
          host: env.DB_HOST,
          port: int(env.DB_PORT, 3306),
          user: env.DB_USER,
          password: env.DB_PASSWORD ?? '',
          database: env.DB_NAME,
          connectionLimit: int(env.DB_POOL_SIZE, 4)
        }
      },
      rateLimit: {
        max: int(env.RATE_LIMIT_MAX, 60),
        windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60000)
      }
    }
  } catch (error) {
    errors.push(error.message)
  }

  if (config && config.licence.graceSeconds < 0) {
    errors.push('LICENCE_GRACE_DAYS must not be negative')
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`)
  }

  return config
}
