#!/bin/bash
###############################################################################
# verify-auth.sh — giip-accounts.json / tCorpUser 인증 경로 회귀 감지 스모크테스트
#
# 배경(2026-08-07 인시던트): tCorpUser.uSecretKey 를 "고쳤다"고 생각하고 업데이트했다가
# slack-bot/.secrets/giip-accounts.json 의 csn:47 항목이 실제로는 lowy.claude@netbako.net
# (uSn 2408) 개인 키가 아니라 **다른 곳에서도 재사용되는 마스터/시스템관리자 키(uSn 29,
# sysadmin)** 였다는 걸 모르고 값을 바꿔 get-issue.sh/register-issue.js 전체가
# "Issue not found or no permission" 로 막혔다. 원인 규명 후 되돌려 복구했다.
#
# 교훈: tCorpUser.uSecretKey, tUserLogin, 또는 slack-bot/.secrets/giip-accounts.json 을
# 건드리기 **전**과 **후** 반드시 이 스크립트를 돌려서 기존 인증 경로가 안 깨졌는지 확인한다.
# AK/SK 파라미터 의미(byAK=AK 필요, bySK=SK 필요)는 반드시
# giipdb/docs/10_Standards/AUTH_PARAMETER_MAPPING.md 를 먼저 읽고 판단할 것 — "이름이 비슷하니
# 같은 값일 것"이라고 추측하지 않는다.
#
# 원리: get-issue.sh 는 이슈가 없어도 있어도 "Issue not found or no permission" 이라는
# 동일 문구를 반환할 수 있어(존재하지 않는 isn 도 이 메시지) 단순히 "not found" 여부로는
# 인증 성공/실패를 구분할 수 없다. 그래서 **실존이 확인된 isn** 을 csn별로 하나씩 등록해두고,
# 그 isn 이 정상 조회되는지(= content 필드가 실제로 채워지는지)로 판정한다.
#
# 사용:
#   scripts/gissue/verify-auth.sh            # 아래 KNOWN_GOOD 표에 등록된 모든 csn 검증
#   scripts/gissue/verify-auth.sh 47          # 특정 csn만(표에 있어야 함)
#
# 새 csn 추가 시: 그 csn 소유의 실존 isn 하나를 KNOWN_GOOD 에 추가할 것.
#
# 종료 코드: 0=전부 통과, 1=하나라도 실패(회귀 발생 — 즉시 원복할 것)
###############################################################################
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# csn:known-existing-isn (실존 확인된 이슈로 인증 성공 여부를 판별)
declare -A KNOWN_GOOD=(
  [47]=921
)

TARGET_CSN="${1:-}"
CSNS_TO_CHECK=()
if [ -n "$TARGET_CSN" ]; then
  CSNS_TO_CHECK=("$TARGET_CSN")
else
  CSNS_TO_CHECK=("${!KNOWN_GOOD[@]}")
fi

FAIL=0
for csn in "${CSNS_TO_CHECK[@]}"; do
  isn="${KNOWN_GOOD[$csn]:-}"
  if [ -z "$isn" ]; then
    echo "⚠️  SKIP csn $csn — KNOWN_GOOD 표에 실존 isn 미등록(검증 불가, 스크립트에 추가 필요)"
    continue
  fi
  echo "── csn $csn (anchor isn=$isn) ──────────────────────────────"
  out=$(bash "$SCRIPT_DIR/get-issue.sh" "$isn" "$csn" 2>&1)
  if echo "$out" | grep -q '"error"'; then
    echo "❌ FAIL: csn $csn 인증/조회 실패 — 실존하는 isn $isn 도 못 읽음"
    echo "$out" | head -5
    FAIL=1
  elif echo "$out" | grep -q "\"isn\": $isn"; then
    echo "✅ OK: csn $csn 인증 정상 (isn $isn 정상 조회됨)"
  else
    echo "⚠️  UNKNOWN: 예상과 다른 응답 형식 — 수동 확인 필요"
    echo "$out" | head -5
    FAIL=1
  fi
done

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "🚨 인증 경로 회귀 감지됨. 방금 tCorpUser/giip-accounts.json 을 건드렸다면 즉시 원복하고,"
  echo "   AUTH_PARAMETER_MAPPING.md 를 다시 읽은 뒤 재시도할 것."
  exit 1
fi
exit 0
