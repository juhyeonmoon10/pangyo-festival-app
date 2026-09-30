# Personal Festival UI VER.2

Updated: 2026-09-10

## Scope

Implements the user's selected second home sketch from the revised UI PDF.
Only the personal web app and its Android asset allowlist changed. No ORBIT
repository, shared database tables, roles, functions, or auth settings changed.

## UI decisions

- Home stays as a destination: identity and stamp count, interactive school map,
  notices, then entry to reviews. The map tab remains the full-screen map and
  sliding booth list. Existing five navigation destinations are preserved.
- The sheet grip stays directly above bottom navigation. One drag produces one
  state change; the subsequent browser click must not toggle it again.
- A stamp is saved after a successful visit claim, independently of rating.
  Ratings require an explicit 1-5 selection; written feedback is optional.
  Closing the review flow never discards an already confirmed visit.
- NFC results do not change the current screen or replace an active text input.
  Informational success/duplicate feedback lasts three seconds. Feedback with a
  rating/retry action remains until dismissed or replaced by another result.
  Login/profile requirements remain the exception and continue the auth flow.
- The pass trail is cumulative, not a fixed route through specific booths.
  Demo stamps are ordered by stored time; server stamps follow the returned
  completed-booth array. Unknown server visit times are not invented.
- Pass shows collected booths only, with an expandable trail for future stamps.
- Unreviewed visits remain reachable from home. Students cannot access mock NFC
  actions. Demo administrators retain the existing test tools.
- Actual activity titles were not supplied. Existing verified club/booth names
  remain unchanged; no activities or physical locations were invented.

## Integration limits

Real review writes and real exchange codes are still unavailable. No fake QR or
barcode is presented as a usable reward. Existing five-stamp/one-exchange logic
is demo-only and explicitly labeled non-redeemable. Production thresholds,
inventory, code issuance, redemption/expiry, and audit rules require a separately
approved server implementation. The UI work does not activate the pending NFC
SQL installer or change Google login configuration.

## Validation

`tests/ui-ver2-browser.cjs` uses isolated browser storage and intercepts all
external requests. It checks 320/390/430/1024 widths, image loading, overflow,
space-insensitive search, Korean composition during NFC, current-screen
preservation, two stamps and duplicate prevention, explicit rating with empty
optional text, review picker, sheet positioning/dragging, and student test-tool
restrictions. Screenshots and the report are under `artifacts/ui-ver2`.

The existing server-client browser test uses synthetic intercepted API responses;
passing it does not mean Google login or a physical NFC card was tested live.
