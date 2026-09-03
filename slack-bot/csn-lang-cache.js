/**
 * csn-lang-cache.js — csn(giip 조직번호) → 응답 언어코드 캐시 + 백그라운드 조회.
 * giip #1252: "csn 이 인식되면 그 csn 의 clang(tCorp.cLang) 을 읽어 그 언어로 답변" 요구를
 * config.js 의 project-lang.json(수동 등록 맵) 보다 우선 적용하기 위한 보조 모듈.
 *
 * 설계 원칙(장애 유발 금지):
 *  - 이 모듈의 모든 조회 함수는 절대 throw 하지 않는다. 실패/미상은 항상 null 로 조용히 반환하고,
 *    호출측(config.resolveLangForProject)이 기존 수동맵 → DEFAULT_LANG 순으로 폴백한다.
 *  - peekCachedLangCode() 는 순수 동기·네트워크 없음 — 프롬프트 빌드처럼 sync 한 호출부(task-manager.js
 *    등)에서 await 없이 그냥 불러도 안전하다. 캐시 미스면 null 을 반환할 뿐, 그 자리에서 API 를 부르지
 *    않는다(그러면 매 응답마다 지연이 생김).
 *  - prefetch(account, csn) 가 실제 네트워크 조회를 백그라운드로 수행해 캐시를 채운다 — 호출부는
 *    channelId/account/csn 이 함께 확보되는 지점(handlers.js 이슈등록, giip-task.js 태스크생성 등)에서
 *    fire-and-forget 으로 호출하면 된다. 동일 csn 에 대한 동시 중복 호출은 inflight 맵으로 합친다.
 *  - giipdb SP(pApiCorpLangGetbySk) 가 현재 admin SK 게이트라 테넌트 SK 로는 403 이 날 수 있음
 *    (giip-api.js#corpLangGet 주석 참고) — 이 경우도 실패로 캐시(짧은 TTL)해 매 호출마다 재시도하지
 *    않는다.
 *  - giip #1968: 프로세스 재시작 시 인메모리 캐시가 날아가 매번 재조회(및 폴백 침묵기간)가 반복되는 문제를
 *    막기 위해 write-through 로 .csn-lang-cache.env(dotenv 형식, git-ignored)에도 기록한다. 모듈 로드 시
 *    이 파일을 읽어 캐시를 미리 채우되, TTL 판정은 기존과 동일하게 fetchedAt 기준으로 계속 이뤄진다
 *    (만료된 항목은 그냥 미스로 취급되어 다음 prefetch 호출 때 자연스럽게 갱신됨). 이 파일 IO 역시
 *    절대 throw 하지 않는다 — 실패 시 로그만 남기고 인메모리 동작으로 계속 진행한다.
 */
const fs = require('fs');
const path = require('path');
const giip = require('./giip-api');

const SUCCESS_TTL_MS = 5 * 60 * 1000;   // 5분 — 성공 조회는 비교적 오래 재사용
const FAILURE_TTL_MS = 60 * 1000;       // 1분 — 실패(403 등)는 짧게만 캐시해 과도한 침묵을 피함

// 영속 캐시 파일(dotenv 형식) — CSN_<n>_LANG=<code|빈문자열>, CSN_<n>_LANG_AT=<epoch_ms>.
const CACHE_FILE = path.join(__dirname, '.csn-lang-cache.env');

// csn(Number) -> { code: 'ko'|'ja'|'en'|'zh-CN'|'zh-TW'|null, fetchedAt: number }
const cache = new Map();
// csn(Number) -> Promise, 동시 prefetch 중복 호출 방지
const inflight = new Map();

/**
 * 모듈 로드 시 1회, 동기로 .csn-lang-cache.env 를 읽어 인메모리 cache 를 미리 채운다.
 * 파일이 없거나 손상됐어도 절대 throw 하지 않는다 — 그냥 빈 캐시로 시작한다.
 */
function _loadFromFile() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const langByCsn = new Map();
    const atByCsn = new Map();
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq);
      const val = t.slice(eq + 1);
      let m = key.match(/^CSN_(\d+)_LANG_AT$/);
      if (m) { atByCsn.set(Number(m[1]), Number(val)); continue; }
      m = key.match(/^CSN_(\d+)_LANG$/);
      if (m) { langByCsn.set(Number(m[1]), val === '' ? null : val); continue; }
    }
    for (const [n, code] of langByCsn) {
      const fetchedAt = atByCsn.has(n) ? atByCsn.get(n) : 0; // AT 없으면 0(=이미 만료 취급)
      cache.set(n, { code, fetchedAt });
    }
    if (process.env.CSN_LANG_CACHE_DEBUG) {
      console.error(`[csn-lang-cache] .csn-lang-cache.env 에서 ${langByCsn.size}건 로드`);
    }
  } catch (e) {
    console.error(`[csn-lang-cache] .csn-lang-cache.env 로드 실패(무시하고 인메모리로 계속): ${e && e.message}`);
  }
}

/**
 * 현재 인메모리 cache 전체를 .csn-lang-cache.env 로 rewrite 한다(write-through).
 * prefetch() 가 cache.set() 직후 호출한다. 절대 throw 하지 않는다.
 */
function _persistToFile() {
  try {
    const lines = [];
    for (const [n, e] of cache) {
      lines.push(`CSN_${n}_LANG=${e.code == null ? '' : e.code}`);
      lines.push(`CSN_${n}_LANG_AT=${e.fetchedAt}`);
    }
    fs.writeFileSync(CACHE_FILE, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  } catch (e) {
    console.error(`[csn-lang-cache] .csn-lang-cache.env 저장 실패(무시하고 계속): ${e && e.message}`);
  }
}

_loadFromFile();

/** giipdb cLang 값('ko-KR','en-US','ja-JP' 등) → config.js LANG_NAMES 코드로 정규화. 미상이면 null. */
function normalizeLangCode(cLang) {
  if (!cLang) return null;
  const s = String(cLang).trim();
  if (/^zh-CN/i.test(s)) return 'zh-CN';
  if (/^zh-TW/i.test(s)) return 'zh-TW';
  const short = s.split(/[-_]/)[0].toLowerCase();
  if (short === 'ko' || short === 'ja' || short === 'en') return short;
  return null;
}

/** 캐시에서 즉시 읽는다(동기, 네트워크 없음). 유효 엔트리 없으면 undefined. */
function readCache(csnNum) {
  const e = cache.get(csnNum);
  if (!e) return undefined;
  const ttl = e.code ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  if (Date.now() - e.fetchedAt >= ttl) return undefined; // 만료 → 재조회 필요
  return e.code; // 문자열(성공) 또는 null(최근 실패 — 짧게 폴백 유지)
}

/**
 * 캐시 피크: hit 이면 코드(string) 또는 null(최근 실패=폴백 위임), miss 면 null 반환.
 * 절대 네트워크를 부르지 않는다 — sync 호출부(config.js)에서 안전하게 쓰기 위함.
 */
function peekCachedLangCode(csn) {
  if (csn == null) return null;
  const n = Number(csn);
  if (!Number.isInteger(n)) return null;
  const hit = readCache(n);
  return hit === undefined ? null : hit;
}

/**
 * 백그라운드 조회로 캐시를 채운다. fire-and-forget 로 호출하는 것을 전제로 하며,
 * 이 함수 자체도 절대 throw 하지 않는다(실패는 캐시에 기록만 하고 조용히 종료).
 */
async function prefetch(account, csn) {
  if (!account || csn == null) return;
  const n = Number(csn);
  if (!Number.isInteger(n)) return;
  if (readCache(n) !== undefined) return; // 이미 유효한 캐시 있음
  if (inflight.has(n)) return inflight.get(n);

  const p = (async () => {
    try {
      const res = await giip.corpLangGet(account, n);
      const code = res && res.ok ? normalizeLangCode(res.cLang) : null;
      cache.set(n, { code, fetchedAt: Date.now() });
      _persistToFile();
    } catch (e) {
      cache.set(n, { code: null, fetchedAt: Date.now() });
      _persistToFile();
      console.error(`[csn-lang-cache] csn=${n} clang 조회 실패(폴백 유지): ${e && e.message}`);
    } finally {
      inflight.delete(n);
    }
  })();
  inflight.set(n, p);
  return p;
}

module.exports = { peekCachedLangCode, prefetch, normalizeLangCode, _cache: cache };
