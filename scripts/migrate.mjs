import process from 'node:process'

/**
 * Verifies the database schema rather than creating it.
 *
 * This is a real change from the MySQL version, which ran `CREATE TABLE IF NOT
 * EXISTS` over a socket. Supabase is reached over HTTP through PostgREST, which
 * cannot execute DDL at all - so schema changes belong to SQL migrations applied
 * with the Supabase CLI or dashboard, and the files in supabase/migrations/ are
 * the source of truth.
 *
 * What is left for a script to do is the genuinely useful half: tell you whether
 * the deployment you are pointing at actually has the schema the code expects,
 * and exit non-zero if not. That catches the mistake this replaces - pointing a
 * new deployment at an empty database and finding out via 500s.
 *
 * Apply migrations with:   supabase db push
 * or paste supabase/migrations/*.sql into the SQL editor.
 */

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.')
  console.error('Find them in the Supabase dashboard -> Project Settings -> API.')
  process.exit(1)
}

const { createClient } = await import('@supabase/supabase-js')
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

const problems = []

for (const table of ['licences', 'activations', 'presets']) {
  const { error } = await db.from(table).select('*', { head: true, count: 'exact' })
  if (error) {
    problems.push(`table "${table}" is not readable: ${error.message}`)
  } else {
    console.log(`  ok    table ${table}`)
  }
}

/**
 * The seat-limit check depends on this function existing, and on it deciding
 * "was this a new seat" atomically with the write. Probe it with a licence key
 * that cannot exist: a missing function reports one thing, and a present function
 * reports a foreign-key violation, which is the answer we want.
 */
const probe = await db.rpc('record_activation', {
  p_licence_key: '__schema_probe_nonexistent__',
  p_fingerprint: '__schema_probe__',
  p_app_version: null
})

if (probe.error) {
  const message = probe.error.message ?? ''
  if (/foreign key|violates/i.test(message)) {
    console.log('  ok    function record_activation (rejected an unknown licence, as it should)')
  } else if (/could not find|does not exist|not found/i.test(message)) {
    problems.push(`function record_activation is missing: ${message}`)
  } else {
    problems.push(`function record_activation failed unexpectedly: ${message}`)
  }
} else {
  // It succeeded, which means a row was written for a licence that should not
  // exist - the foreign key is missing.
  problems.push('function record_activation accepted an unknown licence key; the activations -> licences foreign key is missing')
}

/**
 * The one check worth doing that is not about the app working: if RLS is off,
 * the project's anon key - which is public by design - can read every licence
 * key ever issued. Only checkable when the anon key is available, so it warns
 * rather than failing when it is not set.
 */
const anonKey = process.env.SUPABASE_ANON_KEY
if (anonKey) {
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await anon.from('licences').select('licence_key').limit(1)
  if (error || (data ?? []).length === 0) {
    console.log('  ok    row level security (the public anon key reads nothing)')
  } else {
    problems.push('ROW LEVEL SECURITY IS NOT PROTECTING licences: the public anon key can read it')
  }
} else {
  console.log('  skip  row level security check (set SUPABASE_ANON_KEY to run it)')
}

if (problems.length > 0) {
  console.error('\nSchema check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nApply the migrations in supabase/migrations/ and run this again.')
  process.exit(1)
}

console.log('\nSchema OK.')
