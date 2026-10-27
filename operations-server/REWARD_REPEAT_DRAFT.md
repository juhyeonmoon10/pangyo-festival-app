# 반복 바우처 지급 서버 초안 (2026-10-28)

상태: **로컬 초안. 공용 Supabase에 적용하지 않았습니다.** 적용하려면 별도 승인이 필요합니다.

## 확정된 정책

- 완성 스탬프 3·6·9·12…개마다 바우처 1장. 9개 이후에도 계속 지급합니다.
- **매 회차마다** 포토부스 이용권 / 푸드트럭 교환권 중 하나를 학생이 직접 고릅니다.
  같은 종류를 여러 번 골라도 됩니다. (기존 "3개 선택 → 6개 나머지, 최대 2장" 규칙을 대체합니다.)
- 완성 스탬프의 정의는 그대로입니다: NFC 방문 인증 후 별점까지 등록한 기록.

## 파일

| 파일 | 내용 |
|---|---|
| `operations-server/reward-repeat.draft.sql` | 서버 초안. `reward-choice.draft.sql` **대신** 적용합니다. 둘 다 적용하면 안 됩니다. 이미 다른 초안이 적용돼 있으면 스스로 중단합니다. |
| `tests/reward-repeat-isolated.mjs` | PGlite 격리 DB 검사 23개 |
| `artifacts/reward-repeat/isolated.json` | 마지막 실행 결과 |

`reward-choice.draft.sql`과 그 테스트는 수정하지 않았습니다. 이 작업을 시작할 때 받은 버전에서는 기존 테스트 16/16이 통과했습니다.

### ⚠ 같은 시각 다른 작업자가 만든 초안과 정책이 다릅니다

2026-10-27 16:14 UTC에 다른 작업자가 `reward-choice.draft.sql`을 "Version 2"로 고쳤습니다.
그 초안은 **3·9·15개에서 선택하고 6·12·18개에서 반대 종류를 자동 지급**합니다(6개 단위 반복).
사용자가 확정한 정책(**매 회차 선택, 같은 종류 반복 가능**)과 다릅니다. 두 초안 모두 같은 컬럼과 인덱스를 추가하므로,
**공용 DB에는 둘 중 하나만** 적용할 수 있습니다. 이 초안은 다른 초안이 이미 적용돼 있으면 스스로 중단합니다.
상태 응답 `version`도 겹치지 않도록 이 초안은 `3`을 사용합니다.

## 기존 공용 스키마에 주는 영향 (승인 검토용)

1. `festival_ops.vouchers`의 기존 `unique(event_id,user_id,rule_id)` 제약을 제거하고 다음 두 부분 인덱스로 바꿉니다.
   - 기존 일반 바우처(`reward_stage is null`)는 같은 컬럼의 부분 unique로 **기존 규칙 그대로 유지**합니다.
   - 반복 바우처는 `(event_id,user_id,reward_stage)` unique로 회차별 1장을 보장합니다.
   - 이 변경이 없으면 같은 종류를 두 번 고르는 순간(예: 3개·9개 모두 포토부스) 기존 제약에 막힙니다.
2. `rules.reward_kind`, `vouchers.reward_stage` 컬럼과 체크 제약을 추가합니다. 새 테이블은 없습니다.
3. `festival_ops.award()`를 교체합니다. 종류가 지정된 규칙은 자동 지급, `voucher_claim`, 운영자 수동 발급으로 생성되지 않습니다. 오직 `reward_choose`만 생성합니다.
4. 기존 바우처 행은 삭제·변환·날짜 변경하지 않습니다. 사용·만료·취소된 바우처도 회차를 유지합니다.
5. 기존 일반 바우처가 이미 발급된 행사에서는 `reward_config`가 `REWARD_MIGRATION_REQUIRED`로 막힙니다. 이관은 별도 승인 대상입니다.
6. 복구: SQL 파일 끝의 ROLLBACK 블록을 사용합니다. 반복 바우처가 **한 장도 없을 때만** 안전하며, 격리 DB에서 원래 제약 복원을 확인했습니다. 발급이 시작된 뒤에는 데이터 처리 계획을 따로 검토해야 합니다.

## 클라이언트 계약 변경 (화면 작업자에게 전달)

### 읽기: `festival_reward_read()` → `version: 3`

```json
{
  "version": 3, "policy": "choice-every-3", "step": 3, "eventId": "…",
  "ready": true, "count": 7,
  "nextStage": 6, "pendingStages": 1, "canChoose": true,
  "claimed": [{ "stage": 3, "kind": "photo", "voucherId": "…", "state": "used" }],
  "options": [{ "kind": "photo", "title": "포토부스 이용권", "ruleId": "…", "available": true }, …]
}
```

- `firstChoice`, `secondIssued`, `firstTarget`, `secondTarget`는 **없어졌습니다.**
- `pendingStages`: 도달했지만 아직 고르지 않은 회차 수(늦게 고르는 경우 2개 이상일 수 있음)
- `nextStage`: 다음에 고를 회차. `count >= nextStage`이고 행사가 열려 있을 때 `canChoose`

### 쓰기: `festival_reward_write('reward_choose', { eventId, kind, stage }, requestId)`

- `stage`는 **숫자 필수**. 항상 `nextStage` 값을 보냅니다. 회차를 명시하므로 응답 유실 후 새 요청 ID로 다시 보내도, 연타해도 같은 회차에 두 장이 생기지 않습니다.
- 같은 회차·같은 종류 재요청은 성공(기존 바우처 유지)으로 처리합니다. 같은 회차·다른 종류는 `REWARD_CHOICE_LOCKED`로 거부합니다.

| 오류 | 학생 안내 예시 |
|---|---|
| `VISIT_REQUIRED` | 스탬프가 더 필요해요 |
| `REWARD_STAGE_ORDER` | 앞 회차 바우처부터 받아 주세요 (화면을 새로 고침) |
| `REWARD_CHOICE_LOCKED` | 이미 받은 회차예요 |
| `OUT_OF_STOCK` | 지금은 이 상품이 소진됐어요. 다른 상품을 고르거나 나중에 다시 시도해 주세요 (회차는 그대로 남음) |
| `EVENT_CLOSED` / `REWARD_NOT_READY` | 지금은 바우처를 받을 수 없어요 |

### 지금 로컬 코드에서 바꿔야 할 곳 (이번 작업에서는 수정하지 않음)

- `operations-ui.js` 53행: `program?.version===1` 검사 → `3`으로 바꾸지 않으면 서버 모드에서 혜택이 숨겨집니다.
- `operations-ui.js` `chooseReward(kind)`: `stage: reward.nextStage`를 함께 보내야 합니다.
- `operations-ui.js` 운영자 문구("3개 선택 / 6개 나머지", 확인창 문구)도 새 정책으로 바꿔야 합니다.
- `web-experience.js` 시연 모드: 현재 진행 중인 코드는 **6개 단위 반복**(9개 선택 → 12개 나머지)으로 구현돼 있습니다. 확정 정책은 **매 회차 선택**이므로 `rewardState`/`chooseReward`/`completeSecondReward`/`rewardPanel`을 위 계약에 맞춰 바꿔야 합니다. 6개에서 반대 종류를 자동 지급하면 안 됩니다.
- `tests/stamp-path-unit.cjs`의 "새 바우처를 만들지 않음", "6개 자동 반대 지급" 기대값도 새 정책에 맞춰 갱신해야 합니다.

## 격리 DB 검증 (PGlite, 23/23)

경계 0/2/3/5/6/8/9/12개, 같은 종류 반복 선택, 회차 순서, 잘못된 회차 값, 같은 요청 재전송,
응답 유실 후 새 요청, 연타, 사용·취소 후 재요청, DB unique 백스톱, 재고 소진·재입고, 재고 하향 거부,
만료, 완성 개수 감소, 일시 중지, 기존 일반 바우처 보존·설정 차단, 이중 적용 거부, 롤백 복원.

**한계:** PGlite 단일 연결과 인증/Vault 대체 환경입니다. 실제 Supabase, 실제 동시 접속, 기존 운영 데이터 호환성은 검증하지 않았습니다. 동시 요청은 기존과 같은 advisory lock과 unique 인덱스로 막도록 설계했지만, 여러 연결에서 실제로 경합시키는 검사는 하지 않았습니다.

## 아직 미확정

- 학생 1명당 최대 장수 상한이 필요한가요? 지금은 상한이 없고 종류별 총재고로만 제한합니다.
- 운영자가 바우처를 취소하면 그 회차를 다시 고를 수 있게 할까요? 지금은 기존 규칙처럼 회차가 유지되고 재지급하지 않습니다.
- 기존 일반 바우처가 있는 행사를 어떻게 이관할지 정해야 합니다.
