/**
 * MySQL storage, for the Hostinger deployment.
 *
 * `mysql2` is imported lazily so local development and the test suite never
 * need a database or the native-ish driver loaded.
 *
 * Connection pooling matters more here than usual: Hostinger stops the process
 * when it goes idle and restarts it on the next request, so every cold start
 * pays for a fresh handshake. Keep the pool small and let it warm up.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS licences (
     licence_key   VARCHAR(64)  NOT NULL PRIMARY KEY,
     tier          VARCHAR(32)  NOT NULL DEFAULT 'pro',
     max_seats     INT          NOT NULL DEFAULT 3,
     status        VARCHAR(16)  NOT NULL DEFAULT 'active',
     features      JSON         NULL,
     created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS activations (
     licence_key   VARCHAR(64)  NOT NULL,
     fingerprint   VARCHAR(128) NOT NULL,
     app_version   VARCHAR(32)  NULL,
     first_seen    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     last_seen     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (licence_key, fingerprint),
     CONSTRAINT fk_activations_licence
       FOREIGN KEY (licence_key) REFERENCES licences (licence_key)
       ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS presets (
     licence_key   VARCHAR(64)  NOT NULL,
     preset_id     VARCHAR(64)  NOT NULL,
     name          VARCHAR(128) NOT NULL,
     payload       JSON         NOT NULL,
     updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (licence_key, preset_id),
     CONSTRAINT fk_presets_licence
       FOREIGN KEY (licence_key) REFERENCES licences (licence_key)
       ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
]

/**
 * MySQL's JSON columns come back already parsed on some driver versions and as
 * a string on others, so normalise rather than assuming.
 */
function readJson (value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function createMysqlStorage (options) {
  let pool = null

  async function getPool () {
    if (pool) return pool
    const { default: mysql } = await import('mysql2/promise')
    pool = mysql.createPool({
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      database: options.database,
      connectionLimit: options.connectionLimit,
      waitForConnections: true,
      enableKeepAlive: true,
      namedPlaceholders: false
    })
    return pool
  }

  return {
    driver: 'mysql',

    /**
     * Creates the schema. Run from `npm run migrate`, NOT at boot.
     *
     * This used to run on startup, which meant every cold start imported the
     * driver (~78 ms measured) and spent three round-trips on DDL before
     * serving anything — including requests that never touch the database. On a
     * host that stops the process when idle, that cost was paid constantly.
     */
    async migrate () {
      const db = await getPool()
      for (const statement of SCHEMA) {
        await db.query(statement)
      }
    },

    async close () {
      if (pool) {
        await pool.end()
        pool = null
      }
    },

    async ping () {
      const db = await getPool()
      const connection = await db.getConnection()
      try {
        await connection.ping()
        return true
      } finally {
        connection.release()
      }
    },

    async getLicence (key) {
      const db = await getPool()
      const [rows] = await db.execute(
        'SELECT licence_key, tier, max_seats, status, features FROM licences WHERE licence_key = ? LIMIT 1',
        [key]
      )
      if (rows.length === 0) return null
      const row = rows[0]
      return {
        key: row.licence_key,
        tier: row.tier,
        maxSeats: row.max_seats,
        status: row.status,
        features: readJson(row.features, [])
      }
    },

    async listActivations (licenceKey) {
      const db = await getPool()
      const [rows] = await db.execute(
        'SELECT licence_key, fingerprint, app_version, first_seen, last_seen FROM activations WHERE licence_key = ?',
        [licenceKey]
      )
      return rows.map((row) => ({
        licenceKey: row.licence_key,
        fingerprint: row.fingerprint,
        appVersion: row.app_version,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen
      }))
    },

    async recordActivation ({ licenceKey, fingerprint, appVersion }) {
      const db = await getPool()
      // affectedRows is 1 for a fresh insert and 2 for an applied update, which
      // is how we distinguish a new seat from a returning one without a
      // separate SELECT (and without a race between the two).
      const [result] = await db.execute(
        `INSERT INTO activations (licence_key, fingerprint, app_version)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           app_version = COALESCE(VALUES(app_version), app_version),
           last_seen = CURRENT_TIMESTAMP`,
        [licenceKey, fingerprint, appVersion ?? null]
      )
      return { created: result.affectedRows === 1 }
    },

    async deleteActivation ({ licenceKey, fingerprint }) {
      const db = await getPool()
      const [result] = await db.execute(
        'DELETE FROM activations WHERE licence_key = ? AND fingerprint = ?',
        [licenceKey, fingerprint]
      )
      return result.affectedRows > 0
    },

    async listPresets (licenceKey) {
      const db = await getPool()
      const [rows] = await db.execute(
        'SELECT preset_id, name, payload, updated_at FROM presets WHERE licence_key = ? ORDER BY preset_id',
        [licenceKey]
      )
      return rows.map((row) => ({
        licenceKey,
        id: row.preset_id,
        name: row.name,
        payload: readJson(row.payload, {}),
        updatedAt: row.updated_at
      }))
    },

    async putPreset ({ licenceKey, id, name, payload }) {
      const db = await getPool()
      await db.execute(
        `INSERT INTO presets (licence_key, preset_id, name, payload)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), payload = VALUES(payload)`,
        [licenceKey, id, name, JSON.stringify(payload)]
      )
      return { licenceKey, id, name, payload, updatedAt: new Date() }
    },

    async deletePreset ({ licenceKey, id }) {
      const db = await getPool()
      const [result] = await db.execute(
        'DELETE FROM presets WHERE licence_key = ? AND preset_id = ?',
        [licenceKey, id]
      )
      return result.affectedRows > 0
    }
  }
}
