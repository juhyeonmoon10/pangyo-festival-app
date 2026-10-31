# 1.30 보안 점검과 보완

2026-10-31. 사용자 요청: 사이트를 모두 분석해 보안 문제를 찾고 보완한다.

자세한 점검 내용, 문제없음을 확인한 부분, 남은 위험은 `SECURITY_AUDIT_1_30.md`에 있다.

## 바뀐 점

1. **레거시 서버 함수 배포 중지**
   - `.vercelignore`가 `api/`와 서버·테스트 폴더를 Vercel 업로드에서 뺀다.
   - 지금까지 `POST /api/v1/events/…/stamps/nfc`가 Vercel 함수로 응답하고 있었다(설정이 없어 503).
   - 화면에서 쓰이지 않던 호출 코드 `createHttpStampGateway`를 지웠다.
2. **보안 헤더**: 모든 응답에 다음 헤더를 붙인다(`tools/build-web.cjs`).
   - `Content-Security-Policy`: 이 사이트 스크립트만 실행, `<base>` 인라인 스크립트는 해시로만, 연결은 이 사이트와 축제 Supabase만
   - `Cross-Origin-Opener-Policy`
   - `Permissions-Policy`
3. **데모 바우처 QR 창** 제목을 이스케이프한다.
4. **DB 변경(적용 대기)**: `operations-server/rating-function-grants.sql`.
   - 평점 다시 계산 함수 2개를 브라우저가 직접 부르지 못하게 한다.
   - 되돌리기는 `rating-function-grants-rollback.sql`.

## 검증

- 단위 168/168
- `web-build-unit.cjs`: CSP 내용과 `.vercelignore`를 검사한다.
- 새 브라우저 테스트
  - `xss-sweep-browser.mjs`: 저장 가능한 모든 글을 공격 문구로 채우고 40개 화면을 연다. 실행 0건.
  - `csp-browser.cjs`: 실제 헤더로 13개 화면을 연다. 위반 0건. 넣은 인라인 스크립트와 외부 이미지는 막힌다.
- 새 격리 DB 테스트 `rating-function-grants-isolated.mjs`: 권한 회수, 트리거 갱신, 되돌리기.
- 기존 브라우저 테스트 통과: `booth-manager`, `error-placement`, `sun-nfc`, `nfc-tag-manager`, `identity-self`, `voucher-settings`, `operations-hotfix`, `update-banner`, `booth-reviews`.
