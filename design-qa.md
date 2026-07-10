**Design QA**

- Source visual truth: `C:\Users\juhye\AppData\Local\Temp\codex-clipboard-ebe36b4d-2267-49d8-bf76-ed8406d8deee.png`, `C:\Users\juhye\AppData\Local\Temp\codex-clipboard-6e42bee8-a73f-4153-bfab-3a87979451a7.png`
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

- [P1] Browser-rendered mobile layout is unverified.
  Evidence: source images are available, but no implementation screenshot could be captured.
  Impact: overlap, text legibility, and map framing at 390 x 844 cannot be confirmed visually.
  Fix: capture floors 1 through 4 at 390 x 844, test floor switching, map pan/zoom, pin preview dismissal, and bottom-sheet dragging, then compare against the source layout.

**Static verification completed**

- JavaScript syntax passes.
- All four floor plans render through the map template.
- Class pins G1-01 through G3-08 resolve to the correct classroom sequence.
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
- No visual fix loop was possible without a browser-rendered screenshot.

**Final result**

final result: blocked
