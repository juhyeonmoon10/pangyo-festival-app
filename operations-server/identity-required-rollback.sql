-- Rolls back identity-required.sql (1.53): removes the added lines and the helper.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $patch$
declare def text; next text;
begin
  def := pg_get_functiondef('public.festival_review_identity_self(text,jsonb)'::regprocedure);
  next := replace(def, $s$'required',festival_ops.identity_required(me),$s$, '');
  if next = def then raise exception 'festival_review_identity_self: line not found'; end if;
  execute next;

  def := pg_get_functiondef('festival_nfc_private.claim(text)'::regprocedure);
  next := regexp_replace(def, $s$\r?\n  if festival_ops\.identity_required\(me\) then raise exception using errcode = '42501', message = 'IDENTITY_REQUIRED'; end if;$s$, '');
  if next = def then raise exception 'festival_nfc_private.claim: line not found'; end if;
  execute next;

  def := pg_get_functiondef('public.festival_sun_claim(jsonb,uuid)'::regprocedure);
  next := regexp_replace(def, $s$\r?\n  if festival_ops\.identity_required\(me\) then raise exception 'IDENTITY_REQUIRED'; end if;$s$, '');
  if next = def then raise exception 'festival_sun_claim: line not found'; end if;
  execute next;
end $patch$;

drop function festival_ops.identity_required(jsonb);

notify pgrst, 'reload schema';
commit;
