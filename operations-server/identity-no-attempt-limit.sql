-- 1.58 club membership confirmation has no attempt limit.
--   festival_review_identity_self no longer counts the last hour's mismatches and never returns
--   TOO_MANY_ATTEMPTS. Mismatches and conflicts are still written to the audit log.
-- The function is patched in place so the rest of its body stays exactly as it is.
-- Bodies loaded from a Windows checkout end lines with CRLF, so the patterns accept either ending.
-- ORBIT's orbit_* functions and private.* helpers are not changed. Requested 2026-11-04.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $patch$
declare def text; next text;
begin
  def := pg_get_functiondef('public.festival_review_identity_self(text,jsonb)'::regprocedure);
  next := replace(def, 'identity jsonb; failures integer; result text;', 'identity jsonb; result text;');
  next := regexp_replace(next, $s$      select count\(\*\) into failures from festival_ops\.audit where event_id=e and actor_id=u\r?\n        and action in \('review_identity_self_mismatch','review_identity_self_conflict'\) and created_at>now\(\)-interval '1 hour';\r?\n$s$, '');
  next := regexp_replace(next, $s$      if failures>=5 then result:='TOO_MANY_ATTEMPTS';\r?\n      elsif roster\.student_number is null $s$, '      if roster.student_number is null ');
  if position('failures' in next) > 0 then raise exception 'festival_review_identity_self: anchor not found'; end if;
  execute next;
end $patch$;

notify pgrst, 'reload schema';
commit;
