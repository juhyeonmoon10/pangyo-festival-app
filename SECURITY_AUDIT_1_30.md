# 보안 점검 (1.30)

2026-10-31. 대상: 실서버 https://pangyo-festival-app.vercel.app, Supabase 프로젝트 `vvvkzvxahviwbuyfbwir`의 축제 함수·테이블·저장소, 이 저장소의 화면 코드와 git 기록.

## 1. 고친 문제

| # | 문제 | 위험 | 조치 |
|---|---|---|---|
| 1 | **레거시 NFC 서버 함수가 실서버에 배포돼 있었다.** `api/v1/events/[eventId]/stamps/nfc.mjs`가 Vercel 함수로 올라가 `POST /api/v1/events/…/stamps/nfc`에 응답했다. 빌드 스크립트는 정적 파일만 내보내지만 Vercel이 `api/` 폴더를 따로 함수로 만들었다. | 지금은 비밀 키가 설정돼 있지 않아 `SERVICE_NOT_CONFIGURED`만 돌려준다. 누가 Vercel에 `SUPABASE_SECRET_KEY`를 넣으면 서비스 키로 DB를 부르는 공개 주소가 된다. | `.vercelignore`로 `api/`, `tests/`, `nfc-server/`, `operations-server/`, `supabase/`, `artifacts/`를 업로드에서 뺐다. 화면에서 쓰이지 않던 호출 코드(`createHttpStampGateway`)도 지웠다. |
| 2 | **보안 헤더 부족.** CSP(콘텐츠 보안 정책)가 없었다. | XSS가 생기면 막을 두 번째 벽이 없다. | 모든 응답에 CSP, `Cross-Origin-Opener-Policy`, `Permissions-Policy`를 붙인다(아래 3절). |
| 3 | **평점 함수 2개를 로그인 없이 부를 수 있다.** `public.refresh_booth_rating`, `public.handle_booth_rating_changed`(ORBIT이 만든 함수). 처음 만들 때 PUBLIC 권한만 뺐고, Supabase 기본 권한이 anon·authenticated에 남았다(Supabase 보안 경고 0028·0029). | 점수를 바꿀 수는 없고 다시 계산만 한다. 다만 누구나 반복 호출해 DB에 부하를 줄 수 있다. | `operations-server/rating-function-grants.sql`(되돌리기 `-rollback.sql`). **DB 적용 대기.** 트리거는 실행 권한을 보지 않아 평점은 계속 갱신된다(격리 테스트로 확인). 이 함수를 직접 부르는 앱은 ORBIT 전 브랜치와 이 앱 모두 없다. |
| 4 | 데모 바우처 QR 창 제목을 이스케이프하지 않았다. | 제목이 고정 문구라 실제 위험은 없다. | `escapeHtml` 적용. |

## 2. 문제없음을 확인한 부분

- **서버 함수 권한**
  - 축제 함수는 모두 로그인 없이(anon) 실행할 수 없다.
  - 운영자용 함수는 전부 함수 안에서 `users.admin`을 다시 확인한다. 화면에서 보내는 값은 믿지 않는다.
    - 대상: 쓰기·읽기·초기화·공지·태그·보안 카드·부정 적립·부스 일괄·부스 담당자 지정·학생 조회.
  - 학생용 함수는 로그인한 본인 데이터만 다룬다.
    - 바우처 QR·코드는 `user_id = 본인`이다.
    - 보상 선택은 방문 수와 재고를 서버에서 센다.
    - 후기 작성자 이름은 트리거가 명단에서 넣는다. 화면에서 보낸 이름은 쓰지 않는다.
  - 부스 담당자는 소속 확인이 끝났고 그 부스가 본인 동아리일 때만 그 부스를 고칠 수 있다.
    - 사진은 본인이 올린 파일만 연결된다.
  - 로그인 확인(`current_profile`)
    - Google 로그인, 이메일 확인, 살아 있는 세션을 모두 요구한다.
    - 관리자 여부는 `users.admin`에서만 읽는다. 사용자가 바꿀 수 있는 메타데이터는 보지 않는다.
- **테이블**: `festival_ops`, `festival_nfc_private` 테이블은 브라우저 역할에 권한이 없고 RLS도 켜져 있다. 모든 접근은 위 함수로만 한다.
- **사진 저장소**
  - 버킷 `festival-notices`, `festival-booths`는 JPEG·PNG·WebP, 3MB까지만 받는다. SVG·HTML은 올릴 수 없다.
  - 파일 이름은 `notices|booths/32자리hex.확장자`만 허용한다.
  - 올리기는 운영자·부스 담당자만, 지우기는 본인 파일 또는 운영자만 할 수 있다.
  - 버킷 목록은 로그인 없이 볼 수 없다.
- **로그인**: Google OAuth와 PKCE를 쓴다. 로그인 이동 주소가 이 Supabase 프로젝트의 `/auth/v1/authorize`인지 확인한다. 로그인 뒤 돌아갈 주소는 앱 경로만 받는다(외부 주소로 보낼 수 없음). 현재 계정 16개 모두 Google이다.
- **비밀값·개인정보**
  - 화면 코드에는 공개 키(publishable)만 있다.
  - git 전체 기록(모든 브랜치)에서 비밀 키, 서비스 키, 학생 명단 파일(xlsx·csv)을 찾지 못했다.
  - 실서버에서 `.env`, `.git/config`, SQL, 테스트, `api/` 소스 파일은 모두 404다.
- **XSS**: 새 테스트 `tests/xss-sweep-browser.mjs`(아래 4절)로 확인했다. 40개 화면에서 실행된 코드와 삽입된 요소가 모두 0건이다.
- **HTTPS**: `Strict-Transport-Security`(2년, preload)를 Vercel이 이미 보낸다.

## 3. 추가한 헤더 (`tools/build-web.cjs`)

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://vvvkzvxahviwbuyfbwir.supabase.co;
  connect-src 'self' https://vvvkzvxahviwbuyfbwir.supabase.co wss://vvvkzvxahviwbuyfbwir.supabase.co;
  font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()
```

- 스크립트는 이 사이트 파일만 실행된다. `index.html`의 인라인 스크립트(`<base>` 태그)는 빌드 때 계산한 해시로만 허용한다.
- 스타일은 인라인을 허용한다. 지도의 방 위치를 `style` 속성으로 그리기 때문이다. 스타일만으로는 코드를 실행할 수 없다.
- 카메라는 운영자 QR 스캔에만 쓴다.

## 4. 새 테스트

- `tests/xss-sweep-browser.mjs`
  - 실제 SQL을 로컬 PGlite에서 돌리고 실제 브라우저로 화면을 연다.
  - 학생·부스 담당자·운영자가 저장할 수 있는 글을 모두 HTML 공격 문구로 채운다. 대상은 다음과 같다.
    - 부스 이름·위치·방·소개·프로그램 6칸, 공지 제목·본문, 후기, 실명, 동아리
    - 가입 이름, 승인·조정·발급 사유, 바우처 제목, NFC 태그·보안 카드 메모, 공개 카탈로그 이름
  - 그다음 학생 화면 26개, 부스 담당자 화면 3개, 운영자 도구 전체와 조회 화면을 연다.
  - 공격 코드가 실행되거나 공격 요소가 화면에 생기면 실패한다.
- `tests/csp-browser.cjs`: 빌드 결과를 실제 헤더 그대로 띄우고 학생·데모·운영자 화면 13개를 연다.
  - CSP 위반이 하나라도 있으면 실패한다.
  - 마지막에 인라인 스크립트와 외부 이미지를 직접 넣어 둘 다 막히는지 확인한다.
- `tests/rating-function-grants-isolated.mjs`: 권한을 회수하면 anon·authenticated 호출이 거부되는지 확인한다.
  - 평점 트리거는 추가·삭제 때 계속 갱신돼야 한다.
  - 되돌리기 SQL을 실행하면 원래 권한이 돌아와야 한다.
- `tests/web-build-unit.cjs`: CSP 내용(인라인·eval·외부 스크립트 금지, 해시 일치)과 `.vercelignore` 항목을 검사한다.

## 5. 남은 위험과 결정이 필요한 부분 (이번에 바꾸지 않음)

1. **관리자 계정이 많다.**
   - 계정 16개 중 7개가 `users.admin`이다.
   - 이 표시는 ORBIT 관리자와 축제 운영자가 함께 쓴다. ORBIT 관리자는 자동으로 축제 운영자가 된다.
   - 운영자는 다음을 할 수 있다.
     - 모든 학생의 학번·이메일·방문·포인트 보기
     - 보안 카드 키 보기
     - 운영 데이터 초기화
   - 필요 없는 계정의 관리자 권한을 빼는 것을 권장한다.
2. **아무 Google 계정이나 로그인할 수 있다.**
   - 학교 도메인 제한이 없다.
   - 후기에는 작성자 실명이 붙는다. 작성 화면에 "○○ 이름으로 공개돼요"라고 안내한다.
   - 로그인한 누구나 실명 후기를 볼 수 있다. 외부인 접근을 막으려면 도메인 제한이나 후기 열람 조건이 필요하다.
3. **본인 소속 확인은 "학번 + 실명"을 아는지로만 판단한다.**
   - 다른 학생의 학번과 이름을 알면 그 학생보다 먼저 확인할 수 있다.
   - 실제 학생이 나중에 확인하면 "이미 연결됨"으로 막히고, 두 계정이 운영자 소속 관리 화면에 함께 표시된다.
   - 학교 계정 로그인 없이는 완전히 막을 수 없다.
4. **가입 때 적은 학번은 본인이 언제든 바꿀 수 있다.**
   - 소속 확인 전 계정은 운영자·부스 담당자의 학번 조회에서 이 학번으로 찾아진다.
   - 그래서 다른 학생 학번을 적은 계정이 그 학생 대신 수동 스탬프나 바우처를 받을 수 있다.
   - 같은 학번 계정이 둘이면 이메일로 고르게 한다.
   - 확인된 계정만 조회되게 하면 막을 수 있다. 하지만 소속 확인 전 학생은 수동 승인을 받을 수 없게 된다.
5. **일반 NFC 태그 주소는 복사할 수 있다.**
   - 사진이나 공유로 주소를 받으면 부스에 가지 않고도 적립할 수 있다.
   - 부정 적립 감지가 짧은 시간의 많은 적립을 표시한다.
   - 보안 카드(NTAG 424)로 바꾸면 해결된다(카드 구매 후 구현 예정).
6. **호출 빈도 제한이 없다.**
   - 쓰기 함수는 모두 같은 잠금 하나를 차례로 쓴다.
   - 로그인한 사용자가 반복 호출하면 다른 사람의 처리가 느려질 수 있다.
   - 요청 기록 표(`festival_ops.requests`)도 계속 늘어난다.
7. **Supabase 인증 설정은 대시보드에서 확인해야 한다.**
   - 앱은 Google 로그인만 쓴다. 이메일·비밀번호 가입이 켜져 있다면 끄는 것을 권장한다.
   - 보안 경고 "Leaked Password Protection Disabled"는 이메일 로그인을 쓰지 않으면 관계없다.
8. **점검 범위 밖**
   - 같은 DB의 ORBIT 함수(`orbit_*`: 주식·블랙잭·상점)는 축제 앱이 쓰지 않아 깊게 보지 않았다.
   - 관리자 함수 안에 관리자 확인 코드가 있는 것만 확인했다.
