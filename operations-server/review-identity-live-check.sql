-- Synthetic integration checks only. The final ROLLBACK is mandatory.
-- No real account is impersonated or linked. No authentication email is sent.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $test$
declare
 e uuid; admin_uid uuid:=gen_random_uuid(); student_uid uuid:=gen_random_uuid(); other_uid uuid:=gen_random_uuid();
 admin_session uuid:=gen_random_uuid(); student_session uuid:=gen_random_uuid(); other_session uuid:=gen_random_uuid();
 admin_id integer:=-2147000001; student_id integer:=-2147000002; other_id integer:=-2147000003;
 own_booth text; away_booth text; catalog text[]; r jsonb; r2 jsonb; req uuid:=gen_random_uuid();
 checks text[]:='{}'; sid text:='19998'; before_ledger integer;
begin
 select id into strict e from festival_ops.events where current and state='open';
 select array_agg(key order by key collate "C") into catalog from festival_ops.booths where event_id=e;
 own_booth:=catalog[1]; away_booth:=catalog[2];
 if cardinality(catalog)<2 or exists(select 1 from public.users where id in (admin_id,student_id,other_id))
   or exists(select 1 from festival_ops.review_roster where event_id=e and student_number=sid) then
   raise exception 'SYNTHETIC_FIXTURE_COLLISION'; end if;
 if has_schema_privilege('anon','festival_ops','usage') or has_schema_privilege('authenticated','festival_ops','usage')
   or has_table_privilege('anon','festival_ops.review_roster','select')
   or has_table_privilege('authenticated','festival_ops.review_roster','select')
   or has_table_privilege('authenticated','festival_ops.review_identities','select') then raise exception 'ROSTER_EXPOSURE'; end if;
 if has_function_privilege('anon','public.festival_review_identity_admin(text,jsonb)','execute') then raise exception 'ANON_ADMIN_RPC'; end if;
 checks:=array_append(checks,'Private roster tables and anonymous RPC access denied');
 -- Null email makes the inspected on_auth_user_created trigger a no-op.
 insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
 select x,null,now(),'{"provider":"google"}','{"festival_name":"Synthetic display","festival_student_number":"19998"}'
 from unnest(array[admin_uid,student_uid,other_uid]) x;
 update auth.users set email=id::text||'@example.invalid' where id in(admin_uid,student_uid,other_uid);
 insert into public.users(id,auth_user_id,email,name,admin,money) overriding system value values
 (admin_id,admin_uid,admin_uid::text||'@example.invalid','Synthetic admin',true,0),
 (student_id,student_uid,student_uid::text||'@example.invalid','Synthetic student',false,0),
 (other_id,other_uid,other_uid::text||'@example.invalid','Synthetic other',false,0);
 insert into auth.sessions(id,user_id) values(admin_session,admin_uid),(student_session,student_uid),(other_session,other_uid);
 insert into festival_ops.review_roster(event_id,student_number,real_name,clubs,booth_keys,status,issues,source_cells,source_sha256,catalog_keys)
 values(e,sid,'Verified Synthetic',array['Synthetic Club'],array[own_booth],'ready','{}',array['Synthetic!A1'],repeat('0',64),catalog);
 insert into festival_ops.visits(event_id,user_id,booth_key,method,actor_id,reason)
 select e,student_id,b,'manual',admin_id,'Synthetic transaction-only check' from unnest(array[own_booth,away_booth]) b;

 perform set_config('request.jwt.claims',jsonb_build_object('sub',student_uid,'session_id',student_session,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 begin
   perform public.festival_review_identity_admin('lookup',jsonb_build_object('eventId',e,'userId',student_id,'studentNumber',sid));
   raise exception 'EXPECTED_ADMIN_REQUIRED';
 exception when others then if sqlerrm<>'ADMIN_REQUIRED' then raise; end if; end;
 checks:=array_append(checks,'Student cannot look up the official roster');
 begin
   perform public.festival_ops_write('review_save',jsonb_build_object('booth',away_booth,'rating',5),gen_random_uuid());
   raise exception 'EXPECTED_IDENTITY_REQUIRED';
 exception when others then if sqlerrm<>'REVIEW_IDENTITY_REQUIRED' then raise; end if; end;
 checks:=array_append(checks,'Unverified student review denied');

 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_uid,'session_id',admin_session,'role','authenticated')::text,true);
 begin
   perform public.festival_review_identity_admin('save',jsonb_build_object('eventId',e,'userId',admin_id,'studentNumber',sid,'version',0,'rosterVersion',1,'confirmed',true,'reason','Synthetic independent check'));
   raise exception 'EXPECTED_SELF_ADJUSTMENT';
 exception when others then if sqlerrm<>'SELF_ADJUSTMENT' then raise; end if; end;
 checks:=array_append(checks,'Admin cannot verify their own identity');
 r:=public.festival_review_identity_admin('save',jsonb_build_object('eventId',e,'userId',student_id,'studentNumber',sid,'version',0,'rosterVersion',1,'confirmed',true,'reason','Synthetic independent check','realName','Forged browser name','boothKeys','[]'::jsonb));
 if r->>'realName'<>'Verified Synthetic' or not (r->>'verified')::boolean then raise exception 'OFFICIAL_NAME_NOT_USED'; end if;
 checks:=array_append(checks,'Verified name and affiliation override client input');
 begin
   perform public.festival_review_identity_admin('save',jsonb_build_object('eventId',e,'userId',other_id,'studentNumber',sid,'version',0,'rosterVersion',1,'confirmed',true,'reason','Synthetic duplicate account check'));
   raise exception 'EXPECTED_DUPLICATE_IDENTITY';
 exception when others then if sqlerrm<>'ROSTER_ALREADY_LINKED' then raise; end if; end;
 checks:=array_append(checks,'Same roster entry cannot link to two accounts');

 perform set_config('request.jwt.claims',jsonb_build_object('sub',student_uid,'session_id',student_session,'role','authenticated')::text,true);
 foreach r in array array[jsonb_build_object('booth',own_booth,'rating',5),jsonb_build_object('booth',own_booth,'rating',5,'content','Synthetic text')] loop
   begin
     perform public.festival_ops_write('review_save',r,gen_random_uuid());
     raise exception 'EXPECTED_OWN_CLUB_DENIAL';
   exception when others then if sqlerrm<>'OWN_CLUB_REVIEW' then raise; end if; end;
 end loop;
 checks:=array_append(checks,'Own-club star-only and written reviews denied');
 r:=public.festival_ops_write('review_save',jsonb_build_object('booth',away_booth,'rating',5,'content','Synthetic review'),req);
 r2:=public.festival_ops_write('review_save',jsonb_build_object('booth',away_booth,'rating',5,'content','Synthetic review'),req);
 if r is distinct from r2 or r#>>'{reviews,0,author}'<>'Verified Synthetic' then raise exception 'NAME_OR_RETRY_MISMATCH'; end if;
 if r::text like '%example.invalid%' or r::text like '%19998%' then raise exception 'REVIEW_PII_EXCESS'; end if;
 checks:=array_append(checks,'Unrelated review saves real-name snapshot without student number or email');
 checks:=array_append(checks,'Exact retry returns the same result');
 execute 'reset role';
 if (select count(*) from festival_ops.reviews where user_id=student_id)<>1
   or (select count(*) from festival_ops.ledger where user_id=student_id)>1
   or (select count(*) from festival_ops.visits where user_id=student_id)<>2 then raise exception 'INTEGRITY_MISMATCH'; end if;
 checks:=array_append(checks,'Review retry does not duplicate reward and denied reviews preserve visits');
 update public.users set completed_booths=array[own_booth]::public.booth_enum[] where id=student_id;
 execute 'set local role authenticated';
 begin
   perform public.festival_review_submit(own_booth,5,null);
   raise exception 'EXPECTED_LEGACY_DENIAL';
 exception when others then if sqlerrm<>'REVIEW_POLICY_REQUIRED' then raise; end if; end;
 checks:=array_append(checks,'Legacy review RPC cannot bypass real-name checks');

 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_uid,'session_id',admin_session,'role','authenticated')::text,true);
 perform public.festival_review_identity_admin('revoke',jsonb_build_object('eventId',e,'userId',student_id,'version',1,'reason','Synthetic revocation check'));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',student_uid,'session_id',student_session,'role','authenticated')::text,true);
 r:=public.festival_ops_read('reviews',jsonb_build_object('booth',away_booth));
 if r#>>'{reviewPolicy,reason}'<>'REVIEW_IDENTITY_REQUIRED' then raise exception 'REVOKE_NOT_EFFECTIVE'; end if;
 checks:=array_append(checks,'Revocation blocks the next review request');
 execute 'reset role';
 update auth.sessions set not_after=now()-interval '1 minute' where id=admin_session;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_uid,'session_id',admin_session,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 begin
   perform public.festival_review_identity_admin('get',jsonb_build_object('eventId',e,'userId',student_id));
   raise exception 'EXPECTED_EXPIRED_SESSION';
 exception when others then if sqlerrm<>'GOOGLE_AUTH_REQUIRED' then raise; end if; end;
 checks:=array_append(checks,'Expired administrator session denied');
 execute 'reset role';
 perform set_config('festival.test_result',jsonb_build_object('passed',cardinality(checks),'checks',checks,'syntheticOnly',true,'rolledBack',true)::text,true);
end $test$;
select current_setting('festival.test_result')::jsonb as verification;
rollback;
