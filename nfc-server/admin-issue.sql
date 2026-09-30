-- DRAFT: administrator tag issuance RPC for the personal festival app.
-- Apply only AFTER install.sql and only with explicit approval. No new tables, columns, or policies.
-- Authorization comes from the existing public.users.admin flag of the caller's own row;
-- Auth metadata is never used for the admin decision.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if not exists(select 1 from pg_namespace where nspname = 'festival_nfc_private')
    or to_regprocedure('festival_nfc_private.issue_tag(public.booth_enum, timestamptz)') is null
    or to_regprocedure('festival_nfc_private.current_profile()') is null then
    raise exception 'NFC_INSTALL_REQUIRED_FIRST';
  end if;
  if to_regprocedure('public.festival_nfc_admin_issue(text, integer)') is not null
    or to_regprocedure('festival_nfc_private.admin_issue(text, integer)') is not null then
    raise exception 'NFC_ADMIN_ISSUE_ALREADY_INSTALLED_REVIEW_BEFORE_UPDATING';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'users' and column_name = 'admin' and data_type = 'boolean') then
    raise exception 'USERS_ADMIN_FLAG_MISSING';
  end if;
end $$;

-- Same account checks as claim (Google provider, confirmed email, live session), then the admin flag.
-- Runs as the function owner so it can reach the Vault through issue_tag; students only ever get
-- the two error codes below or a token for an existing booth.
create function festival_nfc_private.admin_issue(p_booth text, p_valid_minutes integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb;
  is_admin boolean;
  booth public.booth_enum;
  expires timestamptz;
  token text;
begin
  me := festival_nfc_private.current_profile();
  select admin into is_admin from public.users
    where id = (me->>'id')::integer and auth_user_id = auth.uid();
  if coalesce(is_admin, false) is not true then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  if p_valid_minutes is null or p_valid_minutes < 1 or p_valid_minutes > 7 * 24 * 60 then
    raise exception using errcode = '22023', message = 'INVALID_TAG_ISSUE_REQUEST';
  end if;
  if p_booth is null or length(p_booth) > 120
    or not exists(select 1 from public.booths where id::text = p_booth) then
    raise exception using errcode = '22023', message = 'NFC_TAG_INVALID';
  end if;
  booth := p_booth::public.booth_enum;
  expires := date_trunc('second', now()) + make_interval(mins => p_valid_minutes);
  token := festival_nfc_private.issue_tag(booth, expires);
  return jsonb_build_object('token', token, 'boothKey', booth, 'expiresAt', expires,
    'issuedAt', now(), 'validMinutes', p_valid_minutes);
end $$;

create function public.festival_nfc_admin_issue(p_booth text, p_valid_minutes integer) returns jsonb
language sql security invoker set search_path = '' as $$
  select festival_nfc_private.admin_issue(p_booth, p_valid_minutes);
$$;

revoke all on function festival_nfc_private.admin_issue(text, integer) from public, anon, authenticated;
revoke all on function public.festival_nfc_admin_issue(text, integer) from public, anon, authenticated;
grant execute on function festival_nfc_private.admin_issue(text, integer),
  public.festival_nfc_admin_issue(text, integer) to authenticated;

notify pgrst, 'reload schema';
commit;
