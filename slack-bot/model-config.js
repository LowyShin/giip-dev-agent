/**
 * model-config.js — 모델명·티어·가격의 중앙 설정 (giip-1063)
 *
 * 목적: `claude-opus-4-8` 같은 모델명이 코드 곳곳에 하드코딩돼 "모든 호출이 최상위 모델"이 되는
 * 것을 막는다. 여기서만 모델명을 해석하고, 나머지 모듈은 티어 이름(trivial/standard/complex/
 * critical/planner)만 다룬다.
 *
 * 설정이 하나도 없어도 동작해야 하므로(기존 동작 보존) 모든 값에 기본값을 둔다.
 *
 * 특수 토큰 `minimax-default`
 *   = "MiniMax 공급자를 그 계정에 설정된 모델로 쓴다". MiniMax 가 미설정/쿨다운이면
 *     해당 티어의 fallback(Claude) 모델로 내려간다. 기존 MiniMax-우선 → Claude-폴백
 *     구조를 그대로 유지하기 위한 표현.
 */

const fs = require('fs');
const path = require('path');

const MINIMAX_DEFAULT = 'minimax-default';

// 기존 코드에 하드코딩돼 있던 값. critical 티어의 기본값으로만 남긴다(현행 동작 보존).
const LEGACY_PREMIUM_MODEL = 'claude-opus-4-8';
// claude CLI 는 `--model sonnet|opus|haiku` 별칭을 해석한다. 버전 문자열을 임의로 지어내지 않기 위해
// 중간 티어는 별칭을 기본값으로 쓴다(환경변수로 정확한 모델명 지정 가능).
const DEFAULT_MID_MODEL = 'sonnet';

const TIERS = ['trivial', 'standard', 'complex', 'critical'];

/** 환경변수 우선, 없으면 기본값. 매 호출마다 읽어서 런타임 변경(테스트)에도 반응한다. */
function env(name, fallback) {
  const v = process.env[name];
  return (v && String(v).trim()) || fallback;
}

/** 티어별 1순위 모델 토큰. */
function modelForTier(tier) {
  switch (tier) {
    case 'trivial':  return env('MODEL_TRIVIAL', MINIMAX_DEFAULT);
    case 'standard': return env('MODEL_STANDARD', MINIMAX_DEFAULT);
    case 'complex':  return env('MODEL_COMPLEX', DEFAULT_MID_MODEL);
    case 'critical': return env('MODEL_CRITICAL', LEGACY_PREMIUM_MODEL);
    case 'planner':  return env('MODEL_PLANNER', MINIMAX_DEFAULT);
    default:         return env('MODEL_STANDARD', MINIMAX_DEFAULT);
  }
}

/** 티어별 Claude 폴백 모델(= MiniMax 실패/미설정 시 쓸 모델). */
function fallbackModelForTier(tier) {
  return tier === 'critical'
    ? env('MODEL_FALLBACK_CRITICAL', LEGACY_PREMIUM_MODEL)
    : env('MODEL_FALLBACK_STANDARD', DEFAULT_MID_MODEL);
}

/**
 * Q&A(질문 응답) 경로 모델. 기존에는 claude-opus-4-8 하드코딩이었다.
 * MODEL_QA 로 덮어쓸 수 있고, 기본은 standard 폴백(=중간급).
 */
function qaModel() {
  return env('MODEL_QA', fallbackModelForTier('standard'));
}

/**
 * intent 분류(task/question 1단어 판정) 모델. 분류에 프리미엄 모델을 쓰지 않는다.
 */
function classifierModel() {
  return env('MODEL_CLASSIFIER', fallbackModelForTier('standard'));
}

function isMiniMaxToken(model) {
  return String(model || '').trim().toLowerCase() === MINIMAX_DEFAULT;
}

/** 재시도 상한(무한 재시도 금지). */
function retryLimits() {
  const n = (name, def) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : def;
  };
  return {
    maxProviderRetries: n('MAX_PROVIDER_RETRIES', 1),
    maxTotalAttempts: n('MAX_TOTAL_ATTEMPTS', 3),
  };
}

function numEnv(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function normTier(taskClass) {
  return TIERS.includes(taskClass) ? taskClass : 'standard';
}

// ── 등급별 한도표 (giip-1068, 2.1~2.3) ────────────────────────────────────────
// 1차 작업에서는 모든 등급에 48,000자를 일괄 적용했다. 등급별로 나눈다.
const CONTEXT_TOTAL_BY_CLASS = { trivial: 12000, standard: 24000, complex: 40000, critical: 64000 };
const PROMPT_INITIAL_BY_CLASS = { trivial: 24000, standard: 48000, complex: 80000, critical: 120000 };
const PROMPT_RESUME_BY_CLASS = { trivial: 12000, standard: 24000, complex: 40000, critical: 64000 };

/** 재개 프롬프트는 최초 프롬프트의 이 비율을 넘으면 안 된다(2.2). */
const RESUME_PROMPT_MAX_RATIO = 0.60;
/** 재개 프롬프트인데 감소율이 이 값보다 작으면 경고를 남긴다(13). */
const RESUME_REDUCTION_WARN_RATIO = 0.40;
/** 최초 프롬프트가 이 길이 이하면 60% 규칙 예외(동일 프롬프트 재사용 허용, 2.2). */
const SMALL_PROMPT_EXEMPT_CHARS = 12000;

/**
 * 컨텍스트 자동 주입 한도(3.1 / giip-1068 2.3).
 * @param {string} [taskClass] trivial|standard|complex|critical (미지정 시 standard)
 */
function contextLimits(taskClass) {
  const tier = normTier(taskClass);
  // 명시적 환경변수가 있으면 등급표보다 우선(운영에서 강제 조정 가능).
  const total = Number(process.env.CONTEXT_TOTAL_MAX_CHARS);
  const perFileDefault = tier === 'critical' ? 6000 : 4000;
  return {
    taskClass: tier,
    minFiles: numEnv('CONTEXT_MIN_FILES', 2),
    defaultMaxFiles: numEnv('CONTEXT_DEFAULT_MAX_FILES', 6),
    hardMaxFiles: numEnv('CONTEXT_HARD_MAX_FILES', 8),
    perFileMaxChars: numEnv('CONTEXT_PER_FILE_MAX_CHARS', perFileDefault),
    totalMaxChars: Number.isFinite(total) && total > 0 ? total : CONTEXT_TOTAL_BY_CLASS[tier],
  };
}

/**
 * 재개(fallback) 프롬프트에 실을 컨텍스트 한도(4.5).
 * 일반: 3개 파일 / 파일당 3,000자 / 전체 8,000자
 * critical: 4개 파일 / 파일당 4,000자 / 전체 14,000자
 */
function resumeContextLimits(taskClass) {
  const tier = normTier(taskClass);
  const critical = tier === 'critical';
  return {
    taskClass: tier,
    maxFiles: numEnv('RESUME_CONTEXT_MAX_FILES', critical ? 4 : 3),
    perFileMaxChars: numEnv('RESUME_CONTEXT_PER_FILE_MAX_CHARS', critical ? 4000 : 3000),
    totalMaxChars: numEnv('RESUME_CONTEXT_TOTAL_MAX_CHARS', critical ? 14000 : 8000),
  };
}

/**
 * 프롬프트 전체 문자 수 상한(2.1 / 2.2). 토큰 추정은 문자 수 ÷ 4.
 * @returns {{taskClass, initialMaxChars, resumeMaxChars, resumeMaxRatio,
 *            initialMaxTokensEstimated, resumeMaxTokensEstimated}}
 */
function promptLimits(taskClass) {
  const tier = normTier(taskClass);
  const initial = numEnv('PROMPT_INITIAL_MAX_CHARS', PROMPT_INITIAL_BY_CLASS[tier]);
  const resume = numEnv('PROMPT_RESUME_MAX_CHARS', PROMPT_RESUME_BY_CLASS[tier]);
  return {
    taskClass: tier,
    initialMaxChars: initial,
    resumeMaxChars: resume,
    resumeMaxRatio: RESUME_PROMPT_MAX_RATIO,
    smallPromptExemptChars: SMALL_PROMPT_EXEMPT_CHARS,
    initialMaxTokensEstimated: Math.ceil(initial / 4),
    resumeMaxTokensEstimated: Math.ceil(resume / 4),
  };
}

/** checkpoint 에 저장할 항목 수 상한(5.6). */
function checkpointLimits() {
  return {
    completed_steps: numEnv('CHECKPOINT_MAX_STEPS', 30),
    files_read: numEnv('CHECKPOINT_MAX_FILES_READ', 100),
    files_changed: numEnv('CHECKPOINT_MAX_FILES_CHANGED', 100),
    commands_run: numEnv('CHECKPOINT_MAX_COMMANDS', 50),
    test_results: numEnv('CHECKPOINT_MAX_TEST_RESULTS', 30),
  };
}

// ── 가격표 ───────────────────────────────────────────────────────────────────
// 가격은 코드에 산재시키지 않고 model-pricing.json 에서만 읽는다.
// 값이 없으면 비용을 지어내지 않고 null 을 돌려준다(토큰량까지만 기록).
const PRICING_FILE = path.join(__dirname, 'model-pricing.json');
let _pricingCache = null;
let _pricingMtime = 0;

function loadPricing() {
  try {
    const st = fs.statSync(PRICING_FILE);
    if (_pricingCache && st.mtimeMs === _pricingMtime) return _pricingCache;
    const parsed = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
    _pricingCache = parsed && typeof parsed === 'object' ? parsed : { models: {} };
    _pricingMtime = st.mtimeMs;
  } catch {
    _pricingCache = { models: {} };
    _pricingMtime = 0;
  }
  if (!_pricingCache.models || typeof _pricingCache.models !== 'object') _pricingCache.models = {};
  return _pricingCache;
}

/**
 * 토큰 수 → USD 추정 비용. 가격 미설정 모델이면 null(= 비용 미기록, 토큰만 기록).
 * @returns {{ cost: number|null, as_of: string|null, source: string|null }}
 */
function estimateCostUsd(model, inputTokens, outputTokens) {
  const pricing = loadPricing();
  const entry = pricing.models[model];
  if (!entry || typeof entry.input_per_mtok !== 'number' || typeof entry.output_per_mtok !== 'number') {
    return { cost: null, as_of: null, source: null };
  }
  const cost = (Number(inputTokens || 0) / 1e6) * entry.input_per_mtok
             + (Number(outputTokens || 0) / 1e6) * entry.output_per_mtok;
  return {
    cost: Math.round(cost * 1e6) / 1e6,
    as_of: entry.as_of || pricing.as_of || null,
    source: entry.source || pricing.source || null,
  };
}

module.exports = {
  TIERS,
  MINIMAX_DEFAULT,
  LEGACY_PREMIUM_MODEL,
  modelForTier,
  fallbackModelForTier,
  qaModel,
  classifierModel,
  isMiniMaxToken,
  retryLimits,
  contextLimits,
  resumeContextLimits,
  promptLimits,
  checkpointLimits,
  loadPricing,
  estimateCostUsd,
  PRICING_FILE,
  CONTEXT_TOTAL_BY_CLASS,
  PROMPT_INITIAL_BY_CLASS,
  PROMPT_RESUME_BY_CLASS,
  RESUME_PROMPT_MAX_RATIO,
  RESUME_REDUCTION_WARN_RATIO,
  SMALL_PROMPT_EXEMPT_CHARS,
  runtimeRoot: (...a) => require('./runtime-paths').runtimeRoot(...a),
};
