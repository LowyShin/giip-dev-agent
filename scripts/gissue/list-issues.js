#!/usr/bin/env node
///////////////////////////////////////////////////////////////////////////
// list-issues.js — CSN + status 로 giip issue 목록을 조회한다 (giipfaw API 경유,
// DB 직접접근 불필요). giipdb/mgmt/list*.ps1(csn47 giipprj 전용, DB-direct) 의
// 이식 가능한 대체품 — 이 레포(giip-fde-agent)를 그대로 복사해 쓰는 모든 배포
// 대상(csn-projects.json 에 자기 project/workdir 만 채운 곳)에서 동일하게 동작한다.
//
// SK 출처: get-issue.sh 와 동일 — <RepoRoot>/slack-bot/.secrets/giip-accounts.json
// (.channels[*].sk, csn 필드로 매칭. 없으면 .default 사용).
//
// "얼마나 오래 그 상태였는가"(-min-age-minutes)는 DB 타임스탬프가 없으므로,
// giip-api.js issueUpdate() 가 상태 전이마다 자동으로 남기는
//   "## [actor] ISN <isn> 状態遷移: OLD -> NEW" + "**日時(When)**: <ISO>"
// 코멘트를 giipIssueComments 에서 역순으로 찾아 "-> <현재상태>" 로 끝나는 가장
// 최근 전이 코멘트의 시각을 그 상태 진입 시각으로 추정한다. 매칭되는 전이 코멘트가
// 없으면(예: 생성 즉시 그 상태) age=null 로 두고 무조건 대상에 포함시킨다(누락 방지 우선).
//
// 사용:
//   node list-issues.js --csn <N> --status PENDING[,READY,IN_PROGRESS] [--min-age-minutes <N>] [--json]
//   node list-issues.js --csn <N> --status REVIEW --hours-back <N>   # [H] 최근 코멘트 재검증용
//
// 출력(기본): 한 줄에 하나, "isn=<n> status=<s> age=<분|?> title=<제목>"
// 출력(--json): [{isn, status, ageMinutes, title}, ...]
///////////////////////////////////////////////////////////////////////////
const https = require('https');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const CSN = args.csn;
const API_BASE = args['api-base'] || 'https://giipfaw.azurewebsites.net/api';
const SCRIPT_DIR = __dirname;
const ACCOUNTS_FILE = args['accounts-file'] || path.join(SCRIPT_DIR, '..', '..', 'slack-bot', '.secrets', 'giip-accounts.json');
const STATUSES = String(args.status || '').split(',').map((s) => s.trim()).filter(Boolean);
const MIN_AGE_MIN = args['min-age-minutes'] ? Number(args['min-age-minutes']) : 0;
const HOURS_BACK = args['hours-back'] ? Number(args['hours-back']) : 0;
const AS_JSON = !!args.json;

if (!CSN || !STATUSES.length) {
  console.error('사용법: node list-issues.js --csn <N> --status PENDING[,READY,IN_PROGRESS] [--min-age-minutes <N>] [--hours-back <N>] [--json]');
  process.exit(2);
}

function resolveSk(csn) {
  if (!fs.existsSync(ACCOUNTS_FILE)) throw new Error(`계정 파일을 찾을 수 없습니다: ${ACCOUNTS_FILE}`);
  const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
  const channels = Object.values(data.channels || {});
  const defaultEntry = data.default ? [data.default] : [];
  const match = [...channels, ...defaultEntry].find((c) => String(c.csn) === String(csn));
  if (!match || !match.sk) throw new Error(`csn ${csn} 에 매칭되는 sk 를 찾지 못했습니다 (${ACCOUNTS_FILE})`);
  return match.sk;
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let parsed = body;
        try { parsed = JSON.parse(body); } catch { /* keep raw */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('list-issues.js: giipfaw request timeout')));
  });
}

function extractStatusEnteredAt(comments, status) {
  const transitionRe = new RegExp(`状態遷移:\\s*\\S+\\s*->\\s*${status}\\s*$`, 'm');
  const timeRe = /\*\*日時\(When\)\*\*:\s*(\S+)/;
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].content || comments[i].Content || '';
    if (transitionRe.test(body)) {
      const m = body.match(timeRe);
      if (m) {
        const d = new Date(m[1]);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
  }
  return null;
}

function lastCommentAt(comments) {
  let latest = null;
  for (const c of comments) {
    const when = c.regdate || c.Regdate;
    if (!when) continue;
    const d = new Date(when);
    if (!Number.isNaN(d.getTime()) && (!latest || d > latest)) latest = d;
  }
  return latest;
}

async function main() {
  const sk = resolveSk(CSN);
  const results = [];
  for (const status of STATUSES) {
    const url = `${API_BASE}/giipIssues?csn=${encodeURIComponent(CSN)}&status=${encodeURIComponent(status)}`;
    const res = await httpGet(url, { 'x-api-key': sk });
    if (res.status !== 200) {
      console.error(`❌ issueList(status=${status}) 실패: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      process.exit(1);
    }
    const issues = res.body?.issues || [];
    for (const issue of issues) {
      const isn = issue.isn ?? issue.Isn;
      if (isn == null) continue;
      let ageMinutes = null;
      let comments = null;
      if (MIN_AGE_MIN > 0 || HOURS_BACK > 0) {
        const cRes = await httpGet(`${API_BASE}/giipIssueComments?isn=${encodeURIComponent(isn)}`, { 'x-api-key': sk });
        comments = cRes.status === 200 ? (cRes.body?.comments || []) : [];
      }
      if (MIN_AGE_MIN > 0) {
        const enteredAt = extractStatusEnteredAt(comments || [], status);
        if (enteredAt) ageMinutes = Math.round((Date.now() - enteredAt.getTime()) / 60000);
        if (ageMinutes !== null && ageMinutes < MIN_AGE_MIN) continue;
      }
      if (HOURS_BACK > 0) {
        const last = lastCommentAt(comments || []);
        if (!last || (Date.now() - last.getTime()) / 3600000 > HOURS_BACK) continue;
      }
      results.push({
        isn,
        status,
        ageMinutes,
        title: issue.title ?? issue.Title ?? '',
      });
    }
  }
  if (AS_JSON) {
    console.log(JSON.stringify(results));
  } else if (!results.length) {
    console.log(`(csn=${CSN} status=${STATUSES.join(',')} 대상 없음)`);
  } else {
    for (const r of results) {
      console.log(`isn=${r.isn} status=${r.status} age=${r.ageMinutes === null ? '?' : r.ageMinutes + 'm'} title=${r.title}`);
    }
  }
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
