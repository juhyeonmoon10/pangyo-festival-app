// 웨이팅 push delivery (1.59). pg_net calls this after a transaction queued messages (waiting-push.sql).
// It claims queued messages, sends each to every browser subscription of the account, and reports back.
// The x-festival-hook header is checked by festival_push_claim against the Vault secret; deploy with
// verify_jwt off because the caller is the database, not a signed-in user.
import { send } from './webpush.js';

const PROJECT = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function rpc(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${PROJECT}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${name} ${response.status}`);
  return response.json();
}

type Subscription = { endpoint: string; p256dh: string; auth: string };
type Item = { id: number; kind: string; title: string; body: string; url: string; tag: string; subscriptions: Subscription[] };

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const hook = request.headers.get('x-festival-hook') ?? '';
  if (!hook) return new Response('Forbidden', { status: 403 });
  let processed = 0;
  for (let round = 0; round < 5; round++) {
    let claim: { vapid: { publicKey: string; privateKey: string; subject: string } | null; items: Item[] };
    try { claim = await rpc('festival_push_claim', { p_hook: hook }); } catch { return new Response('Forbidden', { status: 403 }); }
    if (!claim.items.length) break;
    if (!claim.vapid) return new Response('VAPID keys missing', { status: 500 });
    const results = await Promise.all(claim.items.map(async item => {
      const sent: string[] = [], gone: string[] = [];
      let retry = false, error = '';
      await Promise.all(item.subscriptions.map(async subscription => {
        try {
          const status = await send(subscription, { title: item.title, body: item.body, url: item.url, tag: item.tag, kind: item.kind },
            claim.vapid, { topic: item.tag.replace(/^waiting-/, '').replace(/-/g, '').slice(0, 32) });
          if (status >= 200 && status < 300) sent.push(subscription.endpoint);
          // Expired, unsubscribed, or made with another key: the subscription cannot be used again.
          else if ([403, 404, 410].includes(status)) gone.push(subscription.endpoint);
          else if (status === 429 || status >= 500) { retry = true; error = `HTTP ${status}`; }
          else error = `HTTP ${status}`;
        } catch (e) { retry = true; error = String(e).slice(0, 120); }
      }));
      return { id: item.id, sent, gone, retry: retry && !sent.length, error };
    }));
    await rpc('festival_push_report', { p_hook: hook, p_results: results });
    processed += results.length;
    if (claim.items.length < 100) break;
  }
  return Response.json({ processed });
});
