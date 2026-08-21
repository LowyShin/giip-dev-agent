#!/usr/bin/env node
/**
 * non-ASCII 텍스트를 \uXXXX JSON escape 로 바꾸는 공용 헬퍼 (giip #1236).
 *
 * giipfaw 백엔드에 반복되는 T-SQL N-prefix 클래스 mojibake 버그(giip #581 → #1030 → #1044)를
 * 우회하기 위해, 한글/이모지 등 non-ASCII 를 담은 JSON 본문은 순수 ASCII(\uXXXX escape)로
 * 바꿔서 보낸다(2026-07-28 확인: raw UTF-8 바이트로 보내면 '?' 로 깨져 저장됨).
 *
 * 원래 scripts/gissue/lib/comment-api.js 안에만 있던 구현(giip #1073)을 slack-bot/giip-api.js
 * 도 쓸 수 있게 별도 파일로 뺐다(giip #1236 — issueComment()/issueUpdate() 의 자동 상태전이
 * 코멘트가 이 escape 없이 raw UTF-8 로 나가서 PR #573 병합 이후 거의 모든 상태전이 코멘트가
 * 깨지고 있었음, giip #1193/#1225 등에서 확인).
 */

/** non-ASCII 를 \uXXXX 로 escape (순수 ASCII 문자열 반환). */
function escapeNonAscii(str) {
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      // BMP 밖(이모지 등)은 서로게이트 페어로 나눠서 escape 해야 JSON 으로 유효하다.
      const v = cp - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += '\\u' + hi.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0');
    } else if (cp > 127) {
      out += '\\u' + cp.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out;
}

module.exports = { escapeNonAscii };
