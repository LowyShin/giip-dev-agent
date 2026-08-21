#!/bin/bash
###############################################################################
# get-ak.sh — SK + 로그인ID 로 최신 AK(Access Token) 도출 (rule 39 / giip-get-ak 워크플로우)
#
# 배경: giipv3 웹 화면 다수(admin/menu-config 등)는 AK(실 로그인 세션 토큰)가 있어야
#       동작한다. SK(tCorpUser.uSecretKey)를 그대로 써도 되는 SP(lwGetUSNbyat 계열)와
#       달리, 일부 SP(pApiMenuConfigListbyAk 등)는 Users.ak(=tCorpUser.uaccesstoken)
#       exact match 만 받는다 — 이 경우 SK로는 401 이 나고, AdminGetAK 로 먼저 AK 를
#       도출해야 한다.
#
# 백엔드: giipdb/SP/pApiAdminGetAKbyAK.sql — SK+uloginid 2요소 확인 → 최근 24h 활성 AK
#         재사용, 없으면 신규 발급 + tCorpUser.uaccesstoken 동기화.
#
# 사용:
#   scripts/gissue/get-ak.sh <csn>          # slack-bot/.secrets/giip-accounts.json 에서
#                                            # 해당 csn 계정의 login_id+sk 를 찾아 AK 도출
#   scripts/gissue/get-ak.sh <csn> --json    # 결과를 JSON 그대로 출력(스크립트 연계용)
#
# 출력: ak / usn / csn 만 표준출력에 남긴다. sk 는 어떤 경우에도 화면에 출력하지 않는다.
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNTS_FILE="$(cd "${SCRIPT_DIR}/../.." && pwd)/slack-bot/.secrets/giip-accounts.json"
API_BASE="https://giipfaw.azurewebsites.net/api"
# giipApi(giipfaw)는 anonymous가 아니라 Function Key(code)가 필요하다(giipMenuConfig/giipIssues와 다름).
# 이 code는 giipv3 클라이언트 번들에 이미 하드코딩되어 브라우저로 배포되는 값이다(src/config/api.ts
# AZURE_FUNCTION_API.code) — AK/SK와 달리 비밀값이 아니라 Function 접근키.
API_CODE="${GIIP_AZURE_CODE:-A-NKqA90-xgw_fu0V6CneCnFrJrv6qvusWtDel7MJegTAzFu0E6mYw==}"

CSN="${1:-}"
if [ -z "${CSN}" ]; then
  echo "사용법: $0 <csn> [--json]" >&2
  exit 2
fi
AS_JSON="${2:-}"

if [ ! -f "${ACCOUNTS_FILE}" ]; then
  echo "❌ 계정 파일을 찾을 수 없습니다: ${ACCOUNTS_FILE}" >&2
  exit 2
fi

# login_id + sk 추출 (csn 매칭). sk 는 변수에만 담고 echo 하지 않는다.
read -r LOGIN_ID SK < <(node -e "
const fs=require('fs');
const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const csn=Number(process.argv[2]);
const ch = Object.values(j.channels||j).find(a=>Number(a.csn)===csn);
if(!ch){ process.stderr.write('csn '+csn+' 에 매칭되는 계정이 없습니다\n'); process.exit(1); }
process.stdout.write(ch.login_id.replace(/^<mailto:([^|]+)\|.*>\$/,'\$1')+' '+ch.sk+'\n');
" "${ACCOUNTS_FILE}" "${CSN}")

RESP="$(curl -sS -w '\nHTTP_STATUS:%{http_code}' -X POST "${API_BASE}/giipApi?code=${API_CODE}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "text=AdminGetAK" \
  --data-urlencode "token=${SK}" \
  --data-urlencode "jsondata={\"uloginid\":\"${LOGIN_ID}\"}")"

unset SK
STATUS_LINE="$(echo "${RESP}" | grep -o 'HTTP_STATUS:[0-9]*')"
echo "[debug] ${STATUS_LINE}" >&2
RESP="$(echo "${RESP}" | sed 's/HTTP_STATUS:[0-9]*$//')"

if [ "${AS_JSON}" = "--json" ]; then
  echo "${RESP}"
  exit 0
fi

node -e "
let d = JSON.parse(process.argv[1]);
if (Array.isArray(d)) d = d[0];
if (!d || Number(d.RstVal) !== 200) {
  console.error('❌ AK 도출 실패:', d && d.Proc_MSG);
  process.exit(1);
}
console.log('ak=' + d.ak);
console.log('usn=' + d.usn);
console.log('csn=' + d.csn);
" "${RESP}"
