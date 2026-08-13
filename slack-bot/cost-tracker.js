/**
 * cost-tracker.js — 모델 호출별 토큰/비용/재시도/컨텍스트 계측 (giip-1063, 3.9)
 *
 * 저장 위치: `.agent/runtime/cost-usage.jsonl` (JSON Lines, .gitignore 대상)
 *
 * 측정 원칙
 *  - CLI 가 토큰 사용량을 알려주면 실제값을 쓰고 estimated:false
 *  - 안 알려주면 문자 수 기반 추정치 + estimated:true
 *  - 가격이 설정돼 있지 않은 모델은 비용을 지어내지 않고 estimated_cost_usd:null (토큰만 기록)
 *  - 기록 전 secret 마스킹
 */

const fs = require('fs');
const path = require('path');

const modelConfig = require('./model-config');
const { maskDeep } = require('./secret-mask');

const RUNTIME_SUBDIR = path.join('.agent', 'runtime');
const LOG_BASENAME = 'cost-usage.jsonl';

function logPath(baseDir) {
  return path.join(baseDir, RUNTIME_SUBDIR, LOG_BASENAME);
}

/**
 * 문자 수 → 토큰 추정. 정확한 tokenizer 가 없으므로 보수적 근사(≈4 chars/token)를 쓰고,
 * 반드시 estimated:true 로 표시한다.
 */
function estimateTokensFromChars(chars) {
  const n = Number(chars) || 0;
  return Math.ceil(n / 4);
}

/**
 * claude CLI stdout/stderr 에서 토큰 사용량을 best-effort 로 파싱한다.
 * 현재 `claude -p` 기본 출력은 사용량을 싣지 않으므로 대부분 null 이 나오고,
 * 그때는 호출측이 문자 수 추정으로 대체한다(estimated:true).
 */
function parseUsageFromOutput(output) {
  const text = String(output || '');
  // 1) JSON usage 블록 (--output-format json 등)
  const j = text.match(/"usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)[^}]*"output_tokens"\s*:\s*(\d+)/);
  if (j) return { input_tokens: Number(j[1]), output_tokens: Number(j[2]), estimated: false };
  // 2) 사람이 읽는 형태 "Input tokens: 1234 / Output tokens: 567"
  const i = text.match(/input[_ ]tokens?\s*[:=]\s*(\d+)/i);
  const o = text.match(/output[_ ]tokens?\s*[:=]\s*(\d+)/i);
  if (i && o) return { input_tokens: Number(i[1]), output_tokens: Number(o[1]), estimated: false };
  return null;
}

/**
 * 한 건의 모델 호출을 기록한다.
 *
 * @param {string} baseDir 기록할 저장소 루트
 * @param {object} entry
 *   { task_id, phase, task_class, provider, model, attempt,
 *     input_chars, output_chars, input_tokens, output_tokens, estimated,
 *     context_chars, context_files, skills_loaded, cache_hit, duration_ms,
 *     status, fallback_from, batch_size, model_calls_saved, fast_path,
 *     prompt_version, context_selection }
 * @returns {object|null} 기록된 엔트리(마스킹 후)
 */
function record(baseDir, entry = {}) {
  const inputTokens = Number.isFinite(entry.input_tokens)
    ? entry.input_tokens
    : estimateTokensFromChars(entry.input_chars);
  const outputTokens = Number.isFinite(entry.output_tokens)
    ? entry.output_tokens
    : estimateTokensFromChars(entry.output_chars);
  const estimated = entry.estimated !== undefined
    ? !!entry.estimated
    : !(Number.isFinite(entry.input_tokens) && Number.isFinite(entry.output_tokens));

  const priced = modelConfig.estimateCostUsd(entry.model, inputTokens, outputTokens);

  const row = maskDeep({
    timestamp: new Date().toISOString(),
    task_id: entry.task_id || null,
    phase: entry.phase || null,
    task_class: entry.task_class || null,
    provider: entry.provider || null,
    model: entry.model || null,
    attempt: Number(entry.attempt) || 1,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated,
    context_chars: Number(entry.context_chars) || 0,
    context_files: Number(entry.context_files) || 0,
    skills_loaded: Number(entry.skills_loaded) || 0,
    cache_hit: entry.cache_hit === undefined ? null : entry.cache_hit,
    duration_ms: Number(entry.duration_ms) || 0,
    status: entry.status || 'unknown',
    fallback_from: entry.fallback_from || null,
    estimated_cost_usd: priced.cost,
    price_as_of: priced.as_of,
    price_source: priced.source,
    prompt_version: entry.prompt_version || null,
    fast_path: entry.fast_path === undefined ? null : !!entry.fast_path,
    batch_size: entry.batch_size === undefined ? null : Number(entry.batch_size),
    model_calls_saved: entry.model_calls_saved === undefined ? null : Number(entry.model_calls_saved),
    context_selection: entry.context_selection || null,   // [{path, reason}] — 선택 이유(3.7-7)
    // checkpoint 로 "이어서" 재개한 시도인지. false 인 재시도는 작업을 처음부터 다시 한 것.
    resumed: entry.resumed === undefined ? null : !!entry.resumed,
  });

  try {
    fs.mkdirSync(path.join(baseDir, RUNTIME_SUBDIR), { recursive: true });
    fs.appendFileSync(logPath(baseDir), `${JSON.stringify(row)}\n`, 'utf8');
  } catch (e) {
    console.error('[cost-tracker] 기록 실패:', e.message);
    return null;
  }
  return row;
}

/** JSONL 을 읽어 배열로. 깨진 줄은 건너뛴다. */
function readAll(baseDir) {
  let raw;
  try { raw = fs.readFileSync(logPath(baseDir), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

/**
 * 집계. `!cost`, `!cost today`, `!cost task <id>`, `!cost models` 의 공통 백엔드.
 * @param {object} [opts] { since:Date|string, taskId:string }
 */
function summarize(baseDir, opts = {}) {
  let rows = readAll(baseDir);
  if (opts.since) {
    const since = new Date(opts.since).getTime();
    rows = rows.filter(r => new Date(r.timestamp).getTime() >= since);
  }
  if (opts.taskId) rows = rows.filter(r => r.task_id === opts.taskId);

  const byModel = {};
  const byClass = {};
  let inputTokens = 0, outputTokens = 0, cost = 0, costKnown = 0;
  let fallbacks = 0, retryDuplicateTokens = 0, fastPathCalls = 0, batchSaved = 0;
  let retries = 0, resumedRetries = 0;
  const fastPathTasks = new Set();
  let estimatedRows = 0;

  for (const r of rows) {
    inputTokens += Number(r.input_tokens) || 0;
    outputTokens += Number(r.output_tokens) || 0;
    if (typeof r.estimated_cost_usd === 'number') { cost += r.estimated_cost_usd; costKnown += 1; }
    if (r.estimated) estimatedRows += 1;
    if (r.fallback_from) fallbacks += 1;
    // 재시도 시도에서 다시 보낸 입력 토큰 = 그 호출의 입력 토큰 전부(고정 prefix + 컨텍스트 재전송)
    if ((Number(r.attempt) || 1) > 1) {
      retries += 1;
      retryDuplicateTokens += Number(r.input_tokens) || 0;
      if (r.resumed) resumedRetries += 1;
    }
    if (r.fast_path) { fastPathCalls += 1; if (r.task_id) fastPathTasks.add(r.task_id); }
    if (Number(r.model_calls_saved)) batchSaved += Number(r.model_calls_saved);

    const mk = `${r.provider || '?'}/${r.model || '?'}`;
    byModel[mk] = byModel[mk] || { calls: 0, input_tokens: 0, output_tokens: 0, cost: null };
    byModel[mk].calls += 1;
    byModel[mk].input_tokens += Number(r.input_tokens) || 0;
    byModel[mk].output_tokens += Number(r.output_tokens) || 0;
    if (typeof r.estimated_cost_usd === 'number') {
      byModel[mk].cost = (byModel[mk].cost || 0) + r.estimated_cost_usd;
    }

    const ck = r.task_class || 'unknown';
    byClass[ck] = byClass[ck] || { calls: 0, input_tokens: 0, output_tokens: 0, cost: null, tasks: new Set() };
    byClass[ck].calls += 1;
    byClass[ck].input_tokens += Number(r.input_tokens) || 0;
    byClass[ck].output_tokens += Number(r.output_tokens) || 0;
    if (r.task_id) byClass[ck].tasks.add(r.task_id);
    if (typeof r.estimated_cost_usd === 'number') {
      byClass[ck].cost = (byClass[ck].cost || 0) + r.estimated_cost_usd;
    }
  }

  const byClassOut = {};
  for (const [k, v] of Object.entries(byClass)) {
    const taskCount = v.tasks.size || 1;
    byClassOut[k] = {
      calls: v.calls,
      tasks: v.tasks.size,
      input_tokens: v.input_tokens,
      output_tokens: v.output_tokens,
      avg_calls_per_task: Math.round((v.calls / taskCount) * 100) / 100,
      avg_input_tokens_per_task: Math.round(v.input_tokens / taskCount),
      cost: v.cost,
    };
  }

  return {
    rows: rows.length,
    calls: rows.length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_rows: estimatedRows,
    estimated_cost_usd: costKnown ? Math.round(cost * 1e6) / 1e6 : null,
    priced_calls: costKnown,
    fallbacks,
    retry_duplicate_input_tokens: retryDuplicateTokens,
    retries,
    resumed_retries: resumedRetries,
    fast_path_calls: fastPathCalls,
    fast_path_tasks: fastPathTasks.size,
    // 추정치: Fast Path 태스크 1건당 컨텍스트 선별 호출 1회 + 계획 생성 호출 1회를 생략한다.
    fast_path_model_calls_saved_estimated: fastPathTasks.size * 2,
    batch_model_calls_saved: batchSaved,
    by_model: byModel,
    by_class: byClassOut,
  };
}

/** Slack/CLI 공용 텍스트 리포트. */
function formatSummary(sum, title = '비용 요약') {
  if (!sum.rows) return `${title}: 기록된 모델 호출이 없습니다 (.agent/runtime/${LOG_BASENAME}).`;
  const lines = [];
  lines.push(`*${title}*`);
  lines.push(`• 총 호출 수: ${sum.calls}`);
  lines.push(`• 입력 토큰: ${sum.input_tokens.toLocaleString()} / 출력 토큰: ${sum.output_tokens.toLocaleString()}`);
  lines.push(`• 추정 토큰 기반 기록: ${sum.estimated_rows}/${sum.rows}건 (estimated:true)`);
  lines.push(sum.estimated_cost_usd === null
    ? '• 추정 비용: 측정 불가 (model-pricing.json 에 단가 미설정 — 토큰만 기록)'
    : `• 추정 비용: $${sum.estimated_cost_usd} (단가 설정된 ${sum.priced_calls}건 기준)`);
  lines.push(`• fallback 횟수: ${sum.fallbacks}`);
  lines.push(`• 재시도 ${sum.retries}회 (그중 checkpoint 로 이어서 재개 ${sum.resumed_retries}회), 재전송된 입력 토큰: ${sum.retry_duplicate_input_tokens.toLocaleString()}`);
  lines.push(`• Fast Path 태스크 ${sum.fast_path_tasks}건 → 생략된 모델 호출 ${sum.fast_path_model_calls_saved_estimated}회(추정: 선별 1 + 계획 1)`);
  lines.push(`• 배치로 절약한 모델 호출: ${sum.batch_model_calls_saved}회`);
  lines.push('');
  lines.push('*모델별*');
  for (const [k, v] of Object.entries(sum.by_model)) {
    lines.push(`• ${k}: ${v.calls}회, in ${v.input_tokens.toLocaleString()} / out ${v.output_tokens.toLocaleString()}${v.cost === null ? '' : `, $${Math.round(v.cost * 1e6) / 1e6}`}`);
  }
  lines.push('');
  lines.push('*작업 등급별*');
  for (const [k, v] of Object.entries(sum.by_class)) {
    lines.push(`• ${k}: 태스크 ${v.tasks}건 / 호출 ${v.calls}회 (태스크당 ${v.avg_calls_per_task}회, 평균 입력 ${v.avg_input_tokens_per_task.toLocaleString()} 토큰)${v.cost === null ? ', 비용 측정 불가' : `, $${Math.round(v.cost * 1e6) / 1e6}`}`);
  }
  return lines.join('\n');
}

/** `!cost ...` 인자를 해석해 리포트 문자열을 만든다. Slack/CLI 공용. */
function report(baseDir, arg = '') {
  const a = String(arg || '').trim().toLowerCase();
  if (a === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return formatSummary(summarize(baseDir, { since: d }), '비용 요약 (오늘)');
  }
  if (a.startsWith('task ')) {
    const id = String(arg).trim().slice(5).trim();
    return formatSummary(summarize(baseDir, { taskId: id }), `비용 요약 (task ${id})`);
  }
  if (a === 'models') {
    const sum = summarize(baseDir);
    if (!sum.rows) return '기록된 모델 호출이 없습니다.';
    const lines = ['*모델별 사용량*'];
    for (const [k, v] of Object.entries(sum.by_model)) {
      lines.push(`• ${k}: ${v.calls}회, in ${v.input_tokens.toLocaleString()} / out ${v.output_tokens.toLocaleString()}${v.cost === null ? ' (단가 미설정 — 비용 측정 불가)' : `, $${Math.round(v.cost * 1e6) / 1e6}`}`);
    }
    return lines.join('\n');
  }
  return formatSummary(summarize(baseDir), '비용 요약 (전체)');
}

module.exports = {
  RUNTIME_SUBDIR,
  LOG_BASENAME,
  logPath,
  estimateTokensFromChars,
  parseUsageFromOutput,
  record,
  readAll,
  summarize,
  formatSummary,
  report,
};
