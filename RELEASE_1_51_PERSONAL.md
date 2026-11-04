# 1.51 개인 병합본 배포

## 범위

- 개인 저장소 `juhyeonmoon10/pangyo-festival-app`와 개인 Vercel 사이트만 대상으로 한다.
- 병합본 기준 커밋 `53308b5f5eff9ec4bac4db88ceec22fcec136ca0`(1.49)의 전체 운영 소스를 개인 1.50 UI 개선과 통합했다.
- 공용 ORBIT 저장소와 공용 DB는 변경하지 않는다. 포함된 SQL 참고 파일은 실행하지 않으며 웹 배포물에도 포함하지 않는다.
- UI 실험실의 가짜 로그인, 모의 데이터 어댑터, 격리 스크립트는 가져오지 않는다.

## 포함 기능

- 홈, 지도, 스탬프, 미니게임, MY의 하단 5개 탭.
- `/games`, `/games/stock`, `/games/stock/:id`, `/games/blackjack`과 운영자 게임 관리 화면.
- 동아리 도장 20종, 스탬프 아래 방문 목록, 스탬프 3개와 6개에서만 지급하는 쿠폰 규칙.
- 지도 동아리명 표시, 넓어진 지도 이동 범위, 홈 중복 메뉴 정리, 쿠폰·공지 명칭 통일.
- Google 이름 정보의 성·이름 대체 표시 및 수정 가능한 최초 이름 입력값. 인증·실명 검증 권한은 바꾸지 않는다.
- `/nfc-cards/`의 동아리별 인쇄용 카드 시안.

## 검증

- 단위 테스트 178개 통과. 빌드 공개 파일 78개와 게임 경로, 비공개 파일 제외를 검증했다.
- 배포 빌드에 실제 CSP를 적용한 로컬 브라우저 검사: 320/390/430/1024px, 40개 화면 검사 통과.
- 가상주식·블랙잭·게임 관리 브라우저 검사 통과. 게임 RPC는 가짜 응답으로, 행사 SQL은 로컬 PGlite에서만 실행했다.
- 로컬 브라우저 검사는 한글 조합 입력, 띄어쓰기 무관 검색, 지도 이동·확대, 이름 입력값 보존, 모바일 가로 넘침을 포함한다.
- 실제 Google 로그인, 실물 NFC, 실서버 게임 대전 및 포인트 거래는 이번 배포 검증에서 실행하지 않았다.
- 기존 게임 RPC의 운영 서버 설치 여부는 이번 작업에서 변경하거나 보증하지 않는다. 서버가 준비되지 않은 기능은 기존 오류·대기 안내를 따른다.

## 재검증

```powershell
node --test tests/*-unit.cjs
node tools/build-web.cjs
node tests/ui-refinements-browser.cjs
node tests/club-stamps-browser.cjs
node tests/minigames-browser.mjs
```

브라우저 검사는 Playwright와 Microsoft Edge가 필요하다. 미니게임 검사는 `PGLITE_DIR`에 로컬 PGlite 설치 경로를 지정한다. 검사 보고서와 스크린샷은 Git에서 제외한 `artifacts/`에 저장한다.
