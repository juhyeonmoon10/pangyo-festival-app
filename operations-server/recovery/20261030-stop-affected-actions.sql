-- Emergency containment only. NOT part of the normal repair migration.
-- Blocks reset and the legacy self-confirm endpoint without changing records.
-- Operator identity verification and guarded review writes stay available.
begin;
revoke all on function public.festival_ops_reset(jsonb,uuid),
  public.festival_review_identity_self(text,jsonb) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
