import type { SupabaseClient } from '@supabase/supabase-js'

import type { Activation, Licence, Preset, Storage } from '#lib/storage/types'

/**
 * Supabase (Postgres) storage.
 *
 * Chosen over the previous MySQL driver for one structural reason: this talks
 * HTTP, not a database socket. A serverless function cannot hold a connection
 * pool across invocations - each cold start would open a fresh handshake and a
 * burst of traffic would exhaust the server's connection limit - and Hostinger's
 * shared MySQL is not reachable from rotating egress addresses anyway. An HTTP
 * client has no pool to get wrong, so the same code runs unchanged whether the
 * app is a long-lived `next start` process or a per-request function.
 *
 * The client is imported lazily, exactly as `mysql2` was, so /healthz, /v1/version
 * and every static asset stay off the driver's code path. /healthz is therefore
 * still the cheapest possible warm-up ping.
 */

export interface SupabaseStorageOptions {
  url: string
  serviceRoleKey: string
}

interface LicenceRow {
  licence_key: string
  tier: string
  max_seats: number
  status: string
  features: string[] | null
}

interface ActivationRow {
  licence_key: string
  fingerprint: string
  app_version: string | null
  first_seen: string
  last_seen: string
}

interface PresetRow {
  licence_key: string
  preset_id: string
  name: string
  payload: Record<string, unknown>
  updated_at: string
}

export function createSupabaseStorage (options: SupabaseStorageOptions): Storage {
  let client: SupabaseClient | null = null

  async function getClient (): Promise<SupabaseClient> {
    if (client) return client
    const { createClient } = await import('@supabase/supabase-js')
    client = createClient(options.url, options.serviceRoleKey, {
      auth: {
        // There is no end user here and no session to keep. Leaving these on
        // makes the server-side client try to persist and refresh tokens it
        // will never have.
        persistSession: false,
        autoRefreshToken: false
      }
    })
    return client
  }

  return {
    driver: 'supabase',

    async close () {
      // Nothing to close: the client is stateless HTTP. Kept so the interface
      // stays the same for drivers that do hold resources.
      client = null
    },

    async ping () {
      const db = await getClient()
      // head:true sends the query but asks for no rows back, which is the
      // cheapest thing that still proves the database answered rather than just
      // the API gateway.
      const { error } = await db
        .from('licences')
        .select('licence_key', { head: true, count: 'exact' })
      if (error) throw new Error(`supabase ping failed: ${error.message}`)
      return true
    },

    async getLicence (key) {
      const db = await getClient()
      const { data, error } = await db
        .from('licences')
        .select('licence_key, tier, max_seats, status, features')
        .eq('licence_key', key)
        // maybeSingle, not single: a missing licence is an expected 404, not an
        // error worth throwing over.
        .maybeSingle<LicenceRow>()

      if (error) throw new Error(`getLicence failed: ${error.message}`)
      if (!data) return null

      const licence: Licence = {
        key: data.licence_key,
        tier: data.tier,
        maxSeats: data.max_seats,
        status: data.status,
        // jsonb comes back already parsed, so the readJson() normaliser the
        // MySQL driver needed for its string-or-object JSON columns is gone.
        features: Array.isArray(data.features) ? data.features : []
      }
      return licence
    },

    async listActivations (licenceKey) {
      const db = await getClient()
      const { data, error } = await db
        .from('activations')
        .select('licence_key, fingerprint, app_version, first_seen, last_seen')
        .eq('licence_key', licenceKey)
        .returns<ActivationRow[]>()

      if (error) throw new Error(`listActivations failed: ${error.message}`)
      return (data ?? []).map((row): Activation => ({
        licenceKey: row.licence_key,
        fingerprint: row.fingerprint,
        appVersion: row.app_version,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen
      }))
    },

    /**
     * One round trip, one statement, genuinely atomic.
     *
     * The MySQL version read `affectedRows` (1 for an insert, 2 for an update) to
     * tell a new seat from a returning one. PostgREST cannot express "upsert and
     * report which arm ran", and doing it as upsert-then-select reintroduces the
     * race the seat-limit check exists to avoid: two simultaneous activations
     * would both see a free seat. So the logic lives in the record_activation
     * SQL function, which returns `xmax = 0` - the Postgres equivalent of that
     * affectedRows trick.
     */
    async recordActivation ({ licenceKey, fingerprint, appVersion }) {
      const db = await getClient()
      const { data, error } = await db.rpc('record_activation', {
        p_licence_key: licenceKey,
        p_fingerprint: fingerprint,
        p_app_version: appVersion ?? null
      })

      if (error) throw new Error(`recordActivation failed: ${error.message}`)
      return { created: data === true }
    },

    async deleteActivation ({ licenceKey, fingerprint }) {
      const db = await getClient()
      // .select() after .delete() returns the removed rows, which is how we know
      // whether anything matched without a second query.
      const { data, error } = await db
        .from('activations')
        .delete()
        .eq('licence_key', licenceKey)
        .eq('fingerprint', fingerprint)
        .select('fingerprint')

      if (error) throw new Error(`deleteActivation failed: ${error.message}`)
      return (data ?? []).length > 0
    },

    async listPresets (licenceKey) {
      const db = await getClient()
      const { data, error } = await db
        .from('presets')
        .select('licence_key, preset_id, name, payload, updated_at')
        .eq('licence_key', licenceKey)
        .order('preset_id', { ascending: true })
        .returns<PresetRow[]>()

      if (error) throw new Error(`listPresets failed: ${error.message}`)
      return (data ?? []).map((row): Preset => ({
        licenceKey: row.licence_key,
        id: row.preset_id,
        name: row.name,
        payload: row.payload ?? {},
        updatedAt: row.updated_at
      }))
    },

    async putPreset ({ licenceKey, id, name, payload }) {
      const db = await getClient()
      const { data, error } = await db
        .from('presets')
        .upsert(
          {
            licence_key: licenceKey,
            preset_id: id,
            name,
            payload,
            // Set explicitly because Postgres has no ON UPDATE CURRENT_TIMESTAMP.
            // A trigger would also work; doing it here keeps the behaviour
            // visible at the call site instead of hidden in the schema.
            updated_at: new Date().toISOString()
          },
          { onConflict: 'licence_key,preset_id' }
        )
        .select('licence_key, preset_id, name, payload, updated_at')
        .single<PresetRow>()

      if (error) throw new Error(`putPreset failed: ${error.message}`)
      if (!data) throw new Error('putPreset returned no row')

      return {
        licenceKey: data.licence_key,
        id: data.preset_id,
        name: data.name,
        payload: data.payload ?? {},
        updatedAt: data.updated_at
      }
    },

    async deletePreset ({ licenceKey, id }) {
      const db = await getClient()
      const { data, error } = await db
        .from('presets')
        .delete()
        .eq('licence_key', licenceKey)
        .eq('preset_id', id)
        .select('preset_id')

      if (error) throw new Error(`deletePreset failed: ${error.message}`)
      return (data ?? []).length > 0
    }
  }
}
