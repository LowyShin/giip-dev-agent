/**
 * progress-events.js — 실행 중 진행 상황을 구조화해 남긴다 (giip-1068, 5)
 *
 * 1차 작업(giip-1063)의 남은 문제
 *   checkpoint 의 `completed_steps` / `files_read` / `commands_run` / `test_results` 가 항상 빈 배열이었다.
 *   실행 중에 아무도 채우지 않았기 때문이다. 그래서 fallback 재개 프롬프트가 "이미 한 일"을 알 수 없었다.
 *
 * 여기서
 *   실행 중인 모델이 전용 CLI(`tools/progress-event.js`)로 이벤트를 남기고,
 *   `retry-checkpoint.recordFailure()` 가 그 이벤트를 읽어 checkpoint 를 채운다.
 *
 * 저장 위치: `<runtimeRoot>/progress/<task-id>.jsonl` (JSON Lines)
 * 안전: 기록 전 secret-mask 를 통과시킨다. 절대경로는 마스킹된 상대경로로 바꾼다.
 */

const fs = require('fs');
const path = require('path');

const { maskString, maskDeep } = require('./secret-mask');
const runtimePaths = require('./runtime-paths');

// ── 5.2 허용 이벤트 종류 (이 8종만) ──────────────────────────────────────────
const EVENT_TYPES = [
  'step_started',
  'step_completed',
  'file_read',
  'file_changed',
  'command_run',
  'test_result',
  'decision',
  'blocked',
];

// 정리(pruning) 대상에서 제외되는 종류 — 재개 판단의 근거라 지우지 않는다(5.4).
const PROTECTED_TYPES = new Set(['step_completed', 'file_changed', 'test_result', 'blocked']);

// ── 5.4 길이 제한 ────────────────────────────────────────────────────────────
const LIMITS = {
  summary: 500,
  path: 500,
  step_id: 200,
  command: 1000,
  output: 2000,
  result: 2000,
  status: 40,
  maxEvents: 500,
  maxBytes: 1024 * 1024,   // 1MB
};

function eventPath(baseDir, taskId) {
  return path.join(runtimePaths.progressDir(baseDir), `${runtimePaths.safeTaskId(taskId)}.jsonl`);
}

function clip(value, max) {
  if (value === undefined || value === null) return undefined;
  const s = maskString(String(value));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 절대경로를 로그에 남기지 않는다(7.2). baseDir 하위면 상대경로, 아니면 마스킹.
 */
function normalizePath(p, baseDir) {
  if (!p) return undefined;
  const raw = String(p);
  if (path.isAbsolute(raw)) {
    if (baseDir) {
      const rel = path.relative(baseDir, raw);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
    }
    return runtimePaths.maskWorkDir(raw);
  }
  return raw.replace(/\\/g, '/');
}

/**
 * 이벤트를 검증·정규화한다. 허용되지 않는 종류면 null 을 돌려준다(호출측이 경고 로그).
 * @returns {object|null}
 */
function normalizeEvent(event = {}, taskId = null, baseDir = null) {
  const type = String(event.type || '').trim();
  if (!EVENT_TYPES.includes(type)) return null;

  const out = {
    timestamp: event.timestamp && !Number.isNaN(Date.parse(event.timestamp))
      ? new Date(event.timestamp).toISOString()
      : new Date().toISOString(),
    task_id: String(event.task_id || taskId || 'unknown'),
    attempt: Number.isFinite(Number(event.attempt)) ? Number(event.attempt) : 1,
    type,
  };
  const add = (k, v) => { if (v !== undefined && v !== '') out[k] = v; };
  add('step_id', clip(event.step_id, LIMITS.step_id));
  add('path', clip(normalizePath(event.path, baseDir), LIMITS.path));
  add('summary', clip(event.summary, LIMITS.summary));
  add('status', clip(event.status, LIMITS.status));
  add('command', clip(event.command, LIMITS.command));
  add('output', clip(event.output, LIMITS.output));
  add('result', clip(event.result, LIMITS.result));

  return maskDeep(out);
}

/** JSONL 한 줄씩 파싱. 깨진 줄은 건너뛴다. */
function parseLines(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && EVENT_TYPES.includes(o.type)) out.push(o);
    } catch { /* 깨진 줄 무시 */ }
  }
  return out;
}

/** 저장된 진행 이벤트 전부. 파일이 없으면 빈 배열. */
function readProgressEvents(baseDir, taskId) {
  try { return parseLines(fs.readFileSync(eventPath(baseDir, taskId), 'utf8')); }
  catch { return []; }
}

/**
 * 5.4 정리 규칙: 500개 또는 1MB 초과 시 "오래된 중복 file_read" 부터 지운다.
 * step_completed / file_changed / test_result / blocked 는 절대 지우지 않는다.
 */
function pruneEvents(events) {
  let list = events.slice();
  const overflow = () =>
    list.length > LIMITS.maxEvents
    || Buffer.byteLength(list.map(e => JSON.stringify(e)).join('\n'), 'utf8') > LIMITS.maxBytes;

  if (!overflow()) return { events: list, removed: 0 };

  let removed = 0;

  // 1) 오래된 중복 file_read 부터 (같은 경로가 여러 번 기록된 것 중 마지막만 남긴다)
  const isDupRead = () => {
    const last = new Map();
    list.forEach((e, i) => { if (e.type === 'file_read' && e.path) last.set(e.path, i); });
    return (e, i) => e.type === 'file_read' && e.path && last.get(e.path) !== i;
  };
  while (overflow()) {
    const dup = isDupRead();
    const i = list.findIndex((e, idx) => dup(e, idx));
    if (i < 0) break;
    list.splice(i, 1);
    removed += 1;
  }

  // 2) 그래도 넘치면 보호 대상이 아닌 이벤트를 종류 우선순위대로, 오래된 것부터
  for (const type of ['file_read', 'step_started', 'decision', 'command_run']) {
    if (PROTECTED_TYPES.has(type)) continue;
    while (overflow()) {
      const i = list.findIndex(e => e.type === type);
      if (i < 0) break;
      list.splice(i, 1);
      removed += 1;
    }
    if (!overflow()) break;
  }

  // 3) 최후: 보호 대상만 남았는데도 개수 상한을 넘으면 가장 오래된 것부터
  while (list.length > LIMITS.maxEvents) { list.shift(); removed += 1; }

  return { events: list, removed };
}

function writeAll(baseDir, taskId, events) {
  const p = eventPath(baseDir, taskId);
  runtimePaths.ensureDir(path.dirname(p));
  fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
}

/**
 * 진행 이벤트 한 건 추가.
 * @returns {{ok:boolean, event:object|null, reason:string|null, pruned:number}}
 */
function appendProgressEvent(baseDir, taskId, event = {}) {
  const norm = normalizeEvent(event, taskId, baseDir);
  if (!norm) {
    const reason = `허용되지 않는 진행 이벤트 종류: ${JSON.stringify(String(event && event.type))}`;
    console.warn(`[progress-events] ${reason} — 기록하지 않음 (허용: ${EVENT_TYPES.join(', ')})`);
    return { ok: false, event: null, reason, pruned: 0 };
  }

  const p = eventPath(baseDir, taskId);
  if (!runtimePaths.ensureDir(path.dirname(p))) {
    return { ok: false, event: null, reason: '진행 이벤트 디렉터리 생성 실패', pruned: 0 };
  }

  try {
    const existing = readProgressEvents(baseDir, taskId);
    const { events, removed } = pruneEvents(existing.concat([norm]));
    if (removed > 0) writeAll(baseDir, taskId, events);
    else fs.appendFileSync(p, `${JSON.stringify(norm)}\n`, 'utf8');
    return { ok: true, event: norm, reason: null, pruned: removed };
  } catch (e) {
    console.error('[progress-events] 기록 실패:', e.message);
    return { ok: false, event: null, reason: e.message, pruned: 0 };
  }
}

function clearProgressEvents(baseDir, taskId) {
  try { fs.rmSync(eventPath(baseDir, taskId), { force: true }); return true; } catch { return false; }
}

// ── 5.6 checkpoint 채우기용 요약 ─────────────────────────────────────────────
/**
 * 이벤트 목록 → checkpoint 필드.
 * 중복 제거 + 정렬(step: 완료 시각순 / file: 최초 발생 순 / command·test: 실행 시각순) + 개수 상한.
 */
function summarizeProgressEvents(events = [], limits = null) {
  const lim = limits || require('./model-config').checkpointLimits();
  const byTime = events.slice().sort(
    (a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));

  const dedup = (arr) => {
    const seen = new Set();
    const out = [];
    for (const v of arr) {
      const key = typeof v === 'string' ? v : JSON.stringify(v);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  };

  const completedSteps = [];
  const startedSteps = [];
  const filesRead = [];
  const filesChanged = [];
  const commandsRun = [];
  const testResults = [];
  const decisions = [];
  const blocked = [];

  for (const e of byTime) {
    switch (e.type) {
      case 'step_completed':
        completedSteps.push(e.summary ? `${e.step_id || 'step'}: ${e.summary}` : (e.step_id || 'step'));
        break;
      case 'step_started':
        startedSteps.push(e.step_id || 'step');
        break;
      case 'file_read':
        if (e.path) filesRead.push(e.path);
        break;
      case 'file_changed':
        if (e.path) filesChanged.push(e.path);
        break;
      case 'command_run':
        commandsRun.push(e.command || e.summary || '(명령 미기재)');
        break;
      case 'test_result':
        testResults.push({
          command: e.command || null,
          status: e.status || 'unknown',
          summary: e.result || e.summary || '',
        });
        break;
      case 'decision':
        decisions.push(e.summary || '(판단 미기재)');
        break;
      case 'blocked':
        blocked.push(e.summary || '(막힘 사유 미기재)');
        break;
      default:
        break;
    }
  }

  const completed = dedup(completedSteps).slice(-lim.completed_steps);
  const completedIds = new Set(
    completed.map(s => String(s).split(':')[0].trim()));

  return {
    completed_steps: completed,
    // 시작했지만 완료 기록이 없는 단계 = 미완료 단계(재개 프롬프트의 "다음 할 일")
    pending_steps: dedup(startedSteps).filter(s => !completedIds.has(s)).slice(0, lim.completed_steps),
    files_read: dedup(filesRead).slice(0, lim.files_read),
    files_changed: dedup(filesChanged).slice(0, lim.files_changed),
    commands_run: dedup(commandsRun).slice(-lim.commands_run),
    test_results: dedup(testResults).slice(-lim.test_results),
    decisions: dedup(decisions).slice(-10),
    blocked: dedup(blocked).slice(-10),
    event_count: events.length,
  };
}

module.exports = {
  EVENT_TYPES,
  PROTECTED_TYPES,
  LIMITS,
  eventPath,
  appendProgressEvent,
  readProgressEvents,
  summarizeProgressEvents,
  clearProgressEvents,
  normalizeEvent,
  pruneEvents,
};
