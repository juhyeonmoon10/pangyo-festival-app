# 1.25 보안 NFC 카드 (NTAG 424 DNA)

2026-10-31. 사용자 요청:
- 기존 NFC 기능은 그대로 둔다.
- NTAG 424 DNA로 암호화되고 위조를 막는 NFC 적립을 새로 만든다.
- 두 NFC 기능을 각각 관리할 수 있게 한다.
- 카드 작성 가이드라인을 만든다.

## 학생 적립

- 보안 카드는 찍을 때마다 새 1회용 주소를 만든다: `https://…/#picc_data=<32자리>&cmac=<16자리>`
- 서버가 처리하는 순서:
  1. Key 1로 카드 고유번호(UID)와 읽기 카운터를 복호화한다.
  2. Key 2로 서명(CMAC)을 확인한다.
  3. 카운터가 마지막으로 인정한 값보다 클 때만 적립한다.
- 그래서 주소를 복사해 다른 사람에게 보내도 적립되지 않는다("이미 사용한 카드 주소예요").
- 이미 적립한 부스를 다시 찍어도 그 주소는 사용 처리된다.
- 적립 규칙은 일반 태그와 같다: 축제·부스 운영 상태, 본인 동아리 제외, 연속 적립 제한, 방문 기록(method `nfc`).
- 로그인 전에 카드를 찍으면 일반 태그처럼 로그인 후 이어서 적립한다.
- 앱 안의 "NFC 읽기"(안드로이드 크롬)로 읽어도 적립된다.

## 관리 마법사 → 보안 NFC 카드 (NTAG 424)

일반 "NFC 태그 발급"과 별도 화면이고, 켜고 끄기도 따로다.

1. **카드 키**
   - 키 만들기(서버가 무작위 생성, 또는 직접 입력)
   - 카드 작성용 키 보기(처리 기록에 남음)
   - 보안 카드 적립 중지/다시 사용
   - 키 교체(확인 문구 "키 교체")
2. **카드에 쓸 내용**: 현재 사이트 주소 기준 URL과 PICC·MAC 위치, 키 번호, 접근 권한
3. **카드 확인·등록**
   - 카드 읽기(안드로이드 크롬), 방금 찍은 카드 확인, 주소 붙여넣기
   - 확인만으로는 주소가 사용되지 않는다.
   - 잘못 작성한 카드는 어떤 키나 설정이 틀렸는지 알려 준다.
4. **등록된 카드**: 부스 변경, 메모, 사용 중지·다시 사용, 적립 횟수, 마지막 사용 시각

## 일반 NFC 태그

- `festival_nfc_private.claim`, 태그 목록·발급 화면, 서명 주소 형식은 바꾸지 않았다.
- 클라이언트에는 보안 카드 주소를 알아보고 새 RPC로 보내는 분기만 추가했다.

## 서버 (`operations-server/sun-nfc.sql`)

- 테이블 `festival_nfc_private.sun_cards`: UID, 부스, 메모, 마지막 카운터, 사용 횟수, 중지 여부
- 함수
  - `public.festival_sun_claim(p_payload, p_request_id)`: 학생 적립, 요청 재시도 시 같은 결과
  - `public.festival_sun_admin(p_action, p_payload)`: 운영자 전용
- AES-CMAC과 PICC 복호화는 pgcrypto(AES)로 SQL 안에서 계산한다.
- 키는 Vault 비밀값 `pangyo_festival_sun_v1`에 둔다. 카드 마스터 키(Key 0)는 서버에 두지 않는다.
- 처리 기록: `sun_keys_create`, `sun_keys_reveal`, `sun_enable`, `sun_card_register`, `sun_card_move`, `sun_card_revoke`, `sun_card_restore`
- 되돌리기: `sun-nfc-rollback.sql`(함수만 지우고 등록된 카드와 키는 남긴다)

## 가이드라인

`NTAG424_CARD_GUIDE.md`에 다음을 정리했다.
- 키 정리, 카드에 쓸 URL과 NDEF 바이트
- SDM 설정값(PICCDataOffset 49, SDMMACInputOffset·SDMMACOffset 87)과 파일 접근 권한
- 하지 말 것, 카드 1장 작성 순서, 확인 결과별 해결 방법, 운영 수칙

## 검증

- PGlite 격리 `sun-nfc-isolated.mjs` 11/11:
  - RFC 4493 CMAC 벡터, NXP AN12196 예제값(UID 04DE5F1EACC040, 카운터 61)
  - 운영자 전용·키 보관, 등록, 1회 적립과 재사용 거절, 재시도
  - 위조·키 불일치 진단, 주소 문자열 MAC 방식
  - 본인 동아리·중지·사용 중지, 일반 태그 독립 동작, 부스 변경·키 교체, 되돌리기
- 단위 `sun-nfc-unit.cjs`: 주소 읽기, 토큰 왕복, 카드 레이아웃(실제 주소 기준 오프셋 49·87, 103바이트)
- 브라우저 `sun-nfc-browser.mjs`(390·320):
  - 키 만들기·보기, 위조 진단, 등록
  - 학생 적립과 같은 주소 재사용 거절
  - 방금 찍은 카드 등록, 사용 중지, 화면 넘침 없음
- 기존 검사 통과:
  - 단위 164/164
  - `nfc-tag-registry` 11, `claim-guard` 9, `operator-self-actions` 6, `nfc-api`·`nfc-schema`
  - NFC·운영 브라우저 검사
- 실제 카드로는 아직 시험하지 않았다(카드 구매 후 가이드 5장 순서로 확인).
