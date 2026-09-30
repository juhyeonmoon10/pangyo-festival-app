# 설치 진행 상태

마지막 갱신: 2026-09-11. 대상: Supabase 프로젝트 `vvvkzvxahviwbuyfbwir` (ORBIT, 공용).

## 한 줄 요약

**서버 설치 완료. 로그인·NFC 적립·별점·운영자 태그 발급이 실제 DB에서 동작한다.**

## 적용한 것

| 순서 | 파일 | 결과 |
| --- | --- | --- |
| 1 | `verify-run.sql` | PASS, 전부 롤백. 흔적 없음 |
| 2 | `install.sql` | 적용 완료 |
| 3 | `reviews.sql` | 적용 완료 |
| 4 | `admin-issue.sql` | 적용 완료 (재실행 시 중복 방지 작동 확인) |

Auth Redirect URL(`pangyofestival://auth/callback`)은 그 전에 사용자가 직접 추가했다.

### 시험 실행 결과 원문

```
PASS: profile, own-row RLS, direct update denied, mint denied, two stamps,
duplicate, forgery, expiry, revoked session, anon denied; all changes rolled back
```

격리 환경이 아니라 실제 Supabase에서 통과했다. Vault 비밀 생성, GoTrue `auth.sessions` 검사,
실제 `booth_enum`과 `public.users` 구조, PostgREST 권한까지 진짜 환경에서 검증됐다.

## 설치 후 확인 결과

| 항목 | 값 |
| --- | --- |
| `festival_nfc_private` 스키마 | 있음 |
| 공개 함수 6개 | `festival_nfc_profile`, `festival_nfc_claim`, `festival_booth_reviews`, `festival_my_reviews`, `festival_review_submit`, `festival_nfc_admin_issue` |
| 비공개 함수 | 8개 |
| Vault 서명 비밀 | 1건 |
| `users_authenticated_select` | `auth_user_id = (SELECT auth.uid())` — 본인 행만 |
| `users_authenticated_update` | `false` — 전면 거부 |
| authenticated 테이블 권한 | SELECT만 (UPDATE 회수됨) |
| 익명의 적립·별점·발급 호출 | 전부 불가 |
| 로그인 학생의 적립·별점 | 가능 |
| 학생의 태그 발급 | 불가 |
| `booth_ratings.content` | 추가됨, nullable, 500자 제한 |

기존 데이터는 그대로다. 사용자 11명(전원 auth 연결됨), 기존 별점 2건, 부스 20개, 관리자 4명.
`reviews.sql`의 컬럼 추가는 기존 별점 2건을 깨뜨리지 않았다.

## 남은 일

1. **앱에서 실제 확인.** APK 1.4를 설치하고 Google 로그인 → 이름·학번 등록.
2. **운영자 권한.** 로그인 후 운영자 도구가 안 보이면 본인 계정의 `admin`을 켠다.
   현재 관리자가 4명 있으므로 본인이 이미 포함돼 있을 수도 있다.

   ```sql
   update public.users set admin = true where email = '본인이메일';
   ```

3. **태그 발급과 실물 카드.** 운영자 도구에서 부스와 유효 기간을 고르면
   `pangyofestival://nfc#t=...` 주소가 나온다. NFC 쓰기 앱에서 **URL(URI) 레코드**로 기록한다.
   길이가 약 270바이트라 NTAG215 이상이 필요하다. 기록 후 다시 읽어 온전한지 확인한다.
4. **다른 학생 계정으로 교차 확인.** 그 카드를 다른 계정 폰에 대서 적립되는지,
   같은 카드를 다시 대면 중복 처리되는지 본다.

## 문제가 생기면

| 상황 | 조치 |
| --- | --- |
| 적립·후기를 즉시 멈춰야 함 | `disable.sql`. 데이터는 그대로 |
| 다른 팀 코드가 깨짐 | `uninstall.sql`로 2026-09-09 권한 복원 |
| 태그 유출 의심 | Vault 비밀의 `epoch`만 교체. 기존 카드 무효, 재발급 |

`uninstall.sql`은 users 정책을 예전의 전체 허용 상태로 되돌린다. 그게 원래 보안 우려였던
상태이므로 자동 실행하지 않는다. 적립된 스탬프와 저장된 후기는 어느 경우에도 지우지 않는다.

## 정리해 둘 것

Claude 브라우저에 동아리 Supabase 로그인 세션이 남아 있다. 작업이 끝났으면 그 탭에서
로그아웃해 두는 편이 좋다.
