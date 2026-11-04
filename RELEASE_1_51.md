# 1.51 포인트 하나로: 보유 포인트 = 미니게임 포인트

2026-11-04. 사용자 요청: 가상 포인트와 보유 포인트를 통합한다. `minigame` 브랜치에서 작업했다.

## 바뀐 것

- 포인트는 `public.users.money` 하나다. MY의 "보유 포인트"와 미니게임의 포인트가 같은 값이다(처음 100,000P 그대로).
- 글 후기 보상과 운영자 포인트 조정은 예전처럼 `festival_ops.ledger`에 기록되고, 그 기록이 같은 금액만큼 `users.money`를 바꾼다(`private.wallet_ledger`에도 `reward`/`admin_adjustment`로 남는다).
- 운영자 차감은 `users.money` 기준으로 검사한다. 0P 밑으로는 `POINTS_INSUFFICIENT`.
- 화면 문구: 미니게임의 "가상 포인트"를 "보유 포인트"로 바꿨다. 안내 문구는 "MY의 보유 포인트와 같은 포인트예요. 부스 후기 보상도 여기에 더해져요."

## 서버

- `operations-server/points-unify.sql`(되돌리기 `points-unify-rollback.sql`). 운영 DB의 실제 정의에서 바뀌는 줄만 바꿔 만들었다.
  - 트리거 `festival_ops.ledger_to_money`(축제 포인트 기록이 추가되면 `users.money`를 같은 금액만큼 바꾼다).
  - `festival_ops_read`의 `me`·`participants`, `festival_student_lookup`이 기록 합계 대신 `users.money`를 보여 준다.
  - `festival_ops_write`의 `points_adjust` 잔액 검사를 `users.money` 기준으로 바꿨다.
- 적용할 때 축제 포인트 기록은 비어 있었다(후기 보상 0P). 옮길 잔액은 없다.
- 참여 기록 초기화(`festival_ops_reset`)는 기록 줄은 지우지만 포인트는 되돌리지 않는다.

## 확인

- 운영 DB에서 끝나면 되돌리는 트랜잭션으로 9개 시나리오를 실행했다. 후기 보상이 `money`에 더해짐과 지갑 기록, MY의 보유 포인트, 운영자 차감(학번으로)과 0P 밑 거부, 운영자 참가자 목록, 조정 지갑 기록, 되돌리기(트리거 제거, 기록 합계로 복귀).
