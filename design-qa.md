**Scrollable Stamp Board and Recurring Rewards: 2026-10-28**

- Latest user reference: numbered embossed stamp circles on a serpentine path.
  Replaced the single-column path with three-column alternating rows on a cool gray
  surface. No chapter names or range headings; the title is simply "스탬프".
- Fixed-size circles and 154px rows preserve legibility. The page scrolls vertically
  instead of shrinking the whole board into the viewport. The next stamp remains
  actionable; every third milestone becomes a voucher link once earned.
- Latest confirmed reward policy supersedes the two-voucher cap below: repeat every
  three completed stamps. Choose at 3/9/15/etc.; the opposite benefit at 6/12/18/etc.
  Selection and issuance are immutable per milestone, including used/void/expired
  records. Explicit firstTarget keeps retries tied to their original reward cycle.
- Prepared v2 of the UNAPPLIED SQL draft. Replaces one-voucher-per-rule uniqueness
  with per-stage uniqueness for typed rewards; retains the original uniqueness for
  historical untyped vouchers. No new table and no changes to QR redemption.
- Tests: 110 Node cases, 18 synthetic DB cases, 36 browser scenarios at 320/390/430/1024px.
  Includes 9/12/15/18 rewards, skipped-stage rejection, first-choice immutability,
  repeated requests, stock shortage/retry, scroll access, and old/missing RPC denial.
- Browser network blocked. Screenshots under `artifacts/reward-choice/`, including
  `stamps-{count}-{width}.png` and `board-scroll-{count}-{width}.png`.
- No shared Supabase access/apply, Git commit/push, or deployment. Actual Supabase
  sessions, concurrent connections, real inventory and production data unverified.

**Stamp Navigation Refinement (Superseded Layout): 2026-10-28**

- Stamp entry no longer renders benefit descriptions or the reward choice form.
  The compact ticket-icon voucher button opens the existing voucher screen, where
  the 3/6-stamp selection, issuance status and QR cards remain available.
- Removed the artificial 1-3/4-6 chapters and large milestone actions. A single
  continuous ordered path retains completed visits and the next action, with small
  noninteractive ticket markers at positions 3 and 6 only.
- Voucher button: stable 44px minimum height, restrained border/background, one
  icon and one label. Keyboard focus, navigation and history-back are preserved.
- Verification: 109/109 Node tests and 18/18 isolated browser scenarios across
  320/390/430px. Tested absent benefits on stamp entry and return, single path,
  voucher choice, timeout retries, and retained one-of-each reward rules.
- Screenshots: `artifacts/reward-choice/stamps-{count}-{width}.png` and existing
  choice/issued/server captures. Narrow full-page path inspected visually.
- No server SQL changes, shared DB access, commit, push, or deployment in this step.

**Choice Voucher Audit (Superseded Two-Voucher Policy): 2026-10-28**

- Three completed stamps unlock an explicit choice of photo booth or food truck.
  Six unlock the opposite benefit. Maximum two distinct program vouchers per event.
  A completed stamp still means a verified visit with a submitted star rating.
- Used, expired, and voided first vouchers retain the selection. A first selection
  made at six stamps grants both, subject to stock. Shortages preserve the pending
  entitlement; retry grants only the missing type, never a replacement choice.
- Updated home milestones, stamp path, voucher selection, and operator stock setup.
  Missing/malformed server support does not fabricate eligibility or issue locally.
- Local SQL draft only: `operations-server/reward-choice.draft.sql`. Adds two columns
  and uniqueness constraints to existing private tables, guarded RPCs, and a revised
  award helper. No new table. No shared DB query/apply, commit, push, or deployment.
- Explicit operator configuration disables previous automatic rules. Existing
  untyped issued vouchers block activation until separately approved migration;
  existing voucher records and QR redemption are preserved.
- Validation: 108/108 Node regression tests; 16/16 synthetic PostgreSQL cases;
  18/18 mobile scenarios at 320/390/430px. Browser tests include both choice orders,
  late selection, repeated navigation, absent server support, same-key timeout
  retry, and operator stock configuration. All external browser traffic blocked.
- Evidence: `artifacts/reward-choice/isolated.json`, `browser.json`, and screenshot
  PNGs. Narrow choice, issued-voucher and admin screens inspected without clipping.
- Limits: PGlite auth/Vault shims and mocked RPCs are not real Supabase deployment,
  real concurrent-session tests, or proof of existing production data compatibility.
- Local preview: `http://127.0.0.1:5194/tests/stamp-ui-preview.html?demo=1&completed=3`.
  Fixture data is synthetic and in memory; it is excluded from the public build.

**Named Review / Official Club Roster Audit: 2026-10-29**

- APPROVED DB ROLLOUT UPDATE (2026-10-29, Asia/Seoul): shared project
  `vvvkzvxahviwbuyfbwir` now has migration `20261028160416`
  (`official_review_roster_identity_guards`). This supersedes the pre-approval
  local-only and pending-approval status recorded below, not its design constraints.
- Imported 421 official roster entries privately: 304 ready for independent operator
  verification, 117 pending. Actual account links: 0. No student was auto-enrolled.
  The workbook SHA-256 was rechecked against the original before import.
- Revalidated 25 isolated SQL tests, 8 importer tests, 14 client/build tests and
  13 live PostgreSQL synthetic checks. The live transaction ended with ROLLBACK;
  synthetic account rows are absent. No real account was impersonated during tests.
- Existing counts unchanged: 2 legacy ratings, 0 operations reviews, 0 visits,
  0 ledger entries and 0 vouchers. Operations read/write and current-profile function
  definition hashes match their pre-rollout versions. Existing anonymous ratings
  were not assigned real names. No production UI deployment, commit or push occurred.
- Recovery evidence: `operations-server/review-summary-before-roster-20261029.sql`;
  synthetic live checks: `operations-server/review-identity-live-check.sql`;
  aggregate-only rollout result: `artifacts/review-identity/rollout-20261029.json`.
  Never restore the old summary by itself or remove guards to reopen legacy writes.
- Advisor review: the two private RLS/no-policy notices are intentional deny-all
  ([reference](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)).
  The authenticated admin RPC is intentionally SECURITY DEFINER and checks live
  session, DB admin flag, event, target, versions, consent and audit at every call
  ([reference](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)).
  Pre-existing legacy public-function and leaked-password-protection notices remain
  outside this approved change. Do not describe this rollout as a full security audit.
- Remaining activation steps: release the compatible operator/client screens,
  resolve pending club/source mismatches privately, and independently link accounts.
  Until linked, review writes are intentionally denied, while visits remain intact.

- Local implementation only. Shared DB metadata/catalog were read, but no shared
  schema/data/auth changes, commit, push, or deployment were performed for this work.
- An operator-confirmed roster determines review names and excluded club booths.
  Missing/unverified membership denies writes. Profile aliases are not trusted.
- Own-club stars and later text additions are blocked. NFC visits remain visible;
  these excluded visits do not invent reviews, completion credit, or vouchers.
- New reviews snapshot the verified name; existing anonymous reviews stay anonymous
  unless their author explicitly submits a new text addition under the named policy.
  Public reviews contain neither student numbers nor email addresses.
- Operator flow: Participants > Review identity > select participant > exact student
  number lookup > inspect official name/clubs > independent account identity check >
  reason > link. Names and memberships are read-only; profile metadata is never proof.
  One roster entry cannot be shared by two accounts, including revoked links.
- Pending approval: `operations-server/review-identity.draft.sql` adds two private
  roster/link tables, one nullable author column, an admin RPC, and write guards. It blocks
  legacy `booth_ratings` writes, so team dependency checks are required before rollout.
  The new client intentionally cannot submit reviews to the old server contract.
- Synthetic PostgreSQL checks: 25/25, including old-RPC bypass, duplicate requests,
  membership revocation, cross-event/stale roster edits, and anonymous-history privacy.
  This is PGlite with auth/Vault shims, not live Supabase or concurrent-session proof.
- Mobile browser checks: 12/12 at 320/390/430px, covering own-club, allowed, unverified,
  and admin roster states. External traffic blocked; all fixture saves are in memory.
- Evidence: `artifacts/review-identity/isolated.json`, `browser.json`, and screenshot PNGs.
- Workbook importer: `tools/import-review-roster.py`; 8 synthetic parser checks pass.
  The supplied workbook yields 421 distinct student-number entries: 304 ready for
  operator account verification, 117 pending. This is NOT 304 verified accounts.
  Pending reasons overlap: 107 unmapped club names, 16 cross-sheet conflicts,
  13 single-source entries, 1 name conflict. 51 exact repeated leader/member entries
  were collapsed. Grade 3 has only 9 entries; full third-grade coverage is not established.
- Whitespace is normalized; aliases are not guessed. In particular, 메커니즘 versus
  매커니즘 and 창업특허동아리 versus 창업특허연구소 need a reviewed mapping. Clubs without
  a catalog booth stay pending unless an operator explicitly confirms nonparticipation.
- Only student number, name, club, source coordinates and source hash are extracted.
  Teacher/contact/activity fields are ignored. The original workbook is untouched.
  Generated `roster.json` and `report.json` stay under ignored `nfc-server/private-output/`;
  neither this directory, the workbook, tools nor SQL are in the public build allowlist.
- The real workbook payload passed a local in-memory PGlite import/count check; no
  student records are included in test output, fixtures, screenshots or tracked files.
- Deployment gate: obtain shared DB/schema + school-approved publication/retention
  approval; reconcile pending source cells privately; review aliases and all booth
  mappings; snapshot existing review function definitions; apply the SQL transaction
  and owner-only `festival_ops.import_review_roster(event_id, document, approving_admin_id)`;
  independently link accounts. No automatic matching by a claimed student number/name.
  Catalog changes or a changed roster version invalidate previous review eligibility.
- Recovery: roll back the installation transaction on any failed precheck. After
  installation, revoke an incorrect link using the guarded `revoke` action; do not
  restore unguarded review writes or delete visits/points/vouchers. A new import marks
  removed records inactive and preserves published author snapshots. Do not commit
  exports/backups containing student data. No retention deadline is invented here.

**Login UI Audit: 2026-10-21**

Scope: local login and first-login profile only. This is an incremental improvement,
not a pixel-identical clone. Existing school artwork, Google action, authentication
handlers and explicit demo URL behavior are retained. No commit, push, deployment,
shared ORBIT change or shared Supabase change was performed for this audit.
Concurrent home/stamp 1.5 edits are outside this audit and were left in place.

**Evidence**

- Source visual truth: `../../tmp/login-audit-01-before.jpg` and
  `../../tmp/login-audit-02-profile-before.jpg`.
- Rendered implementation: `../../tmp/login-audit-03-after.jpg` and
  `../../tmp/login-audit-04-profile-after.jpg`.
- Matching state: signed-out login; first-login profile with synthetic long email.
- Matching CSS viewport: 390 x 844. Both before and after captures are 390 x 843
  pixels; the browser omitted one edge pixel consistently. No scaling or crop
  normalization was applied to the comparison pairs.
- Full-view side-by-side comparison: `../../tmp/login-design-comparison.jpg`.
- Account/form comparison: `../../tmp/login-profile-comparison.jpg`.
  The full-height pair already shows the name, email, field and actions at a
  readable 1:1 scale, so an additional crop was not necessary.
- Local preview: `http://127.0.0.1:5190/`.
- Isolated state fixture: `tests/login-ui-preview.html`. It uses actual UI code,
  synthetic identities, mocked account/catalog clients and `connect-src 'none'`.
  It is not part of the public static build.

**Findings and Fixes**

- [P2, resolved] The school image and Google action were separated by about 140px.
  `.login-content` now groups them with a 28px layout gap; the 390px after capture
  shows a continuous visual path to the action. Intentional whitespace around the
  centered group remains on taller screens.
- [P2, resolved] The profile put name and long email in one heavy pill.
  `.login-account` now separates the identity hierarchy and allows email wrapping.
  The field and main action are 56px high; the account-switch action is secondary.
- [P2, resolved] Profile errors and saving state lacked explicit announcements.
  Errors now use `role="alert"` and the submit action exposes `aria-busy`, while
  existing disabled behavior, validation and draft preservation remain unchanged.
- [P3, resolved] Repeated footer branding was removed, supporting text increased
  to 13px, and the Google button border/focus outline made clearer.
- [P3, resolved] At 320px the NFC message left one Korean syllable on its own line.
  `word-break: keep-all` keeps the final word together. Before/final evidence:
  `../../tmp/login-audit-10-nfc-320.jpg` and
  `../../tmp/login-audit-12-nfc-320-final.jpg`.

**Required Fidelity Surfaces**

- Fonts/typography: existing font stack retained; 34px title (30px on narrow
  screens), 13-16px supporting text and controls, 16px input. Long identity text
  wraps without horizontal overflow. No custom replacement font was introduced.
- Spacing/layout: image and action form one constrained column. No button overlap
  at 320/390/430px. Error-heavy profile content scrolls on a short viewport, with
  both actions reachable; no fixed overlay obscures them.
- Colors/tokens: existing white/green language retained. Darker supporting text,
  visible input/button borders and an explicit keyboard focus ring were checked
  visually. This is not a complete WCAG conformance audit.
- Image quality: original `assets/festival-school-1.4.webp` retained, loaded at
  its natural 1536px width and rendered without clipping or distortion.
- Copy/content: duplicate footer removed; no new onboarding step, product feature
  or backend claim was added. Pending-NFC and failure messages remain available.

**Verification**

- 77 automated tests passed, 0 failed, including escaping, busy/disabled state,
  duplicate submission, input retention, normal-login demo exclusion and build
  exclusion of private/test files.
- Browser checks: 320 x 568, 390 x 844, 430 x 932, and 1024 x 768.
- Keyboard Tab reaches Google login with a visible focus ring.
- Mock sign-in failure returns an enabled retry action and an alert.
- Mock profile failure retains `21001`; both actions remain reachable at 320px.
- Pending-NFC login hint remains visible on mobile and desktop.
- Fixture browser console inspection returned no warnings or errors.
- Actual Google OAuth, mobile operating-system keyboard and real NFC hardware
  were not exercised. No production account or DB write was used for UI testing.

**Comparison History**

1. Captured original login/profile at 390 x 844 and identified spacing, account
   grouping and feedback issues.
2. Implemented scoped UI changes, captured the same states and compared each
   before/after pair in a single combined image.
3. Checked mobile error/NFC states, fixed the Korean wrap, and recaptured 320px
   NFC state. No actionable P0/P1/P2 issue remains in this limited UI scope.

**Implementation Checklist**

- [x] Group login artwork and action.
- [x] Separate account name/email and preserve existing form behavior.
- [x] Verify narrow layouts, focus and retry states.
- [x] Run automated tests and retain local screenshot evidence.
- [x] Leave commits, remote uploads and deployment untouched.

final result: passed

---

**Earlier Map QA (Historical; Not Reassessed by the Login Audit)**

- Source visual truth: `C:\Users\juhye\AppData\Local\Temp\codex-clipboard-ebe36b4d-2267-49d8-bf76-ed8406d8deee.png`, `C:\Users\juhye\AppData\Local\Temp\codex-clipboard-6e42bee8-a73f-4153-bfab-3a87979451a7.png`
- User-reported implementation evidence: `C:\Users\juhye\AppData\Local\Temp\codex-clipboard-f8d86c09-a69f-4981-8cec-c0dd576bea8c.png`
- Intended implementation viewport: 390 x 844
- Intended state: signed-in map, floors 1 through 4, booth preview closed and open
- Implementation screenshot: unavailable because the in-app browser control surface was not exposed in this session

**Full-view comparison evidence**

- Source floor relationships were inspected at original resolution.
- The implementation could not be captured in a browser, so visible composition, crop, typography, and touch-target placement could not be compared side by side.

**Focused region comparison evidence**

- Source classroom sequences and connected special-room blocks were inspected at original resolution.
- Browser-rendered focused regions were unavailable.

**Findings**

- [P1] Large pin controls obscured every classroom label.
  Evidence: the supplied 4th-floor screenshot shows circular `3-2` through `3-8` pins covering the room names beneath them.
  Impact: users cannot scan classroom locations without reading duplicate pin labels.
  Fix applied: removed class pins and converted each classroom cell into the touch target; a small corner dot now communicates visit state.

- [P1] Selecting a booth moved and zoomed the plan, leaving edge classrooms clipped.
  Evidence: the supplied screenshot does not show the full left edge of the classroom row.
  Impact: users lose their orientation after checking a booth.
  Fix applied: booth selection no longer changes camera position, and dismissing a preview restores zoom and offsets.

- [P1] Browser-rendered mobile layout is unverified.
  Evidence: source images are available, but no implementation screenshot could be captured.
  Impact: overlap, text legibility, and map framing at 390 x 844 cannot be confirmed visually.
  Fix: capture floors 1 through 4 at 390 x 844, test floor switching, map pan/zoom, pin preview dismissal, and bottom-sheet dragging, then compare against the source layout.

**Static verification completed**

- JavaScript syntax passes.
- All four floor plans render through the map template.
- Class pins G1-01 through G3-08 resolve to the correct classroom sequence.
- Classroom cells are clickable and class-pin overlays are absent.
- Selecting a classroom leaves map zoom and offsets unchanged.
- Elevator, restroom, cafeteria-wing, kitchen, and mechanical-room labels are absent from the user-facing floor-plan data.
- CSS braces and whitespace checks pass.

**Required fidelity surfaces**

- Fonts and typography: code-reviewed; browser rendering blocked.
- Spacing and layout rhythm: responsive constraints added; visual confirmation blocked.
- Colors and visual tokens: classroom, facility, special-room, and visited-state tokens defined; visual confirmation blocked.
- Image quality and asset fidelity: the source plans are used as structural reference rather than shipped raster assets; browser comparison blocked.
- Copy and content: floor labels, classroom order, and retained room names verified in source.

**Comparison history**

- Initial pass: source images opened and analyzed; implementation capture unavailable.
- User screenshot pass: identified label occlusion and retained camera offset; both were fixed in code and interaction smoke tests.
- Post-fix browser capture remains unavailable, so a final visual comparison is still blocked.

**Final result**

final result: blocked
