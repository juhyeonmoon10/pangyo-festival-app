-- Rollback for sun-nfc.sql: removes the secure-card RPCs and helpers. Signed tags (nf1) are unaffected.
-- Registered cards (festival_nfc_private.sun_cards) and the Vault keys are kept so a re-apply restores
-- the same cards; stamps already earned stay. To remove them too, run after this file:
--   drop table festival_nfc_private.sun_cards;
--   delete from vault.secrets where name = 'pangyo_festival_sun_v1';
begin;
select pg_catalog.pg_advisory_xact_lock(170926,1);
drop function if exists public.festival_sun_admin(text, jsonb);
drop function if exists public.festival_sun_claim(jsonb, uuid);
drop function if exists festival_nfc_private.sun_config();
drop function if exists festival_nfc_private.sun_verify(text, text, text, jsonb);
drop function if exists festival_nfc_private.sun_cmac(bytea, bytea);
drop function if exists festival_nfc_private.sun_shl(bytea);
drop function if exists festival_nfc_private.sun_xor(bytea, bytea);
drop function if exists festival_nfc_private.sun_aes(bytea, bytea);
notify pgrst,'reload schema';
commit;
