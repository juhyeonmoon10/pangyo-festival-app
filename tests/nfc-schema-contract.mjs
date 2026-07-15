import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/001_nfc_stamp_core.sql", import.meta.url);

test("NFC migration keeps the P0 security and concurrency contract", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /token_digest\s+bytea\s+not null\s+unique/i);
  assert.doesNotMatch(sql, /\braw_token\b/i);
  assert.match(sql, /create unique index if not exists stamps_one_active_visit[\s\S]+where status = 'active'/i);
  assert.match(sql, /on conflict \(event_id, user_id, booth_id\) where \(status = 'active'\)[\s\S]+do nothing/i);
  assert.match(sql, /primary key \(actor_id, scope, idempotency_key\)/i);
  assert.match(sql, /from festival\.idempotency_records[\s\S]+for update;/i);
  assert.match(sql, /security definer[\s\S]+set search_path = pg_catalog/i);
  assert.match(sql, /revoke all on function public\.claim_nfc_stamp[\s\S]+from authenticated;/i);
  assert.match(sql, /grant execute on function public\.claim_nfc_stamp[\s\S]+to service_role;/i);

  const rlsTables = [
    "events",
    "profiles",
    "event_memberships",
    "booths",
    "nfc_tags",
    "stamps",
    "stamp_attempts",
    "idempotency_records",
    "audit_logs",
  ];

  for (const table of rlsTables) {
    assert.match(sql, new RegExp(`alter table festival\\.${table} enable row level security;`, "i"));
  }
});
