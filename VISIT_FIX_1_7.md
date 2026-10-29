# Visit Approval and Stamp Fix 1.7

## Root Causes

- Manual approval accepted an internal `public.users.id`, not a school number or Auth UUID. A missing linked user or unknown booth results in `NOT_FOUND`. Reproduced against isolated SQL with an unknown internal ID.
- The stamp board counted only visits with reviews. Successful NFC/manual visits therefore remained uncounted until a rating existed; students excluded from reviewing their own club could never complete that stamp.
- A refresh already in progress returned immediately to the claim caller. Callers now await the queued refresh before rendering the confirmed count.

## Changes

- Operator-only participant search, paged selection, linked roster confirmation, named approval, and action-specific missing-target recovery. Internal IDs remain request values, never manual input.
- A distinct non-revoked booth visit is one stamp, independent of reviews. Existing records are counted without rewriting data. Duplicate confirmations remain idempotent.
- NFC feedback and booth details confirm stamp accrual directly. Reviews remain subject to verified real-name and own-club restrictions.
- Existing server authorization, auditing, booth-open checks, and self-adjustment restrictions remain authoritative.

## Verification and Boundaries

- Unit and isolated Edge/PGlite tests cover manual selection, Korean search, duplicate approval, missing recipients, own-account denial, NFC duplicate detection, unrated stamps, reload persistence, and own-club review denial.
- Mobile screenshots: 320, 390, and 430px. Synthetic accounts only; all remote browser requests intercepted.
- No SQL, table, policy, Auth setting, student record, or shared DB write is part of this release. No physical NFC hardware or real Google login was tested.
- Voucher eligibility is still decided by the installed server program. This frontend fix does not install the draft repeat-reward SQL or silently change legacy voucher rules.
