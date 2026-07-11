# 판교고 축제 모바일 웹앱

`index.html`을 브라우저로 열면 바로 실행되는 모바일 웹앱입니다.

## 현재 구현

- 구글 인증 후 학번/아이디 등록 흐름
- `googleUid`, `studentNumber`, `schoolId` 기준 중복 참여 방지 구조
- 4층 지도 구성
- 1층: 보건실, 학생회 안내소, 교무실, 방송실, 매점
- 2층: 1학년 1반 ~ 1학년 8반
- 3층: 2학년 1반 ~ 2학년 8반
- 4층: 3학년 1반 ~ 3학년 8반
- 층별 지도 마커, Bottom Sheet 부스 목록
- 부스 검색, 이름순/별점순 정렬, 즐겨찾기 표시
- NFC 태그 인식 흐름을 위한 `nfcAdapter.scan(tagId)` 구조
- 스탬프 획득 후 리뷰 작성 활성화
- 동일 사용자/동일 부스 리뷰 1회 제한
- 평균 별점 자동 계산
- 스탬프 현황, 목표 달성, 음료 교환 완료 처리
- 관리자 부스 추가/삭제, NFC 태그 수정, 리뷰 삭제, 사용자/통계 조회

## 로그인 구조

현재 버전은 실제 Google OAuth 연결 없이 구글 계정 인증 UI 틀만 제공합니다.

동작 흐름:

1. `G 구글 계정으로 계속` 버튼 클릭
2. 구글 인증이 완료된 것으로 처리
3. 이름, 학번, 아이디 입력
4. 학번/아이디 중복 여부 확인 후 앱 진입

나중에 실제 Google OAuth를 붙일 때는 `authProvider.signInWithGoogle()`만 실제 구글 로그인 결과를 반환하도록 교체하면 됩니다.

필수 저장값:

- `googleUid`: Google 계정 고유 ID
- `googleEmail`: Google 이메일
- `studentNumber`: 학번
- `schoolId`: 학생이 등록한 아이디
- `name`: 이름

중복 방지 기준:

- 같은 `googleUid`는 같은 사용자로 로그인
- 다른 `googleUid`가 이미 등록된 `studentNumber` 또는 `schoolId`를 사용하면 등록 차단
- 스탬프와 리뷰는 내부 `user.id`에 연결

## 나중에 교체할 데이터

실제 동아리 부스와 NFC 태그 정보가 정해지면 `app.js`의 `seed.booths` 배열 또는 `makeClassBooths()`에서 생성되는 교실 부스 이름/설명을 바꾸면 됩니다.

```js
{
  id: "b1",
  name: "부스명",
  floor: 1,
  location: "1층 교실명",
  description: "부스 설명",
  nfcTagId: "실제 NFC 태그 ID",
  x: 24,
  y: 31
}
```

## 실제 서비스 확장 방향

현재는 브라우저 `localStorage`를 임시 데이터베이스로 사용합니다. 배포용 서비스에서는 같은 저장소 인터페이스를 Firebase Firestore, Supabase, PostgreSQL API 등으로 교체하면 됩니다.

권장 컬렉션/테이블:

- `User`: `id`, `googleUid`, `googleEmail`, `studentNumber`, `schoolId`, `name`, `role`, `exchangedAt`
- `Booth`: `id`, `name`, `floor`, `location`, `description`, `nfcTagId`
- `Stamp`: `id`, `userId`, `boothId`, `createdAt`
- `Review`: `id`, `userId`, `boothId`, `rating`, `content`, `createdAt`

NFC는 실제 기기 연동 시 Web NFC API 또는 네이티브 래퍼에서 태그 ID를 읽은 뒤 `nfcAdapter.scan(tagId)`로 넘기면 됩니다.
