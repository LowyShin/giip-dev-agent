#!/usr/bin/env node
/**
 * CSN 불일치 검증 게이트 (giip #1053 인시던트 재발방지, 2026-08-13).
 *
 * 배경: cSn 47(giipprj/giipv3) 완료 작업 관련 코멘트 5개가 완전히 다른 고객사 이슈인
 *   #1053(cSn 70427, ai_tech_forward)에 잘못 게시된 사고가 있었다. 원인 스크립트는 특정되지
 *   않았지만, 구조적 허점은 명확하다 — get-issue.sh 는 조회(list) 시 -Csn 필터를 강제하는 규정은
 *   있지만, 코멘트 작성/상태 변경(write) 전에 "이 isn 이 실제로 의도한 CSN 소속인지" 재확인하는
 *   게이트가 전혀 없었다. 호출자가 준 isn 을 그대로 믿고 썼다.
 *
 * 이 스크립트는 isn 을 조회해 실제 cSn 을 확인하고, 호출부가 기대하는 csn 과 비교한다.
 *
 * 사용: node check-csn.js <isn> <sk> <apiBase> <expectedCsn>
 * stdout: 조회에 성공하면 실제 cSn 값(숫자)을 1줄 출력. 조회/파싱 실패시 아무것도 출력하지 않는다.
 * 종료코드:
 *   0 = 일치, 또는 조회/파싱에 실패해 검증 자체를 할 수 없음(가용성 우선 — fail-open, stderr 에 경고)
 *   1 = 명백한 불일치(실제 cSn 을 stdout 에 출력한 뒤 종료) — 호출부가 이 경우 exit 2 로 승격시킨다
 *
 * expectedCsn 이 비어있으면(호출부가 csn 을 특정할 수 없는 예외적 상황) 비교를 생략하고 0 으로 통과한다
 * — 이 스크립트는 "명백한 불일치"만 잡는 게 목적이고, 애매한 경우까지 차단하면 가용성을 해친다.
 */
const https = require('https');
const { URL } = require('url');

const [, , isn, sk, apiBase, expectedCsn] = process.argv;
if (!isn || !sk || !apiBase) {
  console.error('사용법: node check-csn.js <isn> <sk> <apiBase> <expectedCsn>');
  process.exit(2);
}

const u = new URL(`${apiBase}/giipIssues?isn=${encodeURIComponent(isn)}`);
const req = https.get(u, { headers: { 'x-api-key': sk } }, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => {
    let actualCsn = null;
    try {
      const j = JSON.parse(data);
      const issue = j.issue || j;
      if (issue) {
        if (issue.cSn != null) actualCsn = Number(issue.cSn);
        else if (issue.csn != null) actualCsn = Number(issue.csn);
      }
    } catch (e) {
      // 파싱 실패 — actualCsn=null 유지, 아래에서 검증 불가로 처리
    }

    if (actualCsn == null || Number.isNaN(actualCsn)) {
      console.error(`[WARN] isn=${isn} 의 cSn 을 조회/파싱하지 못해 CSN 검증을 건너뜁니다(HTTP ${res.statusCode}).`);
      process.exit(0);
    }

    console.log(actualCsn);
    if (expectedCsn && String(Number(expectedCsn)) !== String(actualCsn)) {
      process.exit(1);
    }
    process.exit(0);
  });
});
req.on('error', (e) => {
  console.error(`[WARN] isn=${isn} 조회 실패(${e.message}) — CSN 검증을 건너뜁니다.`);
  process.exit(0);
});
req.setTimeout(30000, () => req.destroy(new Error('timeout')));
