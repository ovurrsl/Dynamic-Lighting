-- AmbiFlux licensing schema, ported from the MySQL DDL in the previous
-- server/src/storage/mysql.js.
--
-- Four deliberate differences from the MySQL original:
--
-- 1. jsonb, not JSON. Postgres jsonb is parsed on write, so the readJson()
--    normaliser the MySQL driver needed (it returned JSON columns as an object
--    on some versions and a string on others) is no longer necessary.
-- 2. timestamptz, not TIMESTAMP. MySQL TIMESTAMP is stored UTC but returned in
--    the session timezone; timestamptz removes the ambiguity from token
--    expiry maths.
-- 3. No ON UPDATE CURRENT_TIMESTAMP on presets.updated_at - Postgres has no
--    declarative equivalent. The upsert sets it explicitly instead, which keeps
--    the behaviour visible in the query rather than hidden in a trigger. The
--    API is the only writer.
-- 4. varchar lengths kept rather than widened to text. They are redundant with
--    the request validation, and that is the point: defence in depth costs
--    nothing here.

create table if not exists licences (
  licence_key varchar(64)  primary key,
  tier        varchar(32)  not null default 'pro',
  max_seats   integer      not null default 3,
  status      varchar(16)  not null default 'active',
  features    jsonb,
  created_at  timestamptz  not null default now()
);

create table if not exists activations (
  licence_key varchar(64)  not null references licences (licence_key) on delete cascade,
  fingerprint varchar(128) not null,
  app_version varchar(32),
  first_seen  timestamptz  not null default now(),
  last_seen   timestamptz  not null default now(),
  primary key (licence_key, fingerprint)
);

create table if not exists presets (
  licence_key varchar(64)  not null references licences (licence_key) on delete cascade,
  preset_id   varchar(64)  not null,
  name        varchar(128) not null,
  payload     jsonb        not null,
  updated_at  timestamptz  not null default now(),
  primary key (licence_key, preset_id)
);

-- listActivations and listPresets both filter on licence_key alone. The
-- composite primary keys already cover that as a leading-column prefix, so no
-- extra index is needed and adding one would only cost write throughput.

-- == Row Level Security =====================================================
--
-- This is not optional here, and it is the one thing that would have been a
-- real vulnerability if skipped.
--
-- Supabase exposes every table in the `public` schema through PostgREST using
-- the anon key, and the anon key is designed to be public. With RLS off, anyone
-- holding it could `select * from licences` and walk away with every licence
-- key we have ever issued.
--
-- RLS is enabled with NO policies, which denies everything by default. The API
-- connects with the service role, which bypasses RLS, so the application is
-- unaffected. If the anon key ever leaks, it reads nothing. Verified both ways:
-- the service role reads and writes, `set role anon` sees zero rows.
alter table licences    enable row level security;
alter table activations enable row level security;
alter table presets     enable row level security;

-- Force it for the table owner too, so a future migration run as the owner
-- cannot silently read around the policy set.
alter table licences    force row level security;
alter table activations force row level security;
alter table presets     force row level security;
