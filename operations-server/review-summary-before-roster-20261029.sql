-- Reference snapshot only. Do not restore unguarded writes.
-- Captured before approved official-roster rollout on 2026-10-29 (Asia/Seoul).
CREATE OR REPLACE FUNCTION festival_ops.review_summary(e uuid, u integer, b text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
 select jsonb_build_object('boothKey',b,'count',count(*),'average',round(avg(rating),1),
   'myRating',max(rating) filter(where user_id=u),'reviews',
   coalesce((select jsonb_agg(x.item order by x.ts desc) from (
     select r.created_at ts, jsonb_build_object('rating',r.rating,'content',nullif(r.content,''),
       'createdAt',r.created_at,'mine',r.user_id=u,'author','참여자') item
     from festival_ops.reviews r where r.event_id=e and r.booth_key=b
     order by r.created_at desc limit 50) x),'[]'::jsonb))
 from festival_ops.reviews where event_id=e and booth_key=b;
$function$
;
