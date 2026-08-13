/**
 * model-router.js — 작업 난이도 분류 + 단계별 모델 선택 (giip-1063)
 *
 * 두 가지만 한다.
 *   classifyTask(requestText, selectedContext, taskPlan) → { class, confidence, reasons }
 *   selectModel(taskClass, phase, availableProviders)    → { tier, provider, model, fallback, reasons }
 *
 * 원칙
 *  - 분류는 정적 규칙 우선. 애매할 때만 저비용 모델 1회. 분류에 Opus 를 쓰지 않는다.
 *  - 보안/인증/결제/개인정보/운영DB/인프라 삭제 → 최소 critical
 *  - 마이그레이션/스키마/배포 설정 → 최소 complex
 *  - 신뢰도가 낮으면 한 단계 높은 등급으로 올린다(안전 우선).
 */

const modelConfig = require('./model-config');

const ORDER = ['trivial', 'standard', 'complex', 'critical'];
const rank = c => Math.max(0, ORDER.indexOf(c));
const atLeast = (a, b) => (rank(a) >= rank(b) ? a : b);
const bump = c => ORDER[Math.min(ORDER.length - 1, rank(c) + 1)];

// ── 정적 규칙 사전 ────────────────────────────────────────────────────────────
// 한국어/일본어/영어를 함께 본다(이 봇은 3개 언어로 요청을 받는다).

// 최소 critical: 보안·인증·권한·결제·개인정보·운영 DB·인프라 삭제
const CRITICAL_RE = new RegExp([
  '보안', '인증', '권한', '로그인', '세션\\s*탈취', '암호화', '복호화', '비밀번호', '패스워드',
  '결제', '과금', '청구', '환불', '개인정보', '주민등록', '운영\\s*(디비|db)', '프로덕션\\s*(디비|db)',
  '인증서', '토큰\\s*발급', '시크릿', '크리덴셜',
  '認証', '認可', '権限', 'セキュリティ', '決済', '課金', '個人情報', '本番\\s*(db|データベース)',
  '\\bauth\\b', 'authn', 'authz', 'oauth', '\\bsso\\b', 'login', 'logout', 'session\\s*token',
  'permission', 'security', 'vulnerab', '\\bcve\\b', 'payment', 'billing', 'invoice', 'refund',
  '\\bpii\\b', 'gdpr', 'credential', 'api\\s*key', 'secret', 'encrypt', 'decrypt', 'password',
  'production\\s*(db|database)', 'drop\\s+table', 'truncate\\s+table', 'delete\\s+from',
  'terraform\\s+destroy', 'rm\\s+-rf',
].join('|'), 'i');

// 최소 complex: 마이그레이션·스키마 변경·배포 설정 변경
const MIN_COMPLEX_RE = new RegExp([
  '마이그레이션', '스키마', '배포\\s*설정', '파이프라인', '인프라',
  'マイグレーション', 'スキーマ', 'デプロイ設定',
  'migration', 'schema', 'ddl', 'alter\\s+table', 'ci/?cd', 'pipeline', 'deploy(ment)?\\s*(config|설정)?',
  'dockerfile', 'kubernetes', 'k8s', 'helm', 'terraform', 'github\\s*actions', 'workflow\\.ya?ml',
].join('|'), 'i');

// complex 신호: 신규 기능·다수 파일·여러 서브시스템·데이터 흐름 변경
const COMPLEX_RE = new RegExp([
  '신규\\s*기능', '새\\s*기능', '리팩터링', '리팩토링', '재설계', '아키텍처', '연동', '통합',
  '데이터\\s*흐름', '전면', '대규모', '마이그레', '설계해',
  '新機能', 'リファクタ', '再設計', 'アーキテクチャ', '連携',
  'new\\s+feature', 'refactor', 'redesign', 'architect', 'integrat', 'end-to-end', 'e2e',
  'multi[- ]?service', 'data\\s*flow', 'rewrite',
].join('|'), 'i');

// trivial 신호: 오탈자·문구·rename·lint/format·주석·설정값 한두 개
const TRIVIAL_RE = new RegExp([
  '오탈자', '오타', '문구\\s*(수정|변경)', '텍스트\\s*(수정|변경)', '이름\\s*(변경|바꿔)', '리네임',
  '주석', '들여쓰기', '포맷', '서식', '색상\\s*(변경|바꿔)', '오탈',
  '誤字', '文言', 'リネーム', 'コメント', 'インデント',
  '\\btypo\\b', 'wording', 'rename', '\\blint\\b', 'eslint', 'prettier', 'format(ting)?\\b',
  'comment\\s*(fix|update|change)', 'indent', 'whitespace', 'spelling',
].join('|'), 'i');

// "A"를 "B"로 변경 / replace "A" with "B" — 전형적인 문구 치환(= trivial) 관용구
const REPLACE_IDIOM_RE = new RegExp([
  '["\'“”「][^"\'“”」]{1,80}["\'“”」]\\s*(?:을|를|은|는)?\\s*'
  + '["\'“”「][^"\'“”」]{1,80}["\'“”」]\\s*(?:으로|로)\\s*(?:변경|수정|바꿔|교체)',
  'replace\\s+["\'][^"\']{1,80}["\']\\s+(?:with|to)\\s+["\'][^"\']{1,80}["\']',
  '["\'「][^"\'」]{1,80}["\'」]\\s*(?:を)\\s*["\'「][^"\'」]{1,80}["\'」]\\s*(?:に)\\s*(?:変更|修正)',
].join('|'), 'i');

// 명시적 파일 경로 (a/b/c.ext 또는 확장자 붙은 토큰)
const PATH_RE = /[\w.\-/\\]+\.(?:js|ts|tsx|jsx|md|json|ya?ml|css|scss|html|py|ps1|sh|sql|txt|cs|java|go|rb|php)\b/gi;

const DESTRUCTIVE_RE = /(전부\s*삭제|모두\s*삭제|일괄\s*삭제|全削除|delete\s+all|remove\s+all|purge|wipe)/i;

function uniq(arr) { return Array.from(new Set(arr)); }

// ── giip-1068 (10): 변경 위험과 조회 위험 분리 ───────────────────────────────
// 1차 작업의 문제: "로그인 구조를 설명해줘" 처럼 읽기 전용 요청도 CRITICAL_RE 에 걸려
// critical 실행 작업으로 오인되고 최상위 모델이 붙었다. operation 을 따로 판정한다.

const OPERATIONS = ['read', 'write', 'delete', 'deploy', 'migrate'];

// 조회 동사(읽기 전용 신호)
const OP_READ_RE = new RegExp([
  '알려\\s*(줘|주세요|다오)?', '보여\\s*(줘|주세요)?', '설명해', '설명\\s*(줘|해줘|부탁)', '어디\\s*(에|있)',
  '있는지', '있나', '되어\\s*있는지', '돼\\s*있는지', '확인해', '조회해', '찾아\\s*(줘|봐)', '검색해',
  '무엇인지', '뭔지', '어떤지', '읽기\\s*전용', '분석해\\s*(줘)?', '리뷰해', '목록', '리스트',
  '教えて', '見せて', '説明して', 'どこ', '確認して', '検索して', '一覧',
  '\\bexplain\\b', '\\bshow\\b', '\\blist\\b', '\\bwhere\\b', '\\bwhich\\b', '\\bwhat\\b',
  '\\bfind\\b', '\\bsearch\\b', '\\bcheck\\b', '\\bread[- ]?only\\b', '\\breview\\b', '\\banaly[sz]e\\b',
].join('|'), 'i');

// 변경 동사
const OP_WRITE_RE = new RegExp([
  '수정', '변경', '바꿔', '고쳐', '고치', '추가', '생성', '작성', '만들', '구현', '적용',
  '리팩터', '리팩토', '개선', '교체', '치환', '이름\\s*(변경|바꿔)', '리네임',
  '修正', '変更', '追加', '作成', '実装', 'リファクタ',
  '\\bfix\\b', '\\bchange\\b', '\\bupdate\\b', '\\badd\\b', '\\bcreate\\b', '\\bwrite\\b',
  '\\bimplement\\b', '\\brefactor\\b', '\\brename\\b', '\\breplace\\b', '\\bedit\\b', '\\bpatch\\b',
].join('|'), 'i');

const OP_DELETE_RE = new RegExp([
  '삭제', '지워', '제거', '없애', '드롭',
  '削除', '除去',
  '\\bdelete\\b', '\\bremove\\b', '\\bdrop\\s+table\\b', '\\btruncate\\b', '\\bpurge\\b', '\\bwipe\\b',
  '\\brm\\s+-rf\\b', 'terraform\\s+destroy',
].join('|'), 'i');

const OP_DEPLOY_RE = new RegExp([
  '배포해', '배포\\s*(하|해|를|좀)', '릴리스', '릴리즈', '롤아웃', '반영해\\s*(줘)?\\s*(운영|프로덕션)',
  'デプロイ', 'リリース',
  '\\bdeploy\\b', '\\brelease\\b', '\\brollout\\b', '\\bship\\s+to\\s+prod',
].join('|'), 'i');

const OP_MIGRATE_RE = new RegExp([
  '마이그레이션', '마이그레이', '스키마\\s*(변경|수정|추가|적용)', '데이터\\s*이관', '이관해',
  'マイグレーション',
  '\\bmigrat(e|ion)\\b', '\\balter\\s+table\\b', '\\bddl\\b', '\\bbackfill\\b',
].join('|'), 'i');

// 운영/프로덕션 환경 신호(deploy 위험 판정용)
const PRODUCTION_RE = /(운영\s*(환경|서버|디비|db)|프로덕션|프로덕숀|본番|本番|\bproduction\b|\bprod\b)/i;

// 한국어/일본어는 주동사가 문장 끝에 온다. "결제 기능이 구현되어 있는지 확인해줘" 처럼
// 문장 안에 변경 동사(구현)가 들어 있어도 끝맺음이 조회 동사면 읽기 전용 요청이다(10.1).
const READ_TAIL_RE = new RegExp([
  '(확인|조회|알려|보여|설명|검색|파악|검토|분석|리뷰|찾아|정리)\\s*'
  + '(해|해줘|해주세요|줘|주세요|주라|봐|달라|드려|하라|하세요|해라|바랍니다|해봐|해 줘)?\\s*[.?!。？]*\\s*$',
  '(어디|어느\\s*(파일|폴더|경로|테이블)|무엇|뭔가요|뭐야|있나요|있어|있습니까|なに|どこ)\\s*[.?!。？]*\\s*$',
  '\\?\\s*$',
].join('|'), 'i');

function tailOf(text, chars = 40) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(l => l.trim());
  const last = lines.length ? lines[lines.length - 1].trim() : '';
  return last.slice(-chars);
}

/**
 * 요청의 조작 종류를 판정한다(10.2).
 * 우선순위: delete > deploy > migrate > write > read
 * 변경 동사가 있어도 문장이 조회로 끝나면 read (10.1 오탐 방지).
 */
function detectOperation(text) {
  const t = String(text || '');
  if (OP_DELETE_RE.test(t)) return 'delete';
  if (OP_DEPLOY_RE.test(t)) return 'deploy';
  if (OP_MIGRATE_RE.test(t)) return 'migrate';
  if (OP_WRITE_RE.test(t)) {
    return READ_TAIL_RE.test(tailOf(t)) ? 'read' : 'write';
  }
  if (OP_READ_RE.test(t)) return 'read';
  return 'read';   // 동사를 못 찾으면 가장 안전한 쪽(조회)으로 본다. 승격은 risk 규칙이 담당.
}

/**
 * 조회 위험도(risk_class). 실행 등급(task_class)과 분리된 값이다.
 *   critical — 보안/인증/결제/개인정보/운영DB/인프라 관련 주제
 *   elevated — 스키마/배포설정/마이그레이션/대량 삭제 등
 *   none     — 그 외
 */
function detectRiskClass(text) {
  const t = String(text || '');
  if (CRITICAL_RE.test(t)) return 'critical';
  if (MIN_COMPLEX_RE.test(t) || DESTRUCTIVE_RE.test(t)) return 'elevated';
  return 'none';
}

/** taskPlan(분석 결과 마크다운)에서 "영향 파일/서브시스템" 항목 수를 센다. */
function countPlanImpactFiles(taskPlan) {
  if (!taskPlan) return 0;
  const m = String(taskPlan).match(/##\s*영향\s*파일[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!m) return 0;
  return m[1].split(/\r?\n/).filter(l => /^\s*[-*]\s+\S/.test(l)).length;
}

/** 요청문에서 명시된 파일 경로들. */
function extractPaths(text) {
  return uniq(String(text || '').match(PATH_RE) || []).map(s => s.replace(/\\/g, '/'));
}

/**
 * 작업 난이도 분류. 정적 규칙만으로 판정하고, 애매하면(옵션으로 llm 이 주어졌을 때만)
 * 저비용 모델 1회를 호출해 보정한다.
 *
 * @param {string} requestText          사용자 요청 원문
 * @param {Array}  selectedContext      선택된 컨텍스트 파일 [{path, reason}]
 * @param {string} taskPlan             분석 단계 산출 계획(있으면)
 * @param {object} [opts]
 * @param {(prompt:string)=>string} [opts.llm]  저비용 모델 호출자(없으면 정적 판정만)
 * @returns {{class:string, confidence:number, reasons:string[], method:string,
 *            estimatedFiles:number, explicitPaths:string[], fastPathEligible:boolean}}
 */
function classifyTask(requestText, selectedContext = [], taskPlan = '', opts = {}) {
  const text = `${requestText || ''}\n${taskPlan || ''}`;
  const reasons = [];
  let cls = 'standard';
  let confidence = 0.5;
  let method = 'static';

  const explicitPaths = extractPaths(requestText);
  const planFiles = countPlanImpactFiles(taskPlan);
  const estimatedFiles = Math.max(explicitPaths.length, planFiles, 1);

  const hitCritical = CRITICAL_RE.test(text);
  const hitMinComplex = MIN_COMPLEX_RE.test(text);
  const hitComplex = COMPLEX_RE.test(text);
  const hitReplaceIdiom = REPLACE_IDIOM_RE.test(requestText || '');
  const hitTrivial = TRIVIAL_RE.test(text) || hitReplaceIdiom;
  const hitDestructive = DESTRUCTIVE_RE.test(text);

  // giip-1068 (10.2): 조작 종류와 조회 위험도를 실행 등급과 분리해 먼저 판정한다.
  // operation 은 사용자가 실제로 쓴 문장(requestText)으로 본다 — 계획서 본문의 동사에 끌려가지 않게.
  const operation = detectOperation(requestText || text);
  const riskClass = detectRiskClass(text);
  const isReadOnly = operation === 'read';

  if (hitCritical && !isReadOnly) {
    cls = 'critical';
    confidence = 0.9;
    reasons.push('보안/인증/결제/개인정보/운영DB/인프라 관련 키워드 검출 → 최소 critical');
  } else if (hitComplex || estimatedFiles > 3) {
    cls = 'complex';
    confidence = hitComplex ? 0.75 : 0.65;
    reasons.push(hitComplex ? '신규 기능/재설계/연동 등 광범위 변경 신호' : `변경 예상 파일 ${estimatedFiles}개(3개 초과)`);
  } else if (hitTrivial && estimatedFiles <= 3 && !hitDestructive) {
    cls = 'trivial';
    confidence = explicitPaths.length ? 0.88 : 0.7;
    reasons.push(hitReplaceIdiom
      ? '"A"를 "B"로 치환하는 단순 문구 수정'
      : '오탈자/문구/rename/lint/주석 등 저위험 변경 신호');
    if (explicitPaths.length) reasons.push(`대상 파일 경로가 요청에 명시됨(${explicitPaths.length}개)`);
  } else {
    cls = 'standard';
    confidence = isReadOnly && hitCritical ? 0.85 : 0.6;
    reasons.push(`변경 예상 파일 ${estimatedFiles}개`);
    reasons.push(isReadOnly && hitCritical
      ? '위험 주제이지만 읽기 전용(조회/설명) 요청 — 실행 등급은 올리지 않는다'
      : '보안/인증/DB 변경 신호 없음');
    reasons.push(isReadOnly ? '조회/설명 요청으로 판단' : '기존 기능의 제한된 수정으로 판단');
  }

  if (hitMinComplex && !isReadOnly) {
    const before = cls;
    cls = atLeast(cls, 'complex');
    if (cls !== before) reasons.push('마이그레이션/스키마/배포 설정 변경 → 최소 complex 로 승격');
  }
  if (hitDestructive && !isReadOnly) {
    const before = cls;
    cls = atLeast(cls, 'complex');
    if (cls !== before) reasons.push('대량 삭제 신호 → 최소 complex 로 승격');
  }

  // ── 10.2 operation × risk 규칙표 ────────────────────────────────────────────
  //  read   / 위험 없음  → standard 이하
  //  read   / 위험 있음  → standard 또는 complex
  //  write  / 보안·인증·결제 → critical
  //  delete / 주요 데이터·인프라 → critical
  //  deploy / 운영 환경   → critical
  //  migrate / 스키마·데이터 → complex 이상
  if (operation === 'read') {
    if (riskClass === 'none' && rank(cls) > rank('standard')) {
      cls = 'standard';
      reasons.push('읽기 전용 + 위험 신호 없음 → standard 이하로 제한(단순 조회에 프리미엄 모델 금지)');
    } else if (riskClass !== 'none' && rank(cls) > rank('complex')) {
      cls = 'complex';
      reasons.push('읽기 전용 요청은 위험 주제라도 critical 실행 등급으로 올리지 않는다(최대 complex)');
    }
  } else if (operation === 'write' && riskClass === 'critical') {
    if (cls !== 'critical') reasons.push('보안·인증·결제 영역의 변경(write) → critical');
    cls = 'critical';
  } else if (operation === 'delete' && (riskClass === 'critical' || hitDestructive)) {
    if (cls !== 'critical') reasons.push('주요 데이터·인프라 삭제(delete) → critical');
    cls = 'critical';
  } else if (operation === 'deploy' && (riskClass === 'critical' || PRODUCTION_RE.test(text))) {
    if (cls !== 'critical') reasons.push('운영 환경 배포(deploy) → critical');
    cls = 'critical';
  } else if (operation === 'migrate') {
    const before = cls;
    cls = riskClass === 'critical' ? 'critical' : atLeast(cls, 'complex');
    if (cls !== before) reasons.push('스키마·데이터 마이그레이션(migrate) → 최소 complex');
  }

  // 애매한 경우에만 저비용 모델 1회. Opus 는 절대 쓰지 않는다(호출자가 티어를 강제).
  if (confidence < 0.6 && typeof opts.llm === 'function') {
    const prompt = [
      '다음 개발 요청의 난이도를 trivial / standard / complex / critical 중 하나로만 분류하라.',
      'trivial=오탈자·문구·rename·lint·주석, standard=작은 버그/단일 API·화면 수정,',
      'complex=여러 파일/서브시스템·신규 기능, critical=보안·인증·결제·개인정보·운영DB·인프라.',
      '',
      '요청:',
      String(requestText || '').slice(0, 2000),
      '',
      '한 단어만 출력하라.',
    ].join('\n');
    try {
      const out = String(opts.llm(prompt) || '').toLowerCase();
      const found = ORDER.find(c => out.includes(c));
      if (found) {
        method = 'static+llm';
        // 정적 판정과 LLM 판정 중 높은 쪽을 취한다(안전 우선).
        const merged = atLeast(cls, found);
        if (merged !== cls) reasons.push(`저비용 모델 보조 분류(${found}) 반영`);
        cls = merged;
        confidence = 0.7;
      }
    } catch { /* 보조 분류 실패는 무시 — 정적 판정 유지 */ }
  }

  // 신뢰도가 낮으면 한 단계 높은 등급을 적용한다.
  if (confidence < 0.6 && cls !== 'critical') {
    cls = bump(cls);
    reasons.push(`신뢰도 낮음(${confidence.toFixed(2)}) → 한 단계 상향`);
  }

  // 읽기 전용 요청은 어떤 승격 경로로도 critical 이 되지 않는다(10.1 오탐 방지).
  if (isReadOnly && cls === 'critical') {
    cls = 'complex';
    reasons.push('읽기 전용 요청 — critical 실행 등급으로 승격하지 않음(Opus 라우팅 금지)');
  }

  const fastPathEligible = isFastPathEligible({
    taskClass: cls,
    explicitPaths,
    estimatedFiles,
    destructive: hitDestructive,
    operation,
    contextCount: (selectedContext || []).length,
  });

  return {
    class: cls,
    task_class: cls,
    risk_class: riskClass,
    operation,
    confidence: Math.round(confidence * 100) / 100,
    reasons: uniq(reasons),
    method,
    estimatedFiles,
    explicitPaths,
    fastPathEligible,
  };
}

/**
 * Fast Path(3.4) 적용 가능 여부. 아래를 모두 만족해야 한다.
 *  - trivial 등급
 *  - 변경 대상 1~3개 파일로 제한됨(요청에 경로가 명시돼 정적으로 특정 가능)
 *  - 인증/보안/결제/DB 스키마/배포 변경이 아님(= trivial 이면 이미 보장)
 *  - 삭제·대량 변경이 아님
 */
function isFastPathEligible({ taskClass, explicitPaths = [], estimatedFiles = 1, destructive = false, operation = 'write' }) {
  if (taskClass !== 'trivial') return false;
  if (destructive) return false;
  // giip-1068 10: 삭제/배포/마이그레이션은 등급과 무관하게 Fast Path 금지.
  if (['delete', 'deploy', 'migrate'].includes(operation)) return false;
  if (!explicitPaths.length) return false;            // 요구사항이 "명확"하다는 정적 근거
  if (explicitPaths.length > 3) return false;
  if (estimatedFiles > 3) return false;
  return true;
}

// ── 모델 선택 ────────────────────────────────────────────────────────────────
// phase: 'classify' | 'context' | 'plan' | 'execute' | 'review'
const PHASES = ['classify', 'context', 'plan', 'execute', 'review'];

/**
 * 작업 등급 + 단계 → 사용할 티어/모델.
 *
 * @param {string} taskClass trivial|standard|complex|critical
 * @param {string} phase
 * @param {{minimax?:boolean, claude?:boolean}} [availableProviders]
 * @returns {{tier:string, model:string, provider:string, fallback:{provider:string,model:string},
 *            premiumAllowed:boolean, reasons:string[]}}
 */
function selectModel(taskClass, phase, availableProviders = {}) {
  const providers = { minimax: true, claude: true, ...availableProviders };
  const cls = ORDER.includes(taskClass) ? taskClass : 'standard';
  const ph = PHASES.includes(phase) ? phase : 'execute';
  const reasons = [];

  let tier;
  if (ph === 'classify' || ph === 'context') {
    // 분류·컨텍스트 선별은 언제나 최저 비용 티어. critical 이라도 Opus 를 쓰지 않는다.
    tier = 'trivial';
    reasons.push('분류/컨텍스트 선별 단계 — 저비용 티어 고정(프리미엄 모델 금지)');
  } else if (cls === 'trivial') {
    tier = 'trivial';
    reasons.push('trivial 작업 — 저가 모델 단일 호출');
  } else if (cls === 'standard') {
    tier = ph === 'plan' ? 'planner' : 'standard';
    reasons.push('standard 작업 — MiniMax/중간급 우선');
  } else if (cls === 'complex') {
    tier = 'complex';
    reasons.push('complex 작업 — 계획·실행 모두 중간급 모델');
  } else { // critical
    if (ph === 'plan' || ph === 'review') {
      tier = 'critical';
      reasons.push('critical 작업의 계획/최종 검토 — 최상위 모델 허용');
    } else {
      tier = 'complex';
      reasons.push('critical 작업이지만 탐색/실행 단계 — 중간급 모델(최상위 모델은 계획/검토에만)');
    }
  }

  const token = modelConfig.modelForTier(tier);
  const fallbackTier = cls === 'critical' ? 'critical' : 'standard';
  const fallbackModel = modelConfig.fallbackModelForTier(fallbackTier);

  let provider, model;
  if (modelConfig.isMiniMaxToken(token)) {
    if (providers.minimax) {
      provider = 'minimax';
      model = null; // 실제 모델명은 minimax-accounts.resolve() 가 결정
    } else {
      provider = 'claude';
      model = fallbackModel;
      reasons.push('MiniMax 미설정/쿨다운 → Claude 폴백 모델 사용');
    }
  } else {
    provider = 'claude';
    model = token;
  }

  // 안전 요구사항 4: critical 작업을 무조건 저가 모델로 실행하지 않는다.
  // (실행 단계는 중간급까지 허용하되, 저가(trivial) 티어로 내려가지 않게 가드)
  const premiumAllowed = cls === 'critical' && (ph === 'plan' || ph === 'review');

  return {
    tier,
    provider,
    model,
    fallback: { provider: 'claude', model: fallbackModel },
    premiumAllowed,
    reasons,
  };
}

/**
 * 실패로 인한 승격. complex/critical 에서 중간급이 반복 실패했을 때만 최상위 모델을 허용한다.
 * (그 외 등급은 승격하지 않는다 — Opus 고정 호출 방지)
 */
function escalateOnFailure(taskClass, attempt) {
  if (attempt < 2) return null;
  if (taskClass !== 'complex' && taskClass !== 'critical') return null;
  return {
    provider: 'claude',
    model: modelConfig.fallbackModelForTier('critical'),
    reason: `${taskClass} 작업이 ${attempt}회 실패 → 최상위 모델로 승격`,
  };
}

module.exports = {
  ORDER,
  PHASES,
  OPERATIONS,
  detectOperation,
  detectRiskClass,
  classifyTask,
  selectModel,
  escalateOnFailure,
  isFastPathEligible,
  extractPaths,
  REPLACE_IDIOM_RE,
  countPlanImpactFiles,
};
