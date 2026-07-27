/**
 * claude-accounts.js — 구독 계정 Weighted Round-Robin 라우터
 *
 * slack-bot이 spawn하는 모든 `claude` 호출의 계정(CLAUDE_CONFIG_DIR)을
 * 플랜 가중치(weight) 비율대로 고르게 분산(Smooth WRR, nginx 방식)하고,
 * 사용량 한도(usage limit)에 걸린 계정은 쿨다운으로 잠시 제외한다.
 *
 * 설정: slack-bot/claude-accounts.json (git-ignored, 머신 로컬)
 *   [{ "name": "main", "dir": "C:/claude-accounts/main", "weight": 1, "email": "..." }, ...]
 *   - dir  : 그 계정으로 `claude auth login` 해 둔 CLAUDE_CONFIG_DIR 경로
 *   - weight: 플랜 비중 (Pro=1, Max5x=5, Max20x=20 식으로 상대값, 기본 1)
 *   - email: (선택) 재인증 시 --email 로 전달
 *
 * 파일이 없거나 비어 있으면 → 기본 로그인(현재 계정) 1개로 동작(dir:null, CLAUDE_CONFIG_DIR 미설정).
 * 계정 추가는 이 JSON에 항목만 넣으면 되고 코드 변경은 불필요하다.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'claude-accounts.json');
const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5h — 구독 롤링 한도 리셋 근사치

let accounts = null; // [{ name, dir, weight, email, current, cooldownUntil }]
let cachedMtimeMs = -1;

// JSON을 읽어 계정 목록을 만든다. mtime 기반 핫리로드 — 봇 재시작 없이 계정 추가 반영.
function loadAccounts() {
  let mtimeMs = 0;
  let raw = [];
  try {
    mtimeMs = fs.statSync(CONFIG_FILE).mtimeMs;
    if (accounts && mtimeMs === cachedMtimeMs) return accounts; // 변경 없음 → 캐시
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // 파일 없음/파싱 실패 → 기본 계정 1개로 폴백. 최초 1회만 구성.
    if (accounts && cachedMtimeMs === 0) return accounts;
    mtimeMs = 0;
    raw = [];
  }

  const list = (Array.isArray(raw) ? raw : [])
    .filter(a => a && a.dir)
    .map(a => ({
      name: String(a.name || path.basename(String(a.dir))),
      dir: String(a.dir),
      weight: Math.max(1, Number(a.weight) || 1),
      email: a.email ? String(a.email) : null,
    }));

  if (list.length === 0) {
    // 기본 계정 — CLAUDE_CONFIG_DIR 미설정(현재 로그인 그대로 사용)
    list.push({ name: 'default', dir: null, weight: 1, email: null });
  }

  // 이전 SWRR 상태(current)/쿨다운을 이름 기준으로 보존 (핫리로드 시 분산 연속성 유지)
  const prev = new Map((accounts || []).map(a => [a.name, a]));
  accounts = list.map(a => ({
    ...a,
    current: prev.get(a.name)?.current || 0,
    cooldownUntil: prev.get(a.name)?.cooldownUntil || 0,
  }));
  cachedMtimeMs = mtimeMs;
  return accounts;
}

function count() {
  return loadAccounts().length;
}

// Smooth Weighted Round Robin (nginx 방식) + 쿨다운 제외.
// weight 비율대로 고르게 섞어 반환. 전부 쿨다운이면 null.
function pickAccount() {
  const all = loadAccounts();
  const now = Date.now();
  const pool = all.filter(a => !a.cooldownUntil || a.cooldownUntil < now);
  if (pool.length === 0) return null;

  const total = pool.reduce((s, a) => s + a.weight, 0);
  let best = null;
  for (const a of pool) {
    a.current += a.weight;
    if (!best || a.current > best.current) best = a;
  }
  best.current -= total;
  return best;
}

// 계정에 맞는 spawn env. dir이 없으면(기본 계정) 현재 env 그대로.
function envFor(account) {
  if (!account || !account.dir) return process.env;
  return { ...process.env, CLAUDE_CONFIG_DIR: account.dir };
}

// "usage limit"/"rate limit" 같은 옛 문구뿐 아니라 실제 CLI가 내는
// "You've hit your weekly limit · resets Jul 28, 6am (Asia/Tokyo)" 류(= "...limit"와
// "reset(s)"가 근처에 같이 나오는 문구)도 잡는다. giip-759: 이 문구가 안 잡혀 계정
// 로테이션이 전혀 발동하지 않고 task가 그냥 실패로 끝났다.
const USAGE_LIMIT_RE = /usage limit|rate limit|weekly limit|session limit|too many requests|\b429\b|quota exceeded|\blimit\b[\s\S]{0,40}\breset/i;
function isUsageLimit(text) {
  return USAGE_LIMIT_RE.test(text || '');
}

// 메시지 중 "resets <Mon> <D>, <H>(am|pm)" 형태에서 리셋 시각을 추정해 쿨다운 ms를 구한다.
// 파싱 실패 시: "weekly" 한도면 옛 5h 쿨다운으로는 매번 헛 재시도만 반복하므로 24h로,
// 그 외는 기존 기본값(5h)으로 폴백한다.
function parseResetCooldownMs(text) {
  const m = /resets?\s+([A-Za-z]{3,9}\s+\d{1,2}),?\s*(\d{1,2})\s*(am|pm)/i.exec(text || '');
  if (m) {
    let hour = parseInt(m[2], 10) % 12;
    if (/pm/i.test(m[3])) hour += 12;
    const guess = new Date(`${m[1]} ${new Date().getFullYear()} ${String(hour).padStart(2, '0')}:00:00`);
    if (!Number.isNaN(guess.getTime())) {
      const ms = guess.getTime() - Date.now() + 5 * 60 * 1000; // +5분 여유
      if (ms > 0) return ms;
    }
  }
  return /weekly/i.test(text || '') ? 24 * 60 * 60 * 1000 : DEFAULT_COOLDOWN_MS;
}

// 한도 걸린 계정을 쿨다운 처리. text(= claude 출력)에서 실제 리셋 시각을 추정해 쓰고,
// 못 구하면 기존처럼 기본 쿨다운(weekly 문구면 24h, 아니면 5h)으로 폴백한다.
function noteUsageLimit(account, text = '') {
  if (!account) return;
  const a = loadAccounts().find(x => x.name === account.name);
  if (a) {
    const cooldownMs = parseResetCooldownMs(text);
    a.cooldownUntil = Date.now() + cooldownMs;
    console.log(`[claude-accounts] ${a.name} usage limit → cooldown ${Math.round(cooldownMs / 3600000)}h`);
  }
}

module.exports = {
  loadAccounts,
  count,
  pickAccount,
  envFor,
  isUsageLimit,
  noteUsageLimit,
  DEFAULT_COOLDOWN_MS,
};
