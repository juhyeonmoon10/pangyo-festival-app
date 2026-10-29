---
name: Pangyo Festival Web
description: Bright festival records with green ink stamps and clear everyday controls.
colors:
  primary: "#087652"
  primary-hover: "#075e43"
  mint: "#d9faea"
  ink: "#20382e"
  muted: "#60736b"
  paper: "#ffffff"
  wash: "#f5f8f6"
  line: "#e1ebe5"
  input-edge: "#bdcec4"
  information: "#285e92"
  information-wash: "#eaf4ff"
  claimable: "#ffeb9b"
  reward-ink: "#80560c"
  reward-wash: "#fff9e5"
  reward-edge: "#d9ba61"
  danger: "#b93f3b"
typography:
  heading:
    fontFamily: "Pretendard, Noto Sans KR, -apple-system, BlinkMacSystemFont, Apple SD Gothic Neo, Malgun Gothic, Segoe UI, sans-serif"
    fontSize: "21px"
    fontWeight: 750
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Pretendard, Noto Sans KR, -apple-system, BlinkMacSystemFont, Apple SD Gothic Neo, Malgun Gothic, Segoe UI, sans-serif"
    fontSize: "15px"
    lineHeight: 1.5
    letterSpacing: "0"
  input:
    fontFamily: "Pretendard, Noto Sans KR, -apple-system, BlinkMacSystemFont, Apple SD Gothic Neo, Malgun Gothic, Segoe UI, sans-serif"
    fontSize: "16px"
    letterSpacing: "0"
  screen-title:
    fontSize: "19px"
    fontWeight: 750
    lineHeight: 1.35
    letterSpacing: "0"
rounded:
  compact: "4px"
  control: "8px"
spacing:
  tight: "8px"
  related: "12px"
  compact-edge: "20px"
  page-edge: "24px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    height: "50px"
  button-secondary:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "50px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.input}"
    rounded: "{rounded.control}"
    height: "48px"
  view-tab:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
    height: "52px"
    padding: "10px 4px"
  stamp-path-row:
    height: "138px"
  stamp-face:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.primary}"
    size: "76px"
  stamp-face-compact:
    size: "70px"
  map-search:
    typography: "{typography.input}"
    height: "48px"
    padding: "0 12px"
  map-sheet-peek:
    height: "182px"
  map-sheet-peek-short:
    height: "148px"
  voucher-ticket:
    backgroundColor: "{colors.reward-wash}"
    rounded: "{rounded.control}"
    padding: "20px"
  voucher-ticket-photo:
    backgroundColor: "{colors.information-wash}"
  voucher-ticket-history:
    backgroundColor: "{colors.wash}"
  completion-marker:
    backgroundColor: "{colors.mint}"
    textColor: "{colors.primary}"
  profile-history:
    padding: "24px"
  operator-tool-row:
    height: "76px"
    padding: "12px 0"
---

# Design System: Bright Festival Pass

## Overview

**Creative North Star: "Bright Festival Pass"**

A light, Korean-first task interface. Green ink stamps carry the distinctive festival character; navigation, forms, and operator tools remain compact and familiar. The approved direction is bright rather than dark or muted beige.

**Key Characteristics:**
- White surfaces, mint actions, green records, blue information, and yellow claimable rewards.
- Flat sections and readable lists, with cards reserved for individual coupons and focused tools.
- Operating state, visit state, completed rating, and voucher issuance remain visually distinct.

## Colors

The frontmatter contains the normative reusable palette, extracted from `festival-bright.css`.

Primary green identifies actions, completed ink stamps, selected ratings, and current navigation. Mint supports these controls without flooding the page, including the green completion icon on booth detail. Blue marks information and review continuation. Yellow draws attention to confirmed claimable vouchers; ordinary voucher navigation and issued coupon icons use mint. Issued ticket bodies distinguish food with reward wash, photo with information wash, and used/ended tickets with neutral wash; tint alone never implies claimability. Amber warning treatments remain separate operational signals, such as a paused booth. Red is reserved for destructive actions and errors.

**The Independent State Rule.** A completed visit never hides a paused booth or implies a voucher was issued.

## Typography

Use the local Korean-capable stack in the frontmatter; no remote font download is required. Font names earlier in the stack are optional, not bundled assets. All letter spacing is zero.

- Web screen headers use the screen-title role; map and stamp headers retain the heading role. Home greetings are 27px, reducing to 24px at the compact breakpoint; booth titles are 26px and the login title 32px.
- Body copy is 15px; input text is 16px. Supporting labels are generally 12-13px.
- Home record counts use 36px, the stamp summary 40px, and compact statistics 27px with tabular numerals.
- Korean phrases keep words together but can wrap anywhere when necessary. Do not scale type with viewport width.

## Layout

The existing app stays centered with a maximum width of 480px. Web, profile, detail, and operator screens use page-edge spacing, reducing to compact-edge at widths up to 350px. Some home continuation bands retain their intentional 20px/16px inner inset. Four fixed bottom navigation items remain in the existing 72px navigation area plus the safe-area inset. Content has enough bottom padding to scroll past it.

Use full-width section breaks and unframed lists. The map remains a full-height interactive surface with inline search and a draggable sheet attached above navigation. Its header occupies 174px; default and short-height sheet peeks use the component tokens, with the short variant at viewport heights up to 650px. Preserve the actual floorplan, geometry, and hit testing; no mock replacement geometry or invented location certainty. Stamps follow a three-column alternating path using stamp-path-row and stamp-face tokens, with compact faces at widths up to 350px. The board scrolls instead of shrinking all stamps into one screen.

## Elevation & Depth

Most surfaces are flat and separated by spacing, a thin line, or a restrained tint. Buttons and floor controls have no decorative shadow. The map sheet uses `0 -6px 24px #183e2c12` to identify a movable layer. Dialogs retain protected focus and a dim backdrop.

## Shapes

Controls, coupon items, and dialogs use restrained corners. Buttons use 8px; compact map geometry uses 4px. Circular double-ring stamps and the round brand mark are intentional exceptions. No page section is nested inside a decorative card.

## Components

### Buttons and Inputs

Primary and secondary commands have a minimum height of 50px. Icon commands are at least 44px. Inputs are at least 48px tall. Focus is a 3px information-blue outline with a 3px offset. Input carets are green. Disabled and loading states remain visible and keep their functional behavior.

### Navigation

Student navigation has four items with icon and label. Active items use green over mint. Full-width underline tabs organize vouchers into claim, held, and used/ended history, and reviews into continuation and written reviews. Active tabs use green text and a bottom rule; tab counts remain readable.

Operators use three tabs: Overview, Tools, and History. Tools exposes nine existing workflows: booth status/programs, NFC issuance, manual visits, participant/club roster, point adjustment, voucher rules, voucher issue/use, stamp simulation, and festival settings. Tool detail has a return-to-list command. Settings updates the existing event only; there is no event creation, new notice tool, or emergency server feature.

### Ink Stamps

Completed stamps use a white face, green outer ring, and inner ring. Small alternating rotations belong only to completed stamp marks. The next stamp uses mint and a dashed border. Future stamps are neutral. Claimable voucher milestones use yellow; issued milestones use green with an explicit received label. Keep every-three milestones visible even when the reward service is unavailable.

### Reviews and Vouchers

Selected rating stars have explicit green SVG fill and stroke; unselected stars have neutral outlines. Text reviews remain optional. The redundant review eyebrow is removed. Voucher tabs distinguish unissued entitlement, held coupons, and used/ended history. Unknown reward state is not shown as zero claimable entitlement. Claim choices are single-column radio rows with a minimum height of 90px; tickets have an explicit state, eligibility/expiry details when present, and QR access only for available tickets.

### Map, Profile, and Detail

Map search is inline, retains Korean IME and clear-query behavior, and uses a 2px information-blue focus-within ring with a 2px offset. The sheet has a 68px handle and readable booth rows with a minimum height of 92px. Short-height peeks do not replace the existing drag, zoom, or floor controls.

Profile presents identity, three statistics, shortcuts, and a full-width visit-history section. Booth detail uses a 56px visual column only when an official club visual exists; text-only headings occupy the full width. Its completed marker uses green on mint, independent of paused/closed operating status.

### Motion and Accessibility

Map panning and Korean composition do not trigger whole-screen entrance motion. The sheet can change height, and stamp presses have subtle feedback. Reduced-motion preference removes transitions and animation. Do not remove focus indicators or encode status through color alone.

## Do's and Don'ts

- Do preserve a bright fixed-light palette and comfortable Korean reading sizes.
- Do distinguish visit completion, required rating, operating status, and voucher state.
- Do use mint for ordinary voucher navigation and yellow for a confirmed reward action.
- Do keep real authorization, errors, loading, and retry behavior intact when changing visuals.
- Don't ship synthetic proposal data or mock operator actions as real features.
- Don't reintroduce crowded dashboards, nested cards, crowding indicators, or event creation.
- Don't carry legacy amber selected-star styling into new screens.

Legacy source styles remain beneath the final stylesheet for compatibility. Their dormant decorative treatments are not design rules for new components.
