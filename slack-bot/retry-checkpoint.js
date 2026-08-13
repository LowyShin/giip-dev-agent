/**
 * retry-checkpoint.js — 재시도 시 전체 재실행 방지 (giip-1063, 3.5)
 *
 * 기존: MiniMax 가 실패하면 같은 executionPrompt 전체를 Claude 에 그대로 다시 보내고
 *       태스크를 처음부터 실행 → 이미 끝낸 파일 수정을 다음 모델이 다시 전면 작성.
 *
 * 여기서: 시도마다 진행 상태를 `.agent/runtime/checkpoints/<task-id>.json` 에 남기고,
 *       재시도 프롬프트에는 "원문 전체" 대신 태스크 사양 + 선택 컨텍스트 + checkpoint 요약만
 *       실어 이어서 재개시킨다.
 *
 * 안전: checkpoint 에 API key / Slack token / 인증정보를 저장하지 않는다(secret-mask 통과).
 *       런타임 디렉터리는 .gitignore 대상.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { maskDeep, maskString } = require('./secret-mask');
const modelConfig = require('./model-config');

const RUNTIME_SUBDIR = path.join('.agent', 'runtime', 'checkpoints');

function checkpointDir(baseDir) {
  return path.join(baseDir, RUNTIME_SUBDIR);
}

function checkpointPath(baseDir, taskId) {
  const safe = String(taskId).replace(/[^\w.\-]/g, '_');
  return path.join(checkpointDir(baseDir), `${safe}.json`);
}

function ensureDir(baseDir) {
  try { fs.mkdirSync(checkpointDir(baseDir), { recursive: true }); } catch {}
}

// ── 오류 분류 ────────────────────────────────────────────────────────────────
const ERROR_TYPES = ['usage_limit', 'auth', 'timeout', 'provider_error', 'not_started', 'unknown'];

/** CLI 출력에서 오류 종류를 추정한다. 재시도 정책 분기(3.5)에 쓴다. */
function classifyError(output) {
  const t = String(output || '');
  if (/\b429\b|rate limit|quota|usage limit|weekly limit|insufficient balance|insufficient.{0,10}credit|too many requests/i.test(t)) return 'usage_limit';
  if (/unauthorized|401|invalid api key|authentication|not logged in|auth.*(expired|failed)/i.test(t)) return 'auth';
  if (/etimedout|timed? ?out|deadline exceeded/i.test(t)) return 'timeout';
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|overloaded/i.test(t)) return 'provider_error';
  return 'unknown';
}

// ── 작업 트리 상태 ───────────────────────────────────────────────────────────
/** 현재 브랜치에서 실제로 바뀐 파일 목록(재개 판단 근거). 실패해도 빈 배열. */
function changedFiles(cwd) {
  try {
    const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return [];
    return (r.stdout || '')
      .split(/\r?\n/)
      .map(l => l.slice(3).trim())
      .filter(Boolean)
      .slice(0, 200);
  } catch { return []; }
}

/** diff --stat 요약(길이 제한). 재개 프롬프트에 넣어 "이미 한 일"을 알린다. */
function diffSummary(cwd, maxChars = 2000) {
  try {
    const r = spawnSync('git', ['diff', '--stat', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return '';
    return maskString((r.stdout || '').trim()).slice(0, maxChars);
  } catch { return ''; }
}

// ── 저장 / 로드 ──────────────────────────────────────────────────────────────
function emptyCheckpoint(taskId) {
  return {
    task_id: taskId,
    attempt: 0,
    provider: null,
    model: null,
    started_at: null,
    updated_at: null,
    completed_steps: [],
    files_read: [],
    files_changed: [],
    commands_run: [],
    test_results: [],
    error_type: null,
    error_summary: null,
    resume_instruction: null,
    history: [],
  };
}

function load(baseDir, taskId) {
  try {
    const raw = fs.readFileSync(checkpointPath(baseDir, taskId), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyCheckpoint(taskId), ...parsed, task_id: taskId };
  } catch { return null; }
}

/** patch 를 병합해 저장. 비밀값은 저장 전에 마스킹한다. */
function save(baseDir, taskId, patch = {}) {
  ensureDir(baseDir);
  const cur = load(baseDir, taskId) || emptyCheckpoint(taskId);
  const next = maskDeep({
    ...cur,
    ...patch,
    task_id: taskId,
    updated_at: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(checkpointPath(baseDir, taskId), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('[checkpoint] 저장 실패:', e.message);
  }
  return next;
}

/** 시도 시작 기록. */
function beginAttempt(baseDir, taskId, { attempt, provider, model, taskClass = null }) {
  const cur = load(baseDir, taskId) || emptyCheckpoint(taskId);
  const history = (cur.history || []).concat([{
    attempt, provider, model, task_class: taskClass, started_at: new Date().toISOString(),
  }]).slice(-10);
  return save(baseDir, taskId, {
    attempt,
    provider,
    model,
    task_class: taskClass,
    started_at: cur.started_at || new Date().toISOString(),
    error_type: null,
    error_summary: null,
    history,
  });
}

/** 시도 실패 기록 + 작업 트리 상태 스냅샷 + 재개 지시문 생성. */
function recordFailure(baseDir, taskId, { attempt, provider, model, output, cwd }) {
  const errorType = classifyError(output);
  const files = changedFiles(cwd || baseDir);
  const summary = maskString(String(output || '').trim()).slice(-1500);
  const cp = save(baseDir, taskId, {
    attempt,
    provider,
    model,
    files_changed: files,
    error_type: errorType,
    error_summary: summary,
    diff_stat: diffSummary(cwd || baseDir),
  });
  return save(baseDir, taskId, { resume_instruction: buildResumeInstruction(cp) });
}

/** 시도 성공 기록(다음 실행이 "완료된 단계"를 알 수 있도록). */
function recordSuccess(baseDir, taskId, { attempt, provider, model, cwd, steps = [] }) {
  return save(baseDir, taskId, {
    attempt,
    provider,
    model,
    completed_steps: steps,
    files_changed: changedFiles(cwd || baseDir),
    error_type: null,
    error_summary: null,
    resume_instruction: null,
    finished_at: new Date().toISOString(),
  });
}

function clear(baseDir, taskId) {
  try { fs.rmSync(checkpointPath(baseDir, taskId), { force: true }); } catch {}
}

// ── 재개 프롬프트 ────────────────────────────────────────────────────────────
const RESUME_HEADER = [
  '기존 작업 트리의 변경 사항은 이전 시도의 작업 결과다.',
  '먼저 diff와 checkpoint를 확인하고 완료된 작업을 반복하지 마라.',
  '미완료 단계부터 계속하라.',
].join('\n');

/**
 * checkpoint 로 재개 지시문을 만든다. 전체 원문을 다시 싣지 않는 것이 핵심.
 * 작업 시작 전 실패(파일 변경 0, error_type=not_started/usage_limit + 변경 없음)면 재개 지시 없이
 * 동일 프롬프트를 재사용해도 되므로 null 을 돌려준다.
 */
function buildResumeInstruction(cp) {
  if (!cp) return null;
  const changed = cp.files_changed || [];
  const steps = cp.completed_steps || [];
  const nothingDone = changed.length === 0 && steps.length === 0;
  if (nothingDone) return null;   // 작업 시작 전 실패 → 동일 프롬프트 재사용 가능

  const lines = [RESUME_HEADER, ''];
  lines.push(`이전 시도: attempt=${cp.attempt}, provider=${cp.provider || '?'}, model=${cp.model || '?'}, 실패 유형=${cp.error_type || 'unknown'}`);
  if (steps.length) lines.push(`완료된 단계: ${steps.slice(0, 20).join(' / ')}`);
  if (changed.length) {
    lines.push(`이미 변경된 파일(${changed.length}건):`);
    lines.push(changed.slice(0, 40).map(f => `  - ${f}`).join('\n'));
  }
  if (cp.diff_stat) lines.push(`\ngit diff --stat:\n${cp.diff_stat}`);
  if ((cp.test_results || []).length) {
    lines.push(`\n이전 검증 결과: ${cp.test_results.slice(0, 10).map(t => (typeof t === 'string' ? t : JSON.stringify(t))).join(' / ')}`);
    lines.push('테스트 단계에서 실패했다면 구현을 처음부터 다시 하지 말고 실패한 검증 단계부터 재개하라.');
  }
  if (cp.error_summary) lines.push(`\n이전 오류 요약(마스킹됨):\n${String(cp.error_summary).slice(-800)}`);
  return lines.join('\n');
}

// ── 재시도 상한 ──────────────────────────────────────────────────────────────
/**
 * 재시도 가능 여부. 무한 재시도 금지(3.5).
 * @param {{totalAttempts:number, providerAttempts:object}} state
 * @param {string} provider 다음에 시도할 공급자
 */
function canRetry(state, provider) {
  const { maxProviderRetries, maxTotalAttempts } = modelConfig.retryLimits();
  const total = Number(state && state.totalAttempts) || 0;
  const perProvider = Number(((state && state.providerAttempts) || {})[provider]) || 0;
  if (total >= maxTotalAttempts) return { ok: false, reason: `전체 최대 시도 ${maxTotalAttempts}회 초과` };
  // maxProviderRetries = "재시도" 횟수 → 첫 시도 포함 허용 횟수는 +1
  if (perProvider >= maxProviderRetries + 1) return { ok: false, reason: `${provider} 최대 재시도 ${maxProviderRetries}회 초과` };
  return { ok: true, reason: null };
}

function noteAttempt(state, provider) {
  state.totalAttempts = (Number(state.totalAttempts) || 0) + 1;
  state.providerAttempts = state.providerAttempts || {};
  state.providerAttempts[provider] = (Number(state.providerAttempts[provider]) || 0) + 1;
  return state;
}

module.exports = {
  ERROR_TYPES,
  RESUME_HEADER,
  RUNTIME_SUBDIR,
  checkpointDir,
  checkpointPath,
  classifyError,
  changedFiles,
  diffSummary,
  load,
  save,
  clear,
  beginAttempt,
  recordFailure,
  recordSuccess,
  buildResumeInstruction,
  canRetry,
  noteAttempt,
  emptyCheckpoint,
};
