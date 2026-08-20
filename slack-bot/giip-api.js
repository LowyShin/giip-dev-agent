/**
 * giip-api.js — giip API 클라이언트(의존성 없음, 내장 https).
 * 설계: docs/DESIGN_slackbot_giip_issue_integration.md. 규칙: .agent/rules/39(AK 도출),40(생성 우선).
 *
 * 인증: 전용 이슈 엔드포인트는 SK 를 그대로 x-api-key 로 쓴다(익명, 실측 REPORT_giip_issue_api_test_20260708).
 * AK 도출(AdminGetAK) 안 함 — SK 를 AT(token) 자리에 넣으면 401(SK≠AT 혼동 금지, rule 39).
 */
const https = require('https');
const os = require('os');
const { URL } = require('url');
const accounts = require('./giip-accounts');

const AK_TTL_MS = 20 * 60 * 60 * 1000; // 20h
const akCache = new Map(); // login_id → { ak, csn, usn, fetchedAt }

/**
 * [giip #1211] 이 배포가 giip 이슈 상태전이 코멘트에 남길 행위자 이름표.
 * giip-task.js 의 동명 함수와 동일한 폴백 규칙(GIIP_ACTOR_TAG 우선, 없으면 호스트 기준).
 * 여기 두는 이유: issueUpdate 자체가 코멘트를 남기므로(아래 참고) giip-task.js 를 거치지
 * 않는 호출부(giip-commands.js 등)도 이 모듈 하나만으로 행위자 이름표를 얻을 수 있어야 한다.
 */
function actorTag() {
  return process.env.GIIP_ACTOR_TAG || `slack-bot@${os.hostname()}`;
}

function request(method, urlStr, { headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        let parsed = chunks;
        try { parsed = JSON.parse(chunks); } catch { /* keep string */ }
        resolve({ status: res.statusCode, body: parsed, raw: chunks });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('giip-api request timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function form(params) {
  return Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * 인증 토큰 취득. rule 39 + 실측(REPORT_giip_issue_api_test_20260708):
 * 전용 이슈 엔드포인트(/api/giipIssues 등)는 **SK 를 그대로 x-api-key 로** 인증한다(익명).
 * AK 도출(AdminGetAK)은 불필요하며, SK 를 AdminGetAK 의 token(=AT 자리)으로 넣으면 401 이 난다
 * (SK≠AT 혼동 금지). 따라서 네트워크 호출 없이 SK 를 그대로 반환한다.
 */
async function getAK(account) {
  return { ak: account.sk, csn: account.csn ?? null, usn: null, fetchedAt: Date.now() };
}

/** giipIssues(전용함수) 호출. x-api-key=AK, 401 시 1회 강제 갱신 재시도. */
async function issueApi(account, method, { query = '', body = null } = {}) {
  const base = account.apiBase || accounts.apiBase();
  let ak = (await getAK(account)).ak;
  const url = `${base}/giipIssues${query}`;
  let res = await request(method, url, {
    headers: { 'x-api-key': ak, 'Content-Type': 'application/json' },
    body,
  });
  if (res.status === 401) {
    ak = (await getAK(account, { force: true })).ak;
    res = await request(method, url, {
      headers: { 'x-api-key': ak, 'Content-Type': 'application/json' },
      body,
    });
  }
  return res;
}

async function issueGet(account, isn) {
  const res = await issueApi(account, 'GET', { query: `?isn=${encodeURIComponent(isn)}` });
  if (res.status !== 200) throw new Error(`issueGet 실패: ${res.body?.error || res.status}`);
  return res.body?.issue || {};
}

async function issueList(account, { status = '', csn = '' } = {}) {
  const q = [];
  if (status) q.push(`status=${encodeURIComponent(status)}`);
  if (csn) q.push(`csn=${encodeURIComponent(csn)}`);
  const res = await issueApi(account, 'GET', { query: q.length ? `?${q.join('&')}` : '' });
  if (res.status !== 200) throw new Error(`issueList 실패: ${res.body?.error || res.status}`);
  return res.body?.issues || [];
}

// 생성 기본값은 PENDING(대기열). '생성'은 착수가 아니라 등록이므로, 무인 처리기(:20/:40, PENDING/READY만 픽업)가
// 집을 수 있는 상태로 둔다. 착수(IN_PROGRESS)가 필요한 호출자(task 자동연동 등)는 status 를 명시적으로 넘긴다.
async function issueCreate(account, { title, content, status = 'PENDING', csn, target_lssn = null, agent_workflow = null }) {
  const res = await issueApi(account, 'POST', {
    body: { title, content, status, csn: csn ?? account.csn, target_lssn, agent_workflow },
  });
  if (res.status !== 200 || !res.body?.isn) throw new Error(`issueCreate 실패: ${res.body?.error || res.status}`);
  return res.body; // { success, isn, message }
}

/**
 * PUT 은 전체 덮어쓰기 → read-modify-write 로 미지정 필드 보존(설계 §6).
 *
 * [giip #1211] 상태전이 코멘트를 이 함수 자체가 항상 남긴다. 이전에는 giip-task.js#maybeFinish
 * 를 거치는 호출부만 코멘트를 남기고, giip-commands.js(`giip issue done/review/progress`)나
 * handlers.js 처럼 issueUpdate 를 직접 호출하는 경로는 코멘트 없이 조용히 상태만 바뀌었다
 * (giipprj/giipdb/mgmt/updateIssueStatus.ps1 이 opt-in 이라 겪은 것과 동일한 근본 결함,
 * giip #1155/#1208). 모든 호출부가 이 함수 하나를 거치므로 여기서 강제하면 개별 호출부
 * 수정 없이도 구조적으로 보장된다. 코멘트 자체가 실패해도 상태 변경은 이미 끝난 뒤이므로
 * throw 하지 않고 로그만 남긴다(봇 무중단 원칙).
 *
 * @param {object} fields isn/title/content/status/csn/target_lssn/agent_workflow
 * @param {{actor?:string, reason?:string, skipComment?:boolean}} [opts]
 *   actor: 코멘트에 남길 행위자 이름표(기본: actorTag()).
 *   reason: 상태 변경 사유(기본: "(사유 미기재 - 자동 기본값)").
 *   skipComment: true 면 이 함수가 코멘트를 남기지 않는다 — 호출부(giip-task.js#maybeFinish)가
 *     이미 자기 코멘트를 남기는 경우 중복 방지용으로만 쓴다.
 */
async function issueUpdate(account, fields, opts = {}) {
  const cur = await issueGet(account, fields.isn);
  const merged = {
    isn: fields.isn,
    title: fields.title ?? cur.title,
    content: fields.content ?? cur.content,
    status: fields.status ?? cur.status,
    csn: fields.csn ?? cur.CSn ?? cur.csn ?? account.csn,
    target_lssn: fields.target_lssn ?? cur.target_lssn ?? null,
    agent_workflow: fields.agent_workflow ?? cur.agent_workflow ?? null,
  };
  const res = await issueApi(account, 'PUT', { body: merged });
  if (res.status !== 200) throw new Error(`issueUpdate 실패: ${res.body?.error || res.status}`);

  const oldStatus = cur.status ?? cur.Status ?? null;
  const newStatus = merged.status;
  if (!opts.skipComment && fields.status && newStatus && oldStatus !== newStatus) {
    try {
      const actor = opts.actor || actorTag();
      const reason = opts.reason || '(사유 미기재 - 자동 기본값)';
      const when = new Date().toISOString();
      const commentBody = [
        `## [${actor}] ISN ${fields.isn} 상태전이: ${oldStatus || 'UNKNOWN'} -> ${newStatus}`,
        `**행위자(Actor)**: ${actor}`,
        `**시각(When)**: ${when}`,
        `**사유(Why)**: ${reason}`,
      ].join('\n');
      await issueComment(account, fields.isn, commentBody);
    } catch (e) {
      console.error(`[giip-api] 상태전이 코멘트 등록 실패(isn=${fields.isn}):`, e.message);
    }
  }

  return res.body;
}

async function issueComment(account, isn, content) {
  const base = account.apiBase || accounts.apiBase();
  let ak = (await getAK(account)).ak;
  const doPost = (token) =>
    request('POST', `${base}/giipIssueComments`, {
      headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
      body: { isn: Number(isn), content },
    });
  let res = await doPost(ak);
  if (res.status === 401) { ak = (await getAK(account, { force: true })).ak; res = await doPost(ak); }
  if (res.status !== 200) throw new Error(`issueComment 실패: ${res.body?.error || res.status}`);
  return res.body;
}

/**
 * GET /giipIssueComments?isn= — 이슈의 모든 코멘트를 시간순(regdate ASC)으로 반환한다.
 * giip issue 재처리 시 로컬 태스크 파일이 done/ 이동·타 클론 처리 등으로 없더라도
 * DB(SSOT)에서 전체 코멘트 이력을 복원해 처리 맥락으로 쓰기 위한 조회 경로.
 * 반환: [{ cSn, isn, content, author, issuetype, regdate }, ...]
 */
async function issueComments(account, isn) {
  const base = account.apiBase || accounts.apiBase();
  let ak = (await getAK(account)).ak;
  const doGet = (token) =>
    request('GET', `${base}/giipIssueComments?isn=${encodeURIComponent(isn)}`, {
      headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
    });
  let res = await doGet(ak);
  if (res.status === 401) { ak = (await getAK(account, { force: true })).ak; res = await doGet(ak); }
  if (res.status !== 200) throw new Error(`issueComments 실패: ${res.body?.error || res.status}`);
  return res.body?.comments || [];
}

/**
 * 봇 유저(SK→usn)를 @csn 의 멤버로 giip DB(tUserPerCorp)에 멱등 등록한다.
 * → `giip project set <p> <csn>` 이 로컬 map 저장뿐 아니라 DB 멤버십까지 완결하게 해,
 *   pApiGiipIssuePutbyAK 의 멤버십 게이트가 홈 CSN(47)으로 클램프하는 문제를 자동 해소한다.
 * SP: pApiUserPerCorpGrantBotbySk (권한 게이트: 봇 계정 또는 기존 tCorpUserRel 멤버만, 대상=자기 자신).
 * 호출: giipApiSk2  text="UserPerCorpGrantBot"  jsondata={"csn":<n>}  (ISN-161 auto-append 로 전달).
 * @returns {{ ok:boolean, rstVal:number|null, already:boolean, msg:string, raw:any }}
 */
async function grantBotCsn(account, csn) {
  const n = Number(csn);
  if (!Number.isInteger(n)) throw new Error('csn 은 정수여야 합니다.');
  const raw = await apiCall(account, 'UserPerCorpGrantBot', { csn: n });
  // giipApiSk2 응답: { data: [ { RstVal, Proc_MSG, usn, csn, already } ], debug } 또는 { error }
  const row = raw && Array.isArray(raw.data) ? raw.data[0] : null;
  const rstVal = row && row.RstVal != null ? Number(row.RstVal) : null;
  const already = !!(row && (row.already === true || row.already === 1));
  const msg = (row && row.Proc_MSG) || (raw && raw.error) || (raw && raw.message) || '';
  return { ok: rstVal === 200, rstVal, already, msg, raw };
}

/**
 * [giip #1252] csn 의 실제 언어 설정(tCorp.cLang) 조회 — giipdb SP pApiCorpLangGetbySk 호출.
 * 이 SP 는 giipprj/giipdb/SP/pApiCorpLangGetbySk.sql 에 이미 존재하지만(2025-12-26 신설, MQE AI
 * Advisor 용), **일반 bySk 검증(tSecretKey↔csn) 이 아니라 하드코딩된 단일 Admin SK 게이트**다
 * (`IF (@sk = 'ffd968...')` 외엔 전부 403). giip-fde-agent 는 각 채널의 테넌트 SK(account.sk)만
 * 갖고 있어 이 호출은 (admin SK 를 쓰지 않는 한) 403 으로 실패할 가능성이 높다 — 그래도 실패는
 * 정상 흐름으로 취급해 호출측이 조용히 project-lang.json/DEFAULT_LANG 으로 폴백하게 한다(장애 유발 금지).
 * 후속 조치(giipdb 쪽): SP 를 호출자 자신의 csn 범위로 tSecretKey 검증하도록 완화하거나, 이 봇 전용
 * admin SK 를 안전하게 프로비저닝해야 실제로 200 을 받을 수 있다(이번 PR 범위 밖).
 *
 * 디스패처 규약: pApiCorpLangGetbySk 는 이름에 "Get" 이 포함돼 giipApiSk2/run.ps1 의 jsondata
 * 자동첨부(ISN 161)가 스킵된다 — 그래서 csn 은 jsondata 가 아니라 text 뒤에 숫자 리터럴로 직접
 * 붙여 보낸다(`CorpLangGet <csn>` → `exec pApiCorpLangGetbySk '<sk>', <csn>`), apiCall 의 jsondata
 * 인자는 쓰지 않는다.
 * @returns {{ ok:boolean, cLang:string|null, rstVal:number|null, raw:any }}
 */
async function corpLangGet(account, csn) {
  const n = Number(csn);
  if (!Number.isInteger(n)) throw new Error('csn 은 정수여야 합니다.');
  const raw = await apiCall(account, `CorpLangGet ${n}`);
  const row = raw && Array.isArray(raw.data) ? raw.data[0] : null;
  const rstVal = row && row.RstVal != null ? Number(row.RstVal) : null;
  const cLang = rstVal === 200 && row && row.cLang ? String(row.cLang) : null;
  return { ok: rstVal === 200, cLang, rstVal, raw };
}

/** 범용: 임의 giip API 를 giipApi 디스패처로 호출(text=Verb). */
async function apiCall(account, verb, jsondata = null) {
  const base = account.apiBase || accounts.apiBase();
  // SK 기반 디스패처(giipApiSk2). SK 를 x-api-key + token 으로 직접 인증(AK 도출 안 함).
  const params = { text: verb, token: account.sk, usertoken: account.sk };
  if (jsondata) params.jsondata = typeof jsondata === 'string' ? jsondata : JSON.stringify(jsondata);
  const res = await request('POST', `${base}/giipApiSk2`, {
    headers: { 'x-api-key': account.sk, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });
  return res.body;
}

module.exports = {
  getAK,
  actorTag,
  issueGet,
  issueList,
  issueCreate,
  issueUpdate,
  issueComment,
  issueComments,
  apiCall,
  grantBotCsn,
  corpLangGet,
  _akCache: akCache,
};
