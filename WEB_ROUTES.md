# 화면별 주소

| 화면 | 주소 |
| --- | --- |
| 홈 | `/` |
| 로그인 | `/login` |
| 부스 지도 | `/map` |
| 스탬프 | `/stamp` |
| 바우처 | `/voucher` |
| 내 정보 | `/my` |
| 리뷰 | `/reviews` |
| 본인 소속 확인 | `/identity` |
| 운영자 도구 | `/admin` |
| NFC 진입 | `/nfc` |
| 부스 상세 | `/booth/:id` |
| 부스 리뷰 | `/booth/:id/reviews` |

## 동작

- 기존 화면과 디자인을 유지하면서 History API로 주소를 동기화한다.
- 직접 접속과 새로고침은 같은 화면으로 복귀한다. 같은 탭의 지도 층수와 화면 상태는 history에 보존한다.
- 로그인 전에는 `/login?next=...`로 이동한다. `next`는 등록된 내부 화면만 허용한다.
- Google 인증 복귀 주소는 기존 사이트 루트 `/`를 유지한다. 이동 목적지는 sessionStorage에
  15분간 보관하고, 인증 후 한 번만 사용한다. 저장소 차단 시 로그인 자체는 막지 않는다.
- `/admin`은 주소만 아는 것으로 권한을 얻을 수 없다. 기존 서버 권한 검사와 접근 거부 화면을 유지한다.
- 기존 `/#t=...`, `/nfc#t=...` NFC 링크는 토큰을 주소에서 제거한 뒤 로그인·인증 흐름을 이어간다.
- 없는 부스 주소에서 다른 부스를 대신 표시하지 않는다. 지도 복귀 화면을 표시한다.
- 로컬 파일 미리보기와 기존 Android WebView의 파일 경로·로그인 콜백은 유지한다.

## 구현과 배포

`festival-router.js`가 주소 계약을 제공한다. `app.js`가 화면·로그인·브라우저 이동을 연결한다.
`tools/build-web.cjs`는 [Vercel Build Output API](https://vercel.com/docs/build-output-api/configuration)의
등록된 화면 경로만 `index.html`로 연결한다. 미등록 주소와 서버 파일은 앱으로 재작성하지 않는다.
`tools/preview-ui.cjs`에도 같은 화면 경로를 적용했다.

[Supabase의 redirectTo 허용 목록](https://supabase.com/docs/guides/auth/redirect-urls)을 늘리는 대신
현재 루트 콜백을 유지한다. 주소 분리를 위해 공용 DB·Auth 설정을 변경하지 않는다.
후속 사용자 요청에 따라 개인·공용 저장소 커밋과 Vercel 배포를 1.19에 포함한다.

## 확인 방법

- `node --test tests/router-unit.cjs`: 경로 계약, 내부 복귀 주소 제한, OAuth 목적지 만료, 루트 콜백.
- `node tests/routes-browser.cjs`: 320·390·430px 직접 접속, 새로고침, 뒤로/앞으로,
  지도 층수 복원, 중첩 부스 링크와 정적 리소스, 관리자 권한, 로그인 복귀, NFC 재개.
- 브라우저 테스트의 모든 외부 요청은 합성 응답으로 처리한다. 실물 NFC나 실제 Google 인증은 별도 점검이다.
- `node --test tests/web-build-unit.cjs`: 공개 파일 제한, 경로 재작성, 비공개 파일 미포함.
- `node tools/preview-ui.cjs 0`: 사용 중이지 않은 포트로 로컬 미리보기 실행.

기존 디자인 문서의 버전·디자인 검사 경고는 이 주소 변경과 무관해 수정하지 않았다.
