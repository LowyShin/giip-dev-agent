/**
 * prompt-templates.js — 고정 prefix 를 갖는 프롬프트 중앙 관리 (giip-1063 3.6 / giip-1068 4)
 *
 * 프롬프트 캐시가 지원되는 모델에서 캐시 적중률을 높이려면, 매 호출마다 바뀌는 값이
 * 프롬프트 앞부분에 있으면 안 된다. 그래서 아래 순서를 강제한다.
 *
 *   1. 고정 시스템 역할
 *   2. 고정 안전 규칙
 *   3. 고정 실행 프로토콜
 *   4. 선택한 SKILL 및 role/rule 컨텍스트
 *   5. 프로젝트 정보
 *   6. 태스크 내용
 *   7. checkpoint 및 동적 상태  ← 현재 시각/taskID/브랜치/재시도 번호/변경 파일은 전부 여기
 *
 * giip-1068: 최초 실행과 fallback 재개를 완전히 다른 함수로 분리했다.
 *   buildInitialExecutionPrompt() — 전체 태스크 사양 + 선택 컨텍스트 전체
 *   buildResumeExecutionPrompt()  — 태스크 "요약" + 재개 전용 컨텍스트(최대 3개) + 진행 상태
 * 재개 프롬프트는 최초 프롬프트의 60% 를 넘지 않도록 조립 단계에서 잘라낸다.
 *
 * 템플릿을 바꿀 때만 PROMPT_VERSION 을 올린다.
 */

const modelConfig = require('./model-config');

const PROMPT_VERSION = 'fde-cost-v2';

// ── 1. 고정 시스템 역할 ──────────────────────────────────────────────────────
const SYSTEM_ROLE = `You are a senior software engineer working in a GIIP FDE Agent workspace.
You execute one prepared task at a time inside an already-prepared git branch.`;

// ── 2. 고정 안전 규칙 ────────────────────────────────────────────────────────
const SAFETY_RULES = `=== 안전 규칙 (고정) ===
- 요청 범위 밖의 파일을 고치지 마라. 사용자의 기존 작업 트리 변경을 덮어쓰지 마라.
- git 커밋·push·PR·브랜치 전환은 절대 하지 마라. 브랜치는 이미 준비돼 있고, 봇이 종료 후 자동으로
  커밋·push·PR 을 처리한다. 직접 git 을 만지면 브랜치/PR 흐름이 깨진다.
- .env 내용, API key, 토큰, 인증정보를 출력·로그·보고서에 남기지 마라.
- 비용 절감을 이유로 테스트와 검증을 생략하지 마라. 최소 1건의 재현 검증을 반드시 수행하라.
- 실패를 성공으로 보고하지 마라. 부분 완료면 부분 완료라고 써라.`;

// ── 재개 전용 안전 규칙 (giip-1068 4.4-2) ────────────────────────────────────
const RESUME_SAFETY_RULES = `=== 재개 전용 안전 규칙 (고정) ===
- 아래 "완료된 단계"를 다시 실행하지 마라. 완료 단계의 재실행은 0회여야 한다.
- 아래 "이미 변경한 파일"을 전면 재작성하지 마라. 필요한 부분만 이어서 고쳐라.
- 작업 트리의 기존 변경은 이전 시도의 결과다. 되돌리거나 덮어쓰지 마라.
- 태스크 전체 사양이 아니라 아래 "태스크 요약"과 "미완료 단계"만 근거로 이어서 진행하라.
  더 자세한 사양이 정말 필요하면 태스크 파일 경로를 직접 읽어라(프롬프트에 다시 싣지 않는다).
- git 커밋·push·PR·브랜치 전환은 하지 마라. .env/API key/토큰을 출력하지 마라.
- 실패를 성공으로 보고하지 마라.`;

// ── 5.5 진행 이벤트 기록 규칙 (고정) ─────────────────────────────────────────
const PROGRESS_EVENT_RULES = `=== 진행 이벤트 기록 (고정, 필수) ===
각 중요 단계가 끝날 때 진행 이벤트를 기록하라. 이 기록이 없으면 중간에 실패했을 때 다음 모델이
처음부터 다시 하게 되어 비용이 두 배로 든다.

필수 기록 시점:
1. 계획 단계 시작        → --type step_started
2. 각 계획 단계 완료      → --type step_completed
3. 파일을 처음 읽었을 때   → --type file_read
4. 파일을 실제로 변경했을 때 → --type file_changed
5. 명령이나 테스트를 실행했을 때 → --type command_run / --type test_result
6. 중요한 판단을 했을 때   → --type decision
7. 막힘이 발생했을 때     → --type blocked

JSON 파일을 직접 편집하지 말고 반드시 아래 전용 CLI 를 써라(입력 검증·비밀값 마스킹이 들어 있다).

  node <slack-bot>/tools/progress-event.js --task <task-id> --attempt <n> --type <type> \\
    --step <step-id> --path <상대경로> --summary "<한 줄 요약>"

정확한 명령은 아래 "동적 상태" 절의 progress_event_command 를 그대로 쓴다.
--path 는 저장소 기준 상대경로로 적는다(절대경로 금지). --summary 는 500자 이내.`;

// ── 3. 고정 실행 프로토콜 ────────────────────────────────────────────────────
const EXECUTION_PROTOCOL = `=== 실행 프로토콜 (고정) ===
0. 되묻지 말고 실측하라. 경로·설정·사양처럼 조회로 확정 가능한 값은 사용자에게 다시 묻지 말고 직접 찾아 결정한다.
   - giip 서비스 설정(SMTP·메일·인증 등)의 정본은 giipdb 사양서(giipprj/giipdb/docs/30_Specs/)와 DB다.
     사람에게 묻기 전에 그곳부터 조회하라. 예: SMTP 설정은 tEmailServerConfig 테이블에 있고 giip API
     EmailServerConfigGetActive(SP pApiEmailServerConfigGetActivebyAK, 서버측 bySk)로 조회한다.
   - 정말로 사람만 아는 값(외부 자격증명 실물, 사용자의 의도적 선택)만 질문한다.
1. 아래 "태스크" 절의 실행 계획을 순서대로 수행한다.
2. Read/Edit/Write/Bash 도구로 지정된 작업 디렉터리 안에서 실제 코드 변경을 수행한다.
3. 아래 "동적 상태" 절에 giip issue 번호가 있으면 진행 코멘트 프로토콜을 따른다:
   진행 상황을 논리 묶음 단위로 1~3줄씩 자주 남긴다(같은 내용 연타 금지). 남기는 시점 —
     (1) 착수: 로드해서 따르는 role/rule/skill/workflow 명시
     (2) 참조 정본 변경: 규칙 파일 자체를 고칠 때 무엇을 왜
     (3) 대상 파일 변경: 수정/생성/삭제한 파일마다 경로 + 한 줄
     (4) 검색 발생: 왜 검색했고 결과를 어디에 링크로 흡수했는지
     (5) 분기·막힘·판단: 에러, 사람 확인 필요, 중요한 설계 판단
     (6) 완료 직전(필수): (a) 테스트 결과 — 무엇을 어떻게 실행/재현해 검증했고 결과가 무엇인지
         (커맨드·종료코드·출력 요약. 테스트가 없으면 수행한 수동 재현 절차와 결과. "테스트 없음"만
         쓰고 넘어가지 말 것) (b) 사용자 테스트 방법 — 사람이 직접 확인할 재현 가능한 구체 절차.
   중간 진행 코멘트는 issuetype=note 로 남기고, 상태 전이는 봇이 하므로 여기서 바꾸지 않는다.
4. 모든 단계 완료 후 아래 "동적 상태" 절이 지정한 경로에 결과 보고서를 작성한다. 형식:
   ---
   # 작업 완료 보고서: [태스크 제목]
   ## 완료 일시
   (ISO8601 현재 시각)
   ## 실시 내용
   (실제 수행한 작업의 상세 설명)
   ## 변경 파일
   - path/to/file — 변경 내용 요약
   ## 결과/상태
   (성공 / 부분 완료 / 실패, 이유)
   ## 다음 단계
   (후속 작업이 필요한 경우 명기)
   ---`;

// Fast Path(trivial) 전용 고정 프로토콜 — 컨텍스트 선택/계획/실행을 한 번에 끝낸다.
const FAST_PATH_PROTOCOL = `=== Fast Path 실행 프로토콜 (고정, 단순 작업 전용) ===
이 태스크는 저위험·소범위(trivial)로 정적 분류됐다. 별도 계획 생성 호출 없이 이 한 번의 호출에서
확인 → 수정 → 검증 → 보고까지 끝낸다. 다만 아래는 생략하지 않는다.
1. 변경 전 대상 파일을 반드시 먼저 읽어 현재 내용을 확인한다.
2. 요청 범위 밖의 수정은 하지 않는다(리팩터링·포맷 정리 등 "겸사겸사" 금지).
3. 변경 후 테스트 또는 재현 검증을 수행한다(테스트가 없으면 diff 확인 + 실제 동작 재현).
4. 결과 보고서를 작성한다.
5. 작업이 위 범위를 넘어선다고 판단되면(3개 초과 파일, 인증/보안/DB/배포 변경, 삭제·대량 변경)
   즉시 중단하고 결과 보고서에 "Fast Path 부적합 — 일반 경로로 승격 필요"라고 명시하라.`;

// 재개 전용 실행 프로토콜 — 전체 프로토콜을 다시 싣지 않는다(길이 절감).
const RESUME_PROTOCOL = `=== 재개 실행 프로토콜 (고정) ===
1. 아래 "미완료 단계"의 첫 항목부터 이어서 수행한다. 완료된 단계는 건너뛴다.
2. "이미 변경한 파일"은 현재 작업 트리에 그대로 있다. 필요하면 읽어서 확인만 하고 다시 쓰지 마라.
3. 테스트 단계에서 실패했다면 구현을 처음부터 다시 하지 말고 실패한 검증부터 처리한다.
4. 진행 이벤트를 계속 기록한다(아래 progress_event_command).
5. 완료되면 "동적 상태"의 result_report_path 에 결과 보고서를 작성한다. 이전 시도에서 이미
   보고서가 있으면 새로 쓰지 말고 이어서 갱신한다.`;

function section(title, body) {
  return body && String(body).trim() ? `\n\n${title}\n${String(body).trim()}` : '';
}

// ── 태스크 사양 축약 (4.4) ───────────────────────────────────────────────────
const TASK_SUMMARY_LIMITS = {
  purposeChars: 500,
  successConditions: 10,
  impactTargets: 20,
  prohibitions: 10,
  totalChars: 3000,
};

function bulletItems(block, max) {
  if (!block) return [];
  return String(block)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^(\d+[.)]|[-*•])\s+\S/.test(l))
    .map(l => l.replace(/^(\d+[.)]|[-*•])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function sectionBody(text, headingRe) {
  const m = String(text || '').match(headingRe);
  return m ? m[1] : '';
}

/**
 * 전체 태스크 사양 → 재개 프롬프트용 요약(4.4).
 * 전체 taskContent 를 그대로 싣지 않기 위한 핵심 함수. 전체 상한 3,000자.
 */
function summarizeTaskSpec(taskContent, opts = {}) {
  const lim = { ...TASK_SUMMARY_LIMITS, ...(opts.limits || {}) };
  const text = String(taskContent || '');
  // frontmatter 는 재개에 필요 없다(경로/등급은 동적 상태 절에 따로 들어간다).
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

  const title = (body.match(/^#\s*TASK:\s*(.+)$/m) || body.match(/^#\s+(.+)$/m) || [, ''])[1] || '';

  let purpose = sectionBody(body, /##\s*(?:요청\s*내용|목적|概要|Request)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i).trim();
  if (!purpose) {
    purpose = body.replace(/^#[^\n]*\n/, '').split(/\n##\s/)[0].trim();
  }
  purpose = `${title ? `${title} — ` : ''}${purpose}`.replace(/\s+/g, ' ').trim().slice(0, lim.purposeChars);

  const success = bulletItems(
    sectionBody(body, /##\s*(?:실행\s*계획|성공\s*조건|완료\s*조건|Steps?|Plan)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i),
    lim.successConditions);
  const impact = bulletItems(
    sectionBody(body, /##\s*(?:영향\s*파일[^\n]*|영향\s*대상|대상\s*파일|Impact)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i),
    lim.impactTargets);
  const prohibitions = bulletItems(
    sectionBody(body, /##\s*(?:주의사항|금지사항|제약|Notes?|Caution)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i),
    lim.prohibitions);

  const lines = ['## 태스크 요약'];
  lines.push(`- 목적: ${purpose || '(태스크 파일 참조)'}`);
  if (success.length) {
    lines.push('- 성공 조건:');
    success.forEach((s, i) => lines.push(`  ${i + 1}. ${s.slice(0, 200)}`));
  }
  if (impact.length) {
    lines.push('- 영향 대상:');
    impact.forEach(s => lines.push(`  - ${s.slice(0, 200)}`));
  }
  if (prohibitions.length) {
    lines.push('- 금지사항:');
    prohibitions.forEach(s => lines.push(`  - ${s.slice(0, 200)}`));
  }

  let out = lines.join('\n');
  if (out.length > lim.totalChars) out = `${out.slice(0, lim.totalChars - 20)}\n…(요약 상한 초과)`;
  return out;
}

// ── 길이 상한 적용 ───────────────────────────────────────────────────────────
/**
 * 조립된 파트들을 예산 안으로 줄인다. 우선순위가 낮은 파트부터 잘라낸다.
 * 고정 파트(역할/안전규칙/프로토콜/동적 상태)는 자르지 않는다.
 */
const MIN_RESUME_PROMPT_CHARS = 3000;

const RESUME_TRIM_ORDER = [
  'resume_context', 'diff_summary', 'files_read', 'prev_error',
  'commands', 'test_results', 'decisions', 'task_summary', 'files_changed', 'completed_steps',
];

function joinParts(parts) {
  return parts.filter(p => p.text && String(p.text).trim()).map(p => p.text).join('');
}

function fitParts(parts, budget, trimOrder) {
  let out = joinParts(parts);
  if (out.length <= budget) return { text: out, trimmed: [] };
  const trimmed = [];
  for (const name of trimOrder) {
    if (out.length <= budget) break;
    const p = parts.find(x => x.name === name && x.text && x.text.length > 0);
    if (!p) continue;
    const over = out.length - budget;
    if (p.text.length <= over + 60) { p.text = ''; }
    else { p.text = `${p.text.slice(0, p.text.length - over - 40)}\n…(길이 제한으로 생략)`; }
    trimmed.push(name);
    out = joinParts(parts);
  }
  if (out.length > budget) out = `${out.slice(0, budget - 30)}\n…(프롬프트 상한 초과分 생략)`;
  return { text: out, trimmed };
}

// ── 최초 실행 프롬프트 (4.3) ─────────────────────────────────────────────────
/**
 * 최초 실행 프롬프트. 1~3 은 완전히 고정된 문자열이므로 태스크가 달라도 prefix 가 동일하다.
 *
 * @param {object} p
 *  - fastPath        {boolean} Fast Path 프로토콜 사용
 *  - contextText     {string}  선택된 SKILL/role/rule 본문(선별·축약 완료)
 *  - contextFiles    {Array}   [{path, reason}] — 목록 표시용
 *  - projectName, baseDir, langName, baseBranch  {string} 프로젝트 정보
 *  - taskContent     {string}  태스크 사양(계획 포함)
 *  - kLayerClaims    {string[]}
 *  - taskId, branch, resultFile, isn, addCommentScript, attempt, taskClass, now
 *  - progressEventCommand {string|null}
 *  - resumeInstruction {string|null} (하위 호환 — 재개는 buildResumeExecutionPrompt 를 쓸 것)
 */
function buildInitialExecutionPrompt(p = {}) {
  const parts = [];
  const push = (name, text) => parts.push({ name, text });

  // 1~3: 고정
  push('role', SYSTEM_ROLE);
  push('version', `\nprompt_version: ${PROMPT_VERSION}`);
  push('safety', `\n${SAFETY_RULES}`);
  push('protocol', `\n${p.fastPath ? FAST_PATH_PROTOCOL : EXECUTION_PROTOCOL}`);
  push('progress_rules', `\n\n${PROGRESS_EVENT_RULES}`);

  // 4: 선택된 컨텍스트 (같은 태스크를 재시도해도 동일 → 재시도 간 캐시 적중)
  push('context', section('=== 선택된 컨텍스트 (role/rule/skill — 이 태스크에 관련된 것만) ===',
    p.contextText || '(선택된 컨텍스트 없음 — 최소 기본 규칙만 적용)'));
  if (Array.isArray(p.contextFiles) && p.contextFiles.length) {
    push('context_reasons', section('=== 컨텍스트 선택 사유 ===',
      p.contextFiles.map(f => `- ${f.path} — ${f.reason}`).join('\n')));
  }

  // 5: 프로젝트 정보
  push('project', section('=== 프로젝트 정보 ===', [
    `project: ${p.projectName || '(unknown)'}`,
    `working_directory: ${p.baseDir || ''}`,
    `base_branch: ${p.baseBranch || ''}`,
    `response_language: ${p.langName || 'Korean'} (always respond in this language)`,
  ].join('\n')));

  // 6: 태스크 내용
  push('task', section('=== 태스크 ===', p.taskContent || ''));
  if (Array.isArray(p.kLayerClaims) && p.kLayerClaims.length) {
    push('klayer', section('=== K-Layer 지식 ===', p.kLayerClaims.map(c => `• ${c}`).join('\n')));
  }

  // 7: 동적 상태 (매 호출 달라지는 값은 전부 여기)
  push('dynamic', section('=== 동적 상태 ===', dynamicState(p).join('\n')));

  if (p.resumeInstruction) {
    push('resume_legacy', section('=== 이어서 재개 (checkpoint) ===', p.resumeInstruction));
  }

  push('tail', '\n\n지금 바로 작업을 시작하세요.');

  const budget = (p.limits && p.limits.initialMaxChars)
    || modelConfig.promptLimits(p.taskClass).initialMaxChars;
  const { text, trimmed } = fitParts(parts, budget,
    ['context', 'klayer', 'task', 'context_reasons']);
  if (trimmed.length) {
    console.warn(`[prompt] 최초 프롬프트가 ${p.taskClass || 'standard'} 상한(${budget}자)을 넘어 축약: ${trimmed.join(', ')}`);
  }
  return text;
}

function dynamicState(p) {
  const dyn = [
    `task_id: ${p.taskId || ''}`,
    `task_class: ${p.taskClass || 'standard'}`,
    `current_branch: ${p.branch || ''}`,
    `attempt: ${p.attempt || 1}`,
    `now: ${p.now || new Date().toISOString()}`,
    `result_report_path: ${p.resultFile || ''}`,
  ];
  if (p.progressEventCommand) dyn.push(`progress_event_command: ${p.progressEventCommand}`);
  if (p.isn) {
    dyn.push(`giip_isn: ${p.isn}`);
    if (p.addCommentScript) {
      dyn.push(`progress_comment_command: pwsh -File "${p.addCommentScript}" -isn ${p.isn} -content "<본문>" -issuetype note -author "slack-bot"`);
    }
  }
  return dyn;
}

// ── 재개 프롬프트 (4.4) ──────────────────────────────────────────────────────
function listBlock(items, max, prefix = '  - ') {
  const list = (items || []).slice(0, max);
  if (!list.length) return '';
  const extra = (items || []).length > max ? `\n${prefix}…외 ${(items || []).length - max}건` : '';
  return list.map(i => `${prefix}${typeof i === 'string' ? i : JSON.stringify(i)}`).join('\n') + extra;
}

/**
 * fallback 재개 프롬프트. 전체 taskContent 와 최초 선택 컨텍스트 전체를 절대 싣지 않는다.
 *
 * @param {object} p
 *  - taskSummary        {string}   summarizeTaskSpec() 결과 (없으면 taskContent 로부터 생성)
 *  - taskContent        {string}   (taskSummary 미지정 시 축약용)
 *  - completedSteps     {string[]}
 *  - pendingSteps       {string[]}
 *  - filesRead          {string[]}
 *  - filesChanged       {string[]} 실제 소스 변경 파일(상대경로)
 *  - diffSummary        {string}
 *  - commandsRun        {string[]}
 *  - testResults        {Array}
 *  - decisions          {string[]}
 *  - blocked            {string[]}
 *  - errorSummary       {string}
 *  - resumeContextText  {string}   resume-context-builder 결과 (최대 3~4개 파일)
 *  - resumeContextFiles {Array}
 *  - taskClass, taskId, branch, attempt, now, resultFile, isn, addCommentScript,
 *    projectName, baseBranch, langName, progressEventCommand
 *  - initialPromptChars {number}   최초 프롬프트 길이(60% 규칙 적용용)
 */
function buildResumeExecutionPrompt(p = {}) {
  const parts = [];
  const push = (name, text) => parts.push({ name, text });

  // 1~2: 고정 역할 + 재개 전용 안전 규칙
  push('role', SYSTEM_ROLE);
  push('version', `\nprompt_version: ${PROMPT_VERSION} (resume)`);
  push('safety', `\n${RESUME_SAFETY_RULES}`);
  push('protocol', `\n\n${RESUME_PROTOCOL}`);

  // 3: 태스크 요약 (전체 사양 아님)
  const summary = p.taskSummary || summarizeTaskSpec(p.taskContent || '');
  push('task_summary', section('=== 태스크 요약 (전체 사양 아님) ===', summary));

  // 4~5: 완료 / 미완료 단계
  push('completed_steps', section('=== 완료된 단계 (다시 하지 마라) ===',
    listBlock(p.completedSteps, 30) || '(기록된 완료 단계 없음)'));
  push('pending_steps', section('=== 미완료 단계 (여기부터 이어서) ===',
    listBlock(p.pendingSteps, 30) || '(진행 이벤트에 미완료 단계 기록 없음 — 변경 파일과 오류로 판단하라)'));

  // 6~7: 이미 읽은 파일 / 이미 변경한 파일
  push('files_read', section('=== 이미 읽은 파일 (다시 통독하지 마라) ===', listBlock(p.filesRead, 40)));
  push('files_changed', section('=== 이미 변경한 파일 (전면 재작성 금지) ===',
    listBlock(p.filesChanged, 40) || '(실제 소스 변경 없음)'));

  // 8: 변경 diff 요약
  push('diff_summary', section('=== 변경 diff 요약 ===', p.diffSummary || ''));

  // 9~10: 실행한 명령 / 테스트 결과
  push('commands', section('=== 실행한 명령 ===', listBlock(p.commandsRun, 20)));
  push('test_results', section('=== 테스트 결과 ===',
    listBlock((p.testResults || []).map(t => (typeof t === 'string'
      ? t
      : `${t.command || '(명령 미기재)'} → ${t.status || 'unknown'}${t.summary ? ` — ${t.summary}` : ''}`)), 20)));
  push('decisions', section('=== 이전 판단 / 막힘 ===',
    [listBlock(p.decisions, 10), listBlock(p.blocked, 10, '  ! ')].filter(Boolean).join('\n')));

  // 11: 이전 오류
  push('prev_error', section('=== 이전 오류 (마스킹됨) ===',
    p.errorSummary ? String(p.errorSummary).slice(-1200) : ''));

  // 12: 재개에 필요한 컨텍스트만
  push('resume_context', section('=== 재개 컨텍스트 (최초 선택 전체가 아니라 재개에 필요한 것만) ===',
    p.resumeContextText || ''));
  if (Array.isArray(p.resumeContextFiles) && p.resumeContextFiles.length) {
    push('resume_context_reasons', section('=== 재개 컨텍스트 선택 사유 ===',
      p.resumeContextFiles.map(f => `- ${f.path} — ${f.reason}`).join('\n')));
  }

  // 13: 현재 동적 상태
  push('dynamic', section('=== 동적 상태 ===', [
    ...dynamicState(p),
    `prompt_type: resume`,
    p.taskFilePath ? `task_spec_file: ${p.taskFilePath} (필요할 때만 직접 읽어라)` : '',
  ].filter(Boolean).join('\n')));

  push('tail', '\n\n미완료 단계부터 즉시 이어서 작업하세요.');

  const limits = p.limits || modelConfig.promptLimits(p.taskClass);
  let budget = limits.resumeMaxChars;
  const initialChars = Number(p.initialPromptChars) || 0;
  if (initialChars > 0) {
    // 60% 규칙(2.2). 다만 고정 역할·안전규칙·프로토콜이 잘려나갈 정도로 작아지지는 않게 바닥을 둔다.
    // 바닥(3,000자)이 실제로 걸리는 구간(최초 5,000자 미만)은 2.2 의 "12,000자 이하" 예외 구간이라
    // 애초에 재개 프롬프트 대신 동일 프롬프트 재사용이 허용된다(판정은 task-manager).
    budget = Math.max(MIN_RESUME_PROMPT_CHARS,
      Math.min(budget, Math.floor(initialChars * limits.resumeMaxRatio)));
  }
  const { text, trimmed } = fitParts(parts, budget, RESUME_TRIM_ORDER);
  if (trimmed.length) {
    console.log(`[prompt] 재개 프롬프트를 ${budget}자 예산에 맞춰 축약: ${trimmed.join(', ')}`);
  }
  return text;
}

/** 하위 호환. 기존 호출부는 최초 실행 프롬프트를 만든다. */
function buildExecutionPrompt(options) {
  return buildInitialExecutionPrompt(options);
}

// ── 분석(계획) 프롬프트 ──────────────────────────────────────────────────────
const ANALYSIS_ROLE = `You are a senior software architect. You turn one Slack request into a concrete,
minimal task specification. Do not expand the scope beyond what was asked.`;

const ANALYSIS_FORMAT = `Output a task specification in this EXACT format (in the response language below):

# TASK: [짧은 제목]

## 요청 내용
[요청 요약 — 1~2줄]

## 실행 계획
1. [구체적인 실행 단계]
2. [단계 2]
3. [단계 3]
(최대 7단계)

## 영향 파일/서브시스템
- [변경될 파일 또는 서브시스템]

## 주의사항
- [배포 주의사항, 부작용 등]

Output ONLY the task specification, no extra commentary.`;

function buildAnalysisPrompt(p = {}) {
  const out = [];
  out.push(ANALYSIS_ROLE);
  out.push(`\nprompt_version: ${PROMPT_VERSION}`);
  out.push(`\n\n${ANALYSIS_FORMAT}`);
  out.push(section('=== 선택된 컨텍스트 (role/rule/skill — 이 요청에 관련된 것만) ===', p.contextText || ''));
  out.push(section('=== 프로젝트 정보 ===', [
    `project: ${p.projectName || '(unknown)'}`,
    `working_directory: ${p.baseDir || ''}`,
    `response_language: ${p.langName || 'Korean'}`,
  ].join('\n')));
  if (Array.isArray(p.kLayerClaims) && p.kLayerClaims.length) {
    out.push(section('=== K-Layer 관련 지식 ===', p.kLayerClaims.map(c => `• ${c}`).join('\n')));
  }
  out.push(section('=== 요청 ===', p.requestText || ''));
  return out.join('');
}

/** 컨텍스트 큐레이션 프롬프트(저비용 티어 전용). */
function buildContextSelectionPrompt(p = {}) {
  return [
    '너는 개발 요청을 수행하기 위해 참조해야 할 컨텍스트 파일(role/rule/skill)을 고르는 큐레이터다.',
    `prompt_version: ${PROMPT_VERSION}`,
    '',
    '규칙: 실제로 관련 있는 파일만 고른다(보통 2~6개, 최대 8개). 무관한 파일은 넣지 않는다.',
    '각 파일에 대해 "이 태스크에서 그 파일의 무엇을 참조/적용하려는지"를 한국어 한 줄 사유로 적는다.',
    '아래 JSON 배열만 출력한다(코드펜스·설명 금지):',
    '[{"path":"<목록의 정확한 경로>","reason":"<한 줄 사유>"}]',
    '',
    '=== 사용 가능한 컨텍스트 파일 (이름/설명/trigger 만) ===',
    p.catalogText || '',
    '',
    '=== 요청 ===',
    p.requestText || '',
  ].join('\n');
}

module.exports = {
  PROMPT_VERSION,
  SYSTEM_ROLE,
  SAFETY_RULES,
  RESUME_SAFETY_RULES,
  PROGRESS_EVENT_RULES,
  EXECUTION_PROTOCOL,
  RESUME_PROTOCOL,
  FAST_PATH_PROTOCOL,
  ANALYSIS_ROLE,
  ANALYSIS_FORMAT,
  TASK_SUMMARY_LIMITS,
  MIN_RESUME_PROMPT_CHARS,
  summarizeTaskSpec,
  buildInitialExecutionPrompt,
  buildResumeExecutionPrompt,
  buildExecutionPrompt,
  buildAnalysisPrompt,
  buildContextSelectionPrompt,
};
