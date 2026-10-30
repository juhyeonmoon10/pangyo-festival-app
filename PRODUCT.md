# Pangyo Festival Web

## Scope

This is the personal festival-map application, integrated on ORBIT's `feature/booth-map` branch. It is not the ORBIT main application. The 2026-10-29 release applies the approved bright Impeccable proposal to this web app. It does not change shared SQL, Supabase settings, or the ORBIT main branch.

## Audience and Tasks

Students use mobile browsers to find booths, confirm NFC visits, rate their visit, collect stamps, and receive vouchers. Operators manage one existing festival, booths, NFC issuance, manual approvals, verified club memberships, points, vouchers, and audit records. Desktop remains a centered mobile-width app.

## Product Rules

- A confirmed distinct booth visit earns one stamp immediately, whether confirmed by NFC or an operator. Ratings and text reviews are separate; neither is required for the stamp. Repeated confirmation of the same booth never adds another stamp.
- Manual approvals use an authenticated-participant picker and a named confirmation. Operators do not enter internal participant IDs. An approval retains its actor, reason, and duplicate protection on the server.
- Vouchers are awarded only at 3 and 6 visits, at most two per participant per event. At 3, choose photo-booth or food-truck; at 6, receive the other benefit. Later visits add stamps but no more vouchers.
- Voucher stock and the usage deadline may each be unlimited. Operators see issued and remaining counts per benefit and can change stock (never below issued) and the deadline.
- Operators can reset all participation records (visits, stamps, vouchers, reviews, points, booth rating ranking) before the festival with a typed confirmation. Operator flags, accounts, booth setup, voucher rules, NFC tags, the roster, and the audit history are kept.
- This is a single-festival platform: no festival name is edited or shown.
- The backend remains authoritative for reward eligibility, stocks, issuance, expiry, usage, identity, and operator authorization. The UI must not invent a successful operation.
- Reviews use the real name from the official club roster. Grade 1–2 students confirm their own membership (sign-up student number plus the roster name) and are approved immediately; operators list, revoke, or relink these confirmations. Unconfirmed accounts see a Home prompt and cannot rate. Own-club reviews remain blocked. Grade 3 is out of scope.
- NFC links continue through the existing login and claim flow. Signed tag issuance, non-expiring tags, duplicate prevention, and existing expiry validation are unchanged by this UI release.
- Operators can list every issued NFC tag with its booth, memo, issuer and scan count, re-copy an active tag address, rename it, and stop or restore it. A stopped tag earns no stamps; stamps already earned stay. Tags issued before the registry appear after their first scan. Tag scan counts reset with participation records; the tags themselves are kept.
- NFC stamps are rate limited per participant: at most N new booths in M minutes (operator setting, default 5 in 10). The next new booth is refused with an explanation; re-scans and manual approvals are never limited. Operators see participants who reached the limit. Copied links cannot be told apart from real taps with the current cards.
- Operators post festival notices (title, body, important, published). Participants see published notices on the home screen, important ones first; important notices also appear in the top strip.
- Operators can set one operating status on many booths at once, and register cards issued before the tag list by reading them or pasting their address (no stamp is earned).
- No crowding feature, event creation, public roster, student-facing database diagnostics, or demo entry in the production login.
- Existing map geometry, search/IME behavior, zoom, drag, and bottom-sheet placement are preserved. This release does not certify real booth locations or add a synthetic building filter.
- Operator navigation exposes implemented functions only. Mockup-only notice tools are not represented as production features.

## Design Direction

Bright white surfaces, mint/green actions and ink stamps, blue information, and yellow for claimable rewards. Keep headings compact, sections flat, touch targets comfortable, and Korean text readable. Students navigate through Home, Map, Stamps, and MY; operators use Overview, Tools, and History groups.

## Verification Boundary

Automated tests use synthetic accounts, intercepted requests, and isolated PGlite. They do not substitute for a real Google login, physical NFC tag, or event-site rehearsal. Student spreadsheets and private imported roster files must never enter Git or the static deployment.
