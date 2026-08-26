#!/usr/bin/env node
/**
 * isn 목록의 giip issue 상태를 배치 조회한다 (giip #1547 — orphan .worktrees 자가정리용).
 *
 * 배경: run-gissue-claude.ps1 의 Remove-GissueOrphanWorktrees(giip #1544 를 lowyworkenv 에서
 * 이식, giip #1547)가 .worktrees/ 아래 orphan(=git worktree 미등록) 디렉토리 후보들의 isn 을
 * 뽑아낸 뒤, 그 이슈가 DONE 이거나 더 이상 존재하지 않는지 확인해야 안전하게 삭제할 수 있다.
 * 이 레포는 DB 직접 접근(dbconfig.json/execSQLFile.ps1) 이 없고 giipfaw API(x-api-key 인증)만
 * 쓰므로, lib/check-csn.js 가 이미 쓰는 GET {apiBase}/giipIssues?isn=<isn> 패턴을 그대로 재사용해
 * isn 마다 순차 조회한다(배치 엔드포인트가 없어 여러 번 호출 — orphan 후보 수는 보통 소수라
 * 실용적으로 충분하다).
 *
 * 사용: node get-isn-status.js <apiBase> <sk> <isn1,isn2,...>
 * stdout: 조회에 성공한 isn 만 "isn|status" 한 줄씩(순서 무관). 조회 실패/파싱 실패 isn 은
 * stderr 로 "ERROR: <isn>: <원인>" 출력 후 전체를 실패로 처리한다.
 * 종료코드: 모든 isn 조회 성공 시 0, 조회 실패(네트워크 오류/시간초과/파싱실패)가 1건이라도 있으면 1.
 *   호출측 PowerShell(Get-GissueFdeIsnStatusMap)은 이 종료코드를 확인해, 실패 시 전체 정리를
 *   중단한다(단순 "이슈 없음"으로 오해해 활성 이슈 worktree를 삭제하는 것을 방지 — giip #1547 FINAL-REVIEW).
 */
const https = require('https');
const { URL } = require('url');

const [, , apiBase, sk, isnCsv] = process.argv;
if (!apiBase || !sk || !isnCsv) {
  console.error('사용법: node get-isn-status.js <apiBase> <sk> <isn1,isn2,...>');
  process.exit(1);
}

const isnList = [...new Set(
  isnCsv.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
)];

function fetchStatus(isn) {
  return new Promise((resolve) => {
    const u = new URL(`${apiBase}/giipIssues?isn=${encodeURIComponent(isn)}`);
    const req = https.get(u, { headers: { 'x-api-key': sk } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const issue = j.issue || j;
          if (issue && issue.status) {
            resolve({ ok: true, line: `${isn}|${issue.status}` });
            return;
          }
        } catch (e) {
          // 파싱 실패 — 실패로 처리
        }
        console.error(`ERROR: ${isn}: parse_error`);  // giip #1547 FINAL-REVIEW
        resolve({ ok: false, isn });
      });
    });
    req.on('error', (err) => {
      console.error(`ERROR: ${isn}: ${err.message}`);  // giip #1547 FINAL-REVIEW
      resolve({ ok: false, isn });
    });
    req.setTimeout(30000, () => {
      req.destroy();
      console.error(`ERROR: ${isn}: timeout`);  // giip #1547 FINAL-REVIEW
      resolve({ ok: false, isn });
    });
  });
}

(async () => {
  let hasFailure = false;
  for (const isn of isnList) {
    // 배치 엔드포인트가 없어 순차 처리 — 후보 수가 많아지면 병렬화 고려(현재는 불필요).
    // eslint-disable-next-line no-await-in-loop
    const result = await fetchStatus(isn);
    if (result.ok) {
      console.log(result.line);
    } else {
      hasFailure = true;  // 조회 실패가 1건이라도 있으면 exit 1 (giip #1547 FINAL-REVIEW)
    }
  }
  process.exit(hasFailure ? 1 : 0);
})();
