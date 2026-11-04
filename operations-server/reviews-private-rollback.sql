-- Rolls back reviews-private.sql (1.54): reviews become visible to every participant again.
-- Restores the previous definitions and drops festival_ops.events.reviews_public (the switch only).
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $patch$
declare def text; next text;
begin
  def := pg_get_functiondef('public.festival_ops_read(text,jsonb)'::regprocedure);
  next := replace(def, $s$case when admin or e.reviews_public then (select round(avg(r.rating),1) from festival_ops.reviews r where r.event_id=e.id and r.booth_key=b.key) end)$s$,
    $s$(select round(avg(r.rating),1) from festival_ops.reviews r where r.event_id=e.id and r.booth_key=b.key))$s$);
  if next = def then raise exception 'festival_ops_read: line not found'; end if;
  execute next;

  def := pg_get_functiondef('public.festival_ops_write(text,jsonb,uuid)'::regprocedure);
  next := replace(def, $s$reviews_public=coalesce(case when jsonb_typeof(p_payload->'reviewsPublic')='boolean' then (p_payload->>'reviewsPublic')::boolean end,reviews_public),$s$, '');
  if next = def then raise exception 'festival_ops_write: line not found'; end if;
  execute next;
end $patch$;

create or replace function festival_ops.review_summary(e uuid, u integer, b text) returns jsonb
language sql set search_path='' as $function$
 select jsonb_build_object('boothKey',b,'count',count(*),'average',round(avg(rating),1),
   'reviewPolicy',festival_ops.review_policy(e,u,b),
   'distribution',jsonb_build_object('5',count(*) filter(where rating=5),'4',count(*) filter(where rating=4),
     '3',count(*) filter(where rating=3),'2',count(*) filter(where rating=2),'1',count(*) filter(where rating=1)),
   'myRating',max(rating) filter(where user_id=u),'reviews',
   coalesce((select jsonb_agg(x.item order by x.ts desc) from (
     select r.created_at ts,jsonb_build_object('rating',r.rating,'content',nullif(r.content,''),
       'createdAt',r.created_at,'mine',r.user_id=u,'author',coalesce(r.author_name,'참여자')) item
     from festival_ops.reviews r where r.event_id=e and r.booth_key=b
     order by r.created_at desc limit 50) x),'[]'::jsonb))
 from festival_ops.reviews where event_id=e and booth_key=b;
$function$;

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
end $function$;

drop function festival_ops.reviews_visible(uuid, integer);
alter table festival_ops.events drop column reviews_public;

notify pgrst, 'reload schema';
commit;
