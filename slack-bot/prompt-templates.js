/**
 * prompt-templates.js — 고정 prefix 를 갖는 프롬프트 중앙 관리 (giip-1063, 3.6)
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
 * 템플릿을 바꿀 때만 PROMPT_VERSION 을 올린다.
 */

const PROMPT_VERSION = 'fde-cost-v1';

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

function section(title, body) {
  return body && String(body).trim() ? `\n\n${title}\n${String(body).trim()}` : '';
}

/**
 * 실행 프롬프트. 1~3 은 완전히 고정된 문자열이므로 태스크가 달라도 prefix 가 동일하다.
 *
 * @param {object} p
 *  - fastPath        {boolean} Fast Path 프로토콜 사용
 *  - contextText     {string}  선택된 SKILL/role/rule 본문(선별·축약 완료)
 *  - contextFiles    {Array}   [{path, reason}] — 목록 표시용
 *  - projectName, baseDir, langName, baseBranch  {string} 프로젝트 정보
 *  - taskContent     {string}  태스크 사양(계획 포함)
 *  - kLayerClaims    {string[]}
 *  - taskId, branch, resultFile, isn, addCommentScript, attempt, taskClass, now
 *  - resumeInstruction {string|null} checkpoint 재개 지시문
 */
function buildExecutionPrompt(p = {}) {
  const out = [];

  // 1~3: 고정
  out.push(SYSTEM_ROLE);
  out.push(`\nprompt_version: ${PROMPT_VERSION}`);
  out.push(`\n${SAFETY_RULES}`);
  out.push(`\n${p.fastPath ? FAST_PATH_PROTOCOL : EXECUTION_PROTOCOL}`);

  // 4: 선택된 컨텍스트 (같은 태스크를 재시도해도 동일 → 재시도 간 캐시 적중)
  out.push(section('=== 선택된 컨텍스트 (role/rule/skill — 이 태스크에 관련된 것만) ===',
    p.contextText || '(선택된 컨텍스트 없음 — 최소 기본 규칙만 적용)'));
  if (Array.isArray(p.contextFiles) && p.contextFiles.length) {
    out.push(section('=== 컨텍스트 선택 사유 ===',
      p.contextFiles.map(f => `- ${f.path} — ${f.reason}`).join('\n')));
  }

  // 5: 프로젝트 정보
  out.push(section('=== 프로젝트 정보 ===', [
    `project: ${p.projectName || '(unknown)'}`,
    `working_directory: ${p.baseDir || ''}`,
    `base_branch: ${p.baseBranch || ''}`,
    `response_language: ${p.langName || 'Korean'} (always respond in this language)`,
  ].join('\n')));

  // 6: 태스크 내용
  out.push(section('=== 태스크 ===', p.taskContent || ''));
  if (Array.isArray(p.kLayerClaims) && p.kLayerClaims.length) {
    out.push(section('=== K-Layer 지식 ===', p.kLayerClaims.map(c => `• ${c}`).join('\n')));
  }

  // 7: 동적 상태 (매 호출 달라지는 값은 전부 여기)
  const dyn = [
    `task_id: ${p.taskId || ''}`,
    `task_class: ${p.taskClass || 'standard'}`,
    `current_branch: ${p.branch || ''}`,
    `attempt: ${p.attempt || 1}`,
    `now: ${p.now || new Date().toISOString()}`,
    `result_report_path: ${p.resultFile || ''}`,
  ];
  if (p.isn) {
    dyn.push(`giip_isn: ${p.isn}`);
    if (p.addCommentScript) {
      dyn.push(`progress_comment_command: pwsh -File "${p.addCommentScript}" -isn ${p.isn} -content "<본문>" -issuetype note -author "slack-bot"`);
    }
  }
  out.push(section('=== 동적 상태 ===', dyn.join('\n')));

  if (p.resumeInstruction) {
    out.push(section('=== 이어서 재개 (checkpoint) ===', p.resumeInstruction));
  }

  out.push('\n\n지금 바로 작업을 시작하세요.');
  return out.join('');
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
  EXECUTION_PROTOCOL,
  FAST_PATH_PROTOCOL,
  ANALYSIS_ROLE,
  ANALYSIS_FORMAT,
  buildExecutionPrompt,
  buildAnalysisPrompt,
  buildContextSelectionPrompt,
};
