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
