# 1.58 — 소속 동아리 확인 시도 횟수 제한 없음

## 바뀐 점

- 소속 동아리 확인에서 이름이 1시간에 5번 틀리면 막던 제한을 없앴다.
  - "확인 시도가 너무 많아요. 1시간 뒤 다시 시도하거나 운영 부스에 문의해 주세요." 안내가 더는 뜨지 않는다.
  - 이미 막혀 있던 학생도 바로 다시 확인할 수 있다.
  - 이름이 틀린 시도와 다른 계정과의 충돌은 전처럼 감사 기록에 남는다.

## 서버

- `operations-server/identity-no-attempt-limit.sql`: `festival_review_identity_self`에서 최근 1시간 실패 수를 세는 줄과 `TOO_MANY_ATTEMPTS` 판정만 지운다. 나머지 본문은 그대로다.
- 되돌리기: `operations-server/identity-no-attempt-limit-rollback.sql`(제한을 원래대로 다시 넣는다).
- 시험: `tests/identity-no-attempt-limit-isolated.mjs`(합성 데이터의 PGlite, LF·CRLF 본문 모두 적용·되돌리기 확인).
