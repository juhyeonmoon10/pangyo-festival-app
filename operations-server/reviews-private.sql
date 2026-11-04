-- 1.54 star ratings and written reviews are private by default. Requested 2026-11-04.
--   Other participants' ratings, review text, counts, averages and star distribution are shown only to
--   operators (users.admin) until an operator turns on festival_ops.events.reviews_public in 관리 마법사
--   (축제 운영 설정). Everyone always sees their own review.
--   festival_ops.reviews_visible(e,u)    - new helper: operator, or the event's reviews are public.
--   festival_ops.review_summary          - booth detail and review list; adds 'visible'.
--   festival_ops_read('catalog')         - per-booth average rating is null while private (one line).
--   festival_ops_write('event_save')     - also saves reviewsPublic when it is a boolean (one line).
--   festival_nfc_private.booth_reviews   - legacy path (no current event): operators only.
-- Direct table reads were already closed (festival_ops is not exposed; booth_ratings is own-or-admin).
-- ORBIT's orbit_* functions, private.* helpers and public.booth_ratings are not changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table festival_ops.events add column reviews_public boolean not null default false;

create function festival_ops.reviews_visible(e uuid, u integer) returns boolean
language sql stable set search_path='' as $$
  select coalesce((select admin from public.users where id = u), false)
    or coalesce((select reviews_public from festival_ops.events where id = e), false);
$$;
revoke all on function festival_ops.reviews_visible(uuid, integer) from public, anon, authenticated;

-- While private the summary holds only the caller's own review, so its count, average and
-- distribution say nothing about anyone else.
create or replace function festival_ops.review_summary(e uuid, u integer, b text) returns jsonb
language sql set search_path='' as $$
 select jsonb_build_object('boothKey',b,'visible',v.visible,'count',count(r.rating),'average',round(avg(r.rating),1),
   'reviewPolicy',festival_ops.review_policy(e,u,b),
   'distribution',jsonb_build_object('5',count(*) filter(where r.rating=5),'4',count(*) filter(where r.rating=4),
     '3',count(*) filter(where r.rating=3),'2',count(*) filter(where r.rating=2),'1',count(*) filter(where r.rating=1)),
   'myRating',max(r.rating) filter(where r.user_id=u),'reviews',
   coalesce((select jsonb_agg(x.item order by x.ts desc) from (
     select o.created_at ts,jsonb_build_object('rating',o.rating,'content',nullif(o.content,''),
       'createdAt',o.created_at,'mine',o.user_id=u,'author',coalesce(o.author_name,'참여자')) item
     from festival_ops.reviews o where o.event_id=e and o.booth_key=b and (v.visible or o.user_id=u)
     order by o.created_at desc limit 50) x),'[]'::jsonb))
 from (select festival_ops.reviews_visible(e,u) visible) v
 left join festival_ops.reviews r on r.event_id=e and r.booth_key=b and (v.visible or r.user_id=u)
 group by v.visible;
$$;
revoke all on function festival_ops.review_summary(uuid, integer, text) from public, anon, authenticated;

create or replace function festival_nfc_private.booth_reviews(p_booth text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  me jsonb;
  booth public.booth_enum;
  mine integer;
  summary record;
  items jsonb;
  visible boolean;
  u integer;
begin
  me := festival_nfc_private.current_profile();
  u := (me->>'id')::integer;
  if p_booth is null or length(p_booth) > 120
    or not exists(select 1 from public.booths where id::text = p_booth) then
    raise exception using errcode = '22023', message = 'BOOTH_NOT_FOUND';
  end if;
  booth := p_booth::public.booth_enum;
  visible := festival_ops.reviews_visible((select id from festival_ops.events where current), u);
  select count(*)::int as count, round(avg(rating)::numeric, 1) as average
    into summary from public.booth_ratings where booth_id = booth and (visible or user_id = u);
  select rating into mine from public.booth_ratings
    where booth_id = booth and user_id = u;
  select coalesce(jsonb_agg(row order by row->>'createdAt' desc), '[]'::jsonb) into items from (
    select jsonb_build_object('rating', r.rating, 'content', r.content,
      'createdAt', r.created_at, 'author', festival_nfc_private.display_name(u2.name),
      'mine', r.user_id = u) as row
    from public.booth_ratings r left join public.users u2 on u2.id = r.user_id
    where r.booth_id = booth and (visible or r.user_id = u) order by r.created_at desc limit 50
  ) recent;
  return jsonb_build_object('boothKey', booth, 'visible', visible, 'count', coalesce(summary.count, 0),
    'average', summary.average, 'myRating', mine, 'reviews', items);
end $function$;

do $patch$
declare def text; next text;
begin
  def := pg_get_functiondef('public.festival_ops_read(text,jsonb)'::regprocedure);
  next := replace(def, $s$(select round(avg(r.rating),1) from festival_ops.reviews r where r.event_id=e.id and r.booth_key=b.key))$s$,
    $s$case when admin or e.reviews_public then (select round(avg(r.rating),1) from festival_ops.reviews r where r.event_id=e.id and r.booth_key=b.key) end)$s$);
  if next = def then raise exception 'festival_ops_read: anchor not found'; end if;
  execute next;

  def := pg_get_functiondef('public.festival_ops_write(text,jsonb,uuid)'::regprocedure);
  next := replace(def, $s$review_points=(p_payload->>'reviewPoints')::integer,version=version+1 where id=e.id returning * into e;$s$,
    $s$review_points=(p_payload->>'reviewPoints')::integer,reviews_public=coalesce(case when jsonb_typeof(p_payload->'reviewsPublic')='boolean' then (p_payload->>'reviewsPublic')::boolean end,reviews_public),version=version+1 where id=e.id returning * into e;$s$);
  if next = def then raise exception 'festival_ops_write: anchor not found'; end if;
  execute next;
end $patch$;

notify pgrst, 'reload schema';
commit;
