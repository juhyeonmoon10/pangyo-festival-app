-- 2026-11-04 the club roster names five clubs that had no booth: 바이오 브릿지, 스크린에세이스트, 수학창의탐구반,
-- 미디어비평반, 축구반. This adds them to ORBIT's booth list and the current event's booth list and links their
-- members. The owner chose to add them to ORBIT's list too, so NFC tags and security cards can be issued.
--   public.booth_enum, public.booths - five new values and rows (rating 0, no position). Enum values cannot be
--                                  removed later; the rollback leaves them unused. public.stock is not changed.
--   festival_ops.booths          - five booths linked by legacy_key, open, floor 1, no location yet (the app
--                                  shows "위치 미등록" until an operator places them in 관리 마법사).
--   festival_ops.review_roster   - every row gets the new catalog; members of the five clubs get the new
--                                  booth key, so their own-club review and stamp limits apply.
--   festival_ops.review_identities - a membership that was confirmed before stays confirmed (its roster
--                                  version moves with the roster) and gains the new booth key.
-- A roster re-import would instead drop every confirmation, which is why this is a dedicated step.
-- Student records are only changed in place; nothing is printed or copied. Requested 2026-11-04.
-- Part 1 commits the enum values on their own: a new enum value cannot be used in the transaction that adds it.
begin;
alter type public.booth_enum add value if not exists '바이오 브릿지';
alter type public.booth_enum add value if not exists '스크린에세이스트';
alter type public.booth_enum add value if not exists '수학창의탐구반';
alter type public.booth_enum add value if not exists '미디어비평반';
alter type public.booth_enum add value if not exists '축구반';
commit;

-- Part 2
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $m$
declare e uuid; actor integer; old_catalog text[]; new_catalog text[];
  added text[] := array['바이오 브릿지','스크린에세이스트','수학창의탐구반','미디어비평반','축구반'];
  kept integer; linked integer; members integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(170926,1);
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  if exists(select 1 from festival_ops.booths where event_id=e and key=any(added)) then raise exception 'CLUB_BOOTHS_ALREADY_ADDED'; end if;
  -- The owner who imported the roster signs the change.
  select a.actor_id into actor from festival_ops.audit a join public.users u on u.id=a.actor_id and u.admin
    where a.event_id=e and a.action='maintenance_review_roster_import' order by a.created_at desc limit 1;
  if actor is null then raise exception 'ADMIN_REQUIRED'; end if;

  select coalesce(array_agg(key order by key collate "C"),'{}') into old_catalog from festival_ops.booths where event_id=e;
  -- Confirmations that are valid now (same rule as festival_ops.identity_state).
  create temp table club_booths_kept on commit drop as
    select i.user_id from festival_ops.review_identities i
      join festival_ops.review_roster r on r.event_id=i.event_id and r.student_number=i.student_number
      where i.event_id=e and i.verified and r.status='ready' and i.roster_version=r.version and r.catalog_keys=old_catalog;

  insert into public.booths(id,name) select k::public.booth_enum,k from unnest(added) k on conflict (id) do nothing;
  insert into festival_ops.booths(event_id,key,legacy_key,name,location,description,floor,status)
    select e,k,k::public.booth_enum,k,'','',1,'open' from unnest(added) k;
  select coalesce(array_agg(key order by key collate "C"),'{}') into new_catalog from festival_ops.booths where event_id=e;

  -- Roster clubs are stored without spaces ("바이오브릿지").
  update festival_ops.review_roster r set catalog_keys=new_catalog,
      booth_keys=(select coalesce(array_agg(k order by k collate "C"),'{}') from (select distinct k from unnest(r.booth_keys
        || array(select a from unnest(added) a where replace(a,' ','')=any(r.clubs))) k) d),
      version=r.version+1, updated_at=now()
    where r.event_id=e;
  update festival_ops.review_identities i set roster_version=r.version,
      booth_keys=(select coalesce(array_agg(k order by k collate "C"),'{}') from (select distinct k from unnest(i.booth_keys
        || array(select a from unnest(added) a where replace(a,' ','')=any(r.clubs))) k) d),
      updated_at=now()
    from festival_ops.review_roster r
    where i.event_id=e and r.event_id=e and r.student_number=i.student_number
      and i.user_id in (select user_id from club_booths_kept);
  get diagnostics kept = row_count;
  if kept <> (select count(*) from club_booths_kept) then raise exception 'CLUB_BOOTHS_LINK_MISMATCH'; end if;

  select count(*) into members from festival_ops.review_roster where event_id=e and booth_keys && added;
  select count(*) into linked from festival_ops.review_identities where event_id=e and verified and booth_keys && added;
  insert into festival_ops.audit(event_id,actor_id,action,target,reason)
    values(e,actor,'maintenance_club_booths_added',array_to_string(added,', '),
      format('Added %s booths; %s roster members linked; %s confirmed accounts kept (%s with a new booth)',
        cardinality(added),members,kept,linked));
end $m$;

notify pgrst, 'reload schema';
commit;
