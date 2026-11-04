-- Rolls back club-booths-added.sql: removes the five booths (festival_ops.booths and public.booths) and their
-- keys from the roster and from confirmed memberships, which stay confirmed. Refuses once a booth has visits,
-- reviews, NFC tags, security cards, managers, ratings or stocks, because removing it then would lose records.
-- The five public.booth_enum values stay: Postgres cannot drop an enum value, and nothing uses them afterwards.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $m$
declare e uuid; actor integer; old_catalog text[]; new_catalog text[]; kept integer;
  added text[] := array['바이오 브릿지','스크린에세이스트','수학창의탐구반','미디어비평반','축구반'];
begin
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  if (select count(*) from festival_ops.booths where event_id=e and key=any(added)) <> cardinality(added) then raise exception 'CLUB_BOOTHS_NOT_ADDED'; end if;
  if exists(select 1 from festival_ops.visits where event_id=e and booth_key=any(added))
    or exists(select 1 from festival_ops.reviews where event_id=e and booth_key=any(added))
    or exists(select 1 from festival_ops.booth_managers where event_id=e and booth_key=any(added))
    or exists(select 1 from festival_nfc_private.tags where booth::text=any(added))
    or exists(select 1 from festival_nfc_private.sun_cards where booth::text=any(added))
    or exists(select 1 from public.booth_ratings where booth_id::text=any(added))
    or exists(select 1 from public.stock where booth_id::text=any(added))
    or exists(select 1 from private.booth_nfc_tokens where booth_id::text=any(added)) then raise exception 'CLUB_BOOTHS_IN_USE'; end if;
  select a.actor_id into actor from festival_ops.audit a join public.users u on u.id=a.actor_id and u.admin
    where a.event_id=e and a.action='maintenance_club_booths_added' order by a.created_at desc limit 1;
  if actor is null then raise exception 'ADMIN_REQUIRED'; end if;

  select coalesce(array_agg(key order by key collate "C"),'{}') into new_catalog from festival_ops.booths where event_id=e;
  create temp table club_booths_kept on commit drop as
    select i.user_id from festival_ops.review_identities i
      join festival_ops.review_roster r on r.event_id=i.event_id and r.student_number=i.student_number
      where i.event_id=e and i.verified and r.status='ready' and i.roster_version=r.version and r.catalog_keys=new_catalog;

  delete from festival_ops.booths where event_id=e and key=any(added);
  delete from public.booths where id::text=any(added);
  select coalesce(array_agg(key order by key collate "C"),'{}') into old_catalog from festival_ops.booths where event_id=e;
  update festival_ops.review_roster r set catalog_keys=old_catalog,
      booth_keys=array(select k from unnest(r.booth_keys) k where k<>all(added) order by k collate "C"),
      version=r.version+1, updated_at=now()
    where r.event_id=e;
  update festival_ops.review_identities i set roster_version=r.version,
      booth_keys=array(select k from unnest(i.booth_keys) k where k<>all(added) order by k collate "C"),
      updated_at=now()
    from festival_ops.review_roster r
    where i.event_id=e and r.event_id=e and r.student_number=i.student_number
      and i.user_id in (select user_id from club_booths_kept);
  get diagnostics kept = row_count;
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(e,actor,'maintenance_club_booths_removed',array_to_string(added,', '),format('Removed %s booths; %s confirmed accounts kept',cardinality(added),kept));
end $m$;

notify pgrst, 'reload schema';
commit;
