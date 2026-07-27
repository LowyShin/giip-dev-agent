/**
 * task-manager.js
 * Task lifecycle: 분석 → 파일 생성 → subagent 실행 → git push → GitHub URL 반환
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { searchKLayer } = require('./k-layer');
const accounts = require('./claude-accounts');
const minimax = require('./minimax-accounts');

const BASE_DIR = path.join(__dirname, '..');
const TASKS_DIR = path.join(BASE_DIR, '.agent', 'tasks');
const RESULTS_DIR = path.join(BASE_DIR, '.agent', 'results');
const ROLES_DIR = path.join(BASE_DIR, '.agent', 'roles');
const TASKLIST_FILE = path.join(__dirname, 'tasklist.json');

function ensureDirs() {
  [TASKS_DIR, RESULTS_DIR].forEach(d => {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  });
}

function getTimestampId() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth()+1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// baseDir 配下の .agent/roles/ を読む。なければ Lowyworkenv の roles にフォールバック
// filesRead に読んだファイルの絶対パスを push する
function readRolesContext(baseDir = BASE_DIR, filesRead = []) {
  const dirs = [
    path.join(baseDir, '.agent', 'roles'),
    ROLES_DIR,
  ];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      if (files.length === 0) continue;
      return files.map(f => {
        const fullPath = path.join(dir, f);
        filesRead.push(fullPath);
        const content = fs.readFileSync(fullPath, 'utf8');
        return `### ${f}\n${content.slice(0, 800)}`;
      }).join('\n\n---\n\n');
    } catch {}
  }
  return '';
}

function getCurrentBranch(cwd = BASE_DIR) {
  const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
  return (res.stdout || '').trim() || 'master';
}

// リポジトリの base ブランチ (PR の向き先) を判定。origin/HEAD → master/main 等。
function getBaseBranch(cwd = BASE_DIR) {
  const res = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
  const m = (res.stdout || '').trim().match(/refs\/remotes\/origin\/(.+)$/);
  if (m) return m[1];
  // origin/HEAD 未設定時のフォールバック: main → master の順で存在する方
  for (const b of ['main', 'master']) {
    const chk = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${b}`], { cwd, windowsHide: true });
    if (chk.status === 0) return b;
  }
  return 'master';
}

// 単一 bot プロセス内で作業ツリー(共有)を同時に切り替えないための簡易ガード。
// prepareTaskBranch が成功時に true、restoreTaskBranch で false に戻す。
let gitTreeBusy = false;

function runClaude(args, cwd = BASE_DIR, input = null) {
  // 계정 라우팅: weight 비율대로 계정 선택 → 한도면 다음 계정으로 재시도
  const maxTries = accounts.count();
  let result;
  for (let i = 0; i < maxTries; i++) {
    const acct = accounts.pickAccount();
    if (!acct) throw new Error('claude 전 계정 사용량 한도 소진 — 잠시 후 재시도 필요');
    result = spawnSync('claude', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20 * 60 * 1000, // 20分
      windowsHide: true,
      env: accounts.envFor(acct),
      // 프롬프트는 argv 대신 stdin 으로 전달(ENAMETOOLONG 회피). null 이면 미전달.
      ...(input != null ? { input } : {}),
    });
    if (result.error) throw result.error;
    if (result.status === 0) return (result.stdout || '').trim();
    // 한도 메시지가 stdout에 찍히는 경우가 있어(giip-759) 두 스트림 모두 확인한다.
    const combinedOut = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (accounts.isUsageLimit(combinedOut)) { accounts.noteUsageLimit(acct, combinedOut); continue; }
    break; // 한도 외 실패 — 기존 관대한 동작(부분 출력 반환) 유지
  }
  return (result?.stdout || '').trim();
}

// ── Rule 43: 컨텍스트 파일 provenance (경로 + 로드 사유) ──────────────────────
// 전량 무선별 주입(readRolesContext) 대신, 요청 관련 role/rule/skill 만 사유와 함께 선별 로드한다.

// .agent/roles·rules·skills 의 파일 카탈로그(경로 + 짧은 설명). skills 는 dir(SKILL.md) 또는 *.md.
function buildContextCatalog(baseDir = BASE_DIR) {
  const out = [];
  const firstDesc = (text) => {
    const fm = text.match(/description:\s*(.+)/i);
    if (fm) return fm[1].trim().replace(/^["']|["']$/g, '').slice(0, 140);
    const line = text.split(/\r?\n/).map(l => l.trim()).find(l => l && l !== '---');
    return (line || '').replace(/^#+\s*/, '').slice(0, 140);
  };
  const addFile = (type, absPath) => {
    try {
      const rel = path.relative(baseDir, absPath).replace(/\\/g, '/');
      out.push({ type, path: rel, desc: firstDesc(fs.readFileSync(absPath, 'utf8')) });
    } catch {}
  };
  // roles/rules: project baseDir 우선, 없으면 Lowyworkenv(.agent) 로 폴백
  for (const [type, sub] of [['role', 'roles'], ['rule', 'rules']]) {
    let dir = path.join(baseDir, '.agent', sub);
    try { if (!fs.readdirSync(dir).some(f => f.endsWith('.md'))) dir = path.join(BASE_DIR, '.agent', sub); }
    catch { dir = path.join(BASE_DIR, '.agent', sub); }
    try { fs.readdirSync(dir).filter(f => f.endsWith('.md')).forEach(f => addFile(type, path.join(dir, f))); } catch {}
  }
  // skills: dir 안 SKILL.md, 또는 top-level *.md
  let skillsDir = path.join(baseDir, '.agent', 'skills');
  if (!fs.existsSync(skillsDir)) skillsDir = path.join(BASE_DIR, '.agent', 'skills');
  try {
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const sk = path.join(skillsDir, e.name, 'SKILL.md');
        if (fs.existsSync(sk)) addFile('skill', sk);
      } else if (e.name.endsWith('.md')) {
        addFile('skill', path.join(skillsDir, e.name));
      }
    }
  } catch {}
  return out;
}

// 요청에 관련된 컨텍스트 파일을 LLM 으로 선별하고 각 파일의 로드 사유를 받는다. → [{path, reason}]
function selectContextFiles(requestText, catalog, baseDir = BASE_DIR) {
  if (!catalog.length) return [];
  const catalogText = catalog.map((c, i) => `${i + 1}. [${c.type}] ${c.path} — ${c.desc}`).join('\n');
  const prompt = `너는 아래 Slack 요청을 분석·수행하기 위해 참조해야 할 컨텍스트 파일(role/rule/skill)을 고르는 큐레이터다.

요청:
"${requestText}"

사용 가능한 컨텍스트 파일:
${catalogText}

이 요청 처리에 "실제로 관련 있는" 파일만 골라라(무관한 것은 넣지 말 것, 보통 2~8개). 각 파일에 대해
"이 태스크에서 그 파일의 무엇을 참조/적용하려는지"를 한국어 한 줄 사유로 적어라.
아래 JSON 배열만 출력한다(코드펜스·설명 금지):
[{"path":"<위 목록의 정확한 경로>","reason":"<한 줄 사유>"}]`;
  const raw = runClaude(['-p', '--model', 'claude-opus-4-8'], baseDir, prompt);
  let parsed = [];
  try { const m = raw.match(/\[[\s\S]*\]/); parsed = m ? JSON.parse(m[0]) : []; } catch { parsed = []; }
  const valid = new Set(catalog.map(c => c.path));   // 카탈로그에 없는(할루시네이션) 경로 차단
  const seen = new Set();
  return parsed
    .filter(x => x && typeof x.path === 'string' && valid.has(x.path) && !seen.has(x.path) && seen.add(x.path))
    .map(x => ({ path: x.path, reason: (String(x.reason || '').trim().slice(0, 200)) || '(사유 미기재)' }));
}

// 선별된 파일 내용을 읽어 분석 프롬프트용 컨텍스트 문자열과 filesRead([{path,reason}]) 를 만든다.
function readSelectedContext(selected, baseDir = BASE_DIR) {
  const parts = [], filesRead = [];
  for (const s of selected) {
    try {
      const content = fs.readFileSync(path.join(baseDir, s.path), 'utf8');
      parts.push(`### ${s.path} (로드 사유: ${s.reason})\n${content.slice(0, 800)}`);
      filesRead.push({ path: s.path, reason: s.reason });
    } catch {}
  }
  return { context: parts.join('\n\n---\n\n'), filesRead };
}

// filesRead 항목을 {path, reason} 로 정규화(문자열/절대경로 입력 후방호환 — 예: wfrun 의 [wfPath]).
function normalizeFilesRead(filesRead) {
  return (filesRead || []).map(f => {
    if (typeof f === 'string') {
      const rel = path.isAbsolute(f) ? path.relative(BASE_DIR, f).replace(/\\/g, '/') : f.replace(/\\/g, '/');
      return { path: rel, reason: '(직접 지정)' };
    }
    return { path: String(f.path || '').replace(/\\/g, '/'), reason: f.reason || '(사유 미기재)' };
  });
}

// ── Phase 1: 요청 분석 → TASK 파일 생성 ─────────────────────────────────────
// returns { planContent, filesRead: [{path, reason}] }
function analyzeRequest(requestText, taskId, baseDir = BASE_DIR) {
  ensureDirs();

  const claims = searchKLayer(requestText);
  const projectName = path.basename(baseDir);
  // Rule 43: 요청 관련 role/rule/skill 만 사유와 함께 선별 로드하고, 그 사유를 태스크 파일에 남긴다.
  const catalog = buildContextCatalog(baseDir);
  const selected = selectContextFiles(requestText, catalog, baseDir);
  const { context: rolesContext, filesRead } = readSelectedContext(selected, baseDir);

  const analysisPrompt = `You are a senior software architect. Always respond in Korean.

Working project: ${projectName}
Working directory: ${baseDir}

A team member sent this request via Slack:
"${requestText}"
${rolesContext ? `\n=== 프로젝트 역할/컨텍스트 ===\n${rolesContext}\n` : ''}${claims.length > 0 ? `\n=== K-Layer 관련 지식 ===\n${claims.map(c => `• ${c}`).join('\n')}\n` : ''}
Analyze the request and output a task specification in this EXACT format (in Korean):

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

  const planContent = runClaude(['-p', '--model', 'claude-opus-4-8'], baseDir, analysisPrompt);
  return { planContent, filesRead };
}

function createTaskFile(taskId, requestText, planContent, filesRead = []) {
  ensureDirs();

  const norm = normalizeFilesRead(filesRead);   // Rule 43: 경로 + 로드 사유
  const fileList = norm.length > 0
    ? '\n' + norm.map(f => `#   - ${f.path} — ${f.reason}`).join('\n')
    : '\n#   (없음)';

  const header = `---
task_id: ${taskId}
status: pending
requested_at: ${new Date().toISOString()}
request: "${requestText.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
# 분석에 로드된 컨텍스트 파일 (role/rule/skill — 경로 — 로드 사유):${fileList}
---

`;
  const taskFile = path.join(TASKS_DIR, `${taskId}.md`);
  fs.writeFileSync(taskFile, header + planContent);
  return taskFile;
}

// 既存タスクファイルを「更新」する（新規IDを発給しない）。
// 参照されたタスク番号に改訂を追記し、done/cancel にあれば tasks/ に戻して pending に再オープンする。
// 見つからなければ createTaskFile にフォールバック。返り値は tasks/{taskId}.md の絶対パス。
function updateTaskFile(taskId, requestText, planContent, filesRead = []) {
  ensureDirs();
  const activePath = path.join(TASKS_DIR, `${taskId}.md`);
  const existing = [
    activePath,
    path.join(TASKS_DIR, 'done', `${taskId}.md`),
    path.join(TASKS_DIR, 'cancel', `${taskId}.md`),
  ].find(f => fs.existsSync(f));

  // 元ファイルが見つからない場合のみ新規作成（実質 createTaskFile と同じ挙動）
  if (!existing) return createTaskFile(taskId, requestText, planContent, filesRead);

  let content = fs.readFileSync(existing, 'utf8');

  // status を pending に戻して再オープン
  content = /status:\s*.+/i.test(content)
    ? content.replace(/status:\s*.+/i, 'status: pending')
    : `status: pending\n${content}`;

  // 改訂を追記（元タスクの内容・成果物は保持したまま）
  const now = new Date().toISOString();
  const norm = normalizeFilesRead(filesRead);   // Rule 43: 경로 + 로드 사유
  const fileList = norm.length > 0
    ? '\n' + norm.map(f => `-   ${f.path} — ${f.reason}`).join('\n')
    : '\n-   (없음)';
  content = `${content.trimEnd()}\n\n---\n\n## 개정 (${now})\n\n### 추가 요청\n${requestText}\n\n### 갱신된 계획\n${planContent}\n\n### 로드된 컨텍스트 파일 (role/rule/skill — 경로 — 사유)${fileList}\n`;

  // done/cancel にあった場合は tasks/ 直下へ戻す
  fs.writeFileSync(activePath, content);
  if (existing !== activePath) {
    try { fs.rmSync(existing); } catch {}
  }
  return activePath;
}

// giip issue 재처리용: 로컬 태스크 파일이 없을 때 DB 이력(본문+전체 코멘트)으로 태스크 파일을 재생성한다.
//   done/ 이동·타 클론 처리·워킹트리 churn 등으로 .agent/tasks/{giip-isn}.md 가 사라져도, DB(SSOT)에서
//   복원한 히스토리 다이제스트를 계획 본문으로 삼아 서브에이전트가 코멘트 이력 전체를 읽고 이어서 처리하게 한다.
//   (이 파일이 없어서 startExecution 이 "タスクファイルが見つかりません" 로 실패하던 문제의 항구 대책.)
function rebuildTaskFileFromIssue(taskId, isn, requestText, historyDigest) {
  ensureDirs();
  const plan = [
    `# TASK: giip issue #${isn} 재처리`,
    '',
    '## 원 요청',
    (requestText && requestText.trim()) || `(giip issue #${isn} 처리 요청)`,
    '',
    '## DB에서 복원한 이슈 이력 (본문 + 전체 코멘트 — 반드시 시간순으로 모두 읽고 맥락을 반영)',
    historyDigest || '(이력 없음 — DB 조회 실패. giip issue get 로 직접 확인하라)',
    '',
    '## 지시',
    '- 위 코멘트 이력을 모두 읽고, 아직 처리되지 않았거나 새로 추가된 요청을 파악해 처리하라.',
    `- 새 issue/task 번호를 만들지 말고 #${isn} 에 결과를 코멘트하고 상태를 전이하라.`,
  ].join('\n');
  return createTaskFile(taskId, (requestText && requestText.trim()) || `giip issue #${isn} 재처리`, plan, []);
}

function extractTitle(planContent) {
  const match = planContent.match(/^#\s*TASK:\s*(.+)$/m);
  return match ? match[1].trim() : '作業';
}

// ── Phase 2: subagent 실행 (비동기) ─────────────────────────────────────────
function startExecution(taskId, taskFilePath, { onComplete, onError, isn = null }, baseDir = BASE_DIR, ctx = null) {
  ensureDirs();

  // taskFilePath が未指定 or 存在しない場合は TASKS_DIR/{taskId}.md にフォールバック
  if (!taskFilePath || !fs.existsSync(taskFilePath)) {
    const fallback = path.join(TASKS_DIR, `${taskId}.md`);
    if (fs.existsSync(fallback)) {
      taskFilePath = fallback;
    } else {
      const err = new Error(`タスクファイルが見つかりません: ${taskId}`);
      if (onError) setImmediate(() => onError(err, null));
      return;
    }
  }

  const taskContent = fs.readFileSync(taskFilePath, 'utf8');
  const resultFile = path.join(RESULTS_DIR, `${taskId}.md`);
  const rolesContext = readRolesContext(baseDir);
  const claims = searchKLayer(taskContent);

  // ctx が渡されていれば prepareTaskBranch 済みの専用ブランチ。無ければ現在ブランチ(後方互換)。
  const currentBranch = (ctx && ctx.branch) || getCurrentBranch(baseDir);
  const baseBranch = (ctx && ctx.base) || getBaseBranch(baseDir);

  // 進捗コメント・プロトコル(PROTOCOL_PROGRESS_COMMENT.md): giip issue に連携済み(isn あり)の時だけ
  // 注入する。isn が無ければ giip 未連携なのでブロック全体を省く(条件「giip issue api 접근 가능한 환경이면」)。
  const addCommentScript = path.join(BASE_DIR, '..', 'giipprj', 'giipdb', 'mgmt', 'addIssueComment.ps1');
  const progressBlock = isn ? `

=== 진행 코멘트 프로토콜 (정본 .agent/rules/PROTOCOL_PROGRESS_COMMENT.md) ===
이 태스크는 giip issue #${isn} 에 연동돼 있다. 진행 상황을 자주 코멘트로 남겨, 코멘트만 봐도 어디까지
왔고 무엇이 바뀌었는지 재구성되게 하라. 파일 1개당 코멘트 1개를 강제하지 말고 "논리 묶음" 단위로
각 1~3줄 짧게 남긴다(같은 내용 연타·스팸 금지). 남기는 시점:
  1) 착수: 로드해서 따르는 role/rule/skill/workflow 를 명시.
  2) 참조 정본 변경: 따라야 할 role/rule/skill/workflow 파일 자체를 수정할 때 — 무엇을 왜.
  3) 대상 파일 변경: 실제 수정/생성/삭제한 소스·문서가 생길 때마다(논리 묶음마다) — 경로 + 한 줄.
  4) 검색 발생: 부득이 grep/find 했으면 (a)왜 (b)어디에 링크로 흡수했는지(Search→Link→Report).
  5) 분기·막힘·판단: 에러·사람 확인 필요, 중요한 설계 판단이 생길 때.
빈도: 몇 분 이상 걸리는 작업이면 최소 시작·중간·끝이 코멘트로 남게 한다.
명령(직접-DB append, 한글 안 깨짐):
  pwsh -File "${addCommentScript}" -isn ${isn} -content "<본문>" -issuetype note -author "slack-bot"
  (중간 진행은 issuetype=note. 상태 전이/최종 코멘트는 봇이 별도 처리하므로 여기서 상태는 바꾸지 말 것.)
` : '';
  const executionPrompt = `You are a senior software engineer working in the Lowyworkenv workspace. Always respond in Korean.
Working directory: ${baseDir}
Current branch: ${currentBranch} (task 전용 브랜치, base=${baseBranch} 최신 기준)

=== 담당 태스크 ===
${taskContent}

=== 사용 가능한 역할 ===
${rolesContext || '(roles not found)'}

=== K-LAYER 지식 ===
${claims.length > 0 ? claims.map(c => `• ${c}`).join('\n') : '(없음)'}

=== 작업 지시 ===
0. **되묻지 말고 실측하라**: 경로·설정·사양 등 조회로 확정 가능한 값은 사용자에게 다시 묻지 말고 직접 찾아 결정한다.
   - giip 서비스 설정(SMTP·메일·인증 등)의 정본은 **giipdb 사양서(\`giipprj/giipdb/docs/30_Specs/\`)와 DB**다. 사람에게 묻기 전에 반드시 그곳부터 grep/조회하라. 예: SMTP 설정은 \`tEmailServerConfig\` 테이블에 있고 giip API \`EmailServerConfigGetActive\`(SP \`pApiEmailServerConfigGetActivebyAK\`, 서버측 \`bySk\`)로 조회한다.
   - 정말로 사람만 아는 값(외부 자격증명 실물, 사용자의 의도적 선택)만 질문한다.
1. 위 태스크의 실행 계획을 순서대로 실행하세요.
2. Read/Edit/Write/Bash 도구를 사용해 이 저장소(${baseDir}) 안에서 실제 코드 변경을 수행하세요.
3. **git 커밋·push·PR·브랜치 전환은 절대 하지 마세요.** 작업트리는 이미 태스크 전용 브랜치 \`${currentBranch}\`(base=${baseBranch} 최신 fetch 기준)로 준비돼 있습니다. 파일 변경만 마치면, 봇이 작업 종료 후 자동으로 이 브랜치에 커밋·push 하고 \`${baseBranch}\` 로 PR 을 생성합니다. (당신이 직접 git 을 만지면 브랜치/PR 흐름이 깨집니다.)
4. 모든 단계 완료 후 반드시 다음 경로에 결과 보고서를 작성하세요:
   ${resultFile}

결과 보고서 형식:
---
# 작업 완료 보고서: [태스크 제목]

## 완료 일시
${new Date().toISOString()}

## 실시 내용
(실제 수행한 작업의 상세 설명)

## 변경 파일
- path/to/file — 변경 내용 요약

## 결과/상태
(성공 / 부분 완료 / 실패, 이유)

## 다음 단계
(후속 작업이 필요한 경우 명기)
---
${progressBlock}
지금 바로 작업을 시작하세요.`;

  // 実行サブエージェントが roles/rules/skills/workflows を参照できるよう .agent を許可
  // （baseDir に .agent が無ければ BASE_DIR/.agent にフォールバック — index.js の getAgentDir と同じ規則）
  const agentDir = fs.existsSync(path.join(baseDir, '.agent'))
    ? path.join(baseDir, '.agent')
    : path.join(BASE_DIR, '.agent');
  // 프롬프트는 argv 대신 stdin 으로 전달(ENAMETOOLONG 회피) → proc.stdin 으로 씀
  const args = ['-p', '--dangerously-skip-permissions', '--add-dir', agentDir];

  // 계정 라우팅: weight 비율대로 계정 선택. 실행 중 사용량 한도에 걸리면
  // 해당 계정을 쿨다운하고 다음 계정으로 태스크를 처음부터 재실행한다.
  // (주의: 재실행이므로 이미 push된 커밋이 있으면 중복 커밋 가능 — fail보다 나은 동작)
  const tried = new Set();
  // 우선순위(사용자 지정): MiniMax 먼저, MiniMax 한도 소진 시에만 Claude로 폴백.
  // mmExhausted=true 가 되면(이번 태스크 한정) 이후 attempt() 는 MiniMax를 다시 시도하지 않는다
  // (minimax.resolve() 는 별도로 자체 쿨다운을 갖고 있어 다음 태스크에서는 그 쿨다운을 그대로 따른다).
  let mmExhausted = false;

  function attempt() {
    let acct = mmExhausted ? null : minimax.resolve();
    let env;
    if (acct) {
      env = minimax.envFor(acct);
      console.log(`[TaskManager] task ${taskId}: MiniMax(${acct.model}) 로 실행`);
    } else {
      acct = accounts.pickAccount();
      if (!acct) {
        onError(new Error('MiniMax 미설정/한도 소진 + Claude 전 계정 사용량 한도 소진 — 잠시 후 재실행 필요'), null);
        return null;
      }
      env = accounts.envFor(acct);
      if (mmExhausted) console.log(`[TaskManager] task ${taskId}: MiniMax 한도 소진 → Claude(${acct.name}) 폴백`);
    }
    // tried 는 Claude 계정 로테이션 가드(tried.size < accounts.count())에만 쓰인다.
    // MiniMax 는 별도 mmExhausted 플래그로 추적하므로 여기 섞으면 카운트가 어긋난다(오프바이원 방지).
    if (acct.provider !== 'minimax') tried.add(acct.name);
    // MiniMax 폴백은 claude CLI 기본 모델 선택을 안 타므로 --model 로 명시 지정한다.
    const spawnArgs = acct.provider === 'minimax' ? [...args, '--model', acct.model] : args;
    const proc = spawn('claude', spawnArgs, {
      cwd: baseDir,
      stdio: ['pipe', 'pipe', 'pipe'], // stdin 으로 프롬프트 전달(ENAMETOOLONG 회피)
      env,
    });
    proc.stdin.on('error', () => {}); // 자식이 먼저 종료하면 EPIPE — 무시
    proc.stdin.end(executionPrompt);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; process.stdout.write(`[Subagent:${acct.name}] ${d}`); });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', (code) => {
      const combinedOut = `${stdout}\n${stderr}`;

      // MiniMax(1순위) 실패 → 이번 태스크는 더 이상 MiniMax를 시도하지 않고 Claude 풀로 전환.
      // 한도성 실패면 minimax 자체 쿨다운도 걸어(다음 태스크들도 그동안 Claude 사용), 원인 불명 실패는
      // 쿨다운 없이(다음 태스크는 다시 MiniMax부터 시도) 이번만 Claude로 넘어간다.
      if (code !== 0 && acct.provider === 'minimax') {
        mmExhausted = true;
        if (minimax.isUsageLimit(combinedOut)) minimax.noteUsageLimit();
        console.log(`[TaskManager] task ${taskId}: MiniMax 실패 → Claude 폴백으로 전환`);
        attempt();
        return;
      }

      // 사용량 한도로 실패 & 아직 안 쓴 계정이 남아 있으면 다음 계정으로 재실행
      // 한도 메시지("You've hit your weekly limit ...")는 stderr가 아니라 stdout에
      // 찍히는 경우가 있어(giip-759, PR #430) 두 스트림을 모두 확인한다.
      if (code !== 0 && acct.provider !== 'minimax' && accounts.isUsageLimit(combinedOut) && tried.size < accounts.count()) {
        accounts.noteUsageLimit(acct, combinedOut);
        console.log(`[TaskManager] task ${taskId}: ${acct.name} usage limit → 다음 계정으로 재실행`);
        attempt();
        return;
      }

      // 결과 파일이 없으면 기본 파일 생성
      if (!fs.existsSync(resultFile)) {
        fs.writeFileSync(resultFile, [
          `# 작업 결과: ${taskId}`,
          `\n완료 일시: ${new Date().toISOString()}`,
          `\n## Claude 출력\n${stdout.slice(0, 3000)}`,
          stderr ? `\n## Errors\n${stderr.slice(0, 500)}` : '',
        ].join('\n'));
      }

      if (code === 0) {
        onComplete(resultFile);
      } else {
        onError(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`), resultFile);
      }
    });

    proc.on('error', (err) => onError(err, null));
    return proc;
  }

  return attempt();
}

// ── 작업 완료: 결과를 태스크 파일에 추가 후 done/ 폴더로 이동 ─────────────────
function completeTaskFile(taskId, resultContent) {
  const candidates = [
    path.join(TASKS_DIR, `${taskId}.md`),
    path.join(TASKS_DIR, `task-${taskId}.md`),
  ];
  const taskFile = candidates.find(f => fs.existsSync(f));
  if (!taskFile) throw new Error(`Task file not found for ${taskId}`);

  const now = new Date().toISOString();
  let content = fs.readFileSync(taskFile, 'utf8');

  // status を completed に更新
  content = /status:\s*.+/i.test(content)
    ? content.replace(/status:\s*.+/i, 'status: completed')
    : `status: completed\ncompleted_at: ${now}\n${content}`;

  // 결과 보고서를 파일 말미에 추가
  content = `${content.trimEnd()}\n\n---\n\n## 작업 완료 보고서\n\n완료 일시: ${now}\n\n${(resultContent || '').trim()}\n`;
  fs.writeFileSync(taskFile, content);

  // done/ 폴더로 이동
  const doneDir = path.join(TASKS_DIR, 'done');
  if (!fs.existsSync(doneDir)) fs.mkdirSync(doneDir, { recursive: true });
  const destPath = path.join(doneDir, path.basename(taskFile));
  fs.renameSync(taskFile, destPath);

  console.log(`[TaskManager] task ${taskId} → done/${path.basename(taskFile)}`);
  return destPath;
}

// go <番号> の後ろに付いた「追加指示」を Task ファイル末尾に追記する。
//   Task ファイルの mutation は本モジュールに集約する(handlers は fs で直接書かず tm 経由)。
//   note が空、または対象ファイルが無ければ何もせず false を返す。
function appendTaskNote(taskId, note) {
  if (!note) return false;
  const candidates = [
    path.join(TASKS_DIR, `${taskId}.md`),
    path.join(TASKS_DIR, `task-${taskId}.md`),
  ];
  const taskFile = candidates.find(f => fs.existsSync(f));
  if (!taskFile) return false;
  fs.appendFileSync(taskFile, `\n\n## 추가 지시 (Slack, ${new Date().toISOString()})\n${note}\n`);
  console.log(`[TaskManager] task ${taskId}: 追加指示 ${note.length}字 追記`);
  return true;
}

// ── Phase 3: Git commit + push → GitHub URL 반환 ─────────────────────────────
// doneTaskFile が指定された場合はそのファイルを優先的に stage し URL を返す
function gitPushResult(taskId, taskTitle, resultFile, doneTaskFile = null) {
  const branch = getCurrentBranch();
  const relResult = path.relative(BASE_DIR, resultFile).replace(/\\/g, '/');

  // done task file の URL 用に相対パスだけ先に確定（stage は下の add -A が担う）
  let relDoneTask = null;
  if (doneTaskFile && fs.existsSync(doneTaskFile)) {
    relDoneTask = path.relative(BASE_DIR, doneTaskFile).replace(/\\/g, '/');
  }

  // 스테이지 범위 = 태스크가 실제로 만든/바꾼 산출물 전부(경로 무관). 固定パス（結果ファイル +
  // .agent/tasks/<id>.md）だけ add すると 02-ActiveProjects/** 等の任意パス成果物が取りこぼされ
  // 「ファイルは出来たのにコミットされない」事故になる（2026-07-08 mimity 事件, task 20260708174823）。
  // ランタイム状態 json(.bot-threads/.task-state/tasklist/claude-accounts/.conversations)は
  // .gitignore 済みなので add -A に混入しない。→ rule 35「스테이지 범위」/ rule 38 ②.
  spawnSync('git', ['add', '-A'], { cwd: BASE_DIR, encoding: 'utf8', windowsHide: true });

  // commit
  const msg = `task(${taskId}): ${taskTitle.slice(0, 60)}\n\nAuto-committed by giipclaude Bot\n\nDirective: task result push on ${branch}`;
  const commitRes = spawnSync('git', ['commit', '-m', msg], { cwd: BASE_DIR, encoding: 'utf8', windowsHide: true });
  if (commitRes.status !== 0 && !(commitRes.stdout || '').includes('nothing to commit')) {
    console.error('[TaskManager] git commit:', (commitRes.stderr || '').trim());
    return null;
  }

  // Rebase onto latest remote and push, retrying once on non-fast-forward.
  // --autostash so uncommitted runtime state (bot json) never blocks the rebase. This was the
  // bug that silently dropped result URLs: dirty tree → rebase refused → push rejected → null.
  const runGit = (args) => spawnSync('git', args, { cwd: BASE_DIR, encoding: 'utf8', windowsHide: true });
  const rebaseAndPush = () => {
    const pull = runGit(['pull', '--rebase', '--autostash', 'origin', branch]);
    if (pull.status !== 0) {
      console.error('[TaskManager] git pull --rebase:', (pull.stderr || '').trim());
      runGit(['rebase', '--abort']); // never leave the repo mid-rebase
    }
    return runGit(['push', 'origin', branch]);
  };
  let pushRes = rebaseAndPush();
  if (pushRes.status !== 0) {
    console.error('[TaskManager] git push rejected, retrying after fetch:', (pushRes.stderr || '').trim());
    runGit(['fetch', 'origin', branch]);
    pushRes = rebaseAndPush();
  }
  if (pushRes.status !== 0) {
    console.error('[TaskManager] git push:', (pushRes.stderr || '').trim());
    return null;
  }

  // done task file の URL を優先返却
  return buildGitHubUrl(relDoneTask || relResult);
}

function buildGitHubUrl(relativePath) {
  const remoteRes = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: BASE_DIR, encoding: 'utf8', windowsHide: true });
  const remote = (remoteRes.stdout || '').trim();

  // git@github.com:Owner/Repo.git  →  https://github.com/Owner/Repo
  // https://github.com/Owner/Repo.git  →  https://github.com/Owner/Repo
  const base = remote
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');

  const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: BASE_DIR, encoding: 'utf8', windowsHide: true });
  const branch = (branchRes.stdout || '').trim() || 'master';

  return `${base}/blob/${branch}/${relativePath}`;
}

// remote(origin) → PR compare URL (gh pr create 실패 시 폴백)
function buildCompareUrl(branch, base, baseDir = BASE_DIR) {
  const remoteRes = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: baseDir, encoding: 'utf8', windowsHide: true });
  const remote = (remoteRes.stdout || '').trim();
  const b = remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  return `${b}/compare/${base}...${branch}?expand=1`;
}

// ── 작업 전: 최신 base 에서 태스크 전용 브랜치를 만들어 checkout ────────────────
// 반환 ctx 는 gitPushResultAndPR 에서 push·PR·작업트리 복원에 사용한다.
// 핵심: 반드시 `git fetch origin <base>` 직후 `origin/<base>` 를 기점으로 브랜치를 만든다.
// (오래된 로컬 base 위에서 브랜치를 파면 나중에 PR/merge conflict → 이번 재발방지의 요체.)
function prepareTaskBranch(taskId, baseDir = BASE_DIR) {
  const git = (args) => spawnSync('git', args, { cwd: baseDir, encoding: 'utf8', windowsHide: true });
  const isRepo = git(['rev-parse', '--git-dir']);
  if (isRepo.status !== 0) return { ok: false, notRepo: true, error: 'git 저장소가 아님' };
  if (gitTreeBusy) {
    return { ok: false, busy: true, error: '다른 태스크가 작업트리(git)를 점유 중 — 완료 후 다시 go 하세요.' };
  }

  const originalBranch = getCurrentBranch(baseDir);
  const base = getBaseBranch(baseDir);
  const branch = `bot/task-${taskId}`;

  // 드리프트 조기 감지: 새 작업은 항상 기본 브랜치에서 쉬고 있어야 한다(rule 41).
  // 시작 시점에 비-기본 브랜치(대개 이전 태스크의 bot/task-*)에 있다면 과거에 복원이
  // 누락됐다는 증거 → 로그로 남긴다. restoreTaskBranch 가 base 로 복원하므로 이번 턴에 자가 치유된다.
  if (originalBranch !== base) {
    console.error(`[TaskManager] prepareTaskBranch: ⚠️ 작업 시작 시 트리가 base(${base})가 아닌 '${originalBranch}' 에 있었음 (드리프트 흔적). 이번 작업 종료 시 ${base} 로 복원됩니다.`);
  }

  const fetched = git(['fetch', 'origin', base]);
  const startPoint = fetched.status === 0 ? `origin/${base}` : base;

  // 자가 치유: 워킹트리에 커밋 안 된 tracked 변경이 있으면 `checkout -B` 가
  // "your local changes would be overwritten by checkout … Aborting" 으로 중단한다
  // (02-ActiveProjects/README.md 수정 등). 아무도 치우지 않으므로 go 가 영구 루프로 실패했다.
  // → checkout 을 막는 tracked 변경만 stash 하고 restoreTaskBranch 에서 pop 한다.
  //   untracked(.agent/tasks/<id>.md = 실행할 태스크 파일)은 checkout 을 막지 않고
  //   서브에이전트가 봐야 하므로 stash 에 넣지 않는다(-u 금지).
  //   gitPushResult 의 `pull --rebase --autostash` 와 같은 철학.
  let stashed = false;
  const dirtyTracked = git(['status', '--porcelain', '--untracked-files=no']);
  if ((dirtyTracked.stdout || '').trim()) {
    const stash = git(['stash', 'push', '-m', `giipclaude-autostash-${taskId}`]);
    stashed = stash.status === 0 && !/No local changes/.test(stash.stdout || '');
  }

  // 자가 치유 ②: untracked 태스크 파일이 startPoint(origin/base)에 이미 tracked 로
  // 존재하면(과거 시도가 PR 로 base 에 머지된 경우 — giip-645), `checkout -B` 가
  // "untracked working tree files would be overwritten by checkout … Aborting" 으로
  // 영구 실패한다. autostash 는 tracked 변경만 다루므로 이 충돌은 치우지 못한다.
  //   → 현재 요청(untracked)본을 보존하고 파일을 잠시 치워 checkout 을 통과시킨 뒤,
  //     checkout 후 다시 써서 서브에이전트가 최신 요청을 보게 한다.
  const taskRel = `.agent/tasks/${taskId}.md`;
  const taskAbs = path.join(baseDir, taskRel);
  let savedTaskFile = null;
  const taskTracked = git(['ls-files', '--error-unmatch', taskRel]).status === 0;
  const taskOnStart = git(['cat-file', '-e', `${startPoint}:${taskRel}`]).status === 0;
  if (!taskTracked && taskOnStart) {
    try {
      savedTaskFile = fs.readFileSync(taskAbs, 'utf8');
      fs.rmSync(taskAbs);
    } catch { savedTaskFile = null; }
  }

  const co = git(['checkout', '-B', branch, startPoint]);
  if (co.status !== 0) {
    if (savedTaskFile != null) { try { fs.writeFileSync(taskAbs, savedTaskFile); } catch {} }
    if (stashed) git(['stash', 'pop']); // 실패 시 사용자 변경을 되돌려 유실 방지
    return { ok: false, error: `브랜치 생성 실패: ${(co.stderr || '').trim().slice(0, 200)}` };
  }
  // checkout 성공: base 의 옛 태스크 파일이 트리에 올라왔을 수 있으므로 현재 요청본으로
  // 덮어써 서브에이전트가 최신 요청을 실행하게 한다(커밋되면 이번 태스크 변경으로 남음).
  if (savedTaskFile != null) { try { fs.writeFileSync(taskAbs, savedTaskFile); } catch {} }

  gitTreeBusy = true;
  return { ok: true, branch, base, originalBranch, fetchedBase: fetched.status === 0, stashed };
}

// 작업트리를 기본(base) 브랜치로 복원하고 busy 락을 해제한다. (성공/실패 무관 항상 호출)
//
// rule 41(브랜치 생명주기): 한 작업의 종료 = PR 생성 + 기본 브랜치(master/main) 복귀.
// ⚠️ 근본 원인 수정(giip-633): 예전에는 `ctx.originalBranch`(작업 시작 시점의 브랜치)로 복원했다.
//   그러나 트리가 한 번이라도 비-master 브랜치(강제종료로 남은 bot/task-*, 이전 복원 실패,
//   수동 checkout 등)에 놓이면, 그 브랜치가 다음 태스크의 originalBranch 로 기록되고 복원도
//   다시 그 브랜치로 돌아가, 작업트리가 영구히 master 로 못 돌아오는 드리프트가 됐다
//   (= 사용자가 지적한 "자꾸 디폴트 브랜치에서 시작 안 함"). 복원 목적지를 항상 base 로 고정해
//   태스크가 끝날 때마다 트리를 master 로 되돌려(self-heal) 드리프트를 끊는다.
function restoreTaskBranch(ctx, baseDir = BASE_DIR) {
  const git = (args) => spawnSync('git', args, { cwd: baseDir, encoding: 'utf8', windowsHide: true });
  // ctx 가 없으면 prepareTaskBranch 가 트리를 전환하지 않은 경우(비-repo/busy 등) → 복원할 것이 없다.
  if (!ctx) { gitTreeBusy = false; return; }
  try {
    // 복원 목적지 = 기본 브랜치. ctx.base 우선, 없으면 실측(getBaseBranch).
    const base = ctx.base || getBaseBranch(baseDir);
    const co = git(['checkout', base]);
    if (co.status !== 0) {
      console.error(`[TaskManager] restoreTaskBranch: base(${base}) 체크아웃 실패 —`, (co.stderr || '').trim());
    } else {
      // rule 41 step 5: 기본 브랜치를 origin 최신으로 ff 동기화(다음 태스크의 startPoint 신선도 확보).
      // 절대 로컬 base 에 커밋하지 않으므로 diverge 없음 → ff-only 로 안전. 실패해도 비치명(로그만).
      const pull = git(['pull', '--ff-only', 'origin', base]);
      if (pull.status !== 0) {
        console.error(`[TaskManager] restoreTaskBranch: ${base} ff-pull 실패(비치명) —`, (pull.stderr || '').trim());
      }
    }
    // prepareTaskBranch 에서 autostash 한 tracked 변경을 기본 브랜치로 되돌린다.
    // (정상 경로에서는 originalBranch == base 이므로 팝 대상 브랜치가 동일. 드리프트 상황이었다면
    //  변경을 master 로 합류시켜 브랜치 오염을 정리한다.)
    if (ctx.stashed) {
      const pop = git(['stash', 'pop']);
      if (pop.status !== 0) {
        // pop 충돌 시 stash 는 보존된다(git 기본 동작) — 사용자 변경을 유실하지 않는다.
        console.error('[TaskManager] restoreTaskBranch stash pop 충돌 — stash 보존:', (pop.stderr || '').trim());
      }
    }
  } finally {
    gitTreeBusy = false;
  }
}

// 태스크 브랜치 → base 로 PR 을 보장한다. 이미 열린 PR 이 있으면 그 URL, 없으면 새로 만든다.
function ensurePR(taskId, taskTitle, branch, base, baseDir = BASE_DIR) {
  // gh 는 GH_TOKEN/GITHUB_TOKEN 이 있으면 그 토큰을 우선 사용한다. 봇 .env 의 GITHUB_TOKEN 은
  // PR 생성 권한이 없어 `gh pr create` 가 "Resource not accessible by personal access token" 로
  // 실패하고 compare 링크로 폴백됐다. 이 두 토큰을 제거해 gh 자체 로그인(gh auth login — PR 권한 보유)을
  // 쓰게 한다. (github-issues.js 등 다른 곳의 GITHUB_TOKEN 사용에는 영향 없음: 여기 spawn 에만 적용.)
  const ghEnv = { ...process.env };
  delete ghEnv.GITHUB_TOKEN;
  delete ghEnv.GH_TOKEN;
  const gh = (args) => spawnSync('gh', args, { cwd: baseDir, encoding: 'utf8', windowsHide: true, env: ghEnv });

  // 기존 PR 확인 (재실행/중복 방지)
  const existing = gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url']);
  const existingUrl = (existing.stdout || '').trim();
  if (existing.status === 0 && existingUrl.startsWith('http')) return existingUrl;

  const title = `task(${taskId}): ${taskTitle.slice(0, 60)}`;
  const body = [
    'giipclaude Bot 자동 생성 PR.',
    '',
    `- 태스크: \`${taskId}\``,
    `- 브랜치: \`${branch}\` → \`${base}\``,
    `- 결과 보고서: \`.agent/results/${taskId}.md\``,
    '',
    '🤖 Generated by giipclaude Bot',
  ].join('\n');

  const create = gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]);
  if (create.status === 0) {
    const url = (create.stdout || '').trim().split(/\s+/).filter(u => u.startsWith('http')).pop();
    if (url) return url;
  }
  console.error('[TaskManager] gh pr create 실패:', (create.stderr || create.stdout || '').trim().slice(0, 300));
  return buildCompareUrl(branch, base, baseDir); // 폴백: compare 링크 (수동 PR 생성 가능)
}

// ── PR 충돌 게이트: 변경 파일이 '미머지 열린 PR'의 대상이면 그 PR 목록을 돌려준다 ──────
// 목적(사용자 요청): 같은 파일을 대상으로 한 PR 이 아직 머지 안 된 상태에서 또 다른 작업이
//   같은 파일을 건드리면 나중에 반드시 conflict 가 난다(#84/#85 사례). PR 을 새로 만들기
//   '직전'에 검사해 경쟁 PR 을 만들지 않고 멈춘 뒤, 사용자에게 "먼저 그 PR 을 머지하라"고 알린다.
//   서브에이전트는 작업이 끝나기 전엔 어떤 파일을 바꿀지 알 수 없으므로, 확실한 차단 지점은
//   '변경 파일이 확정된 = PR 생성 직전'이다.
// selfBranch(= 지금 만들 브랜치)의 PR 은 제외한다(자기 자신과는 충돌 아님).
// gh 실패/파싱 실패는 비치명 → 빈 배열(게이트 미적용). 데이터 안전 원칙상 '막지 못해도 진행'.
function findBlockingPRs(root, changedFiles, selfBranch) {
  if (!changedFiles || changedFiles.length === 0) return [];
  const ghEnv = { ...process.env };
  delete ghEnv.GITHUB_TOKEN; // ensurePR 과 동일: 봇 PAT 대신 gh 자체 로그인 사용
  delete ghEnv.GH_TOKEN;
  const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,url,files', '--limit', '100'],
    { cwd: root, encoding: 'utf8', windowsHide: true, env: ghEnv });
  if (r.status !== 0) {
    console.error('[TaskManager] findBlockingPRs: gh pr list 실패(게이트 미적용):', (r.stderr || '').trim().slice(0, 120));
    return [];
  }
  let prs;
  try { prs = JSON.parse(r.stdout || '[]'); } catch { return []; }
  const changed = new Set(changedFiles); // repo-relative path 로 비교(양쪽 동일 기준)
  const blocking = [];
  for (const pr of (prs || [])) {
    if (pr.headRefName === selfBranch) continue;
    const overlap = (pr.files || []).map(f => f.path).filter(p => changed.has(p));
    if (overlap.length) blocking.push({ number: pr.number, url: pr.url, branch: pr.headRefName, files: overlap });
  }
  return blocking;
}

// ── Phase 3': 태스크 브랜치에 커밋·push → base 로 PR 생성 → 작업트리 복원 ────────
// 반환값 = PR URL(성공) / compare URL(폴백) / null(push 실패). 항상 작업트리를 원복한다.
function gitPushResultAndPR(taskId, taskTitle, resultFile, doneTaskFile, ctx, baseDir = BASE_DIR) {
  const git = (args) => spawnSync('git', args, { cwd: baseDir, encoding: 'utf8', windowsHide: true });
  try {
    const branch = (ctx && ctx.branch) || getCurrentBranch(baseDir);
    const base = (ctx && ctx.base) || getBaseBranch(baseDir);

    // 산출물 전부 스테이지(경로 무관, rule 35). 런타임 json 은 .gitignore 처리됨.
    git(['add', '-A']);
    const msg = `task(${taskId}): ${taskTitle.slice(0, 60)}\n\nAuto-committed by giipclaude Bot\n\nDirective: ${branch} → PR to ${base}`;
    const commitRes = git(['commit', '-m', msg]);
    if (commitRes.status !== 0 && !(commitRes.stdout || '').includes('nothing to commit')) {
      console.error('[TaskManager] git commit:', (commitRes.stderr || '').trim());
      return null;
    }

    // 태스크 전용 브랜치 push. 신규면 -u, 이미 있으면 rebase 후 재시도.
    let push = git(['push', '-u', 'origin', branch]);
    if (push.status !== 0) {
      console.error('[TaskManager] push rejected, retry after fetch+rebase:', (push.stderr || '').trim());
      git(['fetch', 'origin', branch]);
      git(['pull', '--rebase', '--autostash', 'origin', branch]);
      push = git(['push', '-u', 'origin', branch]);
    }
    if (push.status !== 0) {
      console.error('[TaskManager] git push:', (push.stderr || '').trim());
      return null;
    }

    return ensurePR(taskId, taskTitle, branch, base, baseDir);
  } finally {
    restoreTaskBranch(ctx, baseDir); // 성공/실패/예외 무관 항상 원복 + busy 해제
  }
}

// ── Phase 3'': タスクが実際に変更した「全リポジトリ」を安全に commit·push·PR ──────
//
// 背景: サブエージェントは effWorkDir 直下のリポだけでなく、その配下の独立した
//   nested git repo (例: giipprj/giipv3, giipprj/giipdb) も変更しうる。従来は単一リポ
//   しか扱わず、nested repo の変更は commit も push も PR もされず「作業ツリーに孤児の
//   未コミット変更」として取り残されていた。ここではそれを解消する。
//
// データ安全性が最優先ルール:
//   ① 実行「前」に clean だったリポだけを自動 PR する。実行前から dirt があったリポは
//      一切触らず skip+報告する（ユーザの未コミット作業を絶対に失わない/上書きしない）。
//   ② タスク由来の変更は git stash で退避してから origin/base 起点の bot/task ブランチへ
//      pop する。pop が conflict した場合は必ず元ブランチへ変更を戻し、stash を捨てない。
//   ③ 各リポは try/finally 相当で必ず元ブランチへ復元する。conflict のまま放置しない。

function gitC(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

// リポジトリ root を Windows 大小文字無視で正規化（除外集合との突合に使う）
function normRoot(p) {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// dir を含む git リポジトリの toplevel（無ければ null）
function repoToplevel(dir) {
  const r = gitC(dir, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function isGitRepoDir(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

// `git status --porcelain` の各行から「変更パス」だけを Set で返す。
// rename(`old -> new`)は new 側、quoted path は unquote して比較キーにする。
function porcelainPathSet(root) {
  const set = new Set();
  const r = gitC(root, ['status', '--porcelain']);
  if (r.status !== 0) return set;
  (r.stdout || '').split('\n').forEach(line => {
    if (!line.trim()) return;
    let p = line.slice(3); // 先頭3文字はステータス(XY + 空白)
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.trim().replace(/^"(.*)"$/, '$1');
    if (p) set.add(p);
  });
  return set;
}

// 実行「前」に候補リポの dirty 状態をスナップショットする。
// 候補 = effWorkDir を含むリポ(toplevel) + その 1〜2 階層下の nested git repo。
// 返り値: [{ root, normRoot, originalBranch, preDirt:Set<path> }]
// 候補リポの root 一覧(Map<normRoot, root>)を返す。
// = effWorkDir を含むリポ(toplevel) + その 1〜2 階層下の nested git repo。
// repo を見つけたらその中へは降りない(サブサブ repo は追わない)。
function candidateRepoRoots(effWorkDir) {
  const roots = new Map(); // normRoot -> 実際の root
  const addRoot = (dir) => {
    const top = repoToplevel(dir);
    if (top) roots.set(normRoot(top), top);
  };

  addRoot(effWorkDir); // primary: effWorkDir を含むリポ

  // nested repo 探索(1〜2 階層)。repo を見つけたらその中へは降りない(サブサブ repo は追わない)。
  const listDirs = (base) => {
    try {
      return fs.readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => path.join(base, d.name));
    } catch { return []; }
  };
  const scanNested = (base) => {
    for (const d1 of listDirs(base)) {
      if (isGitRepoDir(d1)) { addRoot(d1); continue; }
      for (const d2 of listDirs(d1)) {
        if (isGitRepoDir(d2)) addRoot(d2);
      }
    }
  };
  scanNested(effWorkDir);

  // ── 追加: effWorkDir の「兄弟」リポも候補に含める(root cause 修正) ──
  // 背景: プレフィックス無しのタスク(例:「azure-rg …修正」)は effWorkDir=BASE_DIR(lowyworkenv)
  //   になるが、サブエージェントは projects/giipprj/giipv3 のような lowyworkenv の兄弟パスを編集する。
  //   effWorkDir 配下しか見ない従来スキャンでは、その変更は発見されず auto-PR から丸ごと漏れ、
  //   コードは commit も PR もされないまま「完了」報告される(= giipv3 を直したのに PR が無い、の根因)。
  //   → PROJECTS_ROOT を常に 1〜2 階層スキャンして兄弟 repo(giipprj/giipv3, giipprj/giipdb 等)も候補化。
  //   実際に「このタスクが変更した」repo だけが後段(commitAndPRChangedRepos)で preDirt 差分により
  //   commit/PR/skip 判定されるため、候補を広げても無関係リポには一切触れない。
  const PROJECTS_ROOT = path.dirname(BASE_DIR); // …/projects
  scanNested(PROJECTS_ROOT);

  return roots;
}

// ── 作業「前」: 候補 nested repo の base ブランチを origin 最新へ ff 同期する ──
// 根本原因(ユーザ指摘「giipv3 は毎回 conflict」): prepareTaskBranch/restoreTaskBranch の
//   ff-pull は BASE_DIR(lowyworkenv) だけを同期し、nested repo(giipprj/giipv3 等)の
//   ローカル base は誰も更新しなかった。その結果サブエージェントは「数コミット遅れた
//   stale な base」上でファイルを編集し、後段 auto-PR が最新 origin/base から切った
//   ブランチへ replay する時に、既に origin へ merge 済みの変更と衝突していた
//   (= giip-701 が作った SES ファイルを giip-705 が「新規」として再作成 → add/add conflict)。
// 対策: 作業を始める前に、各候補 repo が「base ブランチ上」かつ「クリーン(未コミット無し)」
//   の時だけ origin/base へ ff 同期する。feature ブランチや dirty(= 未統合 WIP)は触らない。
// 安全性: 常に ff-only。ローカル base に独自コミットは積まない前提なので diverge しない。
//   失敗・skip は非致命(ログのみ) — 同期できなくても従来同様に実行は続く。
function syncCandidateReposBase(effWorkDir) {
  const results = [];
  let roots;
  try { roots = candidateRepoRoots(effWorkDir); }
  catch (e) { console.error('[TaskManager] syncCandidateReposBase: 列挙失敗 —', e.message); return results; }
  for (const [, root] of roots) {
    try {
      const base = getBaseBranch(root);
      const cur = getCurrentBranch(root);
      if (cur !== base) { results.push({ root, base, synced: false, reason: `on '${cur}' (not base)` }); continue; }
      if (porcelainPathSet(root).size > 0) { results.push({ root, base, synced: false, reason: 'dirty working tree' }); continue; }
      const fetched = gitC(root, ['fetch', 'origin', base]);
      if (fetched.status !== 0) { results.push({ root, base, synced: false, reason: `fetch failed: ${(fetched.stderr || '').trim().slice(0, 80)}` }); continue; }
      const ff = gitC(root, ['merge', '--ff-only', `origin/${base}`]);
      if (ff.status !== 0) { results.push({ root, base, synced: false, reason: `ff-merge failed: ${(ff.stderr || '').trim().slice(0, 80)}` }); continue; }
      results.push({ root, base, synced: true, advanced: !/Already up to date/i.test(ff.stdout || '') });
    } catch (e) {
      results.push({ root, synced: false, reason: e.message });
    }
  }
  for (const r of results) {
    if (r.synced) console.log(`[TaskManager] syncCandidateReposBase: ${r.root} ${r.base} ${r.advanced ? 'ff-synced to origin' : 'up to date'}`);
    else console.log(`[TaskManager] syncCandidateReposBase: skip ${r.root} — ${r.reason}`);
  }
  return results;
}

// ── 作業「前」: 候補 nested repo を「このタスク専用ブランチ」へ切り替える(スト孤児化の根本予防) ──
//
// 근본원인: prepareTaskBranch/restoreTaskBranch 는 BASE_DIR(lowyworkenv)만 bot/task-<id> 로
//   전환·복원했고, nested repo(giipprj/giipv3, giipprj/giipdb)는 직전 태스크가 남긴 브랜치
//   (예: bot/task-giip-705)에 파킹된 채 방치됐다. 그래서 서브에이전트의 nested 편집은
//   '남의 브랜치'에 쌓였고, 후단 commitAndPRChangedRepos 는 originalBranch≠bot/task-<id> 를
//   'foreign branch' 로 판정해 skip → 코드가 PR 없이 스트랜드됐다(= "REVIEW인데 배포 0"의 뿌리).
//
// 대책: 서브에이전트 실행 '전'에, base 위에서 clean 한 후보 repo 만 origin/base 起点의
//   bot/task-<id> 로 checkout 한다. 그러면 편집이 올바른 전용 브랜치에 쌓여 자동 commit·PR 이
//   성립하고, unlanded(스트랜드)가 정상 경로에서 사라진다.
//
// 안전 원칙(데이터 최우선):
//   · clean(미커밋 0) & base 브랜치 위 인 repo 만 만진다.
//   · dirty(미정리 WIP) 나 이미 비-base(foreign)에 있는 repo 는 절대 건드리지 않는다
//     (= 기존 스트랜드/사용자 WIP 를 덮지 않음 — 그건 감사/재개가 별도 처리).
//   · BASE_DIR 은 prepareTaskBranch 가 이미 담당하므로 제외.
// 반환: [{ root, base, branch, restoreTo }] — restoreNestedBranches 로 원복할 목록.
function prepareNestedBranches(effWorkDir, taskId, excludeRoots = [BASE_DIR]) {
  const branch = `bot/task-${taskId}`;
  const exclude = new Set((excludeRoots || []).map(normRoot));
  const prepared = [];
  let roots;
  try { roots = candidateRepoRoots(effWorkDir); }
  catch (e) { console.error('[TaskManager] prepareNestedBranches: 열거 실패 —', e.message); return prepared; }
  for (const [nr, root] of roots) {
    if (exclude.has(nr)) continue;
    try {
      const base = getBaseBranch(root);
      const cur = getCurrentBranch(root);
      if (porcelainPathSet(root).size > 0) {
        console.log(`[TaskManager] prepareNestedBranches: skip ${root} — dirty(미정리 WIP); ${branch} 전환 안 함`);
        continue;
      }
      if (cur !== base) {
        console.log(`[TaskManager] prepareNestedBranches: skip ${root} — '${cur}'(≠base ${base}); 스트랜드 흔적, 이번엔 만지지 않음`);
        continue;
      }
      const fetched = gitC(root, ['fetch', 'origin', base]);
      const startPoint = fetched.status === 0 ? `origin/${base}` : base;
      const co = gitC(root, ['checkout', '-B', branch, startPoint]);
      if (co.status !== 0) {
        console.error(`[TaskManager] prepareNestedBranches: ${root} checkout 실패 —`, (co.stderr || '').trim().slice(0, 120));
        continue;
      }
      prepared.push({ root, base, branch, restoreTo: base });
      console.log(`[TaskManager] prepareNestedBranches: ${root} → ${branch} (from ${startPoint})`);
    } catch (e) {
      console.error(`[TaskManager] prepareNestedBranches: ${root} 오류 —`, e.message);
    }
  }
  return prepared;
}

// ── 作業「後」: prepareNestedBranches 로 전환한 nested repo 를 base 로 복원한다 ──
// commitAndPRChangedRepos 가 이미 각 repo 를 commit·push·PR 하고 그 전용 브랜치로 checkout 해 둔다.
//   여기서 base 로 되돌려(ff-pull) 다음 태스크가 clean·on-base 에서 시작하게 한다
//   (= restoreTaskBranch 의 nested 판; 드리프트 누적을 끊는다).
// 안전: 커밋 안 된 변경이 남은 repo 는 base 로 옮기면 변경이 딸려가 오염되므로 복원을 보류한다
//   (= commitAndPR 가 skip/blocked 로 남긴 잔여물은 그대로 두고 감사/재개가 처리).
function restoreNestedBranches(prepared) {
  for (const p of (prepared || [])) {
    const root = p.root, base = p.restoreTo || p.base;
    try {
      if (porcelainPathSet(root).size > 0) {
        console.log(`[TaskManager] restoreNestedBranches: ${root} 에 미커밋 변경 잔존 → base 복원 보류(스트랜드 방지)`);
        continue;
      }
      const co = gitC(root, ['checkout', base]);
      if (co.status !== 0) { console.error(`[TaskManager] restoreNestedBranches: ${root} base(${base}) 복원 실패 —`, (co.stderr || '').trim().slice(0, 120)); continue; }
      const pull = gitC(root, ['pull', '--ff-only', 'origin', base]);
      if (pull.status !== 0) console.error(`[TaskManager] restoreNestedBranches: ${root} ${base} ff-pull 실패(비치명) —`, (pull.stderr || '').trim().slice(0, 80));
    } catch (e) {
      console.error(`[TaskManager] restoreNestedBranches: ${root} 오류 —`, e.message);
    }
  }
}

function snapshotCandidateRepos(effWorkDir) {
  const roots = candidateRepoRoots(effWorkDir);
  const snaps = [];
  for (const [norm, root] of roots) {
    snaps.push({
      root,
      normRoot: norm,
      originalBranch: getCurrentBranch(root),
      preDirt: porcelainPathSet(root),
    });
  }
  return snaps;
}

// スナップショットした候補リポのうち、タスクが実際に変更したものを各々 commit·push·PR する。
// opts.excludeRoots: ここで扱わないリポ(既存の gitPushResultAndPR が扱う BASE_DIR 等)。
// 返り値: { prs:[{repo,url}], skipped:[{repo,reason}] }
function commitAndPRChangedRepos(taskId, taskTitle, snapshots, opts = {}) {
  const excludeRoots = new Set((opts.excludeRoots || []).map(normRoot));
  const prs = [];
  const skipped = [];
  const blocked = []; // PR 충돌 게이트에 걸려 PR 생성을 보류한 저장소(브랜치는 push 됨)
  const branch = `bot/task-${taskId}`;
  const coAuthor = 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>';

  for (const snap of (snapshots || [])) {
    const root = snap.root;
    const nr = snap.normRoot || normRoot(root);
    if (excludeRoots.has(nr)) continue; // 別経路が担当 → ここでは扱わない

    const git = (args) => gitC(root, args);
    const originalBranch = snap.originalBranch || getCurrentBranch(root);

    try {
      const postDirt = porcelainPathSet(root);
      const newPaths = [...postDirt].filter(p => !snap.preDirt.has(p));
      if (newPaths.length === 0) continue; // タスクはこのリポを変更していない → 静かに skip

      // ── データ安全ガード ①: 実行前から dirt があったリポの扱い ──
      // 背景: giipv3/giipdb 等の nested repo は、サブエージェントが「git 操作禁止」指示の下で
      //   作業ツリーにのみ変更を残す（あるいは前段セッションが残す）ため、スナップショット時点で
      //   ほぼ常に preDirt > 0 になる。旧実装はこれを一律 skip していたため nested repo の変更は
      //   永遠に自動 PR されなかった（= ユーザ指摘の「毎回 手動 PR」問題の根因）。
      //
      // 判別の鍵: 「専用 feature/task ブランチ上の dirt」はそのタスクの作業とみなせる（base で
      //   ないブランチに居る = 誰かが意図してそのブランチを切って作業した強いシグナル）。一方
      //   「base ブランチ上の dirt」はユーザの無関係な WIP かもしれず、従来通り触らない。
      if (snap.preDirt.size > 0) {
        const base0 = getBaseBranch(root);
        const onFeatureBranch = originalBranch && originalBranch !== base0 && originalBranch !== 'HEAD';
        if (!onFeatureBranch) {
          // base ブランチ上の未コミット変更 = 曖昧な WIP。安全側に倒して従来通り skip。
          skipped.push({ repo: root, reason: `pre-existing uncommitted changes on base branch '${base0}'; manual PR needed`, files: newPaths });
          continue;
        }
        // ── 誤帰属ガード: 「別タスクのブランチ」に停まった共有チェックアウトは自動 commit しない ──
        // 背景(giip-720 実例): giipprj/giipv3 は複数タスクで共有される単一チェックアウトで、
        //   別タスクのブランチ(例 bot/task-giip-705)に停まったまま、そのタスクの未コミット変更と
        //   今回タスクの変更が同じ作業ツリーで混在する。ここで git add -A + commit すると
        //   (1) 他タスクの churn まで巻き込み、(2) 他タスクのブランチ/PR へ push してしまう。
        //   → このタスク専用ブランチ(bot/task-<taskId>)に居る時だけ自動 commit。そうでなければ
        //     手動 PR が必要な旨を明示して skip(= 後段の完了報告で警告される)。
        if (originalBranch !== branch) {
          skipped.push({
            repo: root,
            reason: `changes tangled on foreign branch '${originalBranch}' (≠ ${branch}); shared checkout — manual PR needed`,
            files: newPaths,
          });
          continue;
        }
        // 専用 feature/task ブランチ上の変更 → そのブランチのまま commit·push·PR する。
        // (stash→bot/task ブランチ の付け替えはしない: ブランチは既にセッション/前段が選んでいる。)
        git(['add', '-A']);
        const msgF = `task(${taskId}): ${String(taskTitle).slice(0, 60)}\n\nAuto-committed by giipclaude Bot\n\n${coAuthor}`;
        const commitF = git(['commit', '-m', msgF]);
        if (commitF.status !== 0 && !/nothing to commit/.test(commitF.stdout || '')) {
          skipped.push({ repo: root, reason: `commit failed on '${originalBranch}': ${(commitF.stderr || '').trim().slice(0, 120)}` });
          continue;
        }
        let pushF = git(['push', '-u', 'origin', originalBranch]);
        if (pushF.status !== 0) {
          git(['pull', '--rebase', '--autostash', 'origin', originalBranch]);
          pushF = git(['push', '-u', 'origin', originalBranch]);
        }
        if (pushF.status !== 0) {
          skipped.push({ repo: root, reason: `push failed: ${(pushF.stderr || '').trim().slice(0, 120)} (commit is local on '${originalBranch}')` });
          continue;
        }
        // ── PR 충돌 게이트: 변경 파일이 미머지 열린 PR 대상이면 PR 생성 보류(브랜치는 이미 push) ──
        const blkF = findBlockingPRs(root, newPaths, originalBranch);
        if (blkF.length) {
          blocked.push({ repo: root, branch: originalBranch, base: base0, prs: blkF, files: newPaths });
          continue; // 경쟁 PR 을 만들지 않는다. "머지완료 <taskid>" 로 재개.
        }
        const urlF = ensurePR(taskId, taskTitle, originalBranch, base0, root);
        prs.push({ repo: root, url: urlF });
        continue; // このリポは完了。以降の clean-before(stash) フローには進まない。
      }

      const base = getBaseBranch(root);

      // タスク由来の変更を stash に退避(未追跡ファイル含む -u)
      const stash = git(['stash', 'push', '-u', '-m', `bot-task-${taskId}`]);
      if (stash.status !== 0) {
        skipped.push({ repo: root, reason: `stash failed: ${(stash.stderr || '').trim().slice(0, 120)}` });
        continue;
      }
      if (/No local changes to save/.test(stash.stdout || '')) continue; // 念のため

      // origin/base 起点で bot/task ブランチを作る(常に最新 base 基準)
      const fetched = git(['fetch', 'origin', base]);
      const startPoint = fetched.status === 0 ? `origin/${base}` : base;
      const co = git(['checkout', '-B', branch, startPoint]);
      if (co.status !== 0) {
        // ブランチ作成失敗 → まだ originalBranch に居るので stash を戻して skip(データ保全)
        git(['checkout', originalBranch]);
        git(['stash', 'pop']);
        skipped.push({ repo: root, reason: `branch create failed; changes restored to ${originalBranch}` });
        continue;
      }

      // 退避した変更を bot ブランチへ適用
      const pop = git(['stash', 'pop']);
      const conflicts = git(['diff', '--name-only', '--diff-filter=U']);
      const hasConflict = (conflicts.stdout || '').trim().length > 0;
      if (pop.status !== 0 || hasConflict) {
        // ── conflict 回復(データ非損失を保証) ──
        // pop が conflict した場合、stash エントリは list に残る(pop は drop しない)。
        // bot ブランチ側の部分適用を破棄 → 元ブランチへ戻り → そこへ stash を再適用する。
        // clean-before 保証があるため、この reset --hard + clean は「タスク由来の未追跡物」
        // だけを消し、stash に全て残っているので損失ゼロ。
        git(['reset', '--hard', 'HEAD']);
        git(['clean', '-fd']); // clean-before なので untracked は全てタスク/stash 由来 = 復元可能
        git(['checkout', originalBranch]);
        const pop2 = git(['stash', 'pop']); // clean な元ブランチへ再適用
        git(['branch', '-D', branch]);       // 空の bot ブランチを削除
        skipped.push({
          repo: root,
          reason: pop2.status === 0
            ? 'auto-PR conflict; changes left on original branch'
            : 'auto-PR conflict; stash retained (see `git stash list`) — manual recovery needed',
        });
        continue;
      }

      // clean pop → commit
      git(['add', '-A']);
      const msg = `task(${taskId}): ${String(taskTitle).slice(0, 60)}\n\nAuto-committed by giipclaude Bot\n\n${coAuthor}`;
      const commit = git(['commit', '-m', msg]);
      if (commit.status !== 0 && !/nothing to commit/.test(commit.stdout || '')) {
        git(['checkout', originalBranch]);
        skipped.push({ repo: root, reason: `commit failed: ${(commit.stderr || '').trim().slice(0, 120)}` });
        continue;
      }

      // push(新規は -u、拒否時は fetch+rebase して再試行)
      let push = git(['push', '-u', 'origin', branch]);
      if (push.status !== 0) {
        git(['fetch', 'origin', branch]);
        git(['pull', '--rebase', '--autostash', 'origin', branch]);
        push = git(['push', '-u', 'origin', branch]);
      }
      if (push.status !== 0) {
        // push 失敗: commit はローカル bot ブランチに残る(損失なし)。元ブランチへ戻して報告。
        git(['checkout', originalBranch]);
        skipped.push({ repo: root, reason: `push failed: ${(push.stderr || '').trim().slice(0, 120)} (commit is local on ${branch})` });
        continue;
      }

      // ── PR 충돌 게이트: 변경 파일이 미머지 열린 PR 대상이면 PR 생성 보류(브랜치는 이미 push) ──
      const blk = findBlockingPRs(root, newPaths, branch);
      if (blk.length) {
        blocked.push({ repo: root, branch, base, prs: blk, files: newPaths });
        git(['checkout', originalBranch]); // 작업트리 복원(PR 은 보류)
        continue; // 경쟁 PR 을 만들지 않는다. "머지완료 <taskid>" 로 재개.
      }
      // PR 作成(gh 失敗時は ensurePR が compare URL にフォールバック)
      const url = ensurePR(taskId, taskTitle, branch, base, root);
      prs.push({ repo: root, url });
      git(['checkout', originalBranch]); // 作業ツリーを元ブランチへ復元
    } catch (e) {
      // best-effort: 例外時も必ず元ブランチへ戻し、mid-conflict のまま放置しない
      try { git(['checkout', originalBranch]); } catch {}
      skipped.push({ repo: root, reason: `error: ${e.message}` });
    }
  }
  return { prs, skipped, blocked };
}

// ── 재개: 사용자가 "머지완료 <taskid>" 로 선행 PR 머지를 알리면, 보류했던 저장소들을
//   최신 base 로 rebase 후 PR 을 생성한다. 머지된 변경이 base 에 들어왔으므로 대개 자동 해소.
//   여전히 같은 라인을 건드려 conflict 나면 그 저장소는 수동 필요로 보고(브랜치는 보존).
// blockedRecords: commitAndPRChangedRepos 가 tasklist 에 남긴 [{repo,branch,base,prs,files}].
// 반환: { prs:[{repo,url}], stillBlocked:[{repo,reason,branch,prs?}], failed:[{repo,reason}] }.
function resumeBlockedTask(taskId, taskTitle, blockedRecords) {
  const prs = [], stillBlocked = [], failed = [];
  for (const rec of (blockedRecords || [])) {
    const root = rec.repo;
    const branch = rec.branch;
    const base = rec.base || getBaseBranch(root);
    const git = (args) => gitC(root, args);
    let originalBranch = null;
    try {
      originalBranch = getCurrentBranch(root);
      git(['fetch', 'origin', base]);
      git(['fetch', 'origin', branch]);
      const co = git(['checkout', branch]);
      if (co.status !== 0) { failed.push({ repo: root, reason: `checkout '${branch}' 실패: ${(co.stderr || '').trim().slice(0, 120)}` }); continue; }
      const rb = git(['rebase', `origin/${base}`]);
      if (rb.status !== 0) {
        git(['rebase', '--abort']);
        if (originalBranch) git(['checkout', originalBranch]);
        stillBlocked.push({ repo: root, branch, reason: `origin/${base} 로 rebase conflict — 수동 해소 필요` });
        continue;
      }
      const push = git(['push', '--force-with-lease', 'origin', branch]);
      if (push.status !== 0) {
        if (originalBranch) git(['checkout', originalBranch]);
        failed.push({ repo: root, reason: `push 실패: ${(push.stderr || '').trim().slice(0, 120)} (커밋은 로컬 '${branch}' 에 보존)` });
        continue;
      }
      // 재검사: rebase 후에도 아직 겹치는 미머지 PR 이 있으면 또 보류
      const blk = findBlockingPRs(root, rec.files || [], branch);
      if (blk.length) {
        if (originalBranch) git(['checkout', originalBranch]);
        stillBlocked.push({ repo: root, branch, prs: blk, reason: `아직 미머지 PR ${blk.map(b => '#' + b.number).join(', ')} 대상` });
        continue;
      }
      const url = ensurePR(taskId, taskTitle, branch, base, root);
      prs.push({ repo: root, url });
      if (originalBranch) git(['checkout', originalBranch]);
    } catch (e) {
      try { if (originalBranch) git(['checkout', originalBranch]); } catch {}
      failed.push({ repo: root, reason: e.message });
    }
  }
  return { prs, stillBlocked, failed };
}

// ── Tasklist ファイル管理 ──────────────────────────────────────────────────────
function loadTasklist() {
  try { return JSON.parse(fs.readFileSync(TASKLIST_FILE, 'utf8')); } catch { return []; }
}

function saveTasklist(list) {
  try { fs.writeFileSync(TASKLIST_FILE, JSON.stringify(list, null, 2)); } catch {}
}

function extractSummary(planContent) {
  // "## リクエスト内容" の直後の行を1行サマリとして使う
  const m = planContent.match(/##\s*リクエスト内容\s*\n+(.+)/);
  if (m) return m[1].trim().slice(0, 80);
  // フォールバック: 最初の非ヘッダ行
  const line = planContent.split('\n').find(l => l.trim() && !l.startsWith('#'));
  return (line || '').trim().slice(0, 80);
}

function addToTasklist(taskId, title, summary, requestText) {
  const list = loadTasklist();
  list.push({
    taskId,
    title,
    summary: summary || requestText.slice(0, 80),
    status: 'pending',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    resultUrl: null,
  });
  saveTasklist(list);
}

function updateTasklistEntry(taskId, updates) {
  const list = loadTasklist();
  const idx = list.findIndex(t => t.taskId === taskId);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...updates };
    saveTasklist(list);
  }
}

// status: 'pending' | 'running' | 'completed' | 'cancelled' | null(全件)
function getTasklistByStatus(status = null) {
  const list = loadTasklist();
  return status ? list.filter(t => t.status === status) : list;
}

// ステータス絵文字
function statusEmoji(status) {
  return { pending: '🕐', running: '⚙️', completed: '✅', cancelled: '🚫', blocked: '⏸️' }[status] || '❓';
}

// タスクファイルの GitHub URL を動的に生成
function getTaskFileUrl(taskId) {
  const candidates = [
    path.join(TASKS_DIR, `${taskId}.md`),
    path.join(TASKS_DIR, 'done', `${taskId}.md`),
    path.join(TASKS_DIR, 'cancel', `${taskId}.md`),
  ];
  const found = candidates.find(f => fs.existsSync(f));
  if (!found) return null;
  const rel = path.relative(BASE_DIR, found).replace(/\\/g, '/');
  return buildGitHubUrl(rel);
}

// タスクファイルをキャンセル状態にして cancel/ フォルダへ移動
function cancelTaskFile(taskId) {
  const candidates = [
    path.join(TASKS_DIR, `${taskId}.md`),
    path.join(TASKS_DIR, `task-${taskId}.md`),
  ];
  const taskFile = candidates.find(f => fs.existsSync(f));
  if (!taskFile) throw new Error(`Task file not found for ${taskId}`);

  const now = new Date().toISOString();
  let content = fs.readFileSync(taskFile, 'utf8');
  content = /status:\s*.+/i.test(content)
    ? content.replace(/status:\s*.+/i, 'status: cancelled')
    : `status: cancelled\n${content}`;
  if (content.includes('## 進捗ログ')) {
    content = content.replace(/(## 進捗ログ[\s\S]*?)(\n## |\s*$)/, (m, s, n) => `${s.trimEnd()}\n| ${now} | Slack cancel |\n${n}`);
  } else {
    content = `${content.trimEnd()}\n\n## 進捗ログ\n\n| ${now} | Slack cancel |\n`;
  }
  fs.writeFileSync(taskFile, content);

  const cancelDir = path.join(TASKS_DIR, 'cancel');
  if (!fs.existsSync(cancelDir)) fs.mkdirSync(cancelDir, { recursive: true });
  const destPath = path.join(cancelDir, path.basename(taskFile));

  // task files are untracked runtime files — use fs.rename instead of git mv
  fs.renameSync(taskFile, destPath);

  return path.relative(BASE_DIR, destPath).replace(/\\/g, '/');
}

module.exports = {
  getTimestampId,
  analyzeRequest,
  createTaskFile,
  updateTaskFile,
  rebuildTaskFileFromIssue,
  extractTitle,
  extractSummary,
  startExecution,
  completeTaskFile,
  appendTaskNote,
  gitPushResult,
  prepareTaskBranch,
  restoreTaskBranch,
  gitPushResultAndPR,
  snapshotCandidateRepos,
  syncCandidateReposBase,
  prepareNestedBranches,
  restoreNestedBranches,
  commitAndPRChangedRepos,
  findBlockingPRs,
  resumeBlockedTask,
  getBaseBranch,
  addToTasklist,
  updateTasklistEntry,
  getTasklistByStatus,
  statusEmoji,
  cancelTaskFile,
  getTaskFileUrl,
  buildContextCatalog,
  selectContextFiles,
  normalizeFilesRead,
};
