# NFC 무기한 태그 변경 (2026-09-30)

## 승인 및 적용 범위

사용자가 새 NFC 태그의 유효기한 제거 및 공용 Supabase 서버 변경을 승인했다.
`20260930-nonexpiring-tags.sql`은 프로젝트 `vvvkzvxahviwbuyfbwir`에 적용 완료했다.
기존 비공개 함수 `claim`, `issue_tag`, `admin_issue` 세 개만 교체한다.
새 테이블, 컬럼, 함수, RLS 정책, 권한, 비밀키 또는 학생 기록 변경은 없다.
ORBIT GitHub 저장소는 변경하지 않았다.

## 계약

- 웹은 기존 `festival_nfc_admin_issue`에 `p_booth`와 `p_valid_minutes: null`을 전달한다.
- 무기한 발급 응답의 `expiresAt`, `validMinutes`는 모두 명시적인 JSON `null`이다.
- 서명된 `nf1` payload에 `lifetime: "permanent"`, `expires: null`, nonce, epoch가 포함된다.
- 누락된 expires를 자동으로 무기한으로 해석하지 않는다. 서명된 명시적 표식이 필요하다.
- 기존 기간제 URL과 구버전 클라이언트의 1~10080분 요청은 기존 계약대로 동작한다.
- 기존 카드의 기한을 자동으로 없애지 않는다. 새 URL로 다시 기록해야 한다.
- 로그인, Google 세션 만료, 관리자 권한, 서명, 전체 NFC 중지, epoch 폐기, 부스 존재, 중복 방지는 유지한다.
- 개별 태그 폐기는 아직 지원하지 않는다. 정적 URL 공유에 의한 부정 적립 위험은 무기한 동안 지속될 수 있다.
- 로그인 복귀용 임시 태그 저장의 15분 제한과 바우처 만료는 이번 변경 대상이 아니다.

## 배포 보호 및 복구

적용 전 읽은 실제 서버 함수 원본과 비교해 격리 검증했다. SQL은 원본 함수 본문 해시가 다르면 중단한다.
같은 SQL을 두 번 실행해도 재검토 오류로 중단하며, 임의의 다른 팀 변경을 덮어쓰지 않는다.
커밋 전 함수 권한·소유자·실행 모드 불변과 실제 Vault 기반 기간제/무기한 발급 형식을 검사한다.
이 검사는 URL을 출력하거나 방문을 기록하지 않는다.

실제 서버 복구본은 로컬 `artifacts/nfc-permanent/server-rollback.sql`이다.
사용자 승인 후 복구하면 이전 함수 정의로 돌아가며 이미 적립된 기록은 유지된다.
복구 시 새 무기한 카드는 거부되고 새 웹의 발급 요청도 실패한다. 따라서 웹도 이전 버전으로 함께 복구해야 한다.
과거 `uninstall.sql`은 이 업데이트의 복구 절차가 아니므로 실행하지 않는다.

## 검증

- `isolated-test/permanent-tags.mjs`: PGlite 0.5.8, 합성 계정, 13/13 통과.
- 서버 원본 일치, 권한 불변, 무기한 발급, 중복, 기존 태그, 위조, 세션 만료, 중지, epoch 폐기, 복구 검증.
- `tests/festival-account-unit.cjs`: 23/23 통과. 구 서버의 거부나 기간제 응답을 무기한 성공으로 표시하지 않는다.
- `tests/nfc-permanent-preview.html`: 외부 연결을 CSP로 차단한 관리자 UI fixture.
- 320/390/430px에서 기간 선택 없음, 가로 넘침 없음, 발급 버튼 및 결과 표시 확인.
- 실제 서버 SQL 결과: `NFC_PERMANENT_UPDATE_APPLIED`, 함수 3개, 권한 불변.
- 실제 Google 계정의 발급/방문 전체 흐름과 실물 카드 RF는 이번 검증에서 실행하지 않았다.

검증 자료와 스크린샷: 로컬 `artifacts/nfc-permanent/`. 실제 비밀키와 유효 태그 URL은 자료에 포함하지 않는다.
