// Local PGlite: after rating-function-grants.sql the rating helpers cannot be called by anon or a
// signed-in user, and the booth_ratings trigger still refreshes public.booths.rating.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(process.env.PGLITE_DIR,'node_modules/@electric-sql/pglite/dist');
const {PGlite}=await import(pathToFileURL(path.join(dir,'index.js')));
const {pgcrypto}=await import(pathToFileURL(path.join(dir,'contrib/pgcrypto.js')));
const db=new PGlite({extensions:{pgcrypto}});
await db.exec(fs.readFileSync(path.join(root,'nfc-server/isolated-test/shim.sql'),'utf8'));
// The ORBIT definitions as deployed (search_path=public, SECURITY DEFINER) plus Supabase's default grants.
await db.exec(`
create or replace function public.refresh_booth_rating(target_booth public.booth_enum) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.booths set rating = coalesce((select round(avg(booth_ratings.rating)::numeric, 2)
    from public.booth_ratings where booth_ratings.booth_id = target_booth), 0) where booths.id = target_booth;
end $$;
create or replace function public.handle_booth_rating_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then perform public.refresh_booth_rating(old.booth_id); return old; end if;
  perform public.refresh_booth_rating(new.booth_id);
  if tg_op = 'UPDATE' and old.booth_id is distinct from new.booth_id then perform public.refresh_booth_rating(old.booth_id); end if;
  return new;
end $$;
create trigger booth_ratings_refresh after insert or update or delete on public.booth_ratings
  for each row execute function public.handle_booth_rating_changed();
grant execute on function public.refresh_booth_rating(public.booth_enum) to anon, authenticated;
grant execute on function public.handle_booth_rating_changed() to anon, authenticated;
grant insert, delete on public.booth_ratings to authenticated;
-- RLS off: only the trigger path is under test here, not who may insert a row.
alter table public.booth_ratings disable row level security;
grant usage on schema public to anon, authenticated;`);
const booth=(await db.query('select id from public.booths limit 1')).rows[0].id;
const user=(await db.query(`insert into public.users(email,name) values('rating@example.invalid','x') returning id`)).rows[0].id;
const as=async(role,sql,args=[])=>{ await db.exec('begin'); try { await db.exec(`set local role ${role}`); const r=await db.query(sql,args); await db.exec('commit'); return r; } catch(e){ await db.exec('rollback'); throw e; } };
// Before: anyone can call the helper directly.
await as('anon','select public.refresh_booth_rating($1)',[booth]);
await db.exec(fs.readFileSync(path.join(root,'operations-server/rating-function-grants.sql'),'utf8'));
for(const role of ['anon','authenticated']) {
  await assert.rejects(as(role,'select public.refresh_booth_rating($1)',[booth]),/permission denied/);
  await assert.rejects(as(role,'select public.handle_booth_rating_changed()'),/permission denied/);
}
// The trigger still fires for a signed-in insert and delete.
await as('authenticated','insert into public.booth_ratings(user_id,booth_id,rating) values($1,$2,4)',[user,booth]);
assert.equal(Number((await db.query('select rating from public.booths where id=$1',[booth])).rows[0].rating),4);
await as('authenticated','delete from public.booth_ratings where user_id=$1',[user]);
assert.equal(Number((await db.query('select rating from public.booths where id=$1',[booth])).rows[0].rating),0);
// Rollback restores the default grants.
await db.exec(fs.readFileSync(path.join(root,'operations-server/rating-function-grants-rollback.sql'),'utf8'));
await as('anon','select public.refresh_booth_rating($1)',[booth]);
console.log(JSON.stringify({passed:true,checks:['anon/authenticated denied','trigger insert refresh','trigger delete refresh','rollback']}));
