# 1.37 미니게임 (ORBIT develop `/games` 이식)

2026-11-01. 사용자 요청: develop 브랜치의 `/games`(동아리 가상주식, 1대1 블랙잭)를 이 앱에 이식한다. 지금 기능은 하나도 빼지 않고, 디자인 가이드와 지금까지의 디자인을 따른다. 미니게임으로 가는 길은 하단 바에만 둔다. 이 변경은 `elilim09/ORBIT`의 `feature/merge` 브랜치에만 올리고, `feature/booth-map`과 개인 배포 저장소에는 올리지 않는다.

## 바뀐 것

- **하단 내비 5칸**: 홈 · 부스 지도 · 스탬프 · **미니게임** · MY. 미니게임으로 가는 길은 이 칸 하나뿐이다.
- **미니게임 허브** `/games`: 가상 포인트 잔액, 게임 목록(동아리 가상주식, 1대1 블랙잭).
- **동아리 가상주식** `/games/stock`, `/games/stock/{번호}`
  - 시장 상태와 개장·마감 카운트다운, 자산 요약, 종목·관심·보유·거래 내역 탭, 검색·정렬, 관심 종목(별), 소식.
  - 종목 상세: 가격, 시작가 대비 등락, 행사 2시간 시세 그래프, 보유 정보, 매수·매도 창(수량 조절, 확정 금액).
  - 거래마다 확인 키를 먼저 저장하고 보낸다. 결과를 모르는 거래는 "이전 거래 결과 확인"으로 같은 키를 다시 보내 한 번만 처리된다.
- **1대1 블랙잭** `/games/blackjack`: 300P를 걸고 무작위 상대 찾기, 기다리기·취소(환불), 번갈아 히트·스탠드(10초), 카드 한 장씩 공개, 승패 결과, 규칙·카드 점수·용어 표.
- 아이콘 4개 추가(game, spade, trend, hand. Lucide 1.8.0). 기존 26개는 그대로다.

## 구조

- 새 파일: `festival-games.js`(화면), `festival-games.css`(모양, `festival-bright.css` 다음에 로드), `tests/festival-games-unit.cjs`, `tests/minigames-browser.mjs`.
- `festival-account.js`의 `games`: ORBIT 함수 6개(`orbit_stock_snapshot`, `orbit_trade_stock`, `orbit_blackjack_state/join/cancel/action`)만 허용 목록으로 부르고, 공개 표 `stock_price_history`, `news`를 읽는다.
- 같은 Supabase 프로젝트의 기존 ORBIT 함수와 표를 쓰므로 **DB 변경은 없다**. 운영 DB에서 로그인 사용자가 6개 함수를 실행할 수 있고(익명은 불가), 세 표를 읽을 수 있으며, Auth 계정 19개가 모두 ORBIT 사용자와 연결돼 있음을 확인했다. `orbit_stock_snapshot`의 응답 키는 롤백한 읽기 전용 트랜잭션에서 화면이 기대하는 모양과 같음을 확인했다.
- 쓰는 돈은 ORBIT 가상 포인트(`public.users.money`)다. 축제 포인트·스탬프·바우처와 섞이지 않는다.
- 주소: 라우터에 `games`, `gamesStock`, `gamesStockDetail`(번호는 1 이상의 정수만), `gamesBlackjack`을 추가했다. 배포 경로 패턴도 같이 늘렸다.
- 체험(로컬) 모드에서는 서버를 부르지 않고 안내만 보여 준다.

## 디자인

- 새 부품 없이 기존 부품(`.web-header`, `.profile-list`, `.profile-shortcuts`, `.festival-view-tabs`, `.ops-section`, `.festival-empty`, `.status-badge`, `.ops-dialog`, 버튼 옆 결과 줄)을 쓴다. 자세한 값은 `DESIGN.md` 11.7.
- 가격 등락은 한국 시장 관례(오름 빨강 `#b93f3b`, 내림 파랑 `#285e92`)를 따르되 ▲/▼와 부호를 함께 쓴다. 가이드에 예외로 적었다.

## 확인

- 단위 테스트 173개 통과(새 미니게임·주소 테스트 3개 포함).
- `tests/minigames-browser.mjs`(실제 브라우저, ORBIT 함수는 가짜 응답): 5칸 내비와 활성 칸, 다른 화면에 미니게임 링크가 없음, 종목 목록·검색(포커스 유지)·정렬·관심·상세·그래프·매수 확정·거래 중지 종목·이전 거래 확인, 블랙잭 참가·대기·테이블·스탠드·공개·결과. 320·390·1024px에서 가로 스크롤 없음, 페이지 오류 없음.

- 기존 UI 브라우저 테스트 14개를 1.36 원본과 이 변경에서 같은 조건(미리보기 서버, Chrome)으로 돌렸다. 통과·실패 목록이 같다.
  - 통과: `bright-ui`, `ink-stamp`, `reward-choice`, `error-placement`, `csp`, `xss-sweep`, `voucher-manager`, `account-delete`, `school-account`, `operations-hotfix`.
  - 1.36 원본에서도 실패: `web-redesign-browser`(`#mapSearchBtn` 대기), `web-redesign-boundaries`, `ui-ver2-browser`, `review-ui-browser`. 이번 변경과 관계없는 옛 선택자 문제다.
  - 하단 내비 칸 수·이름을 4칸으로 확인하던 두 테스트(`bright-ui-browser`, `web-redesign-browser`)는 5칸으로 고쳤다.

## 확인하지 못한 것

- 실제 ORBIT 서버로 매수·매도와 블랙잭 판을 해 보지는 않았다. 실제 포인트가 움직이기 때문이다. 주식시장은 2026-12-24 09:00–12:00에만 열린다.
- 이 브랜치는 배포하지 않았다.
