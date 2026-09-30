# 개인 NFC 관리 화면

기준일: 2026-09-10. VER.2 이후 추가한 로컬 관리자 도구다.

## 범위

- 관리자 데모 로그인 후 관리 메뉴의 `NFC 관리`에서 사용한다.
- 긴 부스별 편집 폼 대신 검색 목록과 선택한 부스의 단일 편집 폼을 제공한다.
- 공용 Supabase, Auth 설정, SQL, ORBIT 저장소는 변경하지 않았다.
- 실제 서명 태그 발급/교체/폐기는 연결하지 않았다. `nf1.*` 토큰을 입력받거나 생성하지 않는다.
- 현재 도구는 이 기기의 데모 설정만 바꾼다. 다른 기기와 동기화하지 않는다.

## 기능

1. 부스명, 교실 별칭, 태그 ID 검색. `1학년 1반`과 `1학년1반`은 같다.
2. 층/태그 사용 상태 필터, 전체/사용 중/사용 중지/미등록 수.
3. 태그 ID와 부스 운영 상태, NFC 적립 허용을 한 번에 저장.
4. ID는 `NFC-` 뒤 영문/숫자/하이픈 1~64자. 저장 시 대문자 정규화, 중복 거부.
5. ID 생성은 미저장 초안만 만든다. 저장 전 다른 부스를 선택해도 부스별 초안이 유지된다.
6. 저장 실패 시 기존 메모리/저장값을 바꾸지 않고 초안을 유지한다.
7. 새로고침/탭 종료 및 로그아웃 전에 저장 전 변경을 확인한다. 초안은 reload 후 복구되는 서버 기록이 아니다.
8. NFC 적립 허용을 끄면 mock gateway가 `NFC_TAG_DISABLED`로 거부한다. 기존 스탬프는 삭제하지 않는다.
9. `설정 점검`은 형식/중복 연결/태그 허용/부스 상태/행사 상태만 검사하며 스탬프를 추가하지 않는다.
10. `모의 적립`은 실제 mock claim 경로를 호출한다. 현재 관리자 데모 계정만 대상이며 다른 학생을 대신해 적립하지 않는다.
11. 테스트를 반복하면 중복 방지 결과를 확인할 수 있고, 현재 관리자 화면을 유지한다.
12. 저장된 ID의 `pangyofestival://nfc?nfc=...` URL 복사. Clipboard API 실패 시 입력값을 선택해 수동 복사할 수 있게 한다.
13. 부스 추가는 목록 아래 접힌 보조 영역으로 유지했다. NFC 관리에서는 기록을 삭제하는 대신 적립 허용을 꺼서 중지한다.

실물 NFC 카드 읽기 성공, 현장 방문 증명 또는 실서버 발급 완료를 의미하지 않는다. URL을 다른 기기에서 테스트하려면 그 기기에도 동일한 데모 태그/부스 설정이 있어야 한다. ID 변경 후 카드 URL을 다시 기록해야 하며, 설정만 저장한다고 NFC 카드 내용이 바뀌지 않는다.

## 파일과 데이터

- `nfc-manager.js`: 관리 view, 한글 입력을 유지하는 부분 검색 갱신, 부스별 draft, 원자적 로컬 저장, 점검/모의 적립.
- `app.js`: 관리 화면 연결, 검색용 공통 텍스트, `nfcEnabled === false` claim 거부, 관리자 guard, logout/종료 초안 확인.
- `ui-ver2.css`: `.nfc-*` 관리 화면 스타일.
- `index.html`: 관리 모듈 로드.
- `tools/preview-ui.cjs`: 관리 모듈 공개 자산 allowlist 추가.
- Android `app/build.gradle`: APK에도 관리 모듈 포함.
- Lucide subset: Save/Copy/LogOut 추가.

`nfcEnabled`는 **로컬 데모 booth 객체의 선택 필드**다. 기존 데이터에 없으면 true처럼 취급하며, DB 테이블/열을 추가한 것이 아니다. 이 값으로 실제 서버 보안을 제어하지 않는다.

초안과 점검 결과는 메모리만 사용한다. 저장된 부스 설정은 기존 `pangyo-festival-db-v3` 안에 있다. 점검 로그에 실제 서명 토큰이나 사용자 개인정보를 추가하지 않는다.

## 검증

`tests/nfc-management-browser.cjs`는 320/390/430/1024px에서 외부 HTTPS를 가짜 응답으로 가로챈다.

- 검색 공백/한글 composition 및 input/focus 유지.
- 단일 편집 폼, 부스 전환 시 초안 유지.
- 대소문자 중복과 서명 토큰 입력 거부.
- localStorage 실패 시 기존 설정 불변.
- 설정 점검이 스탬프를 만들지 않음.
- 관리자 계정 모의 적립/반복 중복 방지, 현재 화면 유지.
- 중지된 태그 거부와 기존 스탬프 보존.
- 필터, 변경 취소, URL 복사, reload 후 저장값 유지.
- 일반 학생의 관리 화면/저장 접근 거부.
- 가로 넘침, 부스명에 template 문자가 출력되는 문제, 미처리 JS 오류 검사.

보고서/스크린샷: `artifacts/nfc-management/`.
기존 `tests/ui-ver2-browser.cjs`도 회귀 확인한다. Android는 빌드 후 `tests/android-web-audit.cjs`로 패키징 자산을 검증한다.

이 기능은 실제 Google 로그인, server RPC 설치, 실제 태그 RF 검사, 운영자 행사 권한을 완료하지 않는다.

### 이번 실행 결과

- NFC 관리 320/390/430/1024px 모두 통과, 각 3개 전체 화면 캡처 확인.
- 기존 VER.2 4개 너비 모두 통과.
- 계정 단위 테스트 6개, 계정 브라우저 3개 너비, Android 웹 회귀 3개 너비 통과.
- Android assembleDebug/testDebugUnitTest/lintDebug 성공. 변경하지 않은 native task는 캐시 결과를 사용했다.
- APK 안의 `nfc-manager.js`가 검증한 원본과 일치하며 SQL/env/비밀키 경로가 포함되지 않았음을 확인.
- 당시 설치본: `../pangyo-festival-android/artifacts/pangyo-festival-nfc-manager.apk`
  (SHA-256 `CE8CAB2E3CA8DA3C7334FAEEC66A197FD7E1A39EBAD007613ADD522B1F2F2745`)
- 이후 배포 규칙이 바뀌어 ZIP 없이 버전 APK만 전달한다. 최신 전달본은
  `../pangyo-festival-android/artifacts/pangyo-festival-1.2.apk`이며 기준 문서는
  `../pangyo-festival-android/RELEASES.md`다.
- 개인 미리보기: `http://127.0.0.1:5183/?demo=1`
- GitHub commit/push, 공개 사이트 배포는 하지 않았다.


## 2026-09-11 추가: 서버 모드와의 관계

이 화면은 여전히 **데모 모드 전용**이다. 실제 서버 모드에서는 `내 정보 → 운영자 도구 열기`의
별도 화면에서 서명 태그를 발급한다. 두 화면을 혼동하지 않는다.

| 구분 | NFC 관리 (이 문서) | 운영자 도구 (서버) |
| --- | --- | --- |
| 사용 조건 | 데모 모드 + 관리자 데모 로그인 | 실제 로그인 + `users.admin` = true |
| 저장 위치 | 이 기기의 localStorage | 공용 Supabase |
| 태그 형식 | `NFC-...` 로컬 ID | `nf1.<payload>.<서명>` |
| 다른 기기 사용 | 불가 | 가능 |
