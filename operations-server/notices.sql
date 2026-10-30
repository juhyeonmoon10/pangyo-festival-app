-- Approved 2026-10-30: festival notices written by operators and shown on every participant's home.
-- Apply after booth-bulk-and-tag-register.sql. Participants read only published notices of the
-- current festival; operators list, create, edit, hide and delete them. Every change is audited.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(170926,1);

create table festival_ops.notices(
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references festival_ops.events(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 80),
  body text not null default '' check (length(body) <= 1000),
  important boolean not null default false,
  published boolean not null default true,
  version integer not null default 1,
  created_by integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notices_event_idx on festival_ops.notices(event_id, created_at desc);
alter table festival_ops.notices enable row level security;
revoke all on festival_ops.notices from public, anon, authenticated;

-- Participants: published notices, important ones first, newest first.
create function public.festival_notices() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare me jsonb; e uuid;
begin
  me:=festival_nfc_private.current_profile();
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'title',n.title,'body',n.body,
      'important',n.important,'publishedAt',n.created_at,'updatedAt',n.updated_at) order by n.important desc,n.created_at desc)
    from (select * from festival_ops.notices where event_id=e and published order by important desc,created_at desc limit 20) n),'[]'::jsonb));
end $$;
revoke all on function public.festival_notices() from public,anon,authenticated;
grant execute on function public.festival_notices() to authenticated;

create function public.festival_notice_admin(p_action text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me jsonb; u integer; e uuid; n festival_ops.notices; v_title text; v_body text; nid uuid;
begin
  if p_action is null or p_action not in ('list','save','delete') or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or length(p_payload::text)>4000 then raise exception 'INVALID_INPUT'; end if;
  me:=festival_nfc_private.current_profile(); u:=(me->>'id')::integer;
  if coalesce((me->>'needsProfile')::boolean,true) then raise exception 'PROFILE_REQUIRED'; end if;
  if not coalesce((me->>'isAdmin')::boolean,false) then raise exception 'ADMIN_REQUIRED'; end if;
  select id into e from festival_ops.events where current;
  if e is null then raise exception 'OPS_NOT_READY'; end if;
  if p_action in ('save','delete') then
    perform pg_catalog.pg_advisory_xact_lock(170926,1);
    nid:=nullif(p_payload->>'id','')::uuid;
    if nid is not null then
      select * into n from festival_ops.notices where id=nid and event_id=e for update;
      if n.id is null then raise exception 'NOT_FOUND'; end if;
      if (p_payload->>'version')::integer is distinct from n.version then raise exception 'VERSION_CONFLICT'; end if;
    elsif p_action='delete' then raise exception 'NOT_FOUND';
    end if;
  end if;
  if p_action='save' then
    v_title:=btrim(coalesce(p_payload->>'title','')); v_body:=btrim(coalesce(p_payload->>'body',''));
    if length(v_title) not between 1 and 80 or length(v_body)>1000
      or jsonb_typeof(p_payload->'important') is distinct from 'boolean' or jsonb_typeof(p_payload->'published') is distinct from 'boolean' then
      raise exception 'INVALID_INPUT'; end if;
    if nid is null then
      insert into festival_ops.notices(event_id,title,body,important,published,created_by)
        values(e,v_title,v_body,(p_payload->>'important')::boolean,(p_payload->>'published')::boolean,u) returning * into n;
    else
      update festival_ops.notices set title=v_title,body=v_body,
        important=(p_payload->>'important')::boolean,published=(p_payload->>'published')::boolean,version=version+1,updated_at=now()
        where id=nid returning * into n;
    end if;
    insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e,u,case when nid is null then 'notice_create' else 'notice_save' end,n.id::text,left(n.title,80));
  elsif p_action='delete' then
    delete from festival_ops.notices where id=nid;
    insert into festival_ops.audit(event_id,actor_id,action,target,reason) values(e,u,'notice_delete',nid::text,left(n.title,80));
  end if;
  return jsonb_build_object('id',case when p_action='save' then n.id end,
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'body',x.body,'important',x.important,
      'published',x.published,'version',x.version,'createdAt',x.created_at,'updatedAt',x.updated_at,'author',coalesce(pu.name,'운영자'))
      order by x.created_at desc) from festival_ops.notices x left join public.users pu on pu.id=x.created_by where x.event_id=e),'[]'::jsonb));
end $$;
revoke all on function public.festival_notice_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.festival_notice_admin(text,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
