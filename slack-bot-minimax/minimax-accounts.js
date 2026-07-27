/**
 * minimax-accounts.js — MiniMax Token Plan을 1순위 실행 엔진으로 쓰기 위한 pseudo-account.
 *
 * 우선순위(사용자 지정, giip-780대 후속): MiniMax 먼저 쓰고, MiniMax 한도 소진 시에만 Claude로 폴백.
 * (claude-accounts.js 의 실제 Claude 구독 계정 로테이션이 최종 폴백 — 그쪽은 건드리지 않는다.)
 *
 * MiniMax는 Anthropic Messages API 호환 엔드포인트(https://api.minimax.io/anthropic)를 제공한다
 * (실측: curl POST /anthropic/v1/messages 200, tool_use 블록 정상 반환 — 2026-07-27).
 * 그래서 `claude` CLI 자체를 그대로 spawn하되 ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY 만 바꿔치기하면
 * 새 에이전트 루프를 만들 필요 없이 기존 파일편집/Bash/PR 흐름을 그대로 재사용할 수 있다.
 *
 * 키 종류 주의: MiniMax는 종량제 API Key 와 Token Plan 전용 Subscription Key(sk-cp- 접두)가
 * 서로 호환되지 않는다. MINIMAX_API_KEY 에는 반드시 sk-cp- 로 시작하는 구독 키를 넣는다.
 */

const DEFAULT_MODEL = 'MiniMax-M2.7';
const ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1h — MiniMax 쪽 리셋 주기를 모르므로 보수적 기본값

let cooldownUntil = 0; // 단일 계정(구독 키 1개)이라 claude-accounts.js처럼 배열 대신 모듈 전역 상태로 충분

/** 설정 여부 + 쿨다운 확인 후 pseudo-account 반환. 키 없음/쿨다운 중이면 null(호출측은 Claude로 폴백). */
function resolve() {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return null;
  if (cooldownUntil && cooldownUntil > Date.now()) return null;
  return {
    name: 'minimax',
    provider: 'minimax',
    model: process.env.MINIMAX_MODEL || DEFAULT_MODEL,
    apiKey,
  };
}

/** claude CLI spawn 용 env. CLAUDE_CONFIG_DIR(실 계정 OAuth 세션)은 반드시 제거 — 남아있으면
 *  claude CLI 가 ANTHROPIC_API_KEY 대신 그 세션을 쓰려 해 혼선이 생길 수 있다. */
function envFor(account) {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  env.ANTHROPIC_BASE_URL = ANTHROPIC_BASE_URL;
  env.ANTHROPIC_API_KEY = account.apiKey;
  env.ANTHROPIC_MODEL = account.model;
  return env;
}

// MiniMax/일반 API 한도 표현(429, quota, insufficient balance 등) 휴리스틱 탐지.
// 정확한 문구를 아직 실측하지 못했으므로 넓게 잡는다 — 오탐 시에도 Claude 폴백일 뿐 안전.
const USAGE_LIMIT_RE = /\b429\b|rate limit|quota|insufficient balance|insufficient.{0,10}credit|too many requests/i;
function isUsageLimit(text) {
  return USAGE_LIMIT_RE.test(text || '');
}

/** 한도 감지 시 쿨다운 설정(기본 1h, MINIMAX_COOLDOWN_MS 로 조정 가능) — 그동안은 resolve()가 null. */
function noteUsageLimit() {
  const ms = Number(process.env.MINIMAX_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS;
  cooldownUntil = Date.now() + ms;
  console.log(`[minimax-accounts] usage limit 감지 → cooldown ${Math.round(ms / 60000)}분 (Claude로 폴백)`);
}

module.exports = { resolve, envFor, isUsageLimit, noteUsageLimit, DEFAULT_MODEL, ANTHROPIC_BASE_URL };
