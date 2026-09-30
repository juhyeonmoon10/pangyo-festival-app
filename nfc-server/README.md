# NFC 서버 연결 작업 기록

기록일: 2026-09-09. 개인 축제 앱 전용 작업이며 ORBIT GitHub 저장소에는 변경하거나 업로드하지 않았다.

## 현재 상태

- 클라이언트: 실제 Google PKCE 로그인, 이름/학번 등록, 서버 프로필 조회와 NFC RPC 호출 코드 작성.
- 데모: 명시적으로 선택하는 별도 모드. 데모 기록을 서버에 올리지 않는다.
- 서버: 기본 권한/적립 SQL을 실제 DB의 단일 트랜잭션에서 검증하고 ROLLBACK 완료.
- 검증 통과: 본인 프로필, 다른 사용자 조회 거부, 직접 UPDATE 거부, 학생 태그 발급 거부, 서로 다른 두 부스 적립, 중복 방지, 위조 거부, 익명 요청 거부, Vault 접근 거부.
- 서버 미적용: `festival_nfc_private`가 없고 기존 users 정책이 유지되는 것을 조회로 확인했다.
- 추가된 만료 세션/태그 검사 SQL은 아직 재실행 전이다. SQL 편집기에 전달하는 과정의 달러 구분자 손상 때문에 RLS 경고가 발생했고, 자동 실행이 차단되어 취소했다. 로컬 SQL 파일의 구분자는 정상이다.
- 인증 설정 미변경: 기존 기본 URL 및 ORBIT 리다이렉트 2개를 그대로 유지했다. APK 복귀 주소 추가는 승인 대기다.
- 실제 Google 로그인 및 물리 NFC 태그 검증: 미완료. 코드/모의 테스트 결과를 실기기 인증 성공으로 해석하면 안 된다.

테스트용 auth.users/auth.sessions 및 함수/권한 변경은 롤백했다. PostgreSQL identity sequence는 트랜잭션 롤백 시에도 번호가 진행될 수 있으므로 번호의 빈 구간은 가능하다. 기존 학생 레코드나 방문/금액은 테스트에 사용하지 않았다.

## 변경 범위

사용하는 기존 테이블은 `public.users`, `public.booths`, Supabase의 `auth.users`, `auth.sessions`, 기존 Vault다. 새 테이블은 만들지 않는다.

설치 SQL 적용 시에만 다음 변경이 생긴다.

1. 새 비공개 함수 스키마 `festival_nfc_private`.
2. 기존 Vault에 NFC 서명 설정 한 건. 서명 키는 DB에서 무작위 생성하고 클라이언트에 보내지 않는다.
3. 공개 SECURITY INVOKER RPC 2개와 비공개 구현 함수 3개.
4. `users` 조회는 `auth_user_id = auth.uid()`인 본인 행으로 제한.
5. 학생/익명 역할의 `users` 직접 UPDATE 권한 회수. 돈, 관리자 여부, 완료 부스 배열을 브라우저에서 임의 변경하지 못한다.

기존 ORBIT 함수, Auth 생성 트리거, 주문/주식 테이블, 가이드와 GitHub 브랜치는 수정하지 않는다. 다른 팀이 users를 직접 UPDATE하는 코드를 만들면 이 계약과 충돌하므로 서버 권한 검사를 갖춘 별도 기능으로 검토해야 한다.

## API 계약

공통 요청: Supabase SDK가 publishable key와 로그인한 사용자의 Bearer JWT를 전송한다. service_role/DB 비밀번호는 웹과 APK에 포함하지 않는다.

### festival_nfc_profile()

입력 인자 없음. 사용자 ID를 클라이언트에서 받지 않는다.

응답 필드: `id`, `authUserId`, `name`, `email`, `studentNumber`, `needsProfile`, `completedBooths`.

서버에서 Google 공급자, 이메일 인증, 실제 auth.sessions 존재, 세션 만료와 계정 차단 여부를 검사하도록 작성했다. 이름/학번은 본인의 Auth 메타데이터에서 읽는다. 이 값은 권한이나 관리자 판정에 쓰지 않는다.

### festival_nfc_claim(p_token text)

입력은 서명 토큰 한 개다. 사용자 ID, 부스 번호, 보상액, 완료 목록을 받지 않는다.

검증 순서: 실제 계정/세션, 프로필 등록, NFC 활성 설정, 형식/최대 길이, HMAC 서명, 만료/설정 세대, 기존 부스 존재, 본인 행 잠금, 중복 확인, 배열 추가.

응답: `result`는 `EARNED` 또는 `ALREADY_EARNED`, `boothKey`는 DB의 부스 enum, `completedBooths`는 서버의 현재 목록, `checkedAt`은 확인 시각이다. `checkedAt`을 방문 시각으로 표시하지 않는다.

같은 사용자/부스 재요청은 추가 적립 없이 기존 상태를 반환한다. DB 행 잠금 및 사용자 advisory transaction lock을 사용한다. 실제 다중 DB 세션 부하 검증은 별도로 남아 있다.

클라이언트는 응답을 받기 전에 성공 상태를 표시하지 않는다. 통신 오류에는 재시도를 제공한다. 여러 태그는 순서대로 처리한다. 같은 토큰의 동시 SDK 요청은 한 요청으로 합친다.

## 로그인과 APK

- 공식 supabase-js 2.116.0을 버전 고정하여 번들에 포함했다.
- 웹은 현재 웹 origin/path로 돌아오고 APK는 `pangyofestival://auth/callback`으로 복귀한다.
- APK Google 로그인은 외부 브라우저에서 진행하며, 코드는 WebView에 남아 있는 PKCE verifier로 교환한다.
- APK는 정확한 콜백 scheme/host/path만 받으며 외부 웹페이지를 앱 내부에 로드하지 않는다.
- WebView 외부 요청은 해당 Supabase의 공개 부스 조회, 두 NFC RPC 및 필요한 Auth 경로/메서드만 허용한다.
- 실제 WebView에서 공개 부스 20개 조회 성공을 확인했다. Google 로그인 성공 검증과는 별개다.
- `file://` 미리보기에서는 실제 OAuth 로그인하지 않는다. APK 또는 승인된 웹 복귀 주소가 필요하다.

## 태그 운영

실제 태그 형식은 `nf1.<base64url payload>.<HMAC hex>`다. 예전 `NFC-G1-01` 및 `mock-v1.*`는 실제 서버에서 적립되지 않는다.

설치/인증 검증 후 운영자가 비공개 `issue_tag(booth_enum, expires_at)` 함수를 SQL 권한으로 호출한다. 학생 API에서 발급할 수 없다. 현재 발급 가능 기간은 최대 7일이며 행사 직전 재발급이 필요하다. 실제 태그 발급/재기록은 아직 하지 않았다.

Android 전용 URL은 `pangyofestival://nfc#t=<서명 토큰>`이다. 설치된 APK에서 사용하며, 앱 미설치/iPhone의 웹 대체 경로는 제공하지 않는다. HTTPS URL을 사용할 때는 해당 웹 배포가 이 버전인지 먼저 검증해야 한다. 현재 기존 Vercel 페이지를 새 버전이라고 안내하면 안 된다.

토큰을 포함한 NDEF URL의 전체 바이트 길이와 실제 카드 용량을 확인해야 한다. 작은 카드에는 긴 서명 URL이 들어가지 않을 수 있다. URL 쓰기 후 다시 읽어서 전체 문자열이 보존되는지 확인한다.

서명은 위조를 막지만 정적 태그 URL의 복사/공유까지 막지는 못한다. URL 보유만으로 현장 방문을 완전히 증명한다고 주장하지 않는다.

## 현재 구조의 한계

- 완료 부스 배열에는 행사 ID, 방문 시각, 취소 이력, 감사 로그가 없다.
- 5분 내 과다 방문 제재, 행사별 초기화/통계, 단기 코드 수동 승인, 개인별 리뷰 서버 등록, 보상 지급은 아직 구현/연결하지 않았다.
- 학교 허용 계정 제한, 학번의 실제 소유권/중복 검증은 아직 없다. 학교 전체 운영에 배포하기 전 승인이 필요하다.
- 지도 배치는 임시이며 DB에 없는 운영 상태/운영 시간은 확인 전으로 표시한다.
- 새로운 테이블/열이 필요한 요구는 별도 승인 후 진행한다.

## 검증 자료와 재개 절차

- `../tests/festival-account-unit.cjs`: SDK 경계 단위 테스트 6개.
- `../tests/festival-account-browser.cjs`: 320/390/430px 모의 서버 기반 화면/저장 경로 검증.
- `../artifacts/nfc-server/`: 화면 캡처와 브라우저 결과.
- Android `tests/android-web-audit.cjs`: 패키징된 데모 화면 회귀 검증.
- Android `tests/android-device-smoke.cjs`: 격리 에뮬레이터의 실제 공개 DB 조회 및 데모 NFC 인텐트 테스트.

1. 사용자 승인을 확인한다. 보안 경고를 임의로 우회하지 않는다.
2. 로컬 install.sql의 마지막 COMMIT 대신 database-rollback.sql을 붙여 전체 트랜잭션을 다시 검증한다. 문자열 치환으로 SQL의 `$$`를 손상시키지 않는다.
3. 테스트 성공 및 롤백 확인 후 설치 SQL을 적용한다. 실제 적용된 함수/정책을 다시 조회하고 익명 접근 거부를 검증한다.
4. 기존 인증 설정을 보존하면서 승인받은 APK 콜백만 추가한다.
5. 사용자가 실제 Google 로그인, 이름/학번 등록을 수행한다.
6. 짧은 유효 기간의 두 태그를 발급하여 첫 적립, 다른 부스, 재태깅, 재실행 후 유지, 네트워크 실패를 실기기에서 확인한다.

문제가 생기면 NFC 함수 실행을 제한하는 방식으로 쓰기를 중단한다. 기존의 모든 학생 조회/수정 허용 정책을 자동 복원하지 않는다. 변경 전 정책은 `before-permissions.json`에 남겨 두었다.

## 2026-09-10 추가: 검토 문서와 복구 SQL

- `REVIEW_2026-09-10.md`: 설치안이 다른 팀에 미치는 영향, 격리 검증 결과, 복구 절차, 승인 요청 항목.
- `precheck.sql`: 적용 전후 읽기 전용 상태 조회.
- `admin-issue.sql`: 관리자(`users.admin`) 전용 태그 발급 RPC 초안. `install.sql` 뒤에 별도 승인으로 적용.
- `disable.sql`: 학생 RPC 즉시 중단. 정책·데이터는 유지.
- `uninstall.sql`: 함수·스키마·비밀 제거 후 2026-09-09 권한 복원. 운영자 판단 후에만 실행.
- `isolated-test/`: PGlite 격리 검증(`run.mjs`, `shim.sql`). 결과는 `../artifacts/nfc-isolated-db/report.json`.

공용 DB에는 여전히 아무것도 적용하지 않았다.
