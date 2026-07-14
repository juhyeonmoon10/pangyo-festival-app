# 판교고 개인 축제 앱 서버·DB·API 설계안

| 항목 | 내용 |
| --- | --- |
| 문서 목적 | 현재 `localStorage` 데모를 실제 서버 기반 서비스로 교체하기 전에 데이터 계약, 권한, API, NFC 적립 무결성을 확정한다. |
| 대상 | 프런트엔드, 백엔드, DB 담당자, 운영 책임자, QA |
| 작성 기준일 | 2026-07-14 |
| 현재 상태 | 설계 초안. DB migration과 실제 API는 아직 구현하지 않았다. |
| 적용 범위 | 개인 저장소 `juhyeonmoon10/pangyo-festival-app` |
| 금지 범위 | ORBIT 공용 저장소와 공용 Supabase에는 이 문서를 자동 적용하지 않는다. |

## 1. 설계 목표

실서비스 전환에서 가장 중요한 목표는 다음과 같다.

1. 같은 학생이 같은 행사·부스의 스탬프를 두 번 받을 수 없어야 한다.
2. 브라우저가 요청 결과를 받지 못해 재시도해도 결과가 한 번만 생성되어야 한다.
3. 학생, 부스 운영자, 행사 관리자 권한을 서버에서 구분해야 한다.
4. NFC URL이나 태그 식별자만 복사해 데이터베이스를 직접 조작할 수 없어야 한다.
5. 수동 승인, 상태 변경, 태그 교체, 방문 취소 같은 운영 작업은 행위자와 사유가 남아야 한다.
6. 모든 데이터는 `event_id`로 분리되어 다음 행사 기록과 섞이지 않아야 한다.
7. 모바일 네트워크가 느리거나 응답이 유실되어도 중복과 데이터 손상이 없어야 한다.
8. 리뷰·보상 같은 확장 기능은 핵심 방문 인증과 분리해 기능 플래그로 끌 수 있어야 한다.

### 1.1 이번 설계에 포함하는 기능

- Google 또는 학교 승인 OIDC 로그인
- 행사 접근 권한과 역할
- 부스 목록, 검색, 층·교실 위치, 운영 상태
- NFC 방문 인증과 중복 방지
- 학생 본인의 축제 패스
- 담당 운영자의 수동 방문 승인
- 관리자용 부스·NFC·공지·비상 모드·통계
- 감사 로그와 요청 추적
- P1 확장용 즐겨찾기와 리뷰 계약

### 1.2 이번 설계에서 제외하는 기능

- 실제 금전 결제
- 가상 주식, 공개 자산 순위, 랜덤채팅
- NFC 태그 자체의 발급 장비 또는 능동형 리더 제작
- 공용 ORBIT DB의 직접 변경
- 현재 브라우저 데모 사용자와 스탬프의 운영 DB 이관

## 2. 권장 시스템 구조

```text
학생/운영자 모바일 브라우저
        |
        | HTTPS, HttpOnly 세션 또는 Supabase JWT
        v
웹 앱 + 서버 API(BFF)
        |
        | 서버 권한 검사, 입력 검증, transaction
        v
PostgreSQL / 별도 Supabase 프로젝트
        |
        +-- Auth: Google/OIDC
        +-- RLS: 직접 접근 방어
        +-- Audit/Monitoring
```

### 2.1 권장 기술 선택

- 프런트엔드: 현재 정적 UI를 유지할 수 있으나 실제 연동 단계에서는 Next.js App Router 또는 동등한 서버 런타임을 권장한다.
- 인증: Supabase Auth의 Google/OIDC 또는 학교가 승인한 OIDC 공급자.
- DB: PostgreSQL. Supabase를 사용할 경우 개인 개발용·rehearsal용 프로젝트를 공용 운영 프로젝트와 분리한다.
- API: `/api/v1` BFF. 읽기 일부는 RLS를 적용한 Supabase client로 허용할 수 있지만 모든 쓰기는 서버 API를 우선한다.
- 배포: Vercel 같은 관리형 HTTPS 환경.
- 스키마 격리: PostgreSQL의 `festival` 스키마 사용을 권장한다.

### 2.2 신뢰 경계

다음 값은 클라이언트가 보내더라도 신뢰하지 않는다.

- `userId`, `role`, `admin`, `operatorBoothId`
- 스탬프 획득 시각
- 부스 운영 상태
- NFC 태그와 연결된 행사·부스 ID
- 리뷰 작성 가능 여부
- 방문 수, 평균 별점, 통계 값

서버는 세션의 사용자 ID와 DB의 행사 역할을 사용해 모든 값을 다시 판정한다.

## 3. 인증과 권한 모델

### 3.1 로그인 원칙

1. 사용자가 Google/OIDC 인증을 완료한다.
2. 서버는 공급자의 불변 식별자와 서명된 토큰을 검증한다.
3. 허용 학교 도메인 또는 학교 승인 명단을 서버에서 확인한다.
4. `auth.users.id`와 `festival.profiles.id`를 1:1로 연결한다.
5. 현재 행사 `event_memberships`를 조회해 역할과 활성 상태를 결정한다.
6. 이메일 문자열이나 클라이언트의 `admin: true` 값만으로 권한을 부여하지 않는다.

### 3.2 역할

| 역할 | 허용 범위 |
| --- | --- |
| `student` | 부스 조회, 본인 스탬프·패스 조회, NFC 적립, 본인 즐겨찾기·리뷰 |
| `operator` | 학생 기능 + 배정된 부스 상태 변경·수동 승인 |
| `supervisor` | 여러 부스 운영 관리, 수동 승인 취소, 운영 통계 |
| `admin` | 행사 설정, 부스·NFC·공지·비상 모드·역할 관리, 전체 감사 조회 |

역할은 행사별이다. 이전 행사의 관리자가 다음 행사에서도 자동 관리자가 되어서는 안 된다.

### 3.3 부스 담당 권한

`operator`는 `booth_operator_assignments`에 배정된 부스만 수정한다. `supervisor`와 `admin`은 행사 전체 범위를 관리할 수 있다. 권한 검사는 API와 DB/RLS에서 모두 수행한다.

## 4. DB 공통 규칙

- 기본 키는 UUID를 사용한다. PostgreSQL에서는 `gen_random_uuid()`를 기본값으로 둔다.
- 모든 운영 데이터에는 `event_id`를 포함한다.
- 모든 시각은 `timestamptz`로 저장하고 UI에서 `Asia/Seoul`로 표시한다.
- 원문 이메일, 학번, NFC 토큰, 세션 값은 로그에 남기지 않는다.
- 삭제가 감사 대상이면 물리 삭제 대신 `deleted_at`, `revoked_at`, `status`를 사용한다.
- `created_at`, `updated_at`은 서버/DB가 기록한다.
- 클라이언트가 보낸 평균·방문 수를 저장하지 않고 원본 기록에서 계산한다.
- 스탬프, 수동 승인, NFC 교체, 역할 변경은 transaction 안에서 감사 로그와 함께 처리한다.
- 테이블 이름은 아래와 같이 `festival` 스키마를 기준으로 한다.

## 5. enum과 상태 값

```sql
event_status      = draft | rehearsal | active | paused | ended | archived
membership_role   = student | operator | supervisor | admin
booth_status      = preparing | open | crowded | paused | closed
stamp_method      = nfc | manual
stamp_status      = active | revoked
notice_severity   = info | warning | emergency
review_status     = visible | hidden | deleted
```

앱의 기존 `preparing/open/crowded/paused/closed` 값과 API의 `booth_status`를 동일하게 유지한다.

## 6. 테이블 설계

### 6.1 `festival.events`

행사 한 회차를 나타낸다.

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `slug` | `text` | unique, URL용. 예: `pangyo-2026` |
| `name` | `text` | 필수 |
| `status` | `event_status` | 필수, 기본 `draft` |
| `starts_at` | `timestamptz` | 필수 |
| `ends_at` | `timestamptz` | 필수, `ends_at > starts_at` |
| `timezone` | `text` | 기본 `Asia/Seoul` |
| `emergency_mode` | `boolean` | 기본 `false` |
| `feature_flags` | `jsonb` | 예: `{"reviews": false, "favorites": true}` |
| `created_at` | `timestamptz` | 기본 `now()` |
| `updated_at` | `timestamptz` | trigger 또는 서버 갱신 |

인덱스: `unique(slug)`, `(status, starts_at)`.

### 6.2 `festival.profiles`

인증 사용자와 앱 프로필을 연결한다. Supabase를 사용하면 `id`는 `auth.users.id`를 참조한다.

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK, `auth.users(id)` FK |
| `display_name` | `text` | 필수, 1~40자 |
| `active` | `boolean` | 기본 `true` |
| `created_at` | `timestamptz` | 기본 `now()` |
| `updated_at` | `timestamptz` | 필수 |

이메일은 인증 시스템이 원본을 관리한다. 앱 테이블에 복사해야 한다면 검색·표시 목적을 명확히 하고 별도 접근 정책을 둔다.

### 6.3 `festival.event_memberships`

행사별 참여와 역할을 관리한다.

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `event_id` | `uuid` | `events` FK, 필수 |
| `user_id` | `uuid` | `profiles` FK, 필수 |
| `role` | `membership_role` | 필수 |
| `student_number` | `text` | 학생일 때만 사용, 정규화 후 저장 |
| `active` | `boolean` | 기본 `true` |
| `expires_at` | `timestamptz` | 임시 운영자 권한 만료 |
| `created_by` | `uuid` | 역할을 부여한 사용자 |
| `created_at` | `timestamptz` | 기본 `now()` |

제약:

- `unique(event_id, user_id)`
- 학생 학번은 행사 안에서 중복 불가: `unique(event_id, student_number) where student_number is not null`
- `operator/supervisor/admin` 역할 부여·해제는 감사 로그 필수

### 6.4 `festival.booths`

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `event_id` | `uuid` | `events` FK, 필수 |
| `code` | `text` | 행사 내 식별 코드. 예: `G1-01`, `HEALTH-101` |
| `club_name` | `text` | 동아리/운영 주체 |
| `name` | `text` | 필수, 1~80자 |
| `floor` | `smallint` | 1~4 |
| `room` | `text` | 예: `1-1 교실` |
| `location` | `text` | 사용자 표시용 위치 |
| `description` | `text` | 최대 길이 제한 권장 2,000자 |
| `category` | `text` | `class`, `facility`, `custom` 등 |
| `status` | `booth_status` | 필수 |
| `opens_at` | `timestamptz` | 필수 |
| `closes_at` | `timestamptz` | 필수 |
| `map_x` | `numeric(5,2)` | 0~100 |
| `map_y` | `numeric(5,2)` | 0~100 |
| `favorite_weight` | `integer` | 추천 정렬용, 기본 0 |
| `deleted_at` | `timestamptz` | 운영 중 물리 삭제 금지 |
| `created_at` | `timestamptz` | 기본 `now()` |
| `updated_at` | `timestamptz` | 필수 |

제약과 인덱스:

- `unique(event_id, code)`
- `check(floor between 1 and 4)`
- `check(map_x between 0 and 100 and map_y between 0 and 100)`
- `(event_id, floor, status)`
- 검색용 `lower(name)`, `lower(club_name)`, `location` trigram 인덱스는 데이터가 늘어난 뒤 적용

### 6.5 `festival.booth_operator_assignments`

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `event_id` | `uuid` | 필수 |
| `booth_id` | `uuid` | 필수, 같은 `event_id`의 부스여야 함 |
| `user_id` | `uuid` | 필수, 해당 행사의 `operator` 이상 |
| `created_by` | `uuid` | 필수 |
| `created_at` | `timestamptz` | 기본 `now()` |

PK 또는 unique: `(event_id, booth_id, user_id)`.

### 6.6 `festival.nfc_tags`

실제 태그 URL의 비밀 토큰 원문을 DB에 저장하지 않는다.

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `event_id` | `uuid` | 필수 |
| `booth_id` | `uuid` | 필수 |
| `tag_code` | `text` | 운영자 식별용. 예: `G1-01-A` |
| `token_digest` | `bytea` | HMAC-SHA256 결과, unique |
| `version` | `integer` | 회전 횟수, 기본 1 |
| `active` | `boolean` | 기본 `true` |
| `activated_at` | `timestamptz` | 필수 |
| `expires_at` | `timestamptz` | 행사 종료 시각 이하 권장 |
| `rotated_at` | `timestamptz` | nullable |
| `disabled_reason` | `text` | 분실·복제 의심 사유 |
| `created_by` | `uuid` | 관리자 |
| `created_at` | `timestamptz` | 기본 `now()` |

제약:

- `unique(event_id, tag_code)`
- 한 부스에 여러 예비 태그는 허용하되 활성 태그 수는 운영 정책으로 제한한다.
- `token_digest`는 `HMAC_SHA256(NFC_TOKEN_PEPPER, raw_token)`으로 계산한다.
- 토큰 원문, 서명 비밀, 태그 전체 URL은 로그와 감사 metadata에 저장하지 않는다.

### 6.7 `festival.stamps`

학생 방문 인증의 원본 기록이다.

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `event_id` | `uuid` | 필수 |
| `user_id` | `uuid` | 스탬프를 받은 학생 |
| `booth_id` | `uuid` | 필수 |
| `method` | `stamp_method` | `nfc` 또는 `manual` |
| `status` | `stamp_status` | 기본 `active` |
| `source_tag_id` | `uuid` | NFC 적립일 때 `nfc_tags` FK |
| `approved_by` | `uuid` | 수동 승인 운영자 |
| `approval_reason` | `text` | 수동 승인 사유, 10~300자 권장 |
| `earned_at` | `timestamptz` | DB 서버 시각 |
| `revoked_at` | `timestamptz` | 취소 시각 |
| `revoked_by` | `uuid` | 취소 처리자 |
| `revocation_reason` | `text` | 필수 |
| `created_at` | `timestamptz` | 기본 `now()` |

핵심 제약:

```sql
create unique index stamps_one_active_visit
on festival.stamps(event_id, user_id, booth_id)
where status = 'active';
```

- `method='nfc'`이면 `source_tag_id` 필수
- `method='manual'`이면 `approved_by`, `approval_reason` 필수
- 취소는 행을 삭제하지 않고 `status='revoked'`와 취소 정보를 기록한다.
- 재승인이 필요하면 기존 취소 행은 유지하고 새 `active` 행을 추가한다.

### 6.8 `festival.stamp_attempts`

성공·중복·거부 시도를 짧은 기간 보존해 장애와 복제 의심을 조사한다.

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `event_id` | `uuid` | nullable, 토큰 판별 전이면 비어 있을 수 있음 |
| `user_id` | `uuid` | nullable |
| `booth_id` | `uuid` | nullable |
| `tag_id` | `uuid` | nullable |
| `result_code` | `text` | `EARNED`, `ALREADY_EARNED`, `TAG_INVALID` 등 |
| `request_id` | `uuid` | 서버 요청 추적 ID |
| `idempotency_key` | `text` | 원문 대신 필요 시 digest 저장 |
| `ip_digest` | `bytea` | 선택, 원문 IP 로그 금지 |
| `user_agent_digest` | `bytea` | 선택 |
| `created_at` | `timestamptz` | 기본 `now()` |

보존 기간은 예를 들어 행사 종료 후 30일로 정하고 학교 승인을 받는다.

### 6.9 `festival.idempotency_records`

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `actor_id` | `uuid` | 세션 사용자 |
| `scope` | `text` | 예: `stamp:nfc`, `stamp:manual` |
| `idempotency_key` | `text` | 클라이언트 UUID |
| `request_digest` | `bytea` | 같은 키에 다른 body 사용 방지 |
| `response_status` | `integer` | 최초 응답 HTTP 상태 |
| `response_body` | `jsonb` | 민감정보 제외 |
| `created_at` | `timestamptz` | 기본 `now()` |
| `expires_at` | `timestamptz` | 최소 행사 당일까지 유지 |

PK: `(actor_id, scope, idempotency_key)`.

같은 키와 같은 요청이면 저장된 응답을 반환한다. 같은 키에 다른 body가 오면 `409 IDEMPOTENCY_KEY_REUSED`를 반환한다.

### 6.10 `festival.participant_lookup_codes`

운영자가 학번 전체를 받지 않고 학생을 찾기 위한 단기 코드다.

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `event_id` | `uuid` | 필수 |
| `user_id` | `uuid` | 학생 |
| `code_digest` | `bytea` | 6~8자리 코드 원문 저장 금지 |
| `expires_at` | `timestamptz` | 5~10분 권장 |
| `used_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` | 기본 `now()` |

코드는 짧으므로 서버 비밀키를 사용한 HMAC digest를 저장하고 시도 횟수를 제한한다.

### 6.11 `festival.favorites` P1

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `event_id` | `uuid` | 필수 |
| `user_id` | `uuid` | 본인 |
| `booth_id` | `uuid` | 필수 |
| `created_at` | `timestamptz` | 기본 `now()` |

PK: `(event_id, user_id, booth_id)`.

### 6.12 `festival.reviews` P1

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `event_id` | `uuid` | 필수 |
| `user_id` | `uuid` | 작성자 |
| `booth_id` | `uuid` | 필수 |
| `rating` | `smallint` | 1~5 |
| `content` | `text` | 1~500자 권장 |
| `status` | `review_status` | 기본 `visible` |
| `created_at` | `timestamptz` | 기본 `now()` |
| `updated_at` | `timestamptz` | 수정 허용 시 사용 |
| `deleted_at` | `timestamptz` | 물리 삭제 대신 사용 |
| `deleted_by` | `uuid` | 관리자 삭제 시 기록 |
| `delete_reason` | `text` | 관리자 삭제 사유 |

제약:

- `unique(event_id, user_id, booth_id)`
- 작성 시 같은 행사·사용자·부스의 `active` 스탬프가 있어야 한다.
- 리뷰 활성화 여부는 `events.feature_flags.reviews`에서 서버가 확인한다.
- 평균 별점은 `visible` 리뷰만 집계한다.

### 6.13 `festival.announcements`

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `event_id` | `uuid` | 필수 |
| `severity` | `notice_severity` | 필수 |
| `title` | `text` | 필수 |
| `body` | `text` | 필수 |
| `published_at` | `timestamptz` | nullable, 예약 가능 |
| `expires_at` | `timestamptz` | nullable |
| `created_by` | `uuid` | 관리자 |
| `created_at` | `timestamptz` | 기본 `now()` |
| `updated_at` | `timestamptz` | 필수 |

### 6.14 `festival.audit_logs`

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `event_id` | `uuid` | nullable |
| `actor_id` | `uuid` | 행위자, 시스템 작업이면 nullable |
| `actor_role` | `membership_role` | 당시 역할 snapshot |
| `action` | `text` | 예: `BOOTH_STATUS_CHANGED` |
| `target_type` | `text` | `booth`, `stamp`, `nfc_tag`, `membership` |
| `target_id` | `uuid` | 대상 ID |
| `reason` | `text` | 민감 작업 필수 |
| `metadata` | `jsonb` | 허용 목록 필드만 저장 |
| `request_id` | `uuid` | API 요청과 연결 |
| `created_at` | `timestamptz` | 기본 `now()`, 수정 금지 |

감사 metadata에 이메일, 학번, NFC 토큰, 세션, 리뷰 전체 본문을 넣지 않는다.

## 7. 관계 요약

```text
auth.users 1---1 profiles
events 1---N event_memberships N---1 profiles
events 1---N booths
booths 1---N nfc_tags
profiles N---N booths through stamps
profiles N---N booths through favorites
profiles N---N booths through reviews
booths N---N operator profiles through booth_operator_assignments
events 1---N announcements
events 1---N audit_logs
```

행사와 부스가 다른 레코드를 연결하는 것을 막기 위해 복합 FK 또는 transaction 검증을 사용한다. 예를 들어 `nfc_tags(event_id, booth_id)`는 같은 행사에 속한 `booths(event_id, id)`를 참조해야 한다.

## 8. NFC 태그 설계

### 8.1 수동형 정적 NFC의 현실적 한계

현재 사용하는 수동형 NFC 태그는 내용이 고정되어 있으므로 스캔할 때마다 새 nonce나 짧은 만료 토큰을 자체 생성할 수 없다. 따라서 정적 태그 복제를 기술적으로 완전히 막을 수는 없다.

실서비스 1차 권장안은 **고엔트로피 불투명 토큰 + 서버 검증 + 행사 시간 제한 + 회전 가능 태그**다.

### 8.2 태그에 기록할 URL

```text
https://pangyo-festival-app.vercel.app/nfc#t=<32-byte-random-base64url>
```

토큰을 query가 아니라 URL fragment에 넣으면 일반 HTTP 요청·프록시 로그와 Referrer에 원문이 전달되는 위험을 줄일 수 있다. 앱은 fragment를 읽은 즉시 메모리에 보관하고 `history.replaceState`로 주소창에서 제거한 뒤 HTTPS POST로 서버에 전송한다.

태그에는 DB의 `booth_id`, 순번, 학년·반, 단순한 `NFC-G1-01` 같은 추측 가능한 값만 기록하지 않는다.

### 8.3 토큰 생성과 저장

1. 서버가 암호학적으로 안전한 32바이트 난수를 만든다.
2. 태그에는 base64url 원문 토큰을 기록한다.
3. DB에는 `HMAC_SHA256(NFC_TOKEN_PEPPER, raw_token)`만 저장한다.
4. 관리자 화면에는 원문을 다시 보여주지 않는다. 재발급하면 기존 태그를 비활성화하고 새 토큰을 발급한다.

### 8.4 적립 검증 순서

1. HTTPS와 유효한 사용자 세션 확인
2. 요청 body 스키마와 `Idempotency-Key` 확인
3. 토큰 digest 계산 후 활성 `nfc_tags` 조회
4. 태그·부스·행사 일치 확인
5. 행사 상태가 `active`인지 확인
6. 현재 시각이 행사와 태그 유효 시간 안인지 확인
7. 부스 상태가 `open` 또는 `crowded`인지 확인
8. 사용자가 해당 행사의 활성 학생인지 확인
9. transaction에서 active 스탬프 insert 시도
10. 성공·중복·실패 attempt 기록
11. 결과를 멱등성 저장소에 기록하고 응답

### 8.5 복제 위험 완화

- 한 학생이 짧은 시간에 여러 층의 태그를 연속 인식하면 이상 징후로 기록한다.
- 같은 태그의 비정상적인 요청 폭증에 rate limit을 적용한다.
- 태그 분실·복제 의심 시 즉시 `active=false` 후 교체한다.
- 행사 시작 직전 태그를 배치하고 종료 후 비활성화한다.
- 중요 보상은 스탬프 수만으로 즉시 지급하지 않고 운영자 검증 단계를 둔다.
- 능동형 리더나 운영자 단말이 도입되기 전까지 정적 태그 복제 가능성을 운영 문서에 명시한다.

## 9. 스탬프 transaction과 동시성

NFC와 수동 승인은 같은 내부 서비스 함수 `claimStamp`를 사용해야 한다.

```text
BEGIN
  1. idempotency key 선점 또는 기존 응답 조회
  2. 행사·사용자·부스·태그/운영자 권한 검증
  3. active stamp INSERT ... ON CONFLICT DO NOTHING
  4. INSERT stamp_attempts
  5. 민감 작업이면 INSERT audit_logs
  6. idempotency response 저장
COMMIT
```

성공 insert가 0행이면 현재 active 스탬프를 조회해 `ALREADY_EARNED`로 응답한다. 두 요청이 동시에 들어와도 partial unique index가 최종 중복을 차단해야 한다.

서버 처리 후 응답만 유실되었을 때 같은 `Idempotency-Key` 재요청은 최초 성공 응답을 그대로 반환한다.

## 10. API 공통 계약

### 10.1 기본 규칙

- Base path: `/api/v1`
- Content-Type: `application/json; charset=utf-8`
- 시각: ISO 8601 UTC 문자열
- 인증: `HttpOnly`, `Secure` 세션 쿠키 또는 검증된 Bearer JWT
- 쓰기 요청: `Idempotency-Key: <uuid>` 필수 범위를 명시
- 요청 추적: 응답 헤더 `X-Request-Id`
- 페이지네이션: cursor 방식
- 사용자 ID는 본인 API body에서 받지 않는다.

### 10.2 성공 응답

```json
{
  "data": {
    "id": "uuid",
    "status": "active"
  },
  "meta": {
    "requestId": "uuid"
  }
}
```

### 10.3 오류 응답

```json
{
  "error": {
    "code": "STAMP_ALREADY_EARNED",
    "message": "이미 방문 인증을 완료한 부스입니다.",
    "retryable": false
  },
  "meta": {
    "requestId": "uuid"
  }
}
```

내부 SQL, 스택 trace, 토큰 일부, 리소스 존재 여부를 불필요하게 노출하지 않는다.

### 10.4 HTTP 상태 기준

| 상태 | 사용 |
| --- | --- |
| `200` | 조회, 중복이지만 기존 결과를 정상 반환하는 멱등 응답 |
| `201` | 새 스탬프·리뷰·부스 생성 |
| `204` | 즐겨찾기 해제 등 body 없는 성공 |
| `400` | 입력 형식 오류 |
| `401` | 로그인 필요·세션 만료 |
| `403` | 행사/역할/담당 부스 권한 없음 |
| `404` | 공개하면 안 되는 대상이 없거나 접근 불가 |
| `409` | 멱등성 키 재사용, 상태 충돌, 리뷰 중복 |
| `422` | 유효하지만 현재 운영 상태에서 처리 불가 |
| `429` | 요청 제한 |
| `503` | 비상 모드·쓰기 중지·일시적 DB 장애 |

## 11. 학생 API

### 11.1 세션과 행사

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/api/v1/session` | 로그인 사용자와 현재 행사 역할 |
| `POST` | `/api/v1/session/logout` | 세션 종료 |
| `GET` | `/api/v1/events/current` | 현재 행사, 기능 플래그, 공지, 비상 모드 |
| `PUT` | `/api/v1/events/{eventId}/me/profile` | 최초 이름·학번 등록 또는 승인된 수정 |

`GET /session` 예시:

```json
{
  "data": {
    "user": { "id": "uuid", "displayName": "판교고 학생" },
    "membership": { "eventId": "uuid", "role": "student", "active": true }
  }
}
```

### 11.2 부스

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/api/v1/events/{eventId}/booths` | 목록·검색·정렬 |
| `GET` | `/api/v1/events/{eventId}/booths/{boothId}` | 상세·운영 상태·방문 여부 |
| `PUT` | `/api/v1/events/{eventId}/booths/{boothId}/favorite` | 즐겨찾기 등록 P1 |
| `DELETE` | `/api/v1/events/{eventId}/booths/{boothId}/favorite` | 즐겨찾기 해제 P1 |

목록 query:

```text
?floor=2&status=open,crowded&q=1학년&sort=name&cursor=<opaque>&limit=30
```

허용 정렬값을 서버 목록으로 제한한다. 사용자가 보낸 컬럼명을 SQL `ORDER BY`에 직접 넣지 않는다.

부스 응답 예시:

```json
{
  "id": "uuid",
  "code": "G1-01",
  "clubName": "동아리명",
  "name": "1학년 1반 부스",
  "floor": 2,
  "room": "1-1 교실",
  "location": "2층 1-1 교실",
  "description": "부스 설명",
  "status": "open",
  "opensAt": "2026-12-18T00:00:00.000Z",
  "closesAt": "2026-12-18T06:00:00.000Z",
  "map": { "x": 9.0, "y": 41.0 },
  "visit": { "earned": false, "earnedAt": null },
  "favorite": false
}
```

### 11.3 NFC 스탬프

`POST /api/v1/events/{eventId}/stamps/nfc`

Headers:

```text
Idempotency-Key: 73fe32f8-7e50-4a3e-9ba0-2c6ac2432761
```

Body:

```json
{
  "token": "base64url-opaque-token"
}
```

새 적립 `201`:

```json
{
  "data": {
    "result": "EARNED",
    "stamp": {
      "id": "uuid",
      "boothId": "uuid",
      "method": "nfc",
      "earnedAt": "2026-12-18T01:23:45.000Z"
    }
  },
  "meta": { "requestId": "uuid" }
}
```

기존 적립 `200`:

```json
{
  "data": {
    "result": "ALREADY_EARNED",
    "stamp": {
      "id": "uuid",
      "boothId": "uuid",
      "method": "nfc",
      "earnedAt": "2026-12-18T01:23:45.000Z"
    }
  },
  "meta": { "requestId": "uuid" }
}
```

중복도 오류 페이지 대신 기존 스탬프를 반환해야 앱이 안전하게 동일 결과를 표시할 수 있다.

### 11.4 축제 패스

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/api/v1/events/{eventId}/me/pass` | 본인 방문 목록과 집계 |
| `POST` | `/api/v1/events/{eventId}/me/lookup-code` | 수동 승인용 단기 코드 발급 |

패스 응답에는 다른 학생 정보가 포함되면 안 된다.

```json
{
  "data": {
    "earnedCount": 3,
    "totalBooths": 29,
    "stamps": [
      {
        "id": "uuid",
        "boothId": "uuid",
        "boothName": "보건실",
        "location": "1층 보건실",
        "method": "nfc",
        "earnedAt": "2026-12-18T01:23:45.000Z"
      }
    ]
  }
}
```

### 11.5 리뷰 P1

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/api/v1/events/{eventId}/booths/{boothId}/reviews` | 공개 리뷰 목록 |
| `POST` | `/api/v1/events/{eventId}/booths/{boothId}/reviews` | 방문 인증 후 한 번 작성 |
| `DELETE` | `/api/v1/events/{eventId}/booths/{boothId}/reviews/me` | 본인 리뷰 숨김/삭제 요청 |

작성 body:

```json
{
  "rating": 5,
  "content": "설명이 친절하고 재미있었습니다."
}
```

서버가 active 스탬프와 리뷰 기능 플래그를 확인한 뒤 transaction으로 생성한다.

## 12. 운영자 API

| Method | Path | 권한 | 설명 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/events/{eventId}/operator/booths` | operator+ | 본인 담당 부스 |
| `PATCH` | `/api/v1/events/{eventId}/operator/booths/{boothId}/status` | 담당 operator+ | 상태 변경 |
| `POST` | `/api/v1/events/{eventId}/operator/stamps/manual` | 담당 operator+ | 단기 코드로 수동 승인 |
| `GET` | `/api/v1/events/{eventId}/operator/booths/{boothId}/visits` | 담당 operator+ | 담당 부스 방문 집계 |

수동 승인 body:

```json
{
  "boothId": "uuid",
  "participantCode": "A7K29Q",
  "reason": "학생 기기에서 NFC 인식 실패"
}
```

서버 검증:

1. 운영자 역할과 담당 부스 확인
2. 단기 코드 digest·만료·행사 확인
3. 학생 계정 활성 상태 확인
4. 같은 부스 active 스탬프 중복 확인
5. 스탬프·attempt·audit를 하나의 transaction으로 기록

대량 수동 승인 endpoint는 만들지 않는다.

## 13. 관리자 API

### 13.1 행사와 공지

| Method | Path | 설명 |
| --- | --- | --- |
| `PATCH` | `/api/v1/admin/events/{eventId}` | 행사 상태·시간·기능 플래그 변경 |
| `PUT` | `/api/v1/admin/events/{eventId}/emergency-mode` | 비상 모드 켜기/끄기 |
| `POST` | `/api/v1/admin/events/{eventId}/announcements` | 공지 생성 |
| `PATCH` | `/api/v1/admin/events/{eventId}/announcements/{id}` | 공지 수정·종료 |

비상 모드 변경과 긴급 공지는 재확인 UI와 감사 사유를 요구한다.

### 13.2 부스와 NFC

| Method | Path | 설명 |
| --- | --- | --- |
| `POST` | `/api/v1/admin/events/{eventId}/booths` | 부스 추가 |
| `PATCH` | `/api/v1/admin/events/{eventId}/booths/{boothId}` | 부스 정보 수정 |
| `DELETE` | `/api/v1/admin/events/{eventId}/booths/{boothId}` | soft delete |
| `POST` | `/api/v1/admin/events/{eventId}/booths/{boothId}/nfc-tags` | 태그 토큰 발급 |
| `POST` | `/api/v1/admin/events/{eventId}/nfc-tags/{tagId}/rotate` | 기존 비활성화 후 새 토큰 발급 |
| `POST` | `/api/v1/admin/events/{eventId}/nfc-tags/{tagId}/disable` | 분실·복제 의심 태그 중지 |

태그 발급 응답의 원문 토큰은 **생성 직후 한 번만** 반환한다. 로그·재조회 API·감사 metadata에서는 반환하지 않는다.

### 13.3 역할과 감사

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/api/v1/admin/events/{eventId}/memberships` | 행사 참여자·역할 조회 |
| `PATCH` | `/api/v1/admin/events/{eventId}/memberships/{userId}` | 역할·활성 상태 변경 |
| `PUT` | `/api/v1/admin/events/{eventId}/booths/{boothId}/operators/{userId}` | 담당 운영자 배정 |
| `DELETE` | `/api/v1/admin/events/{eventId}/booths/{boothId}/operators/{userId}` | 담당 해제 |
| `POST` | `/api/v1/admin/events/{eventId}/stamps/{stampId}/revoke` | 부정·오승인 취소 |
| `GET` | `/api/v1/admin/events/{eventId}/audit-logs` | 감사 조회 |

### 13.4 관리자 통계

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/api/v1/admin/events/{eventId}/dashboard` | 총 참여자·방문·운영 부스·확인 필요 수 |
| `GET` | `/api/v1/admin/events/{eventId}/analytics/booths` | 부스별 방문 수·평균 별점 |
| `GET` | `/api/v1/admin/events/{eventId}/analytics/stamps` | 시간대별 성공·중복·실패 |

통계 응답은 원본 학생 목록과 분리한다. 소수 집단 통계로 개인을 추정할 수 있으면 숨기거나 합친다.

## 14. 주요 오류 코드

| 코드 | HTTP | 의미 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | 로그인 필요 |
| `SESSION_EXPIRED` | 401 | 세션 만료 |
| `SCHOOL_ACCOUNT_NOT_ALLOWED` | 403 | 허용 계정 아님 |
| `EVENT_ACCESS_DENIED` | 403 | 행사 참여 권한 없음 |
| `ROLE_REQUIRED` | 403 | 역할 부족 |
| `BOOTH_SCOPE_DENIED` | 403 | 담당하지 않은 부스 |
| `EVENT_NOT_ACTIVE` | 422 | 행사 적립 시간 아님 |
| `EMERGENCY_MODE_ACTIVE` | 503 | 비상 모드로 쓰기 중지 |
| `BOOTH_NOT_OPEN` | 422 | 준비·중지·마감 상태 |
| `NFC_TAG_INVALID` | 422 | 미등록 또는 잘못된 토큰 |
| `NFC_TAG_EXPIRED` | 422 | 만료된 태그 |
| `NFC_TAG_DISABLED` | 422 | 비활성 태그 |
| `STAMP_ALREADY_EARNED` | 200 | 기존 스탬프 반환 |
| `PARTICIPANT_CODE_INVALID` | 422 | 잘못된 단기 코드 |
| `PARTICIPANT_CODE_EXPIRED` | 422 | 단기 코드 만료 |
| `REVIEW_VISIT_REQUIRED` | 403 | 방문 인증 없음 |
| `REVIEW_ALREADY_EXISTS` | 409 | 같은 부스 리뷰 존재 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | 멱등 키 누락 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 같은 키에 다른 요청 body |
| `RATE_LIMITED` | 429 | 과도한 요청 |

## 15. 권한 매트릭스

| 작업 | student | operator | supervisor | admin |
| --- | --- | --- | --- | --- |
| 공개 부스·공지 조회 | O | O | O | O |
| 본인 NFC 스탬프 | O | O | O | O |
| 본인 패스 조회 | O | O | O | O |
| 본인 리뷰 작성 | 기능 활성 시 O | O | O | O |
| 담당 부스 상태 변경 | X | 담당만 | O | O |
| 수동 승인 | X | 담당만 | O | O |
| 승인 취소 | X | X | O | O |
| NFC 발급·회전 | X | X | X | O |
| 역할 관리 | X | X | X | O |
| 감사 로그 전체 조회 | X | X | 제한 | O |

## 16. Supabase RLS 방어선

서버 API가 기본 쓰기 경로여도 RLS를 켜서 실수와 직접 호출을 막는다.

| 테이블 | 권장 정책 |
| --- | --- |
| `events` | 현재 접근 가능한 행사만 SELECT |
| `profiles` | 본인 SELECT/UPDATE, 관리자는 최소 필드만 역할 기반 조회 |
| `event_memberships` | 본인 membership SELECT, 관리자만 서버 경로에서 변경 |
| `booths` | 행사 참여자 SELECT, 직접 INSERT/UPDATE/DELETE 금지 |
| `nfc_tags` | 학생·일반 운영자 직접 SELECT 금지. 서버만 token digest 조회 |
| `stamps` | 본인 SELECT. 직접 INSERT/UPDATE/DELETE 금지 |
| `reviews` | visible SELECT, 본인 작성은 서버 검증 후 수행 |
| `audit_logs` | 관리자 SELECT, 서버 append-only INSERT |
| `idempotency_records` | 클라이언트 직접 접근 전부 금지 |

`service_role` 키는 서버 환경 변수에만 저장하고 브라우저 번들에 포함하지 않는다. RLS를 우회하는 서버 함수는 입력 검증과 역할 검사를 내부에서 다시 수행한다.

Supabase에서 `festival` 같은 사용자 정의 스키마를 브라우저 클라이언트에 직접 노출하려면 Dashboard의 exposed schemas 설정과 `anon`/`authenticated` 역할의 `USAGE`, 테이블별 권한을 별도로 구성해야 한다. 기본값은 **비노출**로 두고, 직접 읽기가 꼭 필요한 공개 부스·공지 view에만 최소 `SELECT` 권한을 부여한다. `nfc_tags`, `stamps`, `idempotency_records`, `audit_logs`, 역할·운영자 배정 테이블은 exposed schema에 있더라도 브라우저 직접 접근을 허용하지 않고 BFF API를 통해서만 사용한다.

## 17. 입력 검증

서버는 Zod, Valibot 또는 동등한 스키마로 다음을 검사한다.

- UUID와 enum 허용 목록
- 이름 1~80자, 설명 0~2,000자
- 리뷰 별점 정수 1~5, 내용 1~500자
- floor 1~4, map 좌표 0~100
- 운영 시간의 시작·종료 관계
- NFC raw token의 base64url 형식과 최대 길이
- 수동 승인 사유 최소·최대 길이
- cursor와 sort 허용 목록
- redirect/callback URL 허용 origin

사용자 입력 HTML은 허용하지 않는 것을 기본으로 하고 텍스트로 렌더링한다.

## 18. 캐시와 실시간 반영

| 데이터 | 전략 |
| --- | --- |
| 부스 목록·지도 | 10~30초 짧은 캐시 또는 ETag 가능 |
| 공지 | 5~15초 polling, 필요 시 Realtime |
| 부스 상태 | 5~15초 polling 또는 Realtime |
| 본인 스탬프·패스 | 성공 직후 캐시 무효화, 사용자별 private/no-store |
| 관리자 통계 | 5~30초 집계 캐시 가능 |
| NFC 적립·수동 승인 | 절대 응답 캐시 금지 |

실시간 연결이 불안정하면 polling으로 전환할 수 있어야 한다. 데이터 무결성은 Realtime보다 DB transaction과 제약이 담당한다.

## 19. 네트워크 실패 처리

- NFC POST timeout이 발생하면 같은 `Idempotency-Key`로 재시도한다.
- 오프라인 상태에서는 스탬프 성공으로 표시하지 않는다.
- 클라이언트에 임시 적립을 저장해 나중에 무조건 동기화하는 방식은 부정 적립 위험 때문에 사용하지 않는다.
- 서버가 처리했지만 응답이 유실된 경우 재시도 응답으로 기존 결과를 복구한다.
- 세션 만료는 로그인 화면으로 보내기 전에 작성 중 상태를 안전하게 보존한다.
- 비상 모드에서는 조회와 안내를 유지하고 쓰기 API를 명확한 오류 코드로 차단한다.

## 20. 보안 헤더와 웹 설정

- HTTPS only, HSTS
- 세션 쿠키: `HttpOnly`, `Secure`, 적절한 `SameSite`
- 상태 변경 요청의 CSRF 방어
- `Content-Security-Policy`
- `Referrer-Policy: no-referrer` 또는 최소 `strict-origin`
- 허용 앱 origin만 CORS 허용
- OAuth callback URL 허용 목록
- 관리자 계정 MFA 권장
- 관리자 공용 계정 금지

## 21. Rate limit 권장 시작값

실제 학생 수와 리허설 결과로 조정한다.

| 대상 | 시작 기준 예시 |
| --- | --- |
| 로그인 callback | IP·계정 기준 완만한 제한 |
| NFC 적립 | 사용자당 10회/분, 태그당 60회/분 |
| 단기 코드 확인 | 운영자당 20회/분, 연속 실패 추가 제한 |
| 리뷰 작성 | 사용자당 5회/10분 |
| 관리자 쓰기 | 사용자당 60회/분 + 감사 |

Rate limit만으로 중복을 막지 않는다. unique 제약과 멱등성이 최종 방어선이다.

## 22. 개인정보와 보존

구현 전에 학교 승인으로 다음을 확정한다.

| 데이터 | 권장 원칙 |
| --- | --- |
| 이름·학번·학교 계정 | 행사 운영에 필요한 최소 범위만 수집 |
| 스탬프 | 행사 정산·이의 처리 기간 후 익명 통계로 전환 검토 |
| 리뷰 | 행사 정책에 따른 보존·삭제 |
| NFC 시도 로그 | 짧은 기간 보존 후 삭제, 원문 IP 금지 |
| 감사 로그 | 운영 책임과 보존 기간을 학교가 결정 |
| 백업 | 원본 삭제 시 백업 만료 일정까지 정의 |

행사 종료 후 임시 운영자·관리자 membership, 세션, 태그를 비활성화한다.

## 23. 환경 변수

```text
PUBLIC_APP_URL=
SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # 서버 전용
ALLOWED_SCHOOL_DOMAIN=
NFC_TOKEN_PEPPER=                 # 서버 전용, 최소 32바이트
LOOKUP_CODE_PEPPER=               # 서버 전용
ERROR_TRACKING_DSN=
```

- `.env.local`과 실제 값은 커밋하지 않는다.
- `.env.example`에는 변수 이름과 설명만 둔다.
- preview/rehearsal/production 키를 분리한다.
- 브라우저 공개 변수에는 service role, pepper, OAuth secret을 넣지 않는다.

## 24. migration 권장 순서

```text
001_create_festival_schema_and_enums.sql
002_create_events_profiles_memberships.sql
003_create_booths_and_operator_assignments.sql
004_create_nfc_tags_stamps_attempts.sql
005_create_notices_reviews_favorites.sql
006_create_audit_and_idempotency.sql
007_add_constraints_and_indexes.sql
008_enable_rls_and_policies.sql
009_create_transaction_functions.sql
010_seed_rehearsal_event.sql
```

규칙:

- migration은 한 번 적용한 파일을 수정하지 않고 새 파일을 추가한다.
- 운영 DB 콘솔에서 임의로 테이블을 수정하지 않는다.
- 파괴적 변경은 확장 → 데이터 이관 → 코드 전환 → 축소 순서로 나눈다.
- rehearsal에서 backup·restore와 migration을 먼저 검증한다.
- down migration보다 호환 가능한 forward-fix를 우선한다.

## 25. 현재 데모 데이터 전환

현재 `app.js`의 `localStorage` 데이터는 운영 원본으로 취급하지 않는다.

| 현재 값 | 서버 전환 |
| --- | --- |
| `seed.event` | 검토 후 `festival.events` seed |
| `seed.booths` | 교실·좌표·설명을 검토한 뒤 CSV/JSON import |
| `seed.users` | 이관 금지, 실제 로그인으로 생성 |
| `seed.stamps` | 이관 금지 |
| `seed.reviews` | 이관 금지 |
| `nfcTagId` | 운영 토큰으로 사용 금지, 새 암호학적 토큰 발급 |

부스 import 전 확인:

- 실제 부스명과 동아리명
- 층·교실·지도 좌표
- 운영 시작·종료 시각
- 운영 상태 초기값
- 태그 `tag_code`와 설치 위치
- 담당 운영자

## 26. 구현 순서

### 단계 0. 운영 결정

- 별도 Supabase project 또는 DB 확정
- 학교 계정 허용 기준과 관리자 지정
- 행사 일시·참여 인원·부스 목록 확정
- 정적 NFC 복제 위험 수용과 대체 절차 승인
- 개인정보 보존 기간 확정

### 단계 1. DB 기준선

- `festival` 스키마, enum, 테이블, FK, unique, check, index
- RLS와 service role 경계
- rehearsal seed
- migration 자동 적용과 schema 검증

### 단계 2. 인증

- Google/OIDC callback
- 학교 계정 서버 검증
- profile과 event membership
- 학생·운영자·관리자 허용/거부 테스트

### 단계 3. 읽기 API

- 현재 행사·공지
- 부스 목록·검색·층 필터·상세
- 짧은 캐시와 오류 UI

### 단계 4. NFC 스탬프

- 태그 발급·digest 저장·비활성화
- 멱등성 저장소
- transaction과 unique index
- 성공·중복·만료·비활성·운영 중지 테스트

### 단계 5. 패스와 수동 승인

- 본인 패스
- 단기 조회 코드
- 담당 부스 운영자 수동 승인
- 승인 취소와 감사 로그

### 단계 6. 관리자

- 부스·상태·NFC 관리
- 공지·비상 모드
- 역할·담당 부스 관리
- 통계와 감사 조회

### 단계 7. P1 확장

- 즐겨찾기
- 방문 인증 리뷰
- 기능 플래그와 별도 테스트

## 27. 자동 테스트 요구사항

### 27.1 Unit

- 역할 판정
- 행사·부스 상태 판정
- NFC digest·형식 검사
- 오류 코드 매핑
- 리뷰 작성 가능 조건

### 27.2 Integration

- 같은 사용자·부스 동시 NFC 요청 2개 중 active 스탬프 1개
- 응답 유실 후 같은 멱등 키 재시도 결과 동일
- 다른 행사 태그 거부
- 만료·비활성 태그 거부
- 운영 중지 부스 거부
- 담당 외 부스 수동 승인 403
- 수동 승인·감사 로그 transaction 일치
- 리뷰 중복과 방문 미인증 거부
- 학생의 다른 학생 패스 IDOR 차단

### 27.3 E2E

1. 학교 계정 로그인
2. 행사 홈·공지 확인
3. 층별 부스 검색과 상세
4. NFC 스탬프 성공
5. 동일 태그 재시도 시 기존 결과
6. 패스 반영
7. NFC 실패 후 운영자 수동 승인
8. 관리자 부스 상태 변경
9. 비상 모드에서 쓰기 중지
10. 로그아웃·세션 만료

### 27.4 실제 기기

- 최신 Android Chrome NFC URL 인식
- 오래된 Android Chrome
- iOS Safari의 NFC URL 열기와 수동 승인 경로
- 320px·390px·430px
- 행사장 Wi-Fi, 이동통신, 네트워크 전환
- 화면 잠금·복귀, 뒤로가기, 연속 탭

## 28. 관찰과 운영 지표

개인정보 없이 다음을 집계한다.

- 로그인 성공·실패 수
- 부스 목록 API p50/p95 지연
- NFC `EARNED`, `ALREADY_EARNED`, `INVALID`, `RATE_LIMITED` 수
- 수동 승인 수와 담당 부스별 비율
- DB transaction 실패와 connection 사용량
- 비상 모드·태그 비활성화·역할 변경
- 관리자 API 오류율

로그에는 `request_id`, endpoint, 결과 코드, 처리 시간만 우선 남기고 이메일·학번·NFC 토큰 원문을 제외한다.

## 29. API·DB 완료 기준

- [ ] 모든 테이블이 `event_id` 범위를 갖거나 행사와 명확히 연결된다.
- [ ] 학생은 본인 패스만 읽을 수 있다.
- [ ] 운영자는 담당 부스만 변경·수동 승인할 수 있다.
- [ ] 관리 권한은 DB membership에서 서버가 판정한다.
- [ ] NFC 토큰 원문이 DB와 로그에 저장되지 않는다.
- [ ] 중복·동시 요청에도 active 스탬프가 한 건이다.
- [ ] timeout 재시도에 같은 결과를 반환한다.
- [ ] 수동 승인·취소·태그 회전·역할 변경에 감사 로그가 있다.
- [ ] 비상 모드에서 쓰기 API를 중지할 수 있다.
- [ ] rehearsal DB backup과 restore를 시험했다.
- [ ] 실제 Android·iOS 대체 흐름을 확인했다.
- [ ] 운영 secret과 preview secret이 분리되어 있다.
- [ ] 실제 학생 데이터 없이 자동 테스트와 리허설을 수행할 수 있다.

## 30. 구현 전에 반드시 확정할 질문

1. 개인 전용 Supabase 프로젝트를 새로 만들지, 승인 후 별도 공용 schema를 사용할지?
2. 허용할 학교 Google 도메인과 예외 계정은 무엇인지?
3. 학번과 이름을 누가, 어떤 목적으로, 언제까지 보관할지?
4. 운영자·관리자 역할을 누가 승인하고 행사 종료 후 언제 회수할지?
5. 부스 운영 상태를 누가 변경할 수 있는지?
6. 정적 NFC 태그 복제 위험을 어떤 운영 절차로 보완할지?
7. NFC 태그 분실·복제 의심 시 현장 교체 담당자는 누구인지?
8. 수동 승인에 사용할 학생 단기 코드의 길이와 유효 시간은 얼마인지?
9. 리뷰를 P0에 포함할지, P1 기능 플래그로 남길지?
10. 행사 예상 참여자 수와 최고 5분 스탬프 요청량은 얼마인지?
11. 감사 로그와 스탬프 기록의 보존 기간은 얼마인지?
12. 비상 모드와 종이/스프레드시트 대체 절차의 책임자는 누구인지?

이 질문이 결정되기 전에는 운영 DB migration과 실제 학생 계정 연결을 시작하지 않는다.

## 31. 권장 산출물

실제 구현 PR에는 다음 파일을 함께 준비한다.

```text
docs/SERVER_DB_API_DESIGN.md
openapi/festival-api.v1.yaml
src/lib/api/contracts.ts
src/lib/api/error-codes.ts
supabase/migrations/*.sql
supabase/seed/rehearsal.sql
.env.example
tests/integration/stamps.*
tests/e2e/student-flow.*
tests/e2e/operator-flow.*
```

이 문서는 구현 전 계약이다. 실제 schema나 endpoint가 달라지면 코드만 바꾸지 말고 문서·migration·OpenAPI·테스트를 같은 변경에서 갱신한다.
