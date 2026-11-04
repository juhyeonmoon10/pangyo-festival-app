-- Rolls back identity-no-attempt-limit.sql: five mismatches in an hour return TOO_MANY_ATTEMPTS again.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $patch$
declare def text; next text;
begin
  def := pg_get_functiondef('public.festival_review_identity_self(text,jsonb)'::regprocedure);
  if position('failures' in def) > 0 then raise exception 'festival_review_identity_self: already limited'; end if;
  next := replace(def, 'identity jsonb; result text;', 'identity jsonb; failures integer; result text;');
  next := regexp_replace(next, $s$(\r?\n)(      select \* into roster from festival_ops\.review_roster where event_id=e and student_number=sid;)$s$,
    $s$\1      select count(*) into failures from festival_ops.audit where event_id=e and actor_id=u\1        and action in ('review_identity_self_mismatch','review_identity_self_conflict') and created_at>now()-interval '1 hour';\1\2$s$);
  next := regexp_replace(next, $s$(\r?\n)      if roster\.student_number is null $s$,
    $s$\1      if failures>=5 then result:='TOO_MANY_ATTEMPTS';\1      elsif roster.student_number is null $s$);
  if (length(next) - length(replace(next, 'failures', ''))) / 8 <> 3 then raise exception 'festival_review_identity_self: anchor not found'; end if;
  execute next;
end $patch$;

notify pgrst, 'reload schema';
commit;
