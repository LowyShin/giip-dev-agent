#!/usr/bin/env node
/**
 * giipIssueComments API 공용 클라이언트 + mojibake 사후검증 유틸 (giip #1073)
 *
 * 배경: giip issue 코멘트에 한글/이모지가 "・""巐" 류로 깨지는 사고가 반복됐다(giip #581 → #1030).
 *   코멘트 등록 경로가 두 개인데(bash: get-issue.sh → 이 모듈, PowerShell: giipdb/mgmt/addIssueComment.ps1)
 *   안전조치가 한쪽에만 적용돼 있었고, 무엇보다 "등록 후 실제로 제대로 저장됐는지" 확인하는 단계가
 *   아예 없어서 사람이 나중에 화면에서 보고 나서야 발견됐다.
 *
 * 이 모듈이 제공하는 것:
 *   1. escapeNonAscii()  — non-ASCII 를 \uXXXX JSON escape 로 바꿔 순수 ASCII 페이로드로 전송
 *                          (2026-07-28 확인: raw UTF-8 바이트로 보내면 '?' 로 깨져 저장됨)
 *                          실제 구현은 giip #1236 로 text-escape.js 로 옮겨 slack-bot/giip-api.js 와 공유한다.
 *   2. listComments()/postComment()/deleteComment() — giipfaw API 얇은 래퍼(내장 https, 의존성 없음)
 *   3. detectMojibake()  — 보낸 원문 vs 재조회한 content 비교로 깨짐 징후 탐지
 *   4. postCommentVerified() — 등록 → 재조회 → 검증 → (깨졌으면) 방금 만든 코멘트만 삭제 후 1회 재시도
 *                          → 그래도 깨지면 삭제하고 명확히 실패(무한 재시도 금지)
 *
 * ★ 삭제 안전장치: 삭제 대상 cSn 은 "POST 직전 스냅샷에 없었고 POST 직후에 새로 생긴" 코멘트에서만
 *   구한다. giipfaw 의 POST 응답은 cSn 을 돌려주지 않으므로(SP 는 돌려주는데 API 래퍼가 버린다,
 *   giipfaw 는 성역이라 수정하지 않는다) 전/후 스냅샷 차집합으로 자기 코멘트를 특정한다.
 *   기존 코멘트는 어떤 경우에도 삭제 대상이 되지 않는다.
 */
const https = require('https');
const { URL } = require('url');
const { escapeNonAscii } = require('./text-escape');

const DEFAULT_API_BASE = 'https://giipfaw.azurewebsites.net/api';

/** giipIssueComments POST body 를 순수 ASCII 로 만든다. */
function buildCommentBody(isn, content, issuetype = 'note') {
  return escapeNonAscii(JSON.stringify({ isn: Number(isn), content, issuetype }));
}

function request(method, url, { apiKey, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'x-api-key': apiKey };
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = Buffer.from(body, 'utf8'); // body 는 이미 순수 ASCII 로 escape 된 상태
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 비-JSON 응답은 raw 로만 전달 */ }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(`timeout: ${method} ${url}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function listComments({ apiBase = DEFAULT_API_BASE, apiKey, isn }) {
  const res = await request('GET', `${apiBase}/giipIssueComments?isn=${encodeURIComponent(isn)}`, { apiKey });
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.comments)) {
    throw new Error(`코멘트 조회 실패 (HTTP ${res.status}): ${res.text.slice(0, 500)}`);
  }
  return res.json.comments;
}

async function postComment({ apiBase = DEFAULT_API_BASE, apiKey, isn, content, issuetype = 'note' }) {
  return request('POST', `${apiBase}/giipIssueComments`, {
    apiKey,
    body: buildCommentBody(isn, content, issuetype),
  });
}

/** ★파괴적★ 지정한 cSn 코멘트 1건을 삭제한다. 호출부가 대상 특정 책임을 진다. */
async function deleteComment({ apiBase = DEFAULT_API_BASE, apiKey, csn }) {
  return request('DELETE', `${apiBase}/giipIssueComments?csn=${encodeURIComponent(csn)}`, { apiKey });
}

/**
 * 개행/후행 공백만 다른 것은 저장 과정의 정상적인 정규화로 보고 동등 취급한다.
 * (mojibake 판정에서 이걸 걸러내지 않으면 멀쩡한 코멘트를 삭제해버릴 수 있다 — 오탐이 더 위험하다.)
 */
function normalize(s) {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * 보낸 원문(expected)과 재조회한 값(actual)을 비교해 mojibake 징후를 찾는다.
 * @returns {{ok: boolean, reasons: string[]}}
 */
function detectMojibake(expected, actual) {
  const reasons = [];
  const e = normalize(expected);
  const a = normalize(actual);

  if (a === '') {
    reasons.push('재조회한 content 가 비어 있음');
    return { ok: false, reasons };
  }

  // (1) U+FFFD replacement character — 손실성 디코딩의 확정적 증거
  if (a.includes('�') && !e.includes('�')) {
    reasons.push('U+FFFD(replacement character) 가 저장본에 나타남');
  }

  // (2) 원문에 없던 '?' 연속 — non-ASCII 가 '?' 로 치환되는 전형적 collation 손실
  const qRunActual = (a.match(/\?{2,}/g) || []).length;
  const qRunExpected = (e.match(/\?{2,}/g) || []).length;
  if (qRunActual > qRunExpected) {
    reasons.push(`원문에 없던 '?' 연속이 저장본에 ${qRunActual - qRunExpected}곳 나타남`);
  }

  // (3) non-ASCII 문자 소실/치환 — 원문 non-ASCII 중 저장본에 남아있는 비율
  const eNonAscii = [...e].filter((c) => c.codePointAt(0) > 127);
  if (eNonAscii.length > 0) {
    const aSet = new Set([...a]);
    const survived = eNonAscii.filter((c) => aSet.has(c)).length;
    const ratio = survived / eNonAscii.length;
    if (ratio < 0.98) {
      reasons.push(
        `원문 non-ASCII ${eNonAscii.length}자 중 ${eNonAscii.length - survived}자가 저장본에서 소실/치환됨(보존율 ${(ratio * 100).toFixed(1)}%)`
      );
    }
    // (4) 대표적 mojibake 징후 문자(giip #581/#1030 실측 패턴)
    const known = ['・', '･']; // '・' KATAKANA MIDDLE DOT (반각 포함)
    for (const k of known) {
      const ce = (e.match(new RegExp(k, 'g')) || []).length;
      const ca = (a.match(new RegExp(k, 'g')) || []).length;
      if (ca - ce >= 3) reasons.push(`mojibake 징후 문자 '${k}' 가 원문보다 ${ca - ce}개 많이 나타남`);
    }
  }

  // (5) 최종 안전망: 완전 일치가 아니면(위 휴리스틱에 안 걸려도) 경고 사유로 남긴다.
  if (reasons.length === 0 && e !== a) {
    reasons.push(`완전 일치하지 않음(원문 ${e.length}자 vs 저장본 ${a.length}자)`);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * 코멘트를 등록하고 즉시 재조회해 검증한다.
 * 깨졌으면 "방금 자기가 만든" 코멘트만 삭제하고 같은 안전경로로 1회만 재시도한다.
 * 재시도도 실패하면 그 코멘트도 삭제하고 throw — 무한 재시도는 하지 않는다(원인이 같으면 또 깨진다).
 *
 * @returns {{csn:number|null, attempts:number, verified:boolean, log:string[]}}
 */
async function postCommentVerified({ apiBase = DEFAULT_API_BASE, apiKey, isn, content, issuetype = 'note', maxAttempts = 2 }) {
  const log = [];
  let lastReasons = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1) POST 직전 스냅샷 — 삭제 대상을 자기 코멘트로 한정하기 위한 기준선
    let before;
    try {
      before = new Set((await listComments({ apiBase, apiKey, isn })).map((c) => Number(c.cSn)));
    } catch (e) {
      log.push(`[WARN] 사전 스냅샷 실패(${e.message}) — 사후검증은 건너뛰고 등록만 시도한다.`);
      before = null;
    }

    // 2) 등록
    const res = await postComment({ apiBase, apiKey, isn, content, issuetype });
    if (res.status !== 200) {
      throw new Error(`코멘트 등록 실패 (HTTP ${res.status}): ${res.text.slice(0, 500)}`);
    }
    log.push(`[POST] 등록 성공 (attempt ${attempt}/${maxAttempts})`);

    if (before === null) {
      return { csn: null, attempts: attempt, verified: false, log };
    }

    // 3) 재조회 → 새로 생긴 cSn 특정(차집합)
    let after;
    try {
      after = await listComments({ apiBase, apiKey, isn });
    } catch (e) {
      log.push(`[WARN] 사후 재조회 실패(${e.message}) — 검증 불가, 등록 자체는 성공했다.`);
      return { csn: null, attempts: attempt, verified: false, log };
    }
    const fresh = after.filter((c) => !before.has(Number(c.cSn)));
    if (fresh.length === 0) {
      log.push('[WARN] 새로 생긴 코멘트를 찾지 못함 — 검증 불가(등록 응답은 200).');
      return { csn: null, attempts: attempt, verified: false, log };
    }
    const mine = fresh.reduce((a, b) => (Number(b.cSn) > Number(a.cSn) ? b : a));
    const csn = Number(mine.cSn);
    log.push(`[VERIFY] 자기 코멘트 cSn=${csn} 특정(신규 ${fresh.length}건 중 최신)`);

    // 4) 검증
    const check = detectMojibake(content, mine.content);
    if (check.ok) {
      log.push(`[VERIFY] OK — 저장본이 원문과 일치(cSn=${csn}).`);
      return { csn, attempts: attempt, verified: true, log };
    }

    lastReasons = check.reasons;
    log.push(`[VERIFY] ❌ mojibake 의심(cSn=${csn}): ${check.reasons.join(' / ')}`);

    // 5) 자기가 만든 그 코멘트만 삭제
    const del = await deleteComment({ apiBase, apiKey, csn });
    if (del.status === 200) log.push(`[DELETE] 깨진 코멘트 cSn=${csn} 삭제 완료.`);
    else log.push(`[DELETE] ⚠ cSn=${csn} 삭제 실패 (HTTP ${del.status}): ${del.text.slice(0, 300)}`);

    if (attempt < maxAttempts) log.push('[RETRY] 같은 안전경로(\\uXXXX escape)로 1회만 재시도한다.');
  }

  const err = new Error(
    `코멘트 mojibake 검증 실패 — ${maxAttempts}회 시도 모두 깨져서 저장됐고 해당 코멘트는 삭제했다. ` +
      `무한 재시도를 피하기 위해 여기서 중단한다(사람 확인 필요). 사유: ${lastReasons.join(' / ')}`
  );
  err.log = log;
  throw err;
}

module.exports = {
  DEFAULT_API_BASE,
  escapeNonAscii,
  buildCommentBody,
  listComments,
  postComment,
  deleteComment,
  detectMojibake,
  postCommentVerified,
};
