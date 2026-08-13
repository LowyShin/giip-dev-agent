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

/** 컨텍스트 자동 주입 한도(3.1). */
function contextLimits() {
  const n = (name, def) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    minFiles: n('CONTEXT_MIN_FILES', 2),
    defaultMaxFiles: n('CONTEXT_DEFAULT_MAX_FILES', 6),
    hardMaxFiles: n('CONTEXT_HARD_MAX_FILES', 8),
    perFileMaxChars: n('CONTEXT_PER_FILE_MAX_CHARS', 4000),
    totalMaxChars: n('CONTEXT_TOTAL_MAX_CHARS', 48000),
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
  loadPricing,
  estimateCostUsd,
  PRICING_FILE,
};
