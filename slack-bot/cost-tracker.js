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
const runtimePaths = require('./runtime-paths');
const { maskDeep } = require('./secret-mask');

const RUNTIME_SUBDIR = path.join('.agent', 'runtime');
const LOG_BASENAME = 'cost-usage.jsonl';

/** giip-1068 7: checkpoint 와 같은 중앙 runtime root 를 쓴다. */
function logPath(baseDir) {
  return runtimePaths.costLogPath(baseDir);
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

  // ── giip-1068 13: 프롬프트 축약 계측 ────────────────────────────────────────
  const initialChars = Number(entry.initial_prompt_chars);
  const currentChars = Number.isFinite(Number(entry.current_prompt_chars))
    ? Number(entry.current_prompt_chars)
    : Number(entry.input_chars);
  let reductionChars = null;
  let reductionRatio = null;
  if (Number.isFinite(initialChars) && initialChars > 0 && Number.isFinite(currentChars)) {
    reductionChars = initialChars - currentChars;
    reductionRatio = Math.round((reductionChars / initialChars) * 1e4) / 1e4;
  }
  const promptType = entry.prompt_type === 'resume' ? 'resume'
    : (entry.prompt_type === 'initial' ? 'initial' : null);
  if (promptType === 'resume' && reductionRatio !== null
      && reductionRatio < modelConfig.RESUME_REDUCTION_WARN_RATIO) {
    console.warn('[CostOptimizationWarning]\nResume prompt reduced input by less than 40%.'
      + ` (task=${entry.task_id || '?'}, initial=${initialChars}자, current=${currentChars}자,`
      + ` ratio=${reductionRatio})`);
  }

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
    // ── giip-1068 8: 가상 절감과 실제 절감을 분리한다 ─────────────────────────
    // 기존 `model_calls_saved` 는 "항목마다 따로 호출했다면 피했을 호출 수"라는 가정값이었다.
    // 기존 구조도 한 메시지를 한 번의 모델 호출로 처리했으므로 실제 절감은 0이다.
    actual_model_calls_saved: entry.actual_model_calls_saved === undefined
      ? null : Number(entry.actual_model_calls_saved),
    hypothetical_separate_calls_avoided: entry.hypothetical_separate_calls_avoided === undefined
      ? null : Number(entry.hypothetical_separate_calls_avoided),
    saving_is_estimated: entry.saving_is_estimated === undefined ? null : !!entry.saving_is_estimated,
    context_selection: entry.context_selection || null,   // [{path, reason}] — 선택 이유(3.7-7)
    // checkpoint 로 "이어서" 재개한 시도인지. false 인 재시도는 작업을 처음부터 다시 한 것.
    resumed: entry.resumed === undefined ? null : !!entry.resumed,
    // ── giip-1068 13: 재개 프롬프트 축약 계측 ──────────────────────────────────
    prompt_type: promptType,
    initial_prompt_chars: Number.isFinite(initialChars) ? initialChars : null,
    current_prompt_chars: Number.isFinite(currentChars) ? currentChars : null,
    prompt_reduction_chars: reductionChars,
    prompt_reduction_ratio: reductionRatio,
    actual_source_files_changed: entry.actual_source_files_changed === undefined
      ? null : Number(entry.actual_source_files_changed),
    metadata_files_changed: entry.metadata_files_changed === undefined
      ? null : Number(entry.metadata_files_changed),
    checkpoint_used: entry.checkpoint_used === undefined ? null : !!entry.checkpoint_used,
    progress_event_count: entry.progress_event_count === undefined
      ? null : Number(entry.progress_event_count),
  });

  try {
    // giip-1068 7: 디렉터리도 runtime root 기준으로 만든다(FDE_RUNTIME_DIR 존중).
    const p = logPath(baseDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(row)}\n`, 'utf8');
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
  let fallbacks = 0, retryDuplicateTokens = 0, fastPathCalls = 0;
  let batchActualSaved = 0, batchHypothetical = 0, batchMessages = 0;
  let retries = 0, resumedRetries = 0;
  let resumePrompts = 0, resumeReductionSum = 0, resumeReductionCount = 0;
  let resumeUnderTarget = 0;
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

    // 배치 수치(8.2). 구 로그의 `model_calls_saved` 는 가정값이었으므로 가정 쪽에 합산한다.
    if (Number(r.batch_size) > 1) batchMessages += 1;
    if (Number.isFinite(Number(r.actual_model_calls_saved))) {
      batchActualSaved += Number(r.actual_model_calls_saved) || 0;
    }
    if (Number.isFinite(Number(r.hypothetical_separate_calls_avoided))) {
      batchHypothetical += Number(r.hypothetical_separate_calls_avoided) || 0;
    } else if (Number(r.model_calls_saved)) {
      batchHypothetical += Number(r.model_calls_saved);   // 구 로그 하위 호환(= 가정값)
    }

    // 재개 프롬프트 축약(13)
    if (r.prompt_type === 'resume') {
      resumePrompts += 1;
      if (typeof r.prompt_reduction_ratio === 'number') {
        resumeReductionSum += r.prompt_reduction_ratio;
        resumeReductionCount += 1;
        if (r.prompt_reduction_ratio < modelConfig.RESUME_REDUCTION_WARN_RATIO) resumeUnderTarget += 1;
      }
    }

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
    // 8.4 Fast Path 절감은 "변경 전 로그"가 없으면 실측이 아니라 추정이다. 반드시 estimated 로 표시.
    fast_path: {
      actual_calls: fastPathCalls,
      baseline_expected_calls: fastPathTasks.size * 3,   // 선별 1 + 계획 1 + 실행 1 (변경 전 가정)
      estimated_calls_saved: fastPathTasks.size * 2,
      saving_is_estimated: true,
    },
    // 하위 호환(구 필드명) — 값은 위 estimated 와 동일하다.
    fast_path_model_calls_saved_estimated: fastPathTasks.size * 2,
    // 8.2/8.3: 실제 절감과 가정 절감을 절대 합치지 않는다.
    batch_messages: batchMessages,
    batch_actual_model_calls_saved: batchActualSaved,
    batch_hypothetical_separate_calls_avoided: batchHypothetical,
    // 13: 재개 프롬프트 축약
    resume_prompts: resumePrompts,
    resume_avg_reduction_ratio: resumeReductionCount
      ? Math.round((resumeReductionSum / resumeReductionCount) * 1e4) / 1e4 : null,
    resume_under_target: resumeUnderTarget,
    by_model: byModel,
    by_class: byClassOut,
  };
}

/**
 * Slack/CLI 공용 텍스트 리포트.
 *
 * giip-1068 8.3: 기본 보고서에는 "실제 절감"만 싣는다. 가상(가정) 절감값은 합산하지 않고
 * `detailed:true`(= `!cost detail`)일 때만, 반드시 "가정값"이라고 명시해 보여준다.
 */
function formatSummary(sum, title = '비용 요약', detailed = false) {
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
  if (sum.resume_prompts) {
    lines.push(`• 재개 프롬프트 ${sum.resume_prompts}회, 평균 입력 감소율 ${sum.resume_avg_reduction_ratio === null ? 'NOT_MEASURED' : `${Math.round(sum.resume_avg_reduction_ratio * 1000) / 10}%`}${sum.resume_under_target ? ` (40% 미만 ${sum.resume_under_target}회 — 경고)` : ''}`);
  }
  lines.push(`• Fast Path 태스크 ${sum.fast_path_tasks}건 → 생략된 모델 호출 ${sum.fast_path.estimated_calls_saved}회 (ESTIMATED — 변경 전 실측 로그 없음)`);
  lines.push(`• 배치 처리 메시지: ${sum.batch_messages}건`);
  lines.push(`• 실제 절감 호출: ${sum.batch_actual_model_calls_saved}회`);
  if (detailed) {
    lines.push(`• (가정값) 개별 호출로 처리했다고 가정했을 때 피한 호출: ${sum.batch_hypothetical_separate_calls_avoided}회 — 실제 절감에 합산하지 않음`);
  }
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
  // `!cost detail` / `!cost today detail` — 가정 절감값은 상세 보고서에만 나온다(8.3).
  const DETAIL_RE = /(^|\s)(detail|details|상세)(\s|$)/i;
  const rawArg = String(arg || '').trim();
  const detailed = DETAIL_RE.test(rawArg);
  const cleaned = (detailed ? rawArg.replace(DETAIL_RE, ' ') : rawArg).trim();
  const a = cleaned.toLowerCase();

  if (a === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return formatSummary(summarize(baseDir, { since: d }), '비용 요약 (오늘)', detailed);
  }
  if (a.startsWith('task ')) {
    const id = cleaned.slice(5).trim();   // 대소문자 보존
    return formatSummary(summarize(baseDir, { taskId: id }), `비용 요약 (task ${id})`, detailed);
  }
  if (a === 'models') return reportModels(baseDir);
  return formatSummary(summarize(baseDir), '비용 요약 (전체)', detailed);
}

function reportModels(baseDir) {
  const sum = summarize(baseDir);
  if (!sum.rows) return '기록된 모델 호출이 없습니다.';
  const lines = ['*모델별 사용량*'];
  for (const [k, v] of Object.entries(sum.by_model)) {
    lines.push(`• ${k}: ${v.calls}회, in ${v.input_tokens.toLocaleString()} / out ${v.output_tokens.toLocaleString()}${v.cost === null ? ' (단가 미설정 — 비용 측정 불가)' : `, $${Math.round(v.cost * 1e6) / 1e6}`}`);
  }
  return lines.join('\n');
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
  reportModels,
};
