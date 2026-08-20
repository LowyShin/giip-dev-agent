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
 */
const giip = require('./giip-api');

const SUCCESS_TTL_MS = 5 * 60 * 1000;   // 5분 — 성공 조회는 비교적 오래 재사용
const FAILURE_TTL_MS = 60 * 1000;       // 1분 — 실패(403 등)는 짧게만 캐시해 과도한 침묵을 피함

// csn(Number) -> { code: 'ko'|'ja'|'en'|'zh-CN'|'zh-TW'|null, fetchedAt: number }
const cache = new Map();
// csn(Number) -> Promise, 동시 prefetch 중복 호출 방지
const inflight = new Map();

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
    } catch (e) {
      cache.set(n, { code: null, fetchedAt: Date.now() });
      console.error(`[csn-lang-cache] csn=${n} clang 조회 실패(폴백 유지): ${e && e.message}`);
    } finally {
      inflight.delete(n);
    }
  })();
  inflight.set(n, p);
  return p;
}

module.exports = { peekCachedLangCode, prefetch, normalizeLangCode, _cache: cache };
