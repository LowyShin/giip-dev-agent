#!/usr/bin/env node
/**
 * get-issue.sh --comment 의 실행부 (giip #1073).
 *
 * 등록(안전한 \uXXXX escape 경로) → 즉시 재조회 → mojibake 검증 →
 * 깨졌으면 방금 자기가 만든 코멘트만 삭제하고 1회 재시도 → 그래도 실패하면 exit 1.
 *
 * 사용: node post-comment.js <isn> <content> <sk> [apiBase] [issuetype]
 *   content 가 '@<path>' 형태면 그 파일을 UTF-8 로 읽어 본문으로 쓴다
 *   (긴 본문/따옴표 많은 본문을 커맨드라인 인자로 넘기지 않아도 되게 하는 안전 경로).
 */
const fs = require('fs');
const { postCommentVerified, DEFAULT_API_BASE } = require('./comment-api');

const [, , isnArg, contentArg, sk, apiBaseArg, issuetypeArg] = process.argv;

if (!isnArg || contentArg === undefined || !sk) {
  console.error('사용법: node post-comment.js <isn> <content|@file> <sk> [apiBase] [issuetype]');
  process.exit(2);
}

let content = contentArg;
if (content.startsWith('@')) {
  content = fs.readFileSync(content.slice(1), 'utf8');
}

postCommentVerified({
  apiBase: apiBaseArg || DEFAULT_API_BASE,
  apiKey: sk,
  isn: Number(isnArg),
  content,
  issuetype: issuetypeArg || 'note',
})
  .then((r) => {
    r.log.forEach((l) => console.log(l));
    if (r.verified) {
      console.log(JSON.stringify({ success: true, verified: true, cSn: r.csn, attempts: r.attempts }));
    } else {
      // 등록은 됐지만 검증을 못한 경우(스냅샷/재조회 실패 등) — 실패로 취급하지 않되 명확히 알린다.
      console.log(JSON.stringify({ success: true, verified: false, cSn: r.csn, attempts: r.attempts }));
    }
  })
  .catch((e) => {
    if (e.log) e.log.forEach((l) => console.error(l));
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
