// giipIssueComments POST body 생성. non-ASCII(한글 등)를 \uXXXX escape로 내보낸다.
// 이유: raw UTF-8 바이트로 보내면 giipfaw/DB 쪽에서 '?'로 깨짐(2026-07-28 확인,
// DB 컬럼 콜레이션 추정). \uXXXX escape(순수 ASCII 본문)로 보내면 정상 저장됨(같은 날 재확인).
//
// giip #1073: 실제 escape/전송 로직은 comment-api.js 로 옮겼다(사후검증·삭제와 공유하기 위해).
// 이 파일은 기존 호출부 호환을 위한 얇은 CLI 래퍼로 남긴다.
// 새 코드는 post-comment.js(등록+사후검증) 를 쓸 것 — 이 스크립트는 검증 없이 body 만 만든다.
const { buildCommentBody } = require('./comment-api');

const isn = Number(process.argv[2]);
const content = process.argv[3];

process.stdout.write(buildCommentBody(isn, content, 'note'));
