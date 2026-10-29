# UI Release 1.6

Build version: **1.6**. Frontend-only structural integration following 1.5's partial theme integration. Previous local baseline: `5fb4e62`; shared feature reference: `3c95369`; personal main reference: `122d020`. These are supplied source references, not a new release or deployment SHA.

## Changes

- Page edges 24px/20px compact; stamp path rows 138px with 76px/70px faces. Existing centered 480px app width and real floorplan are preserved.
- Vouchers use claim/held/used-ended history tabs and explicit ticket states; reviews use continuation/written tabs; profile includes visit history.
- Inline map search retains Korean IME behavior; default sheet peek is 182px, reduced to 148px at viewport heights up to 650px. No fake geometry or invented location certainty.
- Operators use three tabs and nine existing tools. Festival settings updates the existing event only; no event creation or invented notice/emergency server features.
- Final corrections cover contract provenance, full-width no-image detail headings, green/mint completion icons, and removal of the redundant review eyebrow.

## Local Verification

Parent-reported results, not rerun in this documentation-only task:

- 150 unit tests passed; 68 student screens/flows covered widths 320, 390, 430, and 1024px.
- 36 reward scenarios passed: 0/3/6/9/12 stamps across four widths (20), plus four server modes at each width (16).
- Five regression suites passed: `auth-session-lifecycle`, `review`, `ink-stamp`, `stamp-simulator`, and `operations-hotfix`.
- Operations were tested locally with an isolated PGlite shim at 320/390/430px; all remote requests were intercepted.
- Reviewer verdict: **ship**, limited to the four requested corrections above. This is not exhaustive production certification.

## Release Boundary

- Source frontend only. No SQL or Auth configuration changes; no Supabase calls. Real Google login and physical NFC were not tested.
- Static packaging uses a 41-file allowlist excluding private roster data, tests, and SQL.
- This documentation pass changes only `DESIGN.md`, `.impeccable/design.json`, and this release note. PRODUCT, surface contract, unrelated system files, and existing provenance remain untouched; no legacy PRODUCT schema normalization.
- Deployment and deployed-build verification remain the parent task. No deployment URL or new release SHA is asserted here.
