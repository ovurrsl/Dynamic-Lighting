-- The MySQL version of recordActivation() relied on a driver detail:
--
--   INSERT ... ON DUPLICATE KEY UPDATE ...   -- affectedRows is 1 for a fresh
--                                            -- insert and 2 for an update
--
-- and the comment on it explains why that mattered: the seat-limit check
-- records first, then counts, then rolls back if it went over. Counting before
-- inserting would let two simultaneous activations both see a free seat and
-- both take it.
--
-- PostgREST cannot express "upsert and tell me whether you inserted" in one
-- round trip, and doing it as upsert-then-select reintroduces exactly the race
-- the original was written to avoid. So the operation moves into the database,
-- where it is one statement and genuinely atomic.
--
-- `xmax = 0` is the Postgres equivalent of the affectedRows trick: for a row
-- produced by the INSERT arm, xmax is 0; for one produced by the DO UPDATE arm,
-- it carries the updating transaction id.
create or replace function public.record_activation (
  p_licence_key varchar(64),
  p_fingerprint varchar(128),
  p_app_version varchar(32) default null
)
returns boolean
language plpgsql
-- security definer so the function can write through RLS without granting the
-- caller direct table access. search_path is pinned because a security definer
-- function with a mutable search_path is a privilege-escalation vector.
security definer
set search_path = public, pg_temp
as $$
declare
  v_created boolean;
begin
  insert into activations (licence_key, fingerprint, app_version)
  values (p_licence_key, p_fingerprint, p_app_version)
  on conflict (licence_key, fingerprint) do update
    set app_version = coalesce(excluded.app_version, activations.app_version),
        last_seen    = now()
  returning (xmax = 0) into v_created;

  return v_created;
end;
$$;

-- Only the API may call this. The anon key is public by design, and this
-- function writes through RLS.
revoke all on function public.record_activation(varchar, varchar, varchar) from public;
revoke all on function public.record_activation(varchar, varchar, varchar) from anon, authenticated;
grant execute on function public.record_activation(varchar, varchar, varchar) to service_role;
