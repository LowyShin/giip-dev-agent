#!/usr/bin/env node
/**
 * giip issue 코멘트 삭제 클라이언트 (giip #1073 신설).
 *
 * giipfaw 에는 DELETE /giipIssueComments?csn=<cSn> (→ pApiGiipIssueCommentDeletebyAK) 가 예전부터
 * 구현돼 있었는데(giip-800) 이걸 호출하는 클라이언트가 bash/PowerShell 어디에도 없어서 지금까지
 * "깨진 코멘트는 삭제 불가"로 알려져 있었다 — 백엔드가 아니라 클라이언트 도구가 없었을 뿐이다.
 *
 * ★파괴적 작업★ — 대상 cSn 을 정확히 지정해야 한다. 자동화(사후검증 실패 롤백)에서는
 * comment-api.postCommentVerified() 가 "방금 자기가 만든 코멘트"만 골라 이 API 를 호출한다.
 * 사람이 직접 쓸 때는 --isn / --expect-author 로 대상 확인 가드를 걸 수 있다.
 *
 * 사용: node delete-comment.js <csn> <sk> [apiBase] [--isn <isn>] [--expect-author <author>]
 */
const { deleteComment, listComments, DEFAULT_API_BASE } = require('./comment-api');

const argv = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--isn') opts.isn = argv[++i];
  else if (argv[i] === '--expect-author') opts.author = argv[++i];
  else positional.push(argv[i]);
}
const [csnArg, sk, apiBaseArg] = positional;

if (!csnArg || !sk) {
  console.error('사용법: node delete-comment.js <csn> <sk> [apiBase] [--isn <isn>] [--expect-author <author>]');
  process.exit(2);
}

const apiBase = apiBaseArg || DEFAULT_API_BASE;
const csn = Number(csnArg);

(async () => {
  // 가드: --isn 이 주어지면 삭제 전에 그 이슈에 실제로 이 cSn 이 있는지, 작성자가 맞는지 확인한다.
  if (opts.isn) {
    const comments = await listComments({ apiBase, apiKey: sk, isn: opts.isn });
    const target = comments.find((c) => Number(c.cSn) === csn);
    if (!target) {
      console.error(`❌ 이슈 #${opts.isn} 에 cSn=${csn} 코멘트가 없다 — 삭제하지 않는다.`);
      process.exit(1);
    }
    if (opts.author && String(target.author) !== String(opts.author)) {
      console.error(`❌ cSn=${csn} 의 author='${target.author}' 가 기대값 '${opts.author}' 와 다르다 — 삭제하지 않는다.`);
      process.exit(1);
    }
    console.log(`[GUARD] cSn=${csn} (isn=${opts.isn}, author=${target.author}) 확인 — 삭제 진행.`);
  }

  const res = await deleteComment({ apiBase, apiKey: sk, csn });
  console.log(res.text);
  if (res.status !== 200) process.exit(1);
})().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
