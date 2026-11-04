-- 1.53 club membership is confirmed at sign-up and cannot be skipped.
--   festival_ops.identity_required(me) - true for a participant (not an operator) whose sign-up 학번 is
--     1st/2nd grade while the current event has a ready club roster, until the membership is confirmed.
--     The app keeps such a student on the sign-up screen; the server refuses their stamp claims.
--   festival_review_identity_self       - also returns 'required'.
--   festival_nfc_private.claim, festival_sun_claim - raise IDENTITY_REQUIRED for such a student.
-- The functions are patched in place (one line each) so the rest of each body stays exactly as it is.
-- Bodies loaded from a Windows checkout end lines with CRLF, so the patch reuses the line ending it finds.
-- ORBIT's orbit_* functions and private.* helpers are not changed. Requested 2026-11-04.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function festival_ops.identity_required(me jsonb) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare u integer := (me->>'id')::integer; sid text := me->>'studentNumber'; e uuid;
begin
  if u is null or coalesce((me->>'needsProfile')::boolean, true) or coalesce((me->>'isAdmin')::boolean, false)
    or sid is null or sid !~ '^[12][0-9]{4}$' then return false; end if;
  select id into e from festival_ops.events where current;
  -- Without a ready roster there is nothing to confirm against.
  if e is null or not exists(select 1 from festival_ops.review_roster where event_id = e and status = 'ready') then return false; end if;
  return not coalesce((festival_ops.identity_state(e, u)->>'verified')::boolean, false);
end $$;
revoke all on function festival_ops.identity_required(jsonb) from public, anon, authenticated;

do $patch$
declare def text; next text;
begin
  def := pg_get_functiondef('public.festival_review_identity_self(text,jsonb)'::regprocedure);
  next := replace(def, $s$  return jsonb_build_object('version',1,'eventId',e,'result',result,'studentNumber',sid,$s$,
    $s$  return jsonb_build_object('version',1,'eventId',e,'result',result,'studentNumber',sid,'required',festival_ops.identity_required(me),$s$);
  if next = def then raise exception 'festival_review_identity_self: anchor not found'; end if;
  execute next;

  def := pg_get_functiondef('festival_nfc_private.claim(text)'::regprocedure);
  next := regexp_replace(def, $s$(message = 'PROFILE_REQUIRED';\r?\n  end if;)(\r?\n)$s$,
    $s$\1\2  if festival_ops.identity_required(me) then raise exception using errcode = '42501', message = 'IDENTITY_REQUIRED'; end if;\2$s$);
  if next = def then raise exception 'festival_nfc_private.claim: anchor not found'; end if;
  execute next;

  def := pg_get_functiondef('public.festival_sun_claim(jsonb,uuid)'::regprocedure);
  next := regexp_replace(def, $s$(  if coalesce\(\(me->>'needsProfile'\)::boolean, true\) then raise exception 'PROFILE_REQUIRED'; end if;)(\r?\n)$s$,
    $s$\1\2  if festival_ops.identity_required(me) then raise exception 'IDENTITY_REQUIRED'; end if;\2$s$);
  if next = def then raise exception 'festival_sun_claim: anchor not found'; end if;
  execute next;
end $patch$;

notify pgrst, 'reload schema';
commit;
