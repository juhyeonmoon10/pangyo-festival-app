# Isolated NFC database

This directory is for a separate Supabase project owned by the personal festival app. Do not run these migrations against ORBIT or any shared club database.

## Apply later

1. Create or select a separate Supabase project.
2. Review `migrations/001_nfc_stamp_core.sql`.
3. Apply it with the Supabase migration workflow or SQL editor for that separate project.
4. Add the four values from `.env.example` to the personal Vercel project.
5. Keep `STAMP_GATEWAY_MODE` set to `mock` until authentication, seed data, and device tests pass.

The API stores only HMAC-SHA256 digests of NFC tokens. Raw NFC token URLs, the pepper, and Supabase secret keys must never be committed or logged.
