/**
 * retry-checkpoint.js — 재시도 시 전체 재실행 방지 (giip-1063 3.5 / giip-1068 3·6·7)
 *
 * 기존: MiniMax 가 실패하면 같은 executionPrompt 전체를 Claude 에 그대로 다시 보내고
 *       태스크를 처음부터 실행 → 이미 끝낸 파일 수정을 다음 모델이 다시 전면 작성.
 *
 * 여기서: 시도마다 진행 상태를 `<runtimeRoot>/checkpoints/<task-id>.json` 에 남기고,
 *       재시도 프롬프트에는 "원문 전체" 대신 태스크 요약 + 진행 상태 + 재개 컨텍스트만 싣는다.
 *
 * giip-1068 추가
 *   - `changedSourceFiles()`: 태스크/결과/런타임/봇상태 파일을 "실제 소스 변경"에서 제외한다.
 *   - `recordFailure()` 가 progress-events 를 읽어 completed_steps / files_read / commands_run /
 *     test_results 를 실제로 채운다(1차 작업에서는 항상 빈 배열이었다).
 *   - checkpoint 저장 위치를 runtime-paths.runtimeRoot() 로 통일한다(비용 로그와 같은 루트).
 *
 * 안전: checkpoint 에 API key / Slack token / 인증정보를 저장하지 않는다(secret-mask 통과).
 *       절대경로를 그대로 남기지 않는다(7.2). 런타임 디렉터리는 .gitignore 대상.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { maskDeep, maskString } = require('./secret-mask');
const modelConfig = require('./model-config');
const runtimePaths = require('./runtime-paths');
const progressEvents = require('./progress-events');

// 하위 호환용 상수(경로 문자열을 참조하는 테스트/스크립트가 있다).
const RUNTIME_SUBDIR = path.join('.agent', 'runtime', 'checkpoints');

function checkpointDir(baseDir) {
  return runtimePaths.checkpointsDir(baseDir);
}

function checkpointPath(baseDir, taskId) {
  return path.join(checkpointDir(baseDir), `${runtimePaths.safeTaskId(taskId)}.json`);
}

function ensureDir(baseDir) {
  runtimePaths.ensureDir(checkpointDir(baseDir));
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
/** 현재 브랜치에서 실제로 바뀐 파일 목록(원본 — 분류 전). 실패해도 빈 배열. */
function changedFiles(cwd) {
  try {
    const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return [];
    return (r.stdout || '')
      .split(/\r?\n/)
      .map(l => l.slice(3).trim())
      .filter(Boolean)
      .map(l => (l.includes(' -> ') ? l.split(' -> ').pop().trim() : l))   // rename 은 새 경로
      .map(l => l.replace(/^"|"$/g, ''))
      .filter(Boolean)
      .slice(0, 200);
  } catch { return []; }
}

// ── 6.3 실제 소스 변경에서 제외할 경로 ───────────────────────────────────────
/** 태스크 ID 와 무관하게 항상 런타임 산출물인 경로. */
const RUNTIME_PATTERNS = [
  /^\.agent\/runtime\//,
];

/** 봇 자신의 상태 파일(작업 결과가 아니다). */
const BOT_STATE_FILES = new Set([
  'slack-bot/tasklist.json',
  'slack-bot/.task-state.json',
  'slack-bot/.conversations.json',
  'slack-bot/.bot-threads.json',
  'slack-bot/claude-accounts.json',
  'slack-bot/minimax-accounts.json',
]);

function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }

/**
 * 실제 소스 변경 파일 판정(6.2).
 *
 * @param {string} cwd     git 저장소 경로
 * @param {string} taskId  현재 태스크 ID
 * @param {object} [options] { files: string[] } — git 호출 대신 목록을 직접 주입(테스트용)
 * @returns {{sourceFiles:string[], metadataFiles:string[], runtimeFiles:string[],
 *            reportFiles:string[], botStateFiles:string[], anomalies:string[],
 *            totalSourceChanges:number}}
 */
function changedSourceFiles(cwd, taskId, options = {}) {
  const all = (options.files || changedFiles(cwd || '.')).map(norm).filter(Boolean);
  const id = runtimePaths.safeTaskId(taskId);
  const rawId = String(taskId || '').replace(/\\/g, '/');

  const sourceFiles = [];
  const metadataFiles = [];
  const runtimeFiles = [];
  const reportFiles = [];
  const botStateFiles = [];
  const anomalies = [];

  const isCurrentTask = (base) => base === `${id}.md` || (rawId && base === `${rawId}.md`);

  for (const f of all) {
    if (RUNTIME_PATTERNS.some(re => re.test(f))) { runtimeFiles.push(f); continue; }
    if (BOT_STATE_FILES.has(f)) { botStateFiles.push(f); continue; }

    const taskMatch = f.match(/^\.agent\/tasks\/(?:done\/)?(.+\.md)$/);
    if (taskMatch) {
      if (isCurrentTask(taskMatch[1])) metadataFiles.push(f);
      else { metadataFiles.push(f); anomalies.push(`다른 태스크 파일이 변경됨: ${f}`); }
      continue;
    }

    const resultMatch = f.match(/^\.agent\/results\/(.+\.md)$/);
    if (resultMatch) {
      reportFiles.push(f);
      if (!isCurrentTask(resultMatch[1])) anomalies.push(`다른 태스크의 결과 보고서가 변경됨: ${f}`);
      continue;
    }

    // 6.4: 위 제외 경로가 아닌 모든 변경(수정/생성/삭제/rename/nested repo)은 실제 소스 변경.
    sourceFiles.push(f);
  }

  return {
    sourceFiles,
    metadataFiles,
    runtimeFiles,
    reportFiles,
    botStateFiles,
    anomalies,
    totalSourceChanges: sourceFiles.length,
  };
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
    project_name: null,
    work_dir: null,
    started_at: null,
    updated_at: null,
    completed_steps: [],
    pending_steps: [],
    files_read: [],
    files_changed: [],
    metadata_files_changed: [],
    commands_run: [],
    test_results: [],
    progress_event_count: 0,
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
function beginAttempt(baseDir, taskId, { attempt, provider, model, taskClass = null, workDir = null }) {
  const cur = load(baseDir, taskId) || emptyCheckpoint(taskId);
  const history = (cur.history || []).concat([{
    attempt, provider, model, task_class: taskClass, started_at: new Date().toISOString(),
  }]).slice(-10);
  const dir = workDir || baseDir;
  return save(baseDir, taskId, {
    attempt,
    provider,
    model,
    task_class: taskClass,
    // 7.2: 프로젝트 구분은 폴더가 아니라 checkpoint 안에 남기고, 절대경로는 저장하지 않는다.
    project_name: dir ? path.basename(dir) : null,
    work_dir: runtimePaths.maskWorkDir(dir),
    started_at: cur.started_at || new Date().toISOString(),
    error_type: null,
    error_summary: null,
    history,
  });
}

/**
 * 시도 실패 기록 + 진행 이벤트 반영 + 작업 트리 상태 스냅샷 + 재개 지시문 생성.
 *
 * giip-1068: `files_changed` 는 실제 소스 변경 파일만 담는다. 태스크/결과/런타임 파일은
 * `metadata_files_changed` 로 분리해 "작업이 진행됐다"는 오판을 막는다(6.1).
 */
function recordFailure(baseDir, taskId, { attempt, provider, model, output, cwd, taskClass = null }) {
  const errorType = classifyError(output);
  const workDir = cwd || baseDir;
  const changed = changedSourceFiles(workDir, taskId);
  const summary = maskString(String(output || '').trim()).slice(-1500);

  // 5.6: 진행 이벤트를 읽어 checkpoint 를 실제로 채운다.
  const events = progressEvents.readProgressEvents(baseDir, taskId);
  const prog = progressEvents.summarizeProgressEvents(events, modelConfig.checkpointLimits());
  const lim = modelConfig.checkpointLimits();

  // 진행 이벤트의 file_changed 와 git 이 본 소스 변경을 합친다(둘 다 근거).
  const filesChanged = Array.from(new Set(prog.files_changed.concat(changed.sourceFiles)))
    .slice(0, lim.files_changed);

  const cp = save(baseDir, taskId, {
    attempt,
    provider,
    model,
    task_class: taskClass || (load(baseDir, taskId) || {}).task_class || null,
    project_name: path.basename(workDir),
    work_dir: runtimePaths.maskWorkDir(workDir),
    completed_steps: prog.completed_steps,
    pending_steps: prog.pending_steps,
    files_read: prog.files_read,
    files_changed: filesChanged,
    metadata_files_changed: changed.metadataFiles.concat(changed.reportFiles).slice(0, 50),
    runtime_files_changed: changed.runtimeFiles.slice(0, 50),
    commands_run: prog.commands_run,
    test_results: prog.test_results,
    decisions: prog.decisions,
    blocked: prog.blocked,
    progress_event_count: events.length,
    changed_file_anomalies: changed.anomalies,
    error_type: errorType,
    error_summary: summary,
    diff_stat: diffSummary(workDir),
  });
  return save(baseDir, taskId, { resume_instruction: buildResumeInstruction(cp) });
}

/** 시도 성공 기록(다음 실행이 "완료된 단계"를 알 수 있도록). */
function recordSuccess(baseDir, taskId, { attempt, provider, model, cwd, steps = [] }) {
  const workDir = cwd || baseDir;
  const events = progressEvents.readProgressEvents(baseDir, taskId);
  const prog = progressEvents.summarizeProgressEvents(events, modelConfig.checkpointLimits());
  const changed = changedSourceFiles(workDir, taskId);
  return save(baseDir, taskId, {
    attempt,
    provider,
    model,
    completed_steps: steps.length ? steps : prog.completed_steps,
    files_read: prog.files_read,
    files_changed: Array.from(new Set(prog.files_changed.concat(changed.sourceFiles))),
    metadata_files_changed: changed.metadataFiles.concat(changed.reportFiles),
    commands_run: prog.commands_run,
    test_results: prog.test_results,
    progress_event_count: events.length,
    error_type: null,
    error_summary: null,
    resume_instruction: null,
    finished_at: new Date().toISOString(),
  });
}

function clear(baseDir, taskId) {
  try { fs.rmSync(checkpointPath(baseDir, taskId), { force: true }); } catch {}
}

// ── 재개 여부 판정 (4.6 / 6.5) ───────────────────────────────────────────────
/**
 * checkpoint 로 "실제 작업이 있었는지" 판정한다.
 *
 *   hasRealWork = sourceFiles>0 || completedSteps>0 || commandsRun>0 || testResults>0
 *
 * false 면 최초 프롬프트 재사용을 허용하고, true 면 반드시 resume prompt 를 쓴다.
 */
function hasRealWork(cp) {
  if (!cp) return false;
  return (cp.files_changed || []).length > 0
      || (cp.completed_steps || []).length > 0
      || (cp.commands_run || []).length > 0
      || (cp.test_results || []).length > 0;
}

/**
 * resume prompt 를 써야 하는가(4.6).
 * @param {{exitCode:number, checkpoint:object, checkpointSaved:boolean}} p
 */
function shouldResume({ exitCode = 1, checkpoint: cp = null, checkpointSaved = true } = {}) {
  if (Number(exitCode) === 0) return { resume: false, reason: '실패가 아님' };
  if (!cp || !checkpointSaved) return { resume: false, reason: 'checkpoint 저장 전 실패 — 최초 프롬프트 재사용' };
  const real = hasRealWork(cp);
  if (!real) return { resume: false, reason: '실제 작업 흔적 없음(소스 변경/완료 단계/명령/테스트 모두 0) — 최초 프롬프트 재사용' };
  const src = (cp.files_changed || []).length;
  return {
    resume: true,
    reason: `실제 진행 있음(소스 변경 ${src}건 / 완료 단계 ${(cp.completed_steps || []).length}건) — 재개 프롬프트 사용`,
  };
}

// ── 재개 지시문 (프롬프트 조각) ──────────────────────────────────────────────
const RESUME_HEADER = [
  '기존 작업 트리의 변경 사항은 이전 시도의 작업 결과다.',
  '먼저 diff와 checkpoint를 확인하고 완료된 작업을 반복하지 마라.',
  '미완료 단계부터 계속하라.',
].join('\n');

/**
 * checkpoint 로 재개 지시문을 만든다. 전체 원문을 다시 싣지 않는 것이 핵심.
 * 실제 작업 흔적이 없으면(hasRealWork=false) null 을 돌려준다 → 동일 프롬프트 재사용.
 */
function buildResumeInstruction(cp) {
  if (!cp) return null;
  if (!hasRealWork(cp)) return null;

  const changed = cp.files_changed || [];
  const steps = cp.completed_steps || [];
  const lines = [RESUME_HEADER, ''];
  lines.push(`이전 시도: attempt=${cp.attempt}, provider=${cp.provider || '?'}, model=${cp.model || '?'}, 실패 유형=${cp.error_type || 'unknown'}`);
  if (steps.length) lines.push(`완료된 단계: ${steps.slice(0, 20).join(' / ')}`);
  if ((cp.pending_steps || []).length) lines.push(`미완료 단계: ${cp.pending_steps.slice(0, 20).join(' / ')}`);
  if (changed.length) {
    lines.push(`이미 변경된 파일(${changed.length}건):`);
    lines.push(changed.slice(0, 40).map(f => `  - ${f}`).join('\n'));
  }
  if ((cp.files_read || []).length) {
    lines.push(`이미 읽은 파일: ${cp.files_read.slice(0, 20).join(', ')}`);
  }
  if ((cp.commands_run || []).length) {
    lines.push(`실행한 명령: ${cp.commands_run.slice(0, 10).join(' / ')}`);
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
  BOT_STATE_FILES,
  checkpointDir,
  checkpointPath,
  classifyError,
  changedFiles,
  changedSourceFiles,
  diffSummary,
  load,
  save,
  clear,
  beginAttempt,
  recordFailure,
  recordSuccess,
  buildResumeInstruction,
  hasRealWork,
  shouldResume,
  canRetry,
  noteAttempt,
  emptyCheckpoint,
};
