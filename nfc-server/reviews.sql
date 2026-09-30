-- DRAFT: real booth reviews for the personal festival app.
-- Apply only AFTER install.sql and only with explicit approval.
-- Uses the existing public.booth_ratings table. One additive nullable column is required for
-- optional written feedback; existing inserts by other code keep working unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if not exists(select 1 from pg_namespace where nspname = 'festival_nfc_private')
    or to_regprocedure('festival_nfc_private.current_profile()') is null then
    raise exception 'NFC_INSTALL_REQUIRED_FIRST';
  end if;
  if to_regclass('public.booth_ratings') is null then
    raise exception 'REQUIRED_EXISTING_OBJECT_MISSING';
  end if;
  if to_regprocedure('public.festival_review_submit(text, integer, text)') is not null
    or to_regprocedure('public.festival_booth_reviews(text)') is not null
    or to_regprocedure('public.festival_my_reviews()') is not null then
    raise exception 'NFC_REVIEWS_ALREADY_INSTALLED_REVIEW_BEFORE_UPDATING';
  end if;
end $$;

-- Additive and nullable: rows written by any other code stay valid.
alter table public.booth_ratings add column if not exists content text;

-- Written feedback stays short and is never required.
do $$
begin
  if not exists(select 1 from pg_constraint where conname = 'booth_ratings_content_length') then
    alter table public.booth_ratings
      add constraint booth_ratings_content_length check (content is null or char_length(content) <= 500);
  end if;
end $$;

-- Only the first character of a student's name is published with a review.
create function festival_nfc_private.display_name(p_name text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_name is null or btrim(p_name) = '' then '학생'
    else left(btrim(p_name), 1) || repeat('○', greatest(char_length(btrim(p_name)) - 1, 0))
  end;
$$;

create function festival_nfc_private.booth_reviews(p_booth text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me jsonb;
  booth public.booth_enum;
  mine integer;
  summary record;
  items jsonb;
begin
  me := festival_nfc_private.current_profile();
  if p_booth is null or length(p_booth) > 120
    or not exists(select 1 from public.booths where id::text = p_booth) then
    raise exception using errcode = '22023', message = 'BOOTH_NOT_FOUND';
  end if;
  booth := p_booth::public.booth_enum;
  select count(*)::int as count, round(avg(rating)::numeric, 1) as average
    into summary from public.booth_ratings where booth_id = booth;
  select rating into mine from public.booth_ratings
    where booth_id = booth and user_id = (me->>'id')::integer;
  select coalesce(jsonb_agg(row order by row->>'createdAt' desc), '[]'::jsonb) into items from (
    select jsonb_build_object('rating', r.rating, 'content', r.content,
      'createdAt', r.created_at, 'author', festival_nfc_private.display_name(u.name),
      'mine', r.user_id = (me->>'id')::integer) as row
    from public.booth_ratings r left join public.users u on u.id = r.user_id
    where r.booth_id = booth order by r.created_at desc limit 50
  ) recent;
  return jsonb_build_object('boothKey', booth, 'count', coalesce(summary.count, 0),
    'average', summary.average, 'myRating', mine, 'reviews', items);
end $$;

create function festival_nfc_private.submit_review(p_booth text, p_rating integer, p_content text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me jsonb;
  booth public.booth_enum;
  content text;
  visited boolean;
begin
  me := festival_nfc_private.current_profile();
  if (me->>'needsProfile')::boolean then
    raise exception using errcode = '42501', message = 'PROFILE_REQUIRED';
  end if;
  if p_booth is null or length(p_booth) > 120
    or not exists(select 1 from public.booths where id::text = p_booth) then
    raise exception using errcode = '22023', message = 'BOOTH_NOT_FOUND';
  end if;
  booth := p_booth::public.booth_enum;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception using errcode = '22023', message = 'RATING_REQUIRED';
  end if;
  content := nullif(btrim(coalesce(p_content, '')), '');
  if char_length(coalesce(content, '')) > 500 then
    raise exception using errcode = '22023', message = 'REVIEW_TOO_LONG';
  end if;
  -- A review requires a server-recorded visit to the same booth.
  select booth = any(completed_booths) into visited from public.users
    where id = (me->>'id')::integer and auth_user_id = auth.uid();
  if coalesce(visited, false) is not true then
    raise exception using errcode = '42501', message = 'VISIT_REQUIRED';
  end if;
  begin
    insert into public.booth_ratings(user_id, booth_id, rating, content)
      values((me->>'id')::integer, booth, p_rating, content);
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'ALREADY_REVIEWED';
  end;
  return jsonb_build_object('result', 'SAVED') || festival_nfc_private.booth_reviews(p_booth);
end $$;

-- Lets the app show "which of my visits still need a star" without one request per booth.
create function festival_nfc_private.my_reviews() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me jsonb;
begin
  me := festival_nfc_private.current_profile();
  return (select coalesce(jsonb_agg(booth_id order by booth_id), '[]'::jsonb)
    from public.booth_ratings where user_id = (me->>'id')::integer);
end $$;

create function public.festival_my_reviews() returns jsonb
language sql security invoker set search_path = '' as $$
  select festival_nfc_private.my_reviews();
$$;

create function public.festival_booth_reviews(p_booth text) returns jsonb
language sql security invoker set search_path = '' as $$
  select festival_nfc_private.booth_reviews(p_booth);
$$;
create function public.festival_review_submit(p_booth text, p_rating integer, p_content text) returns jsonb
language sql security invoker set search_path = '' as $$
  select festival_nfc_private.submit_review(p_booth, p_rating, p_content);
$$;

revoke all on function festival_nfc_private.display_name(text), festival_nfc_private.my_reviews(),
  festival_nfc_private.booth_reviews(text), festival_nfc_private.submit_review(text, integer, text)
  from public, anon, authenticated;
revoke all on function public.festival_booth_reviews(text), public.festival_my_reviews(),
  public.festival_review_submit(text, integer, text) from public, anon, authenticated;
grant execute on function festival_nfc_private.booth_reviews(text), festival_nfc_private.my_reviews(),
  festival_nfc_private.submit_review(text, integer, text), public.festival_booth_reviews(text),
  public.festival_my_reviews(), public.festival_review_submit(text, integer, text)
  to authenticated;

-- OPTIONAL HARDENING, disabled by default. The existing booth_ratings insert policy does not
-- check that the student actually visited the booth, so a browser can still write a rating
-- directly and bypass festival_review_submit. Enabling the block below closes that hole but
-- BREAKS any other team's code that inserts ratings straight from the client. Decide with the
-- team before uncommenting, and record the current policy first (see precheck.sql).
--
--   revoke insert, update, delete on public.booth_ratings from anon, authenticated;

notify pgrst, 'reload schema';
commit;
