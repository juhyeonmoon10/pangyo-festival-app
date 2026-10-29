# Pangyo Festival Web

## Scope

This is the personal festival-map application, integrated on ORBIT's `feature/booth-map` branch. It is not the ORBIT main application. The 2026-10-29 release applies the approved bright Impeccable proposal to this web app. It does not change shared SQL, Supabase settings, or the ORBIT main branch.

## Audience and Tasks

Students use mobile browsers to find booths, confirm NFC visits, rate their visit, collect stamps, and receive vouchers. Operators manage one existing festival, booths, NFC issuance, manual approvals, verified club memberships, points, vouchers, and audit records. Desktop remains a centered mobile-width app.

## Product Rules

- A confirmed distinct booth visit earns one stamp immediately, whether confirmed by NFC or an operator. Ratings and text reviews are separate; neither is required for the stamp. Repeated confirmation of the same booth never adds another stamp.
- Manual approvals use an authenticated-participant picker and a named confirmation. Operators do not enter internal participant IDs. An approval retains its actor, reason, and duplicate protection on the server.
- Each three completed stamps unlock a voucher. The first voucher in each six-stamp pair is a photo-booth or food-truck choice; the next is the other type. The cycle continues at 9/12 and beyond.
- The backend remains authoritative for reward eligibility, stocks, issuance, expiry, usage, identity, and operator authorization. The UI must not invent a successful operation.
- Reviews use an operator-verified real name. Own-club reviews remain blocked by the existing validation.
- NFC links continue through the existing login and claim flow. Signed tag issuance, non-expiring tags, duplicate prevention, and existing expiry validation are unchanged by this UI release.
- No crowding feature, event creation, public roster, student-facing database diagnostics, or demo entry in the production login.
- Existing map geometry, search/IME behavior, zoom, drag, and bottom-sheet placement are preserved. This release does not certify real booth locations or add a synthetic building filter.
- Operator navigation exposes implemented functions only. Mockup-only notice tools are not represented as production features.

## Design Direction

Bright white surfaces, mint/green actions and ink stamps, blue information, and yellow for claimable rewards. Keep headings compact, sections flat, touch targets comfortable, and Korean text readable. Students navigate through Home, Map, Stamps, and MY; operators use Overview, Tools, and History groups.

## Verification Boundary

Automated tests use synthetic accounts, intercepted requests, and isolated PGlite. They do not substitute for a real Google login, physical NFC tag, or event-site rehearsal. Student spreadsheets and private imported roster files must never enter Git or the static deployment.
