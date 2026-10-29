# Web 1.5: Bright Festival Pass

Approved and implemented: 2026-10-29.

## Preserved Baseline

Before UI integration the working app was clean at `946429ca672231df644fd5dfe7176150c5cf2a5c`. The same previous release was already published as ORBIT `feature/booth-map` commit `ec53c199a9798332a607972d12c2910767c92fe7` and personal main commit `2c36e2f202ea28d5ce385a3fdd8dbb49dc1f97a9`. No empty checkpoint commit was needed.

## Changes

- Shared bright tokens and typography for student and operator views, in `festival-bright.css` loaded after legacy styles.
- Home places stamp progress and the voucher shortcut before the map action. Six compact ink stamps retain the current cycle.
- Scrollable ink-stamp board preserves every-three reward markers; claimable vouchers are yellow, issued rewards remain green and labeled.
- Vouchers distinguish unissued entitlement, available coupons, and used coupons. Unknown server eligibility is displayed as unknown, not inferred from local stamps.
- MY places stamp, voucher, and visit counts together. Existing display-name editing and verified review identity remain separate.
- Operator navigation groups existing work into Overview, Tools, and History. The Tools menu links to eight existing workflows; it is not a new server RPC.
- Map retains original room geometry and interactions while using shared colors. Paused status and visit completion remain independent.
- Login, detail, review, tables, forms, and dialogs share the same visual language.

## Unchanged

No SQL or Supabase configuration changes. No new event, automatic grants, roster imports, or live test transactions. NFC, Google authentication, ownership/role validation, review restrictions, and idempotent rewards retain their existing implementations. The independent design proposal remains separate; synthetic mockup data is not shipped in production screens.

## Checks

- Unit tests: 150 passed, including new voucher-summary distinctions and unknown server state.
- Browser suites: session lifecycle, real-name reviews, ink stamps, operator stamp simulator, and isolated operations.
- Bright UI regression: 49 screen/flow checks across 320, 390, 430, and 1024 pixels; external requests blocked. Selected-rating and zero-claimable states are included.
- Visual captures include home, map, search, detail, review form, stamps, vouchers, MY, login, long names, and operator tools.
- Static build allowlist: 41 public source/asset files; no private roster, SQL, API implementation, tests, or secrets in deployed output.
- Physical NFC and live Google login were not re-executed for this visual-only release.

## Recovery

The previous personal deployment remains associated with commit `2c36e2f`. Reverting this release's UI commit and redeploying restores the previous UI without a database rollback. Do not rewrite remote history or reset shared main.
