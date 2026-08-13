/**
 * secret-mask.js — 로그/checkpoint 저장 전 비밀값 마스킹 (giip-1063, 안전 요구사항 7~9)
 *
 * 디스크에 남기는 모든 진단 정보(checkpoint, cost 로그)는 이 함수를 통과시킨다.
 * "완벽한 탐지"가 아니라 "알려진 형태를 확실히 지우는" 것이 목적이다.
 */

const PATTERNS = [
  // Slack
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***REDACTED***'],
  [/xapp-[A-Za-z0-9-]{10,}/g, 'xapp-***REDACTED***'],
  // Anthropic / MiniMax / OpenAI 계열
  [/sk-cp-[A-Za-z0-9_\-]{8,}/g, 'sk-cp-***REDACTED***'],
  [/sk-ant-[A-Za-z0-9_\-]{8,}/g, 'sk-ant-***REDACTED***'],
  [/\bsk-[A-Za-z0-9_\-]{20,}/g, 'sk-***REDACTED***'],
  // GitHub
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***REDACTED***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***REDACTED***'],
  // JWT
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, '***REDACTED_JWT***'],
  // Azure/AWS 류
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***REDACTED***'],
  // KEY=VALUE 형태의 .env 라인 (KEY 이름에 SECRET/TOKEN/KEY/PASSWORD/PASSWD/PWD/SK 포함)
  [/(^|\s)([A-Z0-9_]*(?:SECRET|TOKEN|API_?KEY|PASSWORD|PASSWD|PWD|_SK|^SK)[A-Z0-9_]*)\s*=\s*("?[^\s"']{4,}"?)/gim,
    (m, pre, key) => `${pre}${key}=***REDACTED***`],
  // JSON 필드 "password": "..." / "sk": "..." 등
  [/("(?:password|passwd|pwd|secret|token|api_?key|apikey|sk|authorization)"\s*:\s*)"[^"]{4,}"/gi, '$1"***REDACTED***"'],
  // Authorization 헤더
  [/(authorization\s*:\s*)(bearer\s+)?[A-Za-z0-9_\-.=]{12,}/gi, '$1***REDACTED***'],
];

/** 문자열 안의 알려진 비밀값 패턴을 마스킹한다. */
function maskString(text) {
  let out = String(text == null ? '' : text);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * 객체/배열을 재귀적으로 마스킹한다(키 이름이 민감하면 값 자체를 지운다).
 *
 * 주의: 키 이름만 보고 지우면 `input_tokens` 같은 "토큰 수" 필드까지 날아간다.
 * 그래서 (a) 문자열 값만 통째로 지우고 (b) *_tokens 처럼 수치 카운터로 쓰이는 키는 제외한다.
 */
const SENSITIVE_KEY_RE = /(secret|token|password|passwd|pwd|api_?key|apikey|credential|authorization|\bsk\b)/i;
const COUNTER_KEY_RE = /_tokens?$|^tokens?$|_count$/i;

function maskDeep(value, depth = 0) {
  if (depth > 8) return value;
  if (value == null) return value;
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(v => maskDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const sensitive = SENSITIVE_KEY_RE.test(k) && !COUNTER_KEY_RE.test(k) && typeof v === 'string';
      out[k] = sensitive ? '***REDACTED***' : maskDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = { maskString, maskDeep, PATTERNS };
