# 판교고 축제 모바일 웹앱

판교고 연말 축제를 위한 모바일 우선 부스 탐색 UI입니다. 현재 저장소는 ORBIT P0 가이드를 참고해 개인 저장소에서 개발하는 독립 프로토타입입니다.

공개 미리보기: <https://pangyo-festival-app.vercel.app/>

## 현재 구현

- 홈, 부스, NFC, 축제 패스, 내 정보의 5개 학생 화면
- 1~4층 학교 지도와 드래그 가능한 Bottom Sheet
- 부스 검색, 층 선택, 상세 화면
- 부스 운영 상태: `preparing`, `open`, `crowded`, `paused`, `closed`
- 행사 공지와 비상 모드 UI
- NFC 성공, 중복, 운영 중지, 미등록 태그 결과 UI
- NFC 실패 시 운영자 수동 승인 안내
- 320px 모바일, iOS safe area, 모션 감소 설정 대응
- 관리자·리뷰·교환 실험 화면은 기존 데모로 유지

## 중요한 제한

현재 Google 로그인, 관리자 권한, NFC 적립, 스탬프와 리뷰는 실제 서버 기능이 아닙니다. 브라우저 `localStorage`에 저장되는 UI 테스트 데이터입니다.

따라서 현재 버전은 실제 학생 개인정보, 보상, 행사 운영 기록에 사용하면 안 됩니다. 실서비스 전에는 다음 기능이 ORBIT 공용 계약으로 구현되어야 합니다.

- 학교 계정 OAuth/OIDC와 서버 세션
- 행사별 역할과 담당 부스 권한
- 서명·만료·nonce를 검증하는 NFC 토큰
- `/api/v1` 서버 API
- 행사 범위 DB, 중복 제약, transaction, 감사 로그
- 운영자 수동 승인과 비상 모드

자세한 차이는 [P0_GAP_AUDIT.md](./P0_GAP_AUDIT.md)에 기록합니다.

## 로컬 실행

정적 웹앱이므로 `index.html`을 브라우저로 열 수 있습니다.

```text
outputs/pangyo-festival-app/index.html
```

NFC URL 테스트 예시:

```text
index.html?nfc=NFC-G1-01
```

## 자동 테스트

`tests/map-performance-smoke.cjs`는 다음 흐름을 확인합니다.

- 320px 가로 넘침
- 하단 메뉴 5개와 화면 전환
- 지도 반복 렌더링 성능
- NFC 샘플 적립과 중복 처리
- 축제 패스 반영

테스트에는 Playwright와 Chrome 경로가 필요합니다.

## 저장소 경계

- 이 저장소는 개인 개발 저장소입니다.
- `elilim09/ORBIT` 공용 저장소와 공용 Supabase를 자동으로 수정하지 않습니다.
- ORBIT 반영은 팀 검토와 명시적 승인 후 별도 작업으로 진행합니다.
