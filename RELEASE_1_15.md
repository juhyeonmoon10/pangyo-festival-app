# 1.15 발급된 NFC 태그 관리, 참여 기록 초기화 오류 수정

2026-10-30. 사용자 요청: 관리자 NFC 태그 발급 화면에서 지금까지 발급된 태그도 관리할 수 있게 하고, 확인 문구를 정확히 입력해도 초기화가 "응답을 확인하지 못했어요" 오류로 실패하는 문제를 고친다.

## 초기화 오류 원인과 수정

- 공용 DB는 API 역할에 `pg_safeupdate`를 불러와, 함수 안에서도 WHERE 없는 DELETE를 거부한다(서버 로그: `DELETE requires a WHERE clause`, 10/30 11:06 두 번).
- `festival_ops_reset`의 `delete from public.booth_ratings`와 `delete from festival_ops.requests`가 여기에 걸려 매번 전체가 롤백됐고, 앱은 알 수 없는 오류 문구를 보여 줬다. 초기화는 한 번도 반영되지 않았다(처리 기록 0건).
- 두 문장에 항상 참인 조건(`booth_id is not null`, `request_id is not null`)을 붙였다. 삭제 범위는 그대로다.
- 격리 테스트가 이 문제를 잡지 못했던 이유: PGlite에는 `pg_safeupdate`가 없다. 이제 모든 축제 함수 본문에서 WHERE 없는 DELETE/UPDATE를 찾는 검사를 추가했다(기존 초기화를 잡아내는 것도 확인).

## 발급된 NFC 태그 관리

- 발급 화면 아래에 "발급된 태그" 목록: 전체·사용 중·사용 중지·만료 개수, 부스·상태 필터.
- 태그마다 부스, 카드 메모, 발급 시각과 발급자, 인식 횟수와 마지막 인식 시각, 중지 시각.
- 작업: 주소 보기(같은 주소 다시 복사), 메모 변경, 사용 중지, 다시 사용.
- 새로 발급할 때 카드 메모(최대 40자, 예: 정문 카드)를 붙일 수 있다.
- 사용 중지한 카드로는 스탬프가 적립되지 않는다("사용이 중지되었거나 교체·만료된 태그입니다"). 이미 적립된 스탬프는 유지된다.
- 이 기능 전에 발급한 카드는 기록이 없어 처음에는 보이지 않고, 학생이 처음 인식할 때 "이전 발급"으로 목록에 나타난다. 그 뒤로는 똑같이 중지할 수 있다.
- 서명 키의 epoch를 바꾸면 모든 태그가 "만료"로 표시되고 다시 사용할 수 없다.
- 주소 복사가 막힌 인앱 브라우저에서는 선택 복사로 한 번 더 시도한다.

## 서버 (`operations-server/nfc-tag-registry.sql`)

- `festival_nfc_private.tags`: 태그 ID(서명에 들어간 nonce), 부스, 서명 대상 payload, 메모, 발급자, 중지 여부, 인식 횟수. 서명된 토큰 자체는 저장하지 않고, 주소 보기 때 서버 키로 다시 서명한다. RLS 사용, 학생·익명 접근 불가.
- `claim`: 중지된 태그 거부, 처음 보는 이전 태그 등록, 인식 횟수 기록. `admin_issue`: 발급한 태그 등록.
- `public.festival_nfc_tag_admin(list|issue|url|label|revoke|restore)`: 운영자 전용, 발급·중지·재사용은 처리 기록에 남는다.
- 초기화는 태그를 유지하고 인식 횟수만 0으로 되돌린다.
- 되돌리기: `nfc-tag-registry-rollback.sql`(태그 관리 제거, 고친 초기화는 유지).

## 검증

- PGlite 격리 SQL: `nfc-tag-registry-isolated.mjs` 11/11(발급·목록·인식 횟수·중지·재사용·메모·이전 태그 등록·권한·초기화·epoch 교체·되돌리기, WHERE 없는 쓰기 검사).
- 브라우저 320/390/430: `nfc-tag-manager-browser.mjs`(HTTPS 출처에서 메모 발급, 목록 새로고침, 중지 후 서버 적립 거부, 상태 필터, 재사용, 같은 주소 다시 보기, 메모 변경, 토큰 미저장). `festival-account-browser.cjs`에 서버 업데이트 전 대체 발급 경로 확인 추가.

## 운영 현황: 부스별 스탬프 완료 인원

- 운영 현황에 "부스별 스탬프 완료" 목록: 부스마다 완료한 참여자 수(한 사람은 부스당 한 번), NFC·수동 구분, 완료 많은 순 막대.
- 서버: `operations-server/booth-stamp-counts.sql`의 `public.festival_booth_stamp_counts()`(운영자 전용, 읽기 전용). 격리 테스트 3/3, 브라우저 테스트에 대시보드 확인 추가.
