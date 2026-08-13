/**
 * batch-planner.js — 한 메시지 안의 독립 조회를 한 번에 묶기 (giip-1063, 3.8)
 *
 * 목적: "파일 5개 존재 확인", "설정값 3개 비교"처럼 한 메시지에 담긴 독립적인 read/search/status
 * 요청을 각각 모델 호출로 쪼개지 않고 한 번에 처리하도록 프롬프트에 배치 지시를 넣는다.
 *
 * 하지 않는 것
 *  - Slack 메시지를 일정 시간 대기시켜 강제로 묶지 않는다(한 메시지 안의 복수 요청만 대상).
 *  - 서로 종속된 "수정" 작업을 한 호출로 무리하게 합치지 않는다.
 */

// 읽기 전용 신호 (조회/확인/검색/비교)
const READONLY_RE = new RegExp([
  '확인', '조회', '보여', '알려', '어디', '무엇', '뭐야', '뭔가요', '있나', '있어', '있는지', '목록', '리스트',
  '비교', '검색', '찾아', '상태', '몇\\s*개',
  '確認', '一覧', 'どこ', 'なに', '検索', '状態',
  '\\bcheck\\b', '\\blist\\b', '\\bshow\\b', '\\bwhat\\b', '\\bwhere\\b', '\\bwhich\\b', '\\bfind\\b',
  '\\bsearch\\b', '\\bstatus\\b', '\\bcompare\\b', '\\bexists?\\b', '\\bdoes\\b',
].join('|'), 'i');

// 변경 신호 (있으면 배치 대상에서 제외 — 충돌 가능성)
const MUTATING_RE = new RegExp([
  '수정', '변경', '삭제', '추가', '생성', '작성', '만들', '고쳐', '바꿔', '배포', '커밋', '푸시', '리팩',
  '修正', '変更', '削除', '追加', '作成', 'デプロイ',
  '\\bfix\\b', '\\bchange\\b', '\\bdelete\\b', '\\bremove\\b', '\\badd\\b', '\\bcreate\\b', '\\bwrite\\b',
  '\\bupdate\\b', '\\bdeploy\\b', '\\bcommit\\b', '\\brefactor\\b', '\\brename\\b',
].join('|'), 'i');

// 앞 항목에 종속됨을 나타내는 지시어
const DEPENDENT_RE = /(그\s*(결과|다음|후|걸|것)|위의|앞의|이어서|거기서|それ|その後|then\b|after that\b|based on (that|the above))/i;

/**
 * 메시지를 독립 항목 후보로 쪼갠다.
 *  - 번호 목록(1. 2. / 1) 2))
 *  - 불릿(- , •)
 *  - 줄바꿈
 *  - 물음표로 끝나는 문장들
 */
function splitItems(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const numbered = lines.filter(l => /^(\d+[.)]|[-*•])\s+/.test(l));
  if (numbered.length >= 2) {
    return numbered.map(l => l.replace(/^(\d+[.)]|[-*•])\s+/, '').trim()).filter(Boolean);
  }

  if (lines.length >= 2) return lines;

  // 한 줄에 물음표로 구분된 복수 질문
  const questions = raw.split(/(?<=[?？])\s+/).map(s => s.trim()).filter(Boolean);
  if (questions.length >= 2) return questions;

  return [raw];
}

/**
 * 한 메시지 안의 독립 조회를 묶을 수 있는지 판정한다.
 *
 * giip-1068 (8): 절감 수치를 "실제"와 "가정"으로 분리한다.
 *   기존 구조도 한 Slack 메시지를 한 번의 모델 호출로 처리했다. 따라서 배치 지시를 붙였다고 해서
 *   모델 호출 수가 줄어드는 것은 아니다(actual_model_calls_saved = 0).
 *   `hypothetical_separate_calls_avoided` 는 "항목마다 따로 물었다면 필요했을 호출 수 − 1" 이라는
 *   가정값이며, 기본 `!cost` 보고서에 실제 절감으로 합산하지 않는다.
 *
 * @returns {{
 *   batchable: boolean, batch_size: number,
 *   hypothetical_separate_calls_avoided: number,
 *   actual_model_calls_before: number, actual_model_calls_after: number,
 *   actual_model_calls_saved: number, saving_is_estimated: boolean,
 *   items: string[], reason: string, instruction: string|null
 * }}
 */
function planBatch(text) {
  const items = splitItems(text);
  const none = (reason) => ({
    batchable: false,
    batch_size: items.length || 1,
    hypothetical_separate_calls_avoided: 0,
    actual_model_calls_before: 1,
    actual_model_calls_after: 1,
    actual_model_calls_saved: 0,
    saving_is_estimated: false,
    items,
    reason,
    instruction: null,
  });

  if (items.length < 2) return none('단일 요청');
  if (items.length > 20) return none('항목이 너무 많음(20개 초과) — 배치 지시 생략');

  const readonlyItems = items.filter(i => READONLY_RE.test(i) && !MUTATING_RE.test(i));
  const dependent = items.some(i => DEPENDENT_RE.test(i));

  if (dependent) return none('항목 간 종속 표현 검출 — 직렬 처리');
  if (readonlyItems.length < 2) return none('독립 read/search/status 항목이 2개 미만');
  if (readonlyItems.length !== items.length) {
    return none('변경 작업이 섞여 있음 — 배치하지 않고 기존 경로로 처리');
  }

  return {
    batchable: true,
    batch_size: items.length,
    // 가정값: 항목마다 따로 물었다면 items.length 회가 필요했을 것 → n-1. 실제 절감이 아니다.
    hypothetical_separate_calls_avoided: items.length - 1,
    // 실측: 배치 지시 유무와 무관하게 한 메시지는 예전에도 지금도 모델 호출 1회다.
    actual_model_calls_before: 1,
    actual_model_calls_after: 1,
    actual_model_calls_saved: 0,
    saving_is_estimated: false,   // 실제 절감값(0)은 추정이 아니라 실측 구조에서 나온 값
    items,
    reason: '한 메시지 안의 독립 read/search/status 요청 — 항목별 되묻기(추가 왕복)를 막는 효과는 있으나 모델 호출 수 절감은 0',
    instruction: buildBatchInstruction(items),
  };
}

/** 배치 처리 지시문. 모델에게 항목별 답을 한 번의 응답으로 만들게 한다. */
function buildBatchInstruction(items) {
  return [
    '=== 배치 처리 지시 ===',
    `이 메시지에는 서로 독립적인 조회 요청이 ${items.length}건 들어 있다. 항목마다 따로 되묻지 말고,`,
    '필요한 읽기/검색/상태 확인을 한 번에(가능하면 병렬로) 수행한 뒤 아래 번호대로 한 응답에 정리해 답하라.',
    ...items.map((it, i) => `${i + 1}. ${it}`),
    '항목 중 하나가 실패하면 그 항목만 실패로 표시하고 나머지는 그대로 답하라.',
  ].join('\n');
}

module.exports = { planBatch, splitItems, buildBatchInstruction, READONLY_RE, MUTATING_RE };
