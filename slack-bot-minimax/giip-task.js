/**
 * giip-task.js — task-manager 생명주기 ↔ giip issue 연동(얇은 훅, best-effort).
 * rule 40: 연결 시 giip issue 우선 등록, 미연결/실패 시 null → 로컬 타임스탬프 폴백.
 * 설계: docs/DESIGN_slackbot_giip_issue_integration.md §4.
 * 모든 함수는 절대 throw 하지 않는다(봇 무중단). 실패는 로그 + null/no-op.
 */
const os = require('os');
const accounts = require('./giip-accounts');
const giip = require('./giip-api');

/**
 * 이 배포가 giip 이슈 코멘트에 남길 행위자 이름표. 여러 사용자가 배포해 쓰는 범용 코드이므로
 * 하드코딩하지 않고 env 로 설정한다(예: 이 PC 배포는 GIIP_ACTOR_TAG=lowyclaude).
 * 미설정 시 host 기준 합리적 기본값으로 폴백 — 최소한 "어느 머신의 봇인지"는 항상 남는다.
 */
function actorTag() {
  return process.env.GIIP_ACTOR_TAG || `slack-bot@${os.hostname()}`;
}

/** 상태전이가 없는 note 코멘트에도 일관되게 행위자/시각 헤더를 붙인다. */
function buildNoteComment(comment) {
  const actor = actorTag();
  const when = new Date().toISOString();
  return [
    `**행위자(Actor)**: ${actor}`,
    `**시각(When)**: ${when}`,
    '',
    String(comment),
  ].join('\n');
}

/** 타임아웃/네트워크 등 일시적 오류인지 판단(1회 재시도 대상). 권한/데이터 오류는 재시도해도 무의미하므로 제외. */
function isRetryableIssueError(e) {
  const msg = String((e && e.message) || e || '');
  const code = e && e.code;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  return /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(msg);
}

/**
 * 태스크 생성(=분석) 시: 연결되어 있으면 issue 생성(PENDING) → isn. 아니면 null(로컬 폴백).
 * 상태는 PENDING 으로 만든다 — 분석만 끝났을 뿐 아직 실행 전(go 대기)이므로. IN_PROGRESS 전이는
 * 실제 실행 시작(handlers.startTaskExecution → maybeFinish(...,'IN_PROGRESS')) 시점에만 한다.
 *   (과거: 여기서 IN_PROGRESS 로 만들어 "아무것도 안 움직이는데 IN_PROGRESS·go 요구" 모순 발생)
 * csn: 프로젝트명 기준 csn(config.resolveProjectCsn). null 이면 issueCreate 가 account.csn 으로 폴백.
 * 반환: { isn, error }. acct 미연동(csn/계정 미설정)은 정상 경로라 error:null 로 조용히 로컬 폴백.
 * API 호출이 실제로 실패한 경우만 error 에 사유를 담아 호출측이 "미설정"과 "일시적 오류"를 구분해
 * 사용자에게 알릴 수 있게 한다(타임아웃 등 일시적 오류로 오인된 채 미설정처럼 보이던 문제 대응).
 * 일시적 오류(타임아웃/네트워크)는 1회만 재시도 후 그래도 실패하면 포기(무인 봇이 무한 대기하지 않도록).
 */
async function maybeCreateIssue(channelId, title, content, csn = null) {
  const acct = accounts.resolve(channelId);
  if (!acct) return { isn: null, error: null };
  const body = {
    title: (title || '(무제)').slice(0, 200),
    content: (content || title || '').slice(0, 8000),
    status: 'PENDING',
    csn,
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await giip.issueCreate(acct, body);
      return { isn: r && r.isn ? Number(r.isn) : null, error: null };
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && isRetryableIssueError(e)) {
        console.error(`[giip-task] issue 생성 실패(재시도 1회): ${e.message}`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      break;
    }
  }
  console.error('[giip-task] issue 생성 실패(로컬 폴백):', lastErr.message);
  return { isn: null, error: lastErr.message };
}

/**
 * 완료/에러/착수 시: 코멘트 + 상태전이(best-effort, 실패해도 무시).
 * [giip #1211] 상태전이 코멘트 자체는 이제 giip-api.js#issueUpdate 가 항상 남긴다(그래야
 * giip-commands.js 등 issueUpdate 를 직접 호출하는 다른 경로도 구조적으로 보장됨). 이 함수는
 * caller 가 준 comment 를 "사유(Why)"로 그대로 전달하기만 한다 — "comment=null 이면 코멘트
 * 자체를 스킵"하던 구버전 버그(giip #1155)는 issueUpdate 쪽에서 기본 사유로 채워지므로 재발하지
 * 않는다.
 */
async function maybeFinish(channelId, isn, status, comment) {
  if (!isn) return;
  const acct = accounts.resolve(channelId);
  if (!acct) return;
  if (status) {
    try {
      await giip.issueUpdate(acct, { isn, status }, {
        actor: actorTag(),
        reason: comment ? String(comment) : '(자동 전이, 상세 사유 미기재)',
      });
    } catch (e) { console.error('[giip-task] status 실패:', e.message); }
    return;
  }
  if (comment) {
    try { await giip.issueComment(acct, isn, buildNoteComment(comment)); }
    catch (e) { console.error('[giip-task] comment 실패:', e.message); }
  }
}

/**
 * 코멘트만 남긴다(상태 전이 없음, best-effort). 작업트리 점유 대기 관계 등
 * "상태는 그대로 두고 사실만 기록"하는 용도. 실패해도 봇 흐름을 막지 않는다.
 * 일관성을 위해 이 코멘트에도 행위자/시각 헤더를 붙인다.
 */
async function maybeComment(channelId, isn, comment) {
  if (!isn || !comment) return;
  const acct = accounts.resolve(channelId);
  if (!acct) return;
  try { await giip.issueComment(acct, isn, buildNoteComment(comment)); }
  catch (e) { console.error('[giip-task] comment(note) 실패:', e.message); }
}

/** 길이 제한(태스크 파일·프롬프트 폭주 방지). */
function clip(s, max) {
  const str = String(s == null ? '' : s);
  return str.length > max ? `${str.slice(0, max)}\n…(${str.length - max}자 생략)` : str;
}

/** 이슈 본문 + 코멘트 배열을 사람이·서브에이전트가 읽는 히스토리 다이제스트(마크다운)로 만든다. */
function formatIssueHistory(isn, issue, comments) {
  const title  = (issue && (issue.title  || issue.Title))  || '(제목 없음)';
  const status = (issue && (issue.status || issue.Status)) || '';
  const body   = (issue && (issue.content || issue.Content)) || '';
  const lines = [`### giip issue #${isn}${status ? ` [${status}]` : ''}: ${title}`];
  if (body) lines.push('', '**본문:**', clip(body, 4000));
  const list = Array.isArray(comments) ? comments : [];
  if (list.length) {
    lines.push('', `**코멘트 이력 (${list.length}건, 시간순):**`);
    list.forEach((c, i) => {
      const when = c.regdate  || c.Regdate  || '';
      const who  = c.author   || c.Author   || '?';
      const type = c.issuetype || c.Issuetype || '';
      lines.push('', `[${i + 1}] ${when} · ${who}${type ? ` · ${type}` : ''}`,
        clip(c.content || c.Content || '', 1500));
    });
  } else {
    lines.push('', '(코멘트 없음)');
  }
  return clip(lines.join('\n'), 12000); // 전체 상한(대량 코멘트 이슈 대비)
}

/**
 * giip issue 의 본문 + 모든 코멘트를 DB(SSOT)에서 가져와 히스토리 다이제스트를 만든다.
 * 로컬 태스크 파일이 done/ 으로 이동됐거나 타 클론에서 처리돼 없어도, 재처리 요청은
 * 코멘트 이력을 모두 읽고 맥락을 이어가야 하므로 DB 에서 전체를 복원한다.
 * best-effort: 계정 미연결/API 실패 시 null(호출자는 기존 폴백 유지).
 * 반환: { issue, comments, digest } | null
 */
async function fetchIssueHistory(channelId, isn) {
  if (!isn) return null;
  const acct = accounts.resolve(channelId);
  if (!acct) return null;
  let issue = null, comments = [];
  try { issue = await giip.issueGet(acct, isn); }
  catch (e) { console.error('[giip-task] issueGet(history) 실패:', e.message); }
  try { comments = await giip.issueComments(acct, isn); }
  catch (e) { console.error('[giip-task] issueComments(history) 실패:', e.message); }
  if (!issue && (!comments || comments.length === 0)) return null;
  return { issue, comments, digest: formatIssueHistory(isn, issue, comments) };
}

module.exports = { maybeCreateIssue, maybeFinish, maybeComment, fetchIssueHistory, formatIssueHistory };
