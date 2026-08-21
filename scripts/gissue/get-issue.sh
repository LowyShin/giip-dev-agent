#!/bin/bash
###############################################################################
# get-issue.sh — giip issue 상태/코멘트 빠른 조회 (+선택적 코멘트 등록/상태 전이)
#
# 배경: admin/giip-issues/<isn> (giipv3 admin 화면)에 뜨는 이슈를 세션에서 확인해달라는
#       요청이 반복됨. DB 직접조회(giipdb/mgmt/dbconfig.json)는 이 레포에 없고,
#       AdminGetAK(AK 발급) 엔드포인트는 현재 빈 응답만 돌려준다(2026-07-24 확인, 재확인 필요시
#       .agent/workflows/giip-get-ak.md 참조). 실사용 가능한 경로는 SK 직접인증 API
#       (giipfaw giipIssues / giipIssueComments, x-api-key: <csn 전용 sk>) 뿐이다.
#
# 2026-08-05 (giip-867 인시던트로 발견): 예전엔 /api/giipIssuesSk 를 썼는데, 그 SP군
#   (pApiGiipIssueGetbySK/ListbySK/StatusUpdatebySK)은 tSecretKey.cSn 단일고정값만 검사하는
#   구버전 권한모델이라, sk 의 "홈 csn"과 다른 csn 의 이슈는 sysadmin sk 로도 무조건 404
#   ("Issue not found or no permission")가 났다(실제로는 존재+정상, 권한모델이 안 맞았을 뿐).
#   /api/giipIssues(→ pApiGiipIssueGetbyAK/ListbyAK/PutbyAK)는 giip-712/728/730/799 에서
#   sysadmin(uLevel>=99) 전역 접근 + tUserPerCorp 멀티csn 멤버십을 이미 지원하도록 패치됐다
#   (봇 마스터 sk → usn 29 → uLevel 99 → 모든 csn 조회/갱신 가능). 이제 이 스크립트는
#   /api/giipIssues 를 쓴다 — csn 인자는 사용하는 sk 선택(계정 매칭)에만 쓰이고, 실제 조회 대상
#   csn 은 이슈 자체의 cSn 을 그대로 따른다(더 이상 sk 의 홈 csn 으로 제한되지 않음).
#
# SK 출처: slack-bot/.secrets/giip-accounts.json (git 비추적) .channels[*].sk, csn 필드로 매칭.
#          다른 csn 을 추가하려면 그 채널의 sk 를 이 파일 channels 에 등록해두면 자동으로 잡힌다.
#          (단, 등록된 sk 중 아무거나 하나가 sysadmin 이면 그걸로 모든 csn 이 조회/갱신 가능하다.)
#
# 2026-08-13 (giip-1053 인시던트): cSn 47(giipprj/giipv3) 이슈 관련 코멘트 5개가 완전히 다른
#   고객사 이슈 #1053(cSn 70427, ai_tech_forward)에 잘못 게시되는 사고가 있었다(원인 스크립트는
#   특정하지 못함 — 이 레포/giipprj 어디에도 없어 외부 프로세스로 추정). 조회(list)는 -Csn 필터를
#   강제하는 규정이 있었지만, 코멘트 작성/상태 변경(write) 전에 "이 isn 이 실제로 의도한 CSN 소속인지"
#   재확인하는 게이트가 전혀 없었던 게 구조적 허점이었다 — 호출자가 준 isn 을 그대로 믿고 썼다.
#   그래서 --comment/--comment-file/--status/--delete-comment 실행 직전에 lib/check-csn.js 로 그
#   isn 의 실제 cSn 을 조회해 요청한 csn 과 비교하고, 불일치하면 쓰기 API 를 호출하지 않고 exit 2 한다
#   (fail-open: 조회 자체가 실패하면 가용성을 위해 경고만 남기고 통과 — 명백한 불일치만 차단).
#   sysadmin 이 의도적으로 다른 csn 의 이슈를 만져야 하는 정상 케이스(방금 이 인시던트 정리처럼)를
#   위해 `--force-csn` 플래그로 우회 가능하다.
#
# 2026-08-13 (giip-1073): 코멘트 등록에 **사후검증(post-verify)** 과 **삭제 클라이언트**를 추가했다.
#   - `--comment` 는 이제 lib/post-comment.js 를 통해 등록 → 즉시 재조회 → 원문과 비교 → mojibake
#     징후(U+FFFD, 원문에 없던 '?' 연속, non-ASCII 소실/치환) 탐지 → 깨졌으면 **방금 자기가 만든
#     코멘트만** 삭제하고 같은 안전경로로 1회 재시도 → 그래도 깨지면 삭제 후 exit 1(무한 재시도 금지).
#     자기 코멘트 특정은 POST 전/후 코멘트 목록 차집합으로 한다(giipfaw POST 응답이 cSn 을 돌려주지
#     않기 때문 — SP 는 돌려주는데 API 래퍼가 버린다. giipfaw 는 성역이라 수정하지 않는다).
#   - `--delete-comment <cSn>` 신설: giipfaw 에 예전부터 있던 DELETE /giipIssueComments?csn= 를
#     호출한다(giip-800 에서 구현됐지만 호출 클라이언트가 없어 "삭제 불가"로 알려져 있었다).
#
# 사용:
#   scripts/gissue/get-issue.sh <isn> [csn]              # 이슈 상세 + 코멘트 조회
#   scripts/gissue/get-issue.sh <isn> [csn] --comment "내용"   # note 코멘트 등록(+사후검증)
#   scripts/gissue/get-issue.sh <isn> [csn] --comment-file <path>  # 본문을 UTF-8 파일에서 읽어 등록
#   scripts/gissue/get-issue.sh <isn> [csn] --status DONE      # 상태 전이(제목/본문 보존, PUT status-only)
#   scripts/gissue/get-issue.sh <isn> [csn] --delete-comment <cSn>  # ★파괴적★ 코멘트 1건 삭제
#   scripts/gissue/get-issue.sh <isn> [csn] --comment "내용" --status DONE   # 둘 다 순서대로 실행(결합 호출 지원)
#   scripts/gissue/get-issue.sh <isn> [csn] --status DONE --force-csn   # 의도적 크로스-CSN 쓰기(CSN 검증 우회)
#
# csn 생략 시 giip-accounts.json 에 등록된 csn 이 1개면 그걸 쓰고, 여러 개면 에러(명시 필요).
#
# --force-csn: 쓰기(--comment/--comment-file/--status/--delete-comment) 직전에 자동 실행되는 CSN
#   일치검증(giip-1053)을 의도적으로 우회한다. sysadmin 이 사람 판단으로 다른 csn 의 이슈를 직접
#   정리할 때만 쓴다 — 무인 자동화 프롬프트/스크립트에서는 절대 기본으로 넣지 않는다.
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNTS_FILE="$(cd "${SCRIPT_DIR}/../.." && pwd)/slack-bot/.secrets/giip-accounts.json"
API_BASE="https://giipfaw.azurewebsites.net/api"

ISN="${1:-}"
if [ -z "${ISN}" ]; then
  echo "사용법: $0 <isn> [csn] [--comment \"내용\" | --comment-file <path> | --status <STATUS> | --delete-comment <cSn>]" >&2
  exit 2
fi
shift

CSN="${1:-}"
if [ -n "${CSN}" ] && [[ "${CSN}" == --* ]]; then CSN=""; else shift || true; fi

if [ ! -f "${ACCOUNTS_FILE}" ]; then
  echo "❌ SK 저장소를 찾을 수 없습니다: ${ACCOUNTS_FILE}" >&2
  exit 2
fi

# node 로 파싱(경로는 argv로 넘겨 git-bash의 유닉스 경로 자동변환을 그대로 활용 — python -c 문자열에
# 경로를 임베드하면 /c/... 유닉스 경로가 변환되지 않아 FileNotFoundError 발생하므로 피한다).
SK="$(node "${SCRIPT_DIR}/lib/resolve-sk.js" "${ACCOUNTS_FILE}" "${CSN}")" || {
  AVAILABLE="$(node "${SCRIPT_DIR}/lib/resolve-sk.js" "${ACCOUNTS_FILE}" --list 2>/dev/null)"
  echo "❌ csn 에 매칭되는 sk 를 찾지 못했습니다. csn을 명시하거나 slack-bot/.secrets/giip-accounts.json 을 확인하세요. 등록된 csn: ${AVAILABLE}" >&2
  exit 2
}

# 인자 없음 = 조회 모드
if [ $# -eq 0 ]; then
  echo "=== Issue #${ISN} ==="
  curl -s "${API_BASE}/giipIssues?isn=${ISN}" -H "x-api-key: ${SK}"
  echo
  echo "=== Comments ==="
  curl -s "${API_BASE}/giipIssueComments?isn=${ISN}" -H "x-api-key: ${SK}"
  echo
  exit 0
fi

# --force-csn 은 어느 위치에 있어도 인식되도록 먼저 스캔해서 제거한다(아래 while 루프의 옵션
# 파서는 --comment/--comment-file/--status/--delete-comment 만 알고, 모르는 옵션은 에러로 처리한다).
FORCE_CSN=0
FILTERED_ARGS=()
for a in "$@"; do
  if [ "${a}" = "--force-csn" ]; then
    FORCE_CSN=1
  else
    FILTERED_ARGS+=("${a}")
  fi
done
set -- "${FILTERED_ARGS[@]}"

# CSN 일치검증 게이트 (giip-1053): --comment/--comment-file/--status/--delete-comment 중 하나라도
# 있으면, 실제 쓰기 API 를 호출하기 전에 이 isn 의 실제 cSn 이 요청한 csn 과 일치하는지 먼저 확인한다.
NEEDS_CSN_GATE=0
for a in "$@"; do
  case "${a}" in
    --comment|--comment-file|--status|--delete-comment) NEEDS_CSN_GATE=1 ;;
  esac
done

if [ "${NEEDS_CSN_GATE}" = "1" ] && [ "${FORCE_CSN}" != "1" ]; then
  EFFECTIVE_CSN="${CSN}"
  if [ -z "${EFFECTIVE_CSN}" ]; then
    # csn 인자를 생략한 호출은 giip-accounts.json 에 등록된 csn 이 1개일 때만 여기까지 도달할 수
    # 있으므로(그 외엔 위에서 SK 해석이 이미 실패한다), 그 단일값을 이번 실행의 의도된 csn 으로 본다.
    EFFECTIVE_CSN="$(node "${SCRIPT_DIR}/lib/resolve-sk.js" "${ACCOUNTS_FILE}" --list)"
  fi
  if ! ACTUAL_CSN="$(node "${SCRIPT_DIR}/lib/check-csn.js" "${ISN}" "${SK}" "${API_BASE}" "${EFFECTIVE_CSN}")"; then
    echo "❌ CSN 불일치: isn=${ISN}의 실제 cSn=${ACTUAL_CSN:-알수없음}, 요청한 csn=${EFFECTIVE_CSN} — 다른 프로젝트 이슈에 쓰려는 것으로 보여 중단합니다. 정말 의도적이면 --force-csn 플래그로 우회하세요." >&2
    exit 2
  fi
fi

# --comment/--status 는 같은 호출에 여러 개(순서대로) 줄 수 있다.
# 예전엔 첫 번째 옵션만 처리하고 나머지를 조용히 무시했다(2026-08-02 발견: get-issue.sh 848/849/850
# --comment ... --status DONE 결합 호출에서 DONE 전이가 누락되어 IN_PROGRESS 로 방치된 인시던트).
# 이제 while 루프로 주어진 옵션을 순서대로 전부 실행한다.
while [ $# -gt 0 ]; do
  case "$1" in
    --comment)
      CONTENT="${2:-}"
      if [ -z "${CONTENT}" ]; then echo "❌ --comment 뒤에 내용이 필요합니다." >&2; exit 2; fi
      # 비-ASCII(한글 등)를 raw UTF-8 바이트로 그대로 보내면 giipfaw/DB 쪽에서 '?'로 깨져 저장됨
      # (2026-07-28 확인, DB 컬럼 콜레이션 추정, 클라이언트 전송 바이트는 xxd로 정상 검증됨).
      # \uXXXX JSON escape 형태(순수 ASCII 본문)로 보내면 정상 저장되는 것을 같은 날 재확인 —
      # 항상 non-ASCII를 \uXXXX 로 escape 해서 보낸다.
      # giip-1073: 등록만 하고 끝내지 않고, post-comment.js 가 즉시 재조회해 mojibake 를 검증한다.
      node "${SCRIPT_DIR}/lib/post-comment.js" "${ISN}" "${CONTENT}" "${SK}" "${API_BASE}" || exit 1
      shift 2
      ;;
    --comment-file)
      CONTENT_FILE="${2:-}"
      if [ -z "${CONTENT_FILE}" ]; then echo "❌ --comment-file 뒤에 파일 경로가 필요합니다." >&2; exit 2; fi
      if [ ! -f "${CONTENT_FILE}" ]; then echo "❌ 본문 파일을 찾을 수 없습니다: ${CONTENT_FILE}" >&2; exit 2; fi
      # 긴 본문/따옴표가 많은 본문은 셸 인자 경유를 피하고 UTF-8 파일로 넘기는 게 안전하다.
      node "${SCRIPT_DIR}/lib/post-comment.js" "${ISN}" "@${CONTENT_FILE}" "${SK}" "${API_BASE}" || exit 1
      shift 2
      ;;
    --delete-comment)
      DEL_CSN="${2:-}"
      if [ -z "${DEL_CSN}" ]; then echo "❌ --delete-comment 뒤에 코멘트 cSn 이 필요합니다." >&2; exit 2; fi
      # ★파괴적★ giipfaw DELETE /giipIssueComments?csn= (pApiGiipIssueCommentDeletebyAK).
      # --isn 가드로 "그 이슈에 실제로 존재하는 코멘트인지" 확인한 뒤에만 삭제한다.
      node "${SCRIPT_DIR}/lib/delete-comment.js" "${DEL_CSN}" "${SK}" "${API_BASE}" --isn "${ISN}" || exit 1
      shift 2
      ;;
    --status)
      STATUS="${2:-}"
      if [ -z "${STATUS}" ]; then echo "❌ --status 뒤에 상태값이 필요합니다(PENDING/READY/IN_PROGRESS/REVIEW/DONE)." >&2; exit 2; fi
      # pApiGiipIssuePutbyAK 는 read-modify-write(title/content 는 ISNULL 로 보존, status만 갱신).
      curl -s -X PUT "${API_BASE}/giipIssues" \
        -H "Content-Type: application/json" -H "x-api-key: ${SK}" \
        -d "{\"isn\":${ISN},\"status\":\"${STATUS}\"}"
      echo
      shift 2
      ;;
    *)
      echo "❌ 알 수 없는 옵션: $1 (--comment | --comment-file | --status | --delete-comment 만 지원)" >&2
      exit 2
      ;;
  esac
done
