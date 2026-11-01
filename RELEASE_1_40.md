# 1.40 블랙잭 자동 스탠드 없애기

2026-11-01. 사용자 요청: 21에 도달하거나 버스트해도 자동으로 스탠드하지 않고, 카드를 더 받을 수 있게 한다. 1.39와 같이 `elilim09/ORBIT`의 `feature/merge`와 미니게임 배포 저장소에만 올린다.

## 바뀐 것

- 히트해서 21이 되거나 버스트돼도 차례가 끝나지 않는다. 처음 두 장이 21인 경우도 마찬가지다. 스탠드를 누르거나 10초 동안 고르지 않아야 멈춘다.
- 내 차례 안내: 21점이면 "21점이에요. 카드를 더 받거나 스탠드할 수 있어요.", 버스트면 "버스트예요. 카드를 더 받거나 스탠드할 수 있어요."
- "21!"·"버스트!" 꼬리표는 그 카드를 받은 히트에 붙는다(예전처럼 "자동으로 멈췄어요"라고 하지 않는다).
- 규칙: "21이 되거나 버스트돼도 자동으로 멈추지 않아요. 스탠드를 눌러야 멈춰요.", "둘 다 스탠드하면 모든 카드를 공개하고 승부를 가려요."
- 승패 계산은 그대로다. 버스트는 지고, 둘 다 버스트이거나 점수가 같으면 판돈을 돌려받는다.

## 서버

- `operations-server/blackjack-no-auto-stand.sql`(되돌리기 `-rollback.sql`). 운영 DB에 적용했다.
  - `festival_blackjack_join()`: `orbit_blackjack_join`과 같고 처음 두 장 21 자동 스탠드만 뺐다. 같은 대기열 잠금을 써서 ORBIT 앱 사용자와도 같은 대기열에서 만난다.
  - `festival_blackjack_action(p_game_id, p_action, p_version)`: `orbit_blackjack_action`과 같고, 히트가 `done`을 켜지 않는다. 덱 52장을 다 쓰면 히트는 스탠드로 처리한다.
  - `festival_blackjack_rematch`: 같은 상대와의 새 판에서도 처음 두 장 21 자동 스탠드를 뺐다.
- 화면은 `orbit_blackjack_join`·`orbit_blackjack_action` 대신 위 두 함수를 부른다(허용 목록에서도 바꿨다). 상태 조회(`orbit_blackjack_state`)와 대기 취소(`orbit_blackjack_cancel`)는 ORBIT 함수 그대로다.
- ORBIT `orbit_*` 함수는 **바꾸지 않았다**. 그래서 ORBIT 앱에서 들어온 상대는 ORBIT 함수를 쓰고, 그 사람은 예전처럼 21·버스트에서 자동으로 멈춘다.

## 확인

- 운영 DB에서, 끝나면 되돌리는 트랜잭션으로 14개 시나리오를 실행했다. 처음 두 장 21이어도 멈추지 않음, 21에서 히트해도 계속, 버스트 뒤 히트로 카드 4장, 둘 다 스탠드하면 정산(둘 다 버스트 → 무승부, 포인트 원래대로), 덱이 비면 히트가 스탠드, 잘못된 동작 `INVALID_ACTION`, 익명 실행 불가, `orbit_blackjack_action`은 그대로. 되돌린 뒤 함수와 판이 남지 않았음을 확인했다.
- `tests/minigames-browser.mjs`에 버스트(22점) 뒤에도 히트·스탠드가 켜져 있고 안내와 "버스트!" 꼬리표가 나오며, 한 번 더 히트해 카드 4장이 되는 확인을 더했다. 화면이 `festival_blackjack_join/action`만 부르고 `orbit_blackjack_join/action`은 부르지 않는지도 확인한다. 단위 테스트 전체 통과.
