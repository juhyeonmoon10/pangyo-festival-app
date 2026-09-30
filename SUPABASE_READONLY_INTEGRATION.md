# 기존 Supabase 읽기 전용 연결

확인일: 2026-09-09. 대상은 개인 판교고 축제 앱이다.

## 적용 범위

- 프로젝트: `vvvkzvxahviwbuyfbwir`
- 클라이언트: `supabase-catalog.js`, 네이티브 APK에도 같은 파일 포함
- 호출: `GET /rest/v1/booths?select=id,name,rating,position&order=id&limit=1000`
- 기존 공개 publishable key만 사용한다. DB 비밀번호, secret/service_role key, 사용자 세션은 사용하지 않는다.
- 이름, 평균 별점, 위치 문자열만 읽는다. 실제 공개 조회 결과는 20개이며 확인 시 모든 위치가 빈 문자열이었다.
- 찾동 동아리 UUID와 DB enum ID의 명시적 대응표로 연결한다. 배열 순서나 교실 번호로 DB 대상을 추정하지 않는다.
- 동아리 설명/로고, 교실 좌표, 운영 상태, 시간은 기존 로컬 자료다. DB 위치 문자열이 생겨도 좌표를 자동 추정하지 않으며 지도는 임시 배치로 표시한다.
- 로컬 NFC 태그와 부스 ID는 유지한다. 기존 데모 사용자/리뷰/스탬프를 공용 DB로 이관하지 않는다.

## 변경하지 않은 것

테이블, 컬럼, enum, RLS, grants, 함수, 트리거, 데이터, 인증 공급자 설정, 마이그레이션 모두 변경하지 않았다.
동아리 ORBIT 저장소와 가이드도 변경하지 않았다. GitHub push와 공개 웹 배포는 하지 않았다.

`supabase/migrations/001_nfc_stamp_core.sql` 및 기존 NFC API 프로토타입은 이 공용 DB와 계약이 다르다.
이 SQL을 적용하거나 공용 DB secret을 기존 API에 넣으면 안 된다. `STAMP_GATEWAY_MODE`는 `mock`을 유지한다.

## 관찰된 기존 계약

| 대상 | 확인한 컬럼/접근 범위 | 판단 |
| --- | --- | --- |
| `public.booths` | enum `id`, `name`, `rating`, `position`; anon SELECT 허용 | 공개 조회 연결 |
| `public.users` | integer `id`, `auth_user_id`, `email`, `admin`, `money`, `completed_booths` 등 | 개인 데이터 접근/수정 연결 보류 |
| `public.booth_ratings` | `user_id`, `booth_id`, `rating`, `created_at`; 사용자/부스 중복 제약 | 조회/작성 연결 보류 |

사용자 실제 행은 조회하거나 수정하지 않았다. 테이블 구조, 정책/권한 메타데이터와 공개 부스 행만 확인했다.
대시보드의 API 표시만으로 단정하지 않고 익명 공개 GET 성공을 별도로 확인했다.

## 로그인과 쓰기 연결을 보류한 이유

- `users_authenticated_select`는 authenticated 전체에 `USING true`였다.
- `users_authenticated_update`는 `USING true`, `WITH CHECK money >= 0`였다. 확인된 UPDATE grant와 함께 보면 사용자 본인 범위 및 관리자 필드 보호가 부족하다.
- `booth_ratings_own_insert`는 이메일 연결을 검사하지만 스탬프 보유를 검사하지 않는다.
- 안전한 NFC 검증/적립 RPC 계약은 확인되지 않았다. 태그 URL이나 부스 ID만으로 DB 적립을 만들지 않는다.
- 실제 Google 공급자는 활성화되어 있지만 위 권한 문제를 클라이언트 필터로 해결할 수 없다.

담당자 승인 후 본인 사용자 범위, 보호 필드, 방문 검증 및 재시도 안전성에 대한 서버 계약이 확보되어야 다음 연결을 진행할 수 있다.
승인 없이 정책을 고치거나 관리자 키로 우회하지 않는다. 현재 Google 버튼은 실제 인증으로 오인하지 않도록 학생 데모 입장으로 표시한다.

## 실패 처리와 데이터 구분

- 로딩: 기존 화면 유지. 자동 폴링 없음, 수동 새로고침 가능.
- 6초 제한/네트워크/HTTP/응답 계약 오류: 오류 상태를 표시하고 최근 공개 캐시가 있으면 저장본으로 표시한다.
- 공개 캐시만 별도 키에 저장하며 재실행 시 24시간이 지난 캐시는 무시한다. 로컬 학생 DB와 분리한다.
- 동시 새로고침은 같은 요청을 공유한다. 요청 본문/사용자 ID/인증 쿠키를 보내지 않는다.
- 서버 별점과 데모 리뷰 수/평균은 별도 출처로 표시한다. 서버 리뷰 개수는 조회하지 않았으므로 만들어내지 않는다.
- 서버 응답은 검증 후 출력 시 escape 또는 textContent를 사용한다. 원격 HTML을 삽입하지 않는다.
- 데이터 도착 시 이름/별점/연결 상태 텍스트만 갱신한다. 전체 render를 호출하지 않아 검색 IME, 입력 중 리뷰, 지도 이동 상태를 유지한다.
- 서버에 새 부스가 생겨 대응표에 없으면 지도에 임의 배치하지 않고 연결 상태에 미배정 개수를 표시한다.

## 검증

- `node tests/supabase-catalog-unit.cjs`: 공개 GET, 20개 대응표, 중복 요청, 오류/재시도, 캐시, timeout, 응답 검증, 저장소 거부.
- `node tests/supabase-catalog-browser.cjs`: 320/390/430px, 서버명 검색, 띄어쓰기, 조회 완료 중 한글 조합/포커스, XSS 문자열, 오프라인 캐시, 로컬 DB 불변.
- `node tests/supabase-catalog-browser.cjs --live`: 기존 공개 부스만 실제 GET 조회. 실제 사용자 기록 및 스탬프/평점 작성은 시험하지 않는다.
- 화면과 JSON 결과: `artifacts/supabase-catalog/`.

Android 하드웨어 NFC 및 실제 OAuth는 이번 연결의 검증 범위가 아니다.

### 이번 실행 결과

- 새 카탈로그 단위 테스트 10개 통과, 기존 NFC API 프로토타입 테스트 11개 통과(모의 upstream).
- 카탈로그 브라우저 검사 320/390/430px 모두 통과. 실제 브라우저에서도 공개 GET 1회로 20개 조회 확인.
- APK 웹 회귀 검사 320/390/430px 모두 통과: 연속 모의 태그 2개, 같은 태그 중복 방지, 재시작 후 로컬 기록 유지.
- Android `assembleDebug`, `testDebugUnitTest`, `lintDebug` 성공. NFC URL 단위 테스트 4개 실패 0; 변경하지 않은 native 테스트는 Gradle 캐시 결과를 사용했다.
- APK 내부 `app.js`, `supabase-catalog.js`, `styles.css`와 검증한 웹 소스 일치 확인. 전송 ZIP 내 APK 바이트 일치 확인.
- 새 APK: `../pangyo-festival-android/artifacts/pangyo-festival-supabase-readonly.apk`
- 전송 ZIP: `../pangyo-festival-android/artifacts/pangyo-festival-supabase-readonly.zip`
- 이전 APK 백업: `../pangyo-festival-android/artifacts/pangyo-festival-before-supabase.apk`
- 새 APK SHA-256: `1a8188007ac34f16aafe3e34a8bf2bd752cbbd6199ae6feadd1a44f7b5de12b5`
