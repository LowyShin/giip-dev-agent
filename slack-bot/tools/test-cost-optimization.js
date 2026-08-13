#!/usr/bin/env node
/**
 * test-cost-optimization.js — giip-1063 비용 최적화 회귀 테스트
 *
 * 이 저장소에는 테스트 러너가 없어서 의존성 없는 순수 Node 스크립트로 만들었다.
 *   node slack-bot/tools/test-cost-optimization.js
 * 종료코드 0 = 전부 통과.
 *
 * 커버 범위 (이슈 "6. 테스트 요구사항" A~G 중 실제 모델 호출 없이 검증 가능한 부분)
 *   A 단순 문구 수정      → trivial 분류 / Fast Path / 계획용 프리미엄 모델 미사용
 *   B 일반 버그 수정      → standard 분류 / MiniMax 우선 / Sonnet급 fallback
 *   C 인증 코드 수정      → critical 분류 / Fast Path 금지 / 프리미엄은 계획·검토에서만
 *   D 사용량 제한         → 오류 분류 / checkpoint 생성 / 재개 지시문 / 재시도 상한
 *   E 컨텍스트 제한       → 50개 이상 파일에서 최대 8개, 중복 제거, 전체 길이 한도, 사유 기록
 *   F 기존 태스크 재실행  → context_files 왕복(신규 YAML + 구형 주석 하위 호환)
 *   G 기존 기능 회귀      → 모든 모듈 로드, export 유지, 명령어 문자열 존재, 하드코딩 제거 확인
 * 추가: 프롬프트 고정 prefix 순서 / 비용 로그 기록·집계 / 비밀값 마스킹 / 배치 처리
 *
 * 실제 모델을 호출하는 경로(A~D 의 "모델 1회 실행", G 의 Slack·PR 흐름)는 여기서 검증할 수
 * 없다 — 라이브 확인이 필요하다.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SB = path.join(__dirname, '..');
const router = require(path.join(SB, 'model-router'));
const modelConfig = require(path.join(SB, 'model-config'));
const ctxBuilder = require(path.join(SB, 'context-builder'));
const prompts = require(path.join(SB, 'prompt-templates'));
const checkpoint = require(path.join(SB, 'retry-checkpoint'));
const costTracker = require(path.join(SB, 'cost-tracker'));
const batchPlanner = require(path.join(SB, 'batch-planner'));
const { maskString, maskDeep } = require(path.join(SB, 'secret-mask'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

/**
 * 마스킹 테스트용 "가짜" 토큰. 소스에 리터럴로 적으면 GitHub push protection 이
 * 실제 시크릿으로 오탐해 push 가 막히므로 런타임에 조립한다. 전부 무효값이다.
 */
function fakeSecrets() {
  const a = 'abcdefghijklmnop';
  return {
    slack: ['xo' + 'xb', '123456789012', a].join('-'),
    anthropic: ['sk', 'a' + 'nt', a].join('-'),
    minimax: ['sk', 'c' + 'p', a].join('-'),
    github: 'g' + 'hp' + '_' + 'abcdefghijklmnopqrstuvwxyz012345',
  };
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── 테스트 A: 단순 문구 수정 ────────────────────────────────────────────────
section('테스트 A: 단순 문구 수정 (trivial + Fast Path)');
const A_REQ = 'README.md의 "Zero Tool Setup"을 "Minimal Tool Setup"으로 변경해줘.';

test('trivial 로 분류된다', () => {
  const c = router.classifyTask(A_REQ, [], '');
  assert.strictEqual(c.class, 'trivial', `class=${c.class} reasons=${c.reasons.join('/')}`);
  assert.ok(c.reasons.length, '분류 사유가 기록돼야 한다');
});

test('Fast Path 적용 대상이다 (경로 명시 + 1개 파일)', () => {
  const c = router.classifyTask(A_REQ, [], '');
  assert.ok(c.fastPathEligible, 'fastPathEligible 이어야 한다');
  assert.deepStrictEqual(c.explicitPaths, ['README.md']);
});

test('계획 단계에 최상위(critical) 티어 모델을 쓰지 않는다', () => {
  const sel = router.selectModel('trivial', 'plan');
  assert.strictEqual(sel.premiumAllowed, false);
  assert.notStrictEqual(sel.tier, 'critical');
});

test('Fast Path 계획은 모델 호출 없이 태스크 사양 형식을 만든다', () => {
  const tm = require(path.join(SB, 'task-manager'));
  const plan = tm.buildFastPathPlan(A_REQ, router.classifyTask(A_REQ, [], ''));
  assert.ok(/^# TASK: /m.test(plan), 'TASK 제목이 있어야 한다');
  assert.ok(/## 실행 계획/.test(plan) && /## 영향 파일/.test(plan));
  assert.ok(/Fast Path/.test(plan), 'Fast Path 임을 명시해야 한다');
  assert.strictEqual(tm.extractTitle(plan).length > 0, true);
});

test('Fast Path 프롬프트도 확인/검증/보고를 강제한다', () => {
  const p = prompts.buildExecutionPrompt({ fastPath: true, taskContent: 'x' });
  assert.ok(/변경 전 대상 파일을 반드시 먼저 읽어/.test(p));
  assert.ok(/테스트 또는 재현 검증/.test(p));
  assert.ok(/결과 보고서/.test(p));
});

// ── 테스트 B: 일반 버그 수정 ────────────────────────────────────────────────
section('테스트 B: 일반 버그 수정 (standard)');
const B_REQ = '로그인 후 대시보드에서 합계가 1 적게 나오는 계산 오류를 고쳐줘';

test('DB/인증 변경이 없는 단일 수정은 standard 이상으로 분류된다', () => {
  const c = router.classifyTask('대시보드 합계가 1 적게 나오는 계산 오류를 고쳐줘', [], '');
  assert.ok(['standard', 'complex'].includes(c.class), `class=${c.class}`);
  assert.strictEqual(c.fastPathEligible, false, 'Fast Path 대상이 아니어야 한다');
});

test('"로그인" 이 들어간 요청은 critical 로 승격된다(안전측)', () => {
  const c = router.classifyTask(B_REQ, [], '');
  assert.strictEqual(c.class, 'critical');
});

test('standard 실행은 MiniMax 우선, 없으면 Sonnet급 fallback', () => {
  const withMM = router.selectModel('standard', 'execute', { minimax: true });
  assert.strictEqual(withMM.provider, 'minimax');
  const noMM = router.selectModel('standard', 'execute', { minimax: false });
  assert.strictEqual(noMM.provider, 'claude');
  assert.strictEqual(noMM.model, modelConfig.fallbackModelForTier('standard'));
  assert.notStrictEqual(noMM.model, modelConfig.LEGACY_PREMIUM_MODEL);
});

// ── 테스트 C: 인증 코드 수정 ────────────────────────────────────────────────
section('테스트 C: 인증 코드 수정 (critical)');
const C_REQ = 'auth.js 의 세션 토큰 검증 로직을 고쳐서 권한 우회를 막아줘';

test('최소 critical 로 분류된다', () => {
  const c = router.classifyTask(C_REQ, [], '');
  assert.strictEqual(c.class, 'critical');
});

test('critical 은 Fast Path 를 적용하지 않는다', () => {
  const c = router.classifyTask(C_REQ, [], '');
  assert.strictEqual(c.fastPathEligible, false);
  assert.strictEqual(router.isFastPathEligible({ taskClass: 'critical', explicitPaths: ['a.js'] }), false);
});

test('critical 은 계획/검토에서만 프리미엄 모델을 허용한다', () => {
  assert.strictEqual(router.selectModel('critical', 'plan').premiumAllowed, true);
  assert.strictEqual(router.selectModel('critical', 'review').premiumAllowed, true);
  assert.strictEqual(router.selectModel('critical', 'execute').premiumAllowed, false);
  assert.strictEqual(router.selectModel('critical', 'classify').tier, 'trivial');
});

test('critical 이라도 실행 단계가 저가(trivial) 티어로 내려가지 않는다', () => {
  const sel = router.selectModel('critical', 'execute', { minimax: true });
  assert.strictEqual(sel.tier, 'complex');
  assert.strictEqual(sel.fallback.model, modelConfig.fallbackModelForTier('critical'));
});

test('마이그레이션/배포 설정은 최소 complex 로 승격된다', () => {
  assert.ok(['complex', 'critical'].includes(router.classifyTask('DB 스키마 마이그레이션 스크립트 추가', [], '').class));
  assert.ok(['complex', 'critical'].includes(router.classifyTask('github actions workflow.yml 배포 설정 변경', [], '').class));
});

// ── 테스트 D: MiniMax 사용량 제한 → checkpoint 재개 ─────────────────────────
section('테스트 D: 사용량 제한 → checkpoint 로 이어서 재개');
const D_DIR = tmpdir('fde-cp-');

test('사용량 제한 응답을 usage_limit 로 분류한다', () => {
  assert.strictEqual(checkpoint.classifyError('HTTP 429 rate limit exceeded'), 'usage_limit');
  assert.strictEqual(checkpoint.classifyError("You've hit your weekly limit"), 'usage_limit');
  assert.strictEqual(checkpoint.classifyError('401 Unauthorized: invalid api key'), 'auth');
  assert.strictEqual(checkpoint.classifyError('ETIMEDOUT'), 'timeout');
});

test('checkpoint 파일이 .agent/runtime/checkpoints 아래에 생성된다', () => {
  checkpoint.beginAttempt(D_DIR, 'giip-1063', { attempt: 1, provider: 'minimax', model: 'MiniMax-M2.7', taskClass: 'standard' });
  const p = checkpoint.checkpointPath(D_DIR, 'giip-1063');
  assert.ok(fs.existsSync(p), `checkpoint 파일이 있어야 한다: ${p}`);
  assert.ok(p.replace(/\\/g, '/').includes('.agent/runtime/checkpoints/'));
});

test('진행이 있었으면 "이어서 재개" 지시문을 만든다(전체 원문 재전송 아님)', () => {
  const cp = checkpoint.save(D_DIR, 'giip-1063', {
    files_changed: ['slack-bot/task-manager.js', 'slack-bot/model-router.js'],
    completed_steps: ['컨텍스트 선별', '모델 라우터 구현'],
    error_type: 'usage_limit',
    error_summary: '429 rate limit',
  });
  const r = checkpoint.buildResumeInstruction(cp);
  assert.ok(r, '재개 지시문이 있어야 한다');
  assert.ok(r.includes('완료된 작업을 반복하지 마라'));
  assert.ok(r.includes('미완료 단계부터 계속하라'));
  assert.ok(r.includes('slack-bot/model-router.js'));
});

test('작업 시작 전 실패(변경 0건)면 재개 지시 없이 동일 프롬프트 재사용', () => {
  const cp = { attempt: 1, files_changed: [], completed_steps: [] };
  assert.strictEqual(checkpoint.buildResumeInstruction(cp), null);
});

test('checkpoint 에 비밀값을 저장하지 않는다', () => {
  const FAKE = fakeSecrets();
  const cp = checkpoint.save(D_DIR, 'giip-secret', {
    error_summary: `failed with ANTHROPIC_API_KEY=${FAKE.anthropic} and ${FAKE.slack}`,
    api_key: FAKE.minimax,
  });
  const raw = fs.readFileSync(checkpoint.checkpointPath(D_DIR, 'giip-secret'), 'utf8');
  assert.ok(!raw.includes(FAKE.anthropic), 'anthropic key 가 남으면 안 된다');
  assert.ok(!raw.includes(FAKE.slack), 'slack token 이 남으면 안 된다');
  assert.ok(!raw.includes(FAKE.minimax), 'minimax key 가 남으면 안 된다');
  assert.ok(/REDACTED/.test(raw));
  assert.strictEqual(cp.api_key, '***REDACTED***');
});

test('무한 재시도를 막는다 (MAX_PROVIDER_RETRIES / MAX_TOTAL_ATTEMPTS)', () => {
  const prevP = process.env.MAX_PROVIDER_RETRIES, prevT = process.env.MAX_TOTAL_ATTEMPTS;
  process.env.MAX_PROVIDER_RETRIES = '1';
  process.env.MAX_TOTAL_ATTEMPTS = '3';
  const st = { totalAttempts: 0, providerAttempts: {} };
  assert.strictEqual(checkpoint.canRetry(st, 'minimax').ok, true);
  checkpoint.noteAttempt(st, 'minimax');
  assert.strictEqual(checkpoint.canRetry(st, 'minimax').ok, true);   // 1회 재시도 허용
  checkpoint.noteAttempt(st, 'minimax');
  assert.strictEqual(checkpoint.canRetry(st, 'minimax').ok, false);  // 상한 도달
  assert.strictEqual(checkpoint.canRetry(st, 'claude').ok, true);    // 다른 공급자는 별도 카운트
  checkpoint.noteAttempt(st, 'claude');
  assert.strictEqual(checkpoint.canRetry(st, 'claude').ok, false);   // 전체 3회 도달
  if (prevP === undefined) delete process.env.MAX_PROVIDER_RETRIES; else process.env.MAX_PROVIDER_RETRIES = prevP;
  if (prevT === undefined) delete process.env.MAX_TOTAL_ATTEMPTS; else process.env.MAX_TOTAL_ATTEMPTS = prevT;
});

// ── 테스트 E: 컨텍스트 제한 ─────────────────────────────────────────────────
section('테스트 E: 컨텍스트 제한 (50개 이상 role/rule/skill)');
const E_DIR = tmpdir('fde-ctx-');
(function seedFakeProject() {
  const mk = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  for (let i = 0; i < 20; i++) {
    mk(path.join(E_DIR, '.agent', 'roles', `role${i}.md`),
      `---\nname: role${i}\ndescription: 역할 ${i} — deploy pipeline 담당\n---\n# Role ${i}\n${'본문 '.repeat(3000)}\n## 금지 사항\n이 섹션은 파일 끝에 있는 중요한 규칙이다 MARKER${i}\n`);
  }
  for (let i = 0; i < 20; i++) {
    mk(path.join(E_DIR, '.agent', 'rules', `rule${i}.md`),
      `---\nname: rule${i}\ndescription: 규칙 ${i} — deploy 관련 금지사항\n---\n# Rule ${i}\n내용\n`);
  }
  for (let i = 0; i < 15; i++) {
    mk(path.join(E_DIR, '.agent', 'skills', `skill${i}`, 'SKILL.md'),
      `---\nname: skill${i}\ndescription: 스킬 ${i}\ntrigger: deploy, 배포\n---\n# Skill ${i}\n${'스킬본문 '.repeat(2000)}\n`);
  }
  // 동일 내용 중복 파일(중복 제거 확인용)
  mk(path.join(E_DIR, '.agent', 'rules', 'dup_a.md'), '---\nname: dup\ndescription: deploy 중복 규칙\n---\n# Dup\n동일내용\n');
  mk(path.join(E_DIR, '.agent', 'rules', 'dup_b.md'), '---\nname: dup\ndescription: deploy 중복 규칙\n---\n# Dup\n동일내용\n');
})();

test('카탈로그가 50개 이상 만들어지고 본문이 아니라 메타만 담는다', () => {
  const cat = ctxBuilder.buildContextCatalog(E_DIR, E_DIR);
  assert.ok(cat.length >= 50, `catalog=${cat.length}`);
  const text = ctxBuilder.formatCatalogForPrompt(cat);
  assert.ok(!text.includes('본문 본문'), '카탈로그에 파일 본문이 들어가면 안 된다');
  assert.ok(text.includes('trigger: deploy'), 'skill 의 trigger 는 노출돼야 한다');
});

test('정적 선별은 기본 최대 6개를 넘지 않는다', () => {
  const cat = ctxBuilder.buildContextCatalog(E_DIR, E_DIR);
  const sel = ctxBuilder.selectContextFilesStatic('deploy 배포 설정 확인', cat);
  assert.ok(sel.length > 0 && sel.length <= modelConfig.contextLimits().defaultMaxFiles, `selected=${sel.length}`);
  assert.ok(sel.every(s => s.reason), '선택 이유가 기록돼야 한다');
});

test('최대 8개 / 전체 48,000자 한도를 지키고 중복을 제거한다', () => {
  const cat = ctxBuilder.buildContextCatalog(E_DIR, E_DIR);
  const many = cat.slice(0, 30).map(c => ({ path: c.path, reason: 'test' }));
  const r = ctxBuilder.readSelectedContext(many, E_DIR, { queryText: 'deploy' });
  const lim = modelConfig.contextLimits();
  assert.ok(r.filesRead.length <= lim.hardMaxFiles, `files=${r.filesRead.length}`);
  assert.ok(r.stats.chars <= lim.totalMaxChars, `chars=${r.stats.chars}`);
  assert.ok(r.filesRead.every(f => f.chars <= lim.perFileMaxChars), '파일별 한도 초과');
  const paths = r.filesRead.map(f => f.path);
  assert.strictEqual(new Set(paths).size, paths.length, '같은 파일이 두 번 들어가면 안 된다');
});

test('내용이 같은 두 파일은 한 번만 포함된다', () => {
  const r = ctxBuilder.readSelectedContext(
    [{ path: '.agent/rules/dup_a.md', reason: 'a' }, { path: '.agent/rules/dup_b.md', reason: 'b' }],
    E_DIR, { queryText: 'dup' });
  assert.strictEqual(r.filesRead.length, 1, `files=${r.filesRead.length}`);
});

test('앞부분만 자르지 않고 제목 기준으로 관련 섹션을 보존한다', () => {
  const r = ctxBuilder.readSelectedContext(
    [{ path: '.agent/roles/role0.md', reason: 'test', max_chars: 2000 }], E_DIR, { queryText: '금지 MARKER0' });
  assert.strictEqual(r.filesRead.length, 1);
  assert.ok(r.context.includes('MARKER0'), '파일 끝의 중요한 규칙이 살아남아야 한다(slice(0,800) 회귀)');
  assert.ok(r.filesRead[0].condensed, '축약 표시가 있어야 한다');
});

test('선택 결과가 없으면 최소 기본 컨텍스트만 쓴다(전체 roles 재로딩 금지)', () => {
  const repoRoot = path.join(SB, '..');
  const min = ctxBuilder.minimalDefaultContext(repoRoot, repoRoot);
  assert.ok(min.length <= 2, `minimal=${min.length}`);
  assert.ok(min.every(m => m.path.startsWith('.agent/rules/')), '최소 컨텍스트는 rule 몇 개뿐이어야 한다');
});

test('mtime/hash 캐시로 같은 파일을 재파싱하지 않는다', () => {
  ctxBuilder.resetCaches();
  const p = path.join(E_DIR, '.agent', 'rules', 'rule0.md');
  const first = ctxBuilder.getBody(p);
  const second = ctxBuilder.getBody(p);
  assert.strictEqual(first.cached, false);
  assert.strictEqual(second.cached, true);
  assert.strictEqual(first.hash, second.hash);
});

// ── 테스트 F: 태스크 메타데이터 왕복 ────────────────────────────────────────
section('테스트 F: 태스크 메타데이터 (신규 YAML + 구형 주석 하위 호환)');

test('context_files YAML 을 쓰고 다시 읽을 수 있다', () => {
  const files = [
    { path: '.agent/roles/developer.md', reason: '소스 수정 및 테스트 수행', max_chars: 4000 },
    { path: '.agent/rules/10_karpathy_guidelines.md', reason: '요청 범위 밖의 수정 방지', max_chars: 3000 },
  ];
  const yaml = ctxBuilder.formatContextFilesYaml(files);
  const doc = `---\ntask_id: giip-1063\nstatus: pending\n${yaml}\n---\n\n# TASK: x\n`;
  const back = ctxBuilder.parseContextFiles(doc);
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].path, '.agent/roles/developer.md');
  assert.strictEqual(back[0].reason, '소스 수정 및 테스트 수행');
  assert.strictEqual(back[1].max_chars, 3000);
});

test('구형 주석 형식 태스크 파일도 읽힌다(하위 호환)', () => {
  const legacy = [
    '---',
    'task_id: 20260101000000',
    'status: pending',
    '# 분석에 로드된 컨텍스트 파일 (role/rule/skill — 경로 — 로드 사유):',
    '#   - .agent/roles/developer.md — 소스 수정',
    '#   - .agent/rules/09_investment_safety.md — 안전 확인',
    '---',
    '',
    '# TASK: legacy',
  ].join('\n');
  const back = ctxBuilder.parseContextFiles(legacy);
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].path, '.agent/roles/developer.md');
});

test('기존 태스크 파일 갱신 시 context_files 가 최신으로 교체된다', () => {
  const tm = require(path.join(SB, 'task-manager'));
  const old = `---\ntask_id: giip-1\nstatus: pending\ntask_class: standard\n${ctxBuilder.formatContextFilesYaml([{ path: 'a.md', reason: 'old' }])}\n---\n\n# TASK: t\n`;
  const next = tm.upsertContextFilesFrontmatter(old, [{ path: 'b.md', reason: 'new', max_chars: 4000 }], { taskClass: 'complex' });
  const back = ctxBuilder.parseContextFiles(next);
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].path, 'b.md');
  assert.ok(/task_class: complex/.test(next));
});

// ── 프롬프트 고정 prefix ────────────────────────────────────────────────────
section('프롬프트 고정 prefix 안정화 (3.6)');

test('태스크가 달라도 prefix(역할/안전규칙/실행프로토콜)가 동일하다', () => {
  const mk = (over) => prompts.buildExecutionPrompt(Object.assign({
    contextText: 'CTX', projectName: 'p', baseDir: '/a', taskContent: 'T1',
    taskId: 't1', branch: 'b1', attempt: 1, now: '2026-01-01T00:00:00Z',
  }, over));
  const a = mk({});
  const b = mk({ taskContent: 'T2', taskId: 't2', branch: 'b2', attempt: 3, now: '2026-02-02T00:00:00Z' });
  const prefixLen = a.indexOf('=== 선택된 컨텍스트');
  assert.ok(prefixLen > 200, 'prefix 를 찾지 못했다');
  assert.strictEqual(a.slice(0, prefixLen), b.slice(0, prefixLen), '고정 prefix 가 달라졌다');
});

test('동적 값(시각/taskID/브랜치/재시도)은 프롬프트 뒤쪽에만 나온다', () => {
  const p = prompts.buildExecutionPrompt({
    contextText: 'CTX', projectName: 'proj', baseDir: '/a', taskContent: 'TASK BODY',
    taskId: 'giip-1063', branch: 'bot/task-giip-1063', attempt: 2, now: '2026-08-13T00:00:00Z',
  });
  const dynIdx = p.indexOf('=== 동적 상태 ===');
  assert.ok(dynIdx > 0);
  for (const needle of ['giip-1063', 'bot/task-giip-1063', '2026-08-13T00:00:00Z', 'attempt: 2']) {
    assert.ok(p.indexOf(needle) > dynIdx, `${needle} 가 동적 상태 절보다 앞에 있다`);
  }
});

test('프롬프트 버전이 기록된다', () => {
  assert.strictEqual(prompts.PROMPT_VERSION, 'fde-cost-v2');
  assert.ok(prompts.buildExecutionPrompt({ taskContent: 'x' }).includes('prompt_version: fde-cost-v2'));
  assert.ok(prompts.buildAnalysisPrompt({ requestText: 'x' }).includes('prompt_version: fde-cost-v2'));
});

test('재개 지시문은 checkpoint 절(맨 뒤)에만 들어간다', () => {
  const p = prompts.buildExecutionPrompt({ taskContent: 'x', resumeInstruction: 'RESUME-MARK' });
  assert.ok(p.indexOf('RESUME-MARK') > p.indexOf('=== 동적 상태 ==='));
});

// ── 비용 계측 ───────────────────────────────────────────────────────────────
section('토큰·비용 계측 (3.9)');
const F_DIR = tmpdir('fde-cost-');

test('JSON Lines 로 .agent/runtime/cost-usage.jsonl 에 기록된다', () => {
  costTracker.record(F_DIR, {
    task_id: 'giip-1063', phase: 'execute', task_class: 'standard', provider: 'minimax',
    model: 'MiniMax-M2.7', attempt: 1, input_chars: 4000, output_chars: 400,
    context_chars: 11800, context_files: 4, skills_loaded: 1, duration_ms: 1200, status: 'success',
  });
  const p = costTracker.logPath(F_DIR);
  assert.ok(fs.existsSync(p));
  assert.ok(p.replace(/\\/g, '/').endsWith('.agent/runtime/cost-usage.jsonl'));
  const row = JSON.parse(fs.readFileSync(p, 'utf8').trim().split('\n')[0]);
  assert.strictEqual(row.estimated, true, '토큰 미제공 시 추정값 표시');
  assert.strictEqual(row.input_tokens, 1000);
  assert.strictEqual(row.estimated_cost_usd, null, '단가 미설정 모델은 비용을 지어내지 않는다');
});

test('CLI 가 토큰을 알려주면 실제값 + estimated:false', () => {
  const u = costTracker.parseUsageFromOutput('{"usage":{"input_tokens":3200,"output_tokens":700}}');
  assert.deepStrictEqual(u, { input_tokens: 3200, output_tokens: 700, estimated: false });
  costTracker.record(F_DIR, { task_id: 'giip-1063', phase: 'plan', provider: 'claude', model: 'sonnet', ...u });
  const rows = costTracker.readAll(F_DIR);
  assert.strictEqual(rows[rows.length - 1].estimated, false);
});

test('집계는 fallback/재시도 중복 토큰/등급별 평균을 낸다', () => {
  costTracker.record(F_DIR, {
    task_id: 'giip-1063', phase: 'execute', task_class: 'standard', provider: 'claude',
    model: 'sonnet', attempt: 2, input_chars: 8000, output_chars: 100, fallback_from: 'minimax', status: 'success',
  });
  const sum = costTracker.summarize(F_DIR);
  assert.strictEqual(sum.calls, 3);
  assert.strictEqual(sum.fallbacks, 1);
  assert.ok(sum.retry_duplicate_input_tokens > 0, "재시도 중복 토큰이 집계돼야 한다");
  assert.strictEqual(sum.retries, 1);
  assert.ok(sum.by_class.standard, '작업 등급별 집계가 있어야 한다');
  assert.strictEqual(sum.estimated_cost_usd, null, '단가 미설정이면 비용은 측정 불가');
  const text = costTracker.report(F_DIR, '');
  assert.ok(text.includes('총 호출 수'));
  assert.ok(text.includes('측정 불가'), '지어낸 비용 대신 측정 불가로 표기해야 한다');
});

test('비용 로그에도 비밀값을 남기지 않는다', () => {
  const FAKE = fakeSecrets();
  costTracker.record(F_DIR, {
    task_id: 'leak', phase: 'qa', provider: 'claude', model: 'sonnet',
    context_selection: [{ path: 'a', reason: `token is ${FAKE.slack}` }],
  });
  const raw = fs.readFileSync(costTracker.logPath(F_DIR), 'utf8');
  assert.ok(!raw.includes(FAKE.slack));
});

test('가격 파일은 기준일/출처 없이 값을 만들지 않는다', () => {
  const pricing = modelConfig.loadPricing();
  assert.ok(pricing && typeof pricing.models === 'object');
  const r = modelConfig.estimateCostUsd('nonexistent-model', 1000, 1000);
  assert.strictEqual(r.cost, null);
});

// ── 마스킹 ──────────────────────────────────────────────────────────────────
section('비밀값 마스킹 (안전 요구사항 7~9)');

test('알려진 토큰 형식을 마스킹한다', () => {
  const FAKE = fakeSecrets();
  const s = maskString([
    `SLACK_BOT_TOKEN=${FAKE.slack}`,
    `MINIMAX_API_KEY=${FAKE.minimax}`,
    `GITHUB_TOKEN=${FAKE.github}`,
    'Authorization: Bearer abcdefghijklmnopqrstu',
  ].join('\n'));
  assert.ok(!s.includes(FAKE.slack));
  assert.ok(!s.includes(FAKE.minimax));
  assert.ok(!s.includes(FAKE.github));
  assert.ok(!/Bearer abcdefghijklmnopqrstu/.test(s));
});

test('민감한 키 이름의 값은 통째로 지운다', () => {
  const o = maskDeep({ nested: { apiKey: 'plain-value', ok: 'keep-me' } });
  assert.strictEqual(o.nested.apiKey, '***REDACTED***');
  assert.strictEqual(o.nested.ok, 'keep-me');
});

// ── 배치 처리 ───────────────────────────────────────────────────────────────
section('배치 처리 (3.8)');

test('한 메시지의 독립 조회 여러 건을 한 번에 묶는다', () => {
  const p = batchPlanner.planBatch([
    '1. config.js 파일 있는지 확인해줘',
    '2. handlers.js 있는지 확인해줘',
    '3. task-manager.js 있는지 확인해줘',
  ].join('\n'));
  assert.strictEqual(p.batchable, true);
  assert.strictEqual(p.batch_size, 3);
  // giip-1068 8: 실제 절감은 0, 가정 절감만 2. 구 필드(model_calls_saved)는 제거됐다.
  assert.strictEqual(p.actual_model_calls_saved, 0);
  assert.strictEqual(p.hypothetical_separate_calls_avoided, 2);
  assert.strictEqual(p.model_calls_saved, undefined, '가상 절감을 실제 절감처럼 부르던 필드는 제거돼야 한다');
  assert.ok(p.instruction.includes('배치 처리 지시'));
});

test('변경 작업이 섞이면 배치하지 않는다', () => {
  const p = batchPlanner.planBatch('1. 설정값 확인해줘\n2. config.js 를 수정해줘');
  assert.strictEqual(p.batchable, false);
});

test('종속 표현이 있으면 배치하지 않는다', () => {
  const p = batchPlanner.planBatch('1. 로그 확인해줘\n2. 그 결과로 어떤 파일이 문제인지 알려줘');
  assert.strictEqual(p.batchable, false);
});

test('단일 요청은 배치 대상이 아니다', () => {
  assert.strictEqual(batchPlanner.planBatch('이 파일 뭐하는거야?').batchable, false);
});

// ── 테스트 G: 기존 기능 회귀 ────────────────────────────────────────────────
section('테스트 G: 기존 기능 회귀 (정적 검증)');

test('모든 slack-bot 모듈이 로드된다', () => {
  for (const m of ['config', 'task-manager', 'claude-cli', 'handlers', 'intent', 'giip-commands',
                   'giip-task', 'giip-api', 'dashboard', 'task-dedup', 'repo-lock', 'repo-status',
                   'k-layer', 'state', 'slack-api', 'minimax-accounts', 'claude-accounts',
                   'model-config', 'model-router', 'context-builder', 'prompt-templates',
                   'retry-checkpoint', 'cost-tracker', 'batch-planner', 'secret-mask']) {
    require(path.join(SB, m));
  }
});

test('task-manager 의 기존 export 가 그대로 남아 있다', () => {
  const tm = require(path.join(SB, 'task-manager'));
  for (const fn of ['analyzeRequest', 'createTaskFile', 'updateTaskFile', 'rebuildTaskFileFromIssue',
                    'startExecution', 'completeTaskFile', 'gitPushResultAndPR', 'prepareTaskBranch',
                    'restoreTaskBranch', 'commitAndPRChangedRepos', 'addToTasklist', 'cancelTaskFile',
                    'buildContextCatalog', 'selectContextFiles', 'normalizeFilesRead', 'extractTitle']) {
    assert.strictEqual(typeof tm[fn], 'function', `${fn} export 가 사라졌다`);
  }
});

test('실행 단계에서 전체 roles 를 재로딩하지 않는다', () => {
  const src = fs.readFileSync(path.join(SB, 'task-manager.js'), 'utf8');
  assert.ok(!/^\s*(const|let)\s+rolesContext\s*=\s*readRolesContext\(/m.test(src), 'readRolesContext 호출이 남아 있다');
  assert.ok(!/function readRolesContext/.test(src), 'readRolesContext 정의가 남아 있다');
});

test('모델명이 코드에 하드코딩돼 있지 않다(중앙 설정만)', () => {
  for (const f of ['task-manager.js', 'claude-cli.js', 'intent.js', 'handlers.js']) {
    const src = fs.readFileSync(path.join(SB, f), 'utf8');
    const hits = src.split('\n').filter(l => /['"]claude-opus-4-8['"]/.test(l));
    assert.strictEqual(hits.length, 0, `${f} 에 모델명 하드코딩이 남아 있다: ${hits.join(' | ')}`);
  }
  // 유일한 정의 위치
  const mc = fs.readFileSync(path.join(SB, 'model-config.js'), 'utf8');
  assert.ok(/LEGACY_PREMIUM_MODEL = 'claude-opus-4-8'/.test(mc));
});

test('Slack 명령/흐름 문자열이 유지된다 (go / cancel / tasklist / PR)', () => {
  const h = fs.readFileSync(path.join(SB, 'handlers.js'), 'utf8');
  for (const needle of ["cmd === 'tasklist'", '!issues', '!klayer', '!cost', 'startExecution', 'commitAndPRChangedRepos']) {
    assert.ok(h.includes(needle), `${needle} 가 사라졌다`);
  }
  const i = fs.readFileSync(path.join(SB, 'index.js'), 'utf8');
  assert.ok(/go\b/.test(i) || /go /.test(h), 'go 명령 경로가 사라졌다');
});

test('MiniMax 우선 → Claude fallback 구조가 유지된다', () => {
  const src = fs.readFileSync(path.join(SB, 'task-manager.js'), 'utf8');
  assert.ok(/minimax\.resolve\(\)/.test(src));
  assert.ok(/minimax\.noteUsageLimit\(\)/.test(src));
  assert.ok(/accounts\.isUsageLimit\(/.test(src));
  assert.ok(/accounts\.noteUsageLimit\(/.test(src));
});

test('런타임 산출물이 .gitignore 대상이다', () => {
  const gi = fs.readFileSync(path.join(SB, '..', '.gitignore'), 'utf8');
  assert.ok(/^\.agent\/runtime\/$/m.test(gi), '.agent/runtime/ 이 .gitignore 에 없다');
});

// ═══════════════════════════════════════════════════════════════════════════
// giip-1068 비용 최적화 2차 — 테스트 A~I (이슈 §11.2)
// ═══════════════════════════════════════════════════════════════════════════
const progress = require(path.join(SB, 'progress-events'));
const resumeCtx = require(path.join(SB, 'resume-context-builder'));
const runtimePaths = require(path.join(SB, 'runtime-paths'));

/** 프롬프트 조립용 공통 옵션 — 최초/재개를 같은 태스크로 비교하기 위해. */
const G_TASK = [
  '---',
  'task_id: giip-1234',
  'task_class: standard',
  '---',
  '',
  '# TASK: 버튼 글자색 변경',
  '',
  '## 요청 내용',
  '대시보드 버튼 글자색을 파랑으로 바꾼다. ' + '상세 배경 설명. '.repeat(60),
  '',
  '## 실행 계획',
  '1. src/a.js 의 색상 상수 수정',
  '2. src/b.js 의 스타일 적용',
  '3. npm test 로 검증',
  '',
  '## 영향 파일/서브시스템',
  '- src/a.js',
  '- src/b.js',
  '',
  '## 주의사항',
  '- 요청 범위 밖 수정 금지',
  '',
  '## 부가 설명',
  '아주 긴 부가 설명. '.repeat(400),
].join('\n');

function gInitialPrompt(over = {}) {
  return prompts.buildInitialExecutionPrompt(Object.assign({
    taskContent: G_TASK,
    taskClass: 'standard',
    taskId: 'giip-1234',
    branch: 'bot/task-giip-1234',
    attempt: 1,
    now: '2026-08-13T00:00:00Z',
    contextText: '컨텍스트 본문. '.repeat(800),
    contextFiles: [
      { path: '.agent/rules/10_karpathy_guidelines.md', reason: '요청 범위 밖 수정 방지' },
      { path: '.agent/roles/developer.md', reason: '소스 수정 및 테스트 수행' },
      { path: '.agent/skills/frontend/SKILL.md', reason: '스타일 적용 규칙' },
    ],
  }, over));
}

// ── 테스트 A: 시작 전 MiniMax 429 ───────────────────────────────────────────
section('테스트 A: 시작 전 429 (작업 흔적 0) → 최초 프롬프트 재사용');
const A_DIR = tmpdir('fde-1068a-');

test('실제 소스 변경 0 / 완료 단계 0 / 명령 0 → hasRealWork=false', () => {
  const cp = checkpoint.save(A_DIR, 'giip-1234', {
    error_type: 'usage_limit',
    completed_steps: [], files_changed: [], commands_run: [], test_results: [],
  });
  assert.strictEqual(checkpoint.hasRealWork(cp), false);
  const d = checkpoint.shouldResume({ exitCode: 1, checkpoint: cp, checkpointSaved: true });
  assert.strictEqual(d.resume, false, `resume=${d.resume} (${d.reason})`);
  assert.strictEqual(checkpoint.buildResumeInstruction(cp), null, 'resume prompt 를 만들면 안 된다');
  assert.strictEqual(cp.error_type, 'usage_limit');
});

test('checkpoint 저장 전 실패면 재개하지 않는다', () => {
  const d = checkpoint.shouldResume({ exitCode: 1, checkpoint: null, checkpointSaved: false });
  assert.strictEqual(d.resume, false);
});

test('태스크 파일만 바뀐 상태는 source change 에 포함되지 않는다', () => {
  const r = checkpoint.changedSourceFiles(A_DIR, 'giip-1234', {
    files: ['.agent/tasks/giip-1234.md', '.agent/results/giip-1234.md',
            '.agent/runtime/checkpoints/giip-1234.json', 'slack-bot/tasklist.json'],
  });
  assert.strictEqual(r.sourceFiles.length, 0, `sourceFiles=${JSON.stringify(r.sourceFiles)}`);
  assert.strictEqual(r.totalSourceChanges, 0);
});

// ── 테스트 B: 파일 2개 수정 후 429 → 재개 프롬프트 ──────────────────────────
section('테스트 B: 파일 2개 수정 후 429 → 재개 프롬프트 (60% 이하)');

test('hasRealWork=true 이면 반드시 재개 프롬프트를 쓴다', () => {
  const cp = {
    attempt: 1, error_type: 'usage_limit',
    files_changed: ['src/a.js', 'src/b.js'], completed_steps: [], commands_run: [], test_results: [],
  };
  assert.strictEqual(checkpoint.hasRealWork(cp), true);
  assert.strictEqual(checkpoint.shouldResume({ exitCode: 1, checkpoint: cp }).resume, true);
});

test('재개 프롬프트에 변경 파일이 들어가고 전체 taskContent 는 안 들어간다', () => {
  const initial = gInitialPrompt();
  const resume = prompts.buildResumeExecutionPrompt({
    taskContent: G_TASK, taskClass: 'standard', taskId: 'giip-1234',
    branch: 'bot/task-giip-1234', attempt: 2, now: '2026-08-13T00:10:00Z',
    filesChanged: ['src/a.js', 'src/b.js'],
    pendingSteps: ['3. npm test 로 검증'],
    errorSummary: 'HTTP 429 rate limit',
    resumeContextText: '재개 컨텍스트 본문',
    resumeContextFiles: [{ path: '.agent/rules/10_karpathy_guidelines.md', reason: '범위 밖 수정 방지' }],
    initialPromptChars: initial.length,
  });
  assert.ok(resume.includes('src/a.js') && resume.includes('src/b.js'));
  assert.ok(!resume.includes('아주 긴 부가 설명.'), '전체 taskContent 가 재개 프롬프트에 들어갔다');
  assert.ok(!resume.includes('컨텍스트 본문. 컨텍스트 본문.'), '최초 선택 컨텍스트 전체가 재개 프롬프트에 들어갔다');
  assert.ok(resume.includes('태스크 요약'), '태스크 요약 절이 있어야 한다');
});

test('재개 프롬프트가 최초 프롬프트의 60% 이하다', () => {
  const initial = gInitialPrompt();
  const resume = prompts.buildResumeExecutionPrompt({
    taskContent: G_TASK, taskClass: 'standard', taskId: 'giip-1234', attempt: 2,
    filesChanged: ['src/a.js', 'src/b.js'],
    completedSteps: ['step-1: 색상 상수 수정', 'step-2: 스타일 적용'],
    pendingSteps: ['step-3: npm test'],
    filesRead: Array.from({ length: 40 }, (_, i) => `src/read${i}.js`),
    diffSummary: 'src/a.js | 4 ++--\nsrc/b.js | 2 +-',
    errorSummary: 'x'.repeat(3000),
    resumeContextText: 'C'.repeat(8000),
    initialPromptChars: initial.length,
  });
  const ratio = resume.length / initial.length;
  assert.ok(ratio <= 0.60, `ratio=${ratio.toFixed(3)} (initial=${initial.length}, resume=${resume.length})`);
});

test('재개 컨텍스트는 최대 3개(critical 4개), 8,000자(critical 14,000자)', () => {
  const initialSelection = Array.from({ length: 8 }, (_, i) => ({
    path: `.agent/rules/rule${i}.md`, reason: `테스트 검증 실패 관련 규칙 ${i}`,
  }));
  const pick = resumeCtx.selectResumeContext({
    initialSelection, failedStep: '테스트 검증 실패', pendingSteps: ['테스트 수정'],
    changedFiles: ['src/a.js'], taskClass: 'standard',
  });
  assert.ok(pick.length <= 3, `picked=${pick.length}`);
  assert.ok(pick.every(p => p.max_chars <= 3000));
  const critPick = resumeCtx.selectResumeContext({
    initialSelection, failedStep: '테스트 검증 실패', taskClass: 'critical',
  });
  assert.ok(critPick.length <= 4, `criticalPicked=${critPick.length}`);
  assert.ok(critPick.every(p => p.max_chars <= 4000));
  const lim = modelConfig.resumeContextLimits('standard');
  assert.strictEqual(lim.totalMaxChars, 8000);
  assert.strictEqual(modelConfig.resumeContextLimits('critical').totalMaxChars, 14000);
});

// ── 테스트 C: 테스트 단계에서 실패 ──────────────────────────────────────────
section('테스트 C: 테스트 단계 실패 → 구현 재시작 금지');
const C_DIR = tmpdir('fde-1068c-');

test('진행 이벤트 4건을 기록하고 checkpoint 에 반영한다', () => {
  const ev = (e) => {
    const r = progress.appendProgressEvent(C_DIR, 'giip-1234', e);
    assert.ok(r.ok, `이벤트 기록 실패: ${r.reason}`);
  };
  ev({ type: 'step_completed', step_id: 'step-1', summary: '색상 상수 수정', attempt: 1 });
  ev({ type: 'step_completed', step_id: 'step-2', summary: '스타일 적용', attempt: 1 });
  ev({ type: 'command_run', command: 'npm test', summary: '테스트 실행', attempt: 1 });
  ev({ type: 'test_result', command: 'npm test', status: 'failed', result: '2 failing', attempt: 1 });
  const events = progress.readProgressEvents(C_DIR, 'giip-1234');
  assert.strictEqual(events.length, 4);
  const sum = progress.summarizeProgressEvents(events);
  assert.strictEqual(sum.completed_steps.length, 2);
  assert.strictEqual(sum.commands_run.length, 1);
  assert.strictEqual(sum.test_results.length, 1);
  assert.strictEqual(sum.test_results[0].status, 'failed');
});

test('recordFailure 가 진행 이벤트로 checkpoint 필드를 채운다(빈 배열이 아님)', () => {
  const cp = checkpoint.recordFailure(C_DIR, 'giip-1234', {
    attempt: 1, provider: 'minimax', model: 'MiniMax-M2.7',
    output: 'HTTP 429 rate limit', cwd: C_DIR, taskClass: 'standard',
  });
  assert.strictEqual(cp.completed_steps.length, 2, `completed=${JSON.stringify(cp.completed_steps)}`);
  assert.strictEqual(cp.commands_run.length, 1);
  assert.strictEqual(cp.test_results.length, 1);
  assert.strictEqual(cp.progress_event_count, 4);
  assert.strictEqual(checkpoint.hasRealWork(cp), true);
});

test('재개 프롬프트에 완료 단계·실패 명령이 들어가고 재시작 금지 지시가 있다', () => {
  const cp = checkpoint.load(C_DIR, 'giip-1234');
  const resume = prompts.buildResumeExecutionPrompt({
    taskContent: G_TASK, taskClass: 'standard', taskId: 'giip-1234', attempt: 2,
    completedSteps: cp.completed_steps,
    pendingSteps: ['테스트 수정 또는 실패 원인 처리'],
    commandsRun: cp.commands_run,
    testResults: cp.test_results,
    initialPromptChars: gInitialPrompt().length,
  });
  assert.ok(resume.includes('step-1'), 'step-1 완료 표시가 있어야 한다');
  assert.ok(resume.includes('step-2'), 'step-2 완료 표시가 있어야 한다');
  assert.ok(resume.includes('npm test'), '실패한 테스트 명령이 있어야 한다');
  assert.ok(/구현을 처음부터 다시 하지 말고/.test(resume), '구현 재시작 금지 지시가 있어야 한다');
  assert.ok(/테스트 수정 또는 실패 원인 처리/.test(resume), '다음 단계가 지정돼야 한다');
});

// ── 테스트 D: 태스크 파일만 변경 ────────────────────────────────────────────
section('테스트 D: 태스크 파일만 변경 → 작업 수행으로 보지 않는다');

test('sourceFiles=0, metadataFiles=1', () => {
  const r = checkpoint.changedSourceFiles('.', 'giip-1234', { files: ['.agent/tasks/giip-1234.md'] });
  assert.strictEqual(r.sourceFiles.length, 0);
  assert.strictEqual(r.metadataFiles.length, 1);
  assert.strictEqual(r.totalSourceChanges, 0);
});

test('다른 태스크 파일 변경은 제외하지 않고 이상 상태로 기록한다(6.3)', () => {
  const r = checkpoint.changedSourceFiles('.', 'giip-1234', { files: ['.agent/tasks/giip-9999.md'] });
  assert.strictEqual(r.anomalies.length, 1, `anomalies=${JSON.stringify(r.anomalies)}`);
  assert.ok(r.anomalies[0].includes('giip-9999'));
});

test('런타임·봇 상태 파일도 소스 변경이 아니다', () => {
  const r = checkpoint.changedSourceFiles('.', 'giip-1234', {
    files: ['.agent/runtime/progress/giip-1234.jsonl', '.agent/runtime/cost-usage.jsonl',
            'slack-bot/.task-state.json', 'slack-bot/minimax-accounts.json'],
  });
  assert.strictEqual(r.sourceFiles.length, 0);
  assert.strictEqual(r.runtimeFiles.length, 2);
  assert.strictEqual(r.botStateFiles.length, 2);
});

// ── 테스트 E: nested repository 변경 ────────────────────────────────────────
section('테스트 E: nested repository 의 실제 변경');

test('nested repo 변경은 실제 source change 로 본다', () => {
  const r = checkpoint.changedSourceFiles('.', 'giip-1234', {
    files: ['projects/giipprj/giipv3/src/example.js'],
  });
  assert.deepStrictEqual(r.sourceFiles, ['projects/giipprj/giipv3/src/example.js']);
  assert.strictEqual(r.totalSourceChanges, 1);
});

test('재개 프롬프트에 상대경로로 표시되고 절대경로가 노출되지 않는다', () => {
  const resume = prompts.buildResumeExecutionPrompt({
    taskContent: G_TASK, taskClass: 'standard', taskId: 'giip-1234', attempt: 2,
    filesChanged: ['projects/giipprj/giipv3/src/example.js'],
    initialPromptChars: gInitialPrompt().length,
  });
  assert.ok(resume.includes('projects/giipprj/giipv3/src/example.js'));
  assert.ok(!/[A-Za-z]:\\Users\\/.test(resume), 'Windows 절대경로가 노출됐다');
  assert.ok(!/\/home\/[a-z]+\//.test(resume), 'POSIX 홈 절대경로가 노출됐다');
});

test('진행 이벤트의 절대경로는 저장 시 마스킹된다(7.2)', () => {
  const E2 = tmpdir('fde-1068e-');
  const abs = path.join(E2, 'src', 'secretpath.js');
  const r = progress.appendProgressEvent(E2, 'giip-1234', { type: 'file_changed', path: abs });
  assert.ok(r.ok);
  assert.strictEqual(r.event.path, 'src/secretpath.js', `path=${r.event.path}`);
});

// ── 테스트 F: prompt 길이 제한 ──────────────────────────────────────────────
section('테스트 F: 등급별 프롬프트 길이 상한');

test('등급별 최초/재개 상한값이 이슈 표와 일치한다', () => {
  const expect = {
    trivial: [24000, 12000], standard: [48000, 24000],
    complex: [80000, 40000], critical: [120000, 64000],
  };
  for (const [cls, [ini, res]] of Object.entries(expect)) {
    const l = modelConfig.promptLimits(cls);
    assert.strictEqual(l.initialMaxChars, ini, `${cls} initial`);
    assert.strictEqual(l.resumeMaxChars, res, `${cls} resume`);
    assert.strictEqual(l.initialMaxTokensEstimated, Math.ceil(ini / 4));
  }
});

test('거대 컨텍스트를 넣어도 등급별 상한을 1자도 넘지 않는다', () => {
  const huge = '가'.repeat(400000);
  for (const cls of ['trivial', 'standard', 'complex', 'critical']) {
    const l = modelConfig.promptLimits(cls);
    const p = prompts.buildInitialExecutionPrompt({
      taskClass: cls, taskContent: huge, contextText: huge, taskId: 't', attempt: 1,
    });
    assert.ok(p.length <= l.initialMaxChars, `${cls} initial=${p.length} > ${l.initialMaxChars}`);
    const r = prompts.buildResumeExecutionPrompt({
      taskClass: cls, taskContent: huge, taskId: 't', attempt: 2,
      resumeContextText: huge, errorSummary: huge, diffSummary: huge,
      filesChanged: Array.from({ length: 200 }, (_, i) => `src/f${i}.js`),
    });
    assert.ok(r.length <= l.resumeMaxChars, `${cls} resume=${r.length} > ${l.resumeMaxChars}`);
  }
});

test('등급별 컨텍스트 총량 한도가 적용된다(48,000자 일괄 적용 폐지)', () => {
  assert.strictEqual(modelConfig.contextLimits('trivial').totalMaxChars, 12000);
  assert.strictEqual(modelConfig.contextLimits('standard').totalMaxChars, 24000);
  assert.strictEqual(modelConfig.contextLimits('complex').totalMaxChars, 40000);
  assert.strictEqual(modelConfig.contextLimits('critical').totalMaxChars, 64000);
  assert.strictEqual(modelConfig.contextLimits('critical').perFileMaxChars, 6000);
  assert.strictEqual(modelConfig.contextLimits('standard').perFileMaxChars, 4000);
});

// ── 테스트 G: 배치 수치 ─────────────────────────────────────────────────────
section('테스트 G: 배치 절감 수치 (실제 vs 가정)');
const G_DIR = tmpdir('fde-1068g-');

test('3개 질문 → batch_size 3, 가정 절감 2, 실제 절감 0', () => {
  const p = batchPlanner.planBatch('1. a.js 있는지 확인해줘\n2. b.js 있는지 확인해줘\n3. c.js 있는지 확인해줘');
  assert.strictEqual(p.batch_size, 3);
  assert.strictEqual(p.hypothetical_separate_calls_avoided, 2);
  assert.strictEqual(p.actual_model_calls_before, 1);
  assert.strictEqual(p.actual_model_calls_after, 1);
  assert.strictEqual(p.actual_model_calls_saved, 0);
});

test('!cost 기본 보고서에 가상 절감 2회가 실제 절감으로 표시되지 않는다', () => {
  costTracker.record(G_DIR, {
    task_id: 'giip-1068', phase: 'qa', provider: 'minimax', model: 'MiniMax-M2.7',
    input_chars: 400, output_chars: 100, batch_size: 3,
    actual_model_calls_saved: 0, hypothetical_separate_calls_avoided: 2,
  });
  const sum = costTracker.summarize(G_DIR);
  assert.strictEqual(sum.batch_actual_model_calls_saved, 0);
  assert.strictEqual(sum.batch_hypothetical_separate_calls_avoided, 2);
  const basic = costTracker.report(G_DIR, '');
  assert.ok(/실제 절감 호출: 0회/.test(basic), `기본 보고서: ${basic}`);
  assert.ok(!/가정/.test(basic), '기본 보고서에 가정 절감이 나오면 안 된다');
  const detail = costTracker.report(G_DIR, 'detail');
  assert.ok(/가정값.*2회/.test(detail), `상세 보고서에 가정값 표기가 없다: ${detail}`);
});

test('Fast Path 절감값에 estimated 표시가 있다(8.4)', () => {
  costTracker.record(G_DIR, {
    task_id: 'giip-fp', phase: 'execute', provider: 'minimax', model: 'MiniMax-M2.7',
    input_chars: 100, fast_path: true,
  });
  const sum = costTracker.summarize(G_DIR);
  assert.strictEqual(sum.fast_path.saving_is_estimated, true);
  assert.strictEqual(sum.fast_path.estimated_calls_saved, 2);
  assert.strictEqual(sum.fast_path.baseline_expected_calls, 3);
  assert.ok(/ESTIMATED/.test(costTracker.report(G_DIR, '')), '보고서에 ESTIMATED 표기가 없다');
});

test('비용 로그에 프롬프트 축약 필드가 기록된다(13)', () => {
  const row = costTracker.record(G_DIR, {
    task_id: 'giip-1068', phase: 'execute', provider: 'claude', model: 'sonnet', attempt: 2,
    prompt_type: 'resume', initial_prompt_chars: 48000, current_prompt_chars: 22000,
    actual_source_files_changed: 2, metadata_files_changed: 1,
    checkpoint_used: true, progress_event_count: 14, saving_is_estimated: false,
  });
  assert.strictEqual(row.prompt_type, 'resume');
  assert.strictEqual(row.prompt_reduction_chars, 26000);
  assert.strictEqual(row.prompt_reduction_ratio, 0.5417, `ratio=${row.prompt_reduction_ratio}`);
  assert.strictEqual(row.actual_source_files_changed, 2);
  assert.strictEqual(row.checkpoint_used, true);
  assert.strictEqual(row.progress_event_count, 14);
});

test('재개인데 감소율이 40% 미만이면 경고를 남긴다', () => {
  const orig = console.warn;
  let warned = '';
  console.warn = (...a) => { warned += a.join(' '); };
  try {
    costTracker.record(G_DIR, {
      task_id: 'giip-warn', phase: 'execute', provider: 'claude', model: 'sonnet',
      prompt_type: 'resume', initial_prompt_chars: 10000, current_prompt_chars: 9000,
    });
  } finally { console.warn = orig; }
  assert.ok(/CostOptimizationWarning/.test(warned), `경고가 없다: ${warned}`);
  assert.ok(/less than 40%/.test(warned));
});

// ── 테스트 H: read-only 보안 질문 ───────────────────────────────────────────
section('테스트 H: read-only 보안 질문 (Opus 금지)');

test('"인증 관련 코드가 어느 파일에 있는지 알려줘" → read / critical / standard', () => {
  const c = router.classifyTask('인증 관련 코드가 어느 파일에 있는지 알려줘', [], '');
  assert.strictEqual(c.operation, 'read');
  assert.strictEqual(c.risk_class, 'critical');
  assert.strictEqual(c.task_class, 'standard', `task_class=${c.task_class} (${c.reasons.join('/')})`);
});

test('읽기 전용 위험 질문은 프리미엄(Opus) 모델로 라우팅되지 않는다', () => {
  const c = router.classifyTask('인증 관련 코드가 어느 파일에 있는지 알려줘', [], '');
  const sel = router.selectModel(c.task_class, 'execute', { minimax: false });
  assert.strictEqual(sel.premiumAllowed, false);
  assert.notStrictEqual(sel.model, modelConfig.LEGACY_PREMIUM_MODEL);
  assert.strictEqual(router.selectModel(c.task_class, 'plan').premiumAllowed, false);
});

test('§10.1 의 읽기 전용 예시 4건이 모두 critical 실행으로 오인되지 않는다', () => {
  for (const q of ['로그인 구조를 설명해줘',
                   '인증 관련 문서가 어디 있어?',
                   '결제 기능이 구현되어 있는지 확인해줘',
                   '운영 DB 스키마를 읽기 전용으로 보여줘']) {
    const c = router.classifyTask(q, [], '');
    assert.strictEqual(c.operation, 'read', `${q} → operation=${c.operation}`);
    assert.notStrictEqual(c.task_class, 'critical', `${q} → task_class=${c.task_class}`);
    assert.ok(['trivial', 'standard', 'complex'].includes(c.task_class));
  }
});

// ── 테스트 I: 인증 코드 수정 ────────────────────────────────────────────────
section('테스트 I: 인증 코드 수정 (write + critical)');

test('"auth/login.js의 세션 토큰 검증 로직을 수정해줘" → write / critical / critical', () => {
  const c = router.classifyTask('auth/login.js의 세션 토큰 검증 로직을 수정해줘', [], '');
  assert.strictEqual(c.operation, 'write');
  assert.strictEqual(c.risk_class, 'critical');
  assert.strictEqual(c.task_class, 'critical');
  assert.strictEqual(c.fastPathEligible, false, 'Fast Path 금지');
});

test('delete/deploy/migrate 위험 작업이 적절히 승격된다(10.2)', () => {
  const del = router.classifyTask('운영 DB 의 사용자 테이블을 전부 삭제해줘', [], '');
  assert.strictEqual(del.operation, 'delete');
  assert.strictEqual(del.task_class, 'critical');
  const dep = router.classifyTask('운영 서버에 배포해줘', [], '');
  assert.strictEqual(dep.operation, 'deploy');
  assert.strictEqual(dep.task_class, 'critical');
  const mig = router.classifyTask('사용자 테이블 스키마 마이그레이션을 실행해줘', [], '');
  assert.strictEqual(mig.operation, 'migrate');
  assert.ok(['complex', 'critical'].includes(mig.task_class), `migrate=${mig.task_class}`);
  for (const c of [del, dep, mig]) assert.strictEqual(c.fastPathEligible, false);
});

// ── 진행 이벤트 모듈 상세 (5) ───────────────────────────────────────────────
section('진행 이벤트 모듈 (giip-1068 §5)');
const P_DIR = tmpdir('fde-1068p-');

test('허용 이벤트는 정확히 8종이다', () => {
  assert.deepStrictEqual(progress.EVENT_TYPES, [
    'step_started', 'step_completed', 'file_read', 'file_changed',
    'command_run', 'test_result', 'decision', 'blocked']);
});

test('허용되지 않는 종류는 기록하지 않고 경고만 남긴다', () => {
  const orig = console.warn;
  let warned = '';
  console.warn = (...a) => { warned += a.join(' '); };
  let r;
  try { r = progress.appendProgressEvent(P_DIR, 'giip-x', { type: 'random_event' }); }
  finally { console.warn = orig; }
  assert.strictEqual(r.ok, false);
  assert.ok(/허용되지 않는/.test(warned));
  assert.strictEqual(progress.readProgressEvents(P_DIR, 'giip-x').length, 0);
});

test('JSON Lines 로 .agent/runtime/progress/<task-id>.jsonl 에 저장된다', () => {
  progress.appendProgressEvent(P_DIR, 'giip-1234', { type: 'file_read', path: 'src/a.js' });
  const p = progress.eventPath(P_DIR, 'giip-1234').replace(/\\/g, '/');
  assert.ok(p.endsWith('.agent/runtime/progress/giip-1234.jsonl'), p);
  const raw = fs.readFileSync(progress.eventPath(P_DIR, 'giip-1234'), 'utf8');
  assert.strictEqual(raw.trim().split('\n').length, 1);
  const o = JSON.parse(raw.trim());
  assert.ok(o.timestamp && o.task_id === 'giip-1234' && o.type === 'file_read');
});

test('길이 제한을 적용한다 (summary 500 / command 1000 / output 2000)', () => {
  const r = progress.appendProgressEvent(P_DIR, 'giip-len', {
    type: 'command_run', summary: 'S'.repeat(2000), command: 'C'.repeat(5000), output: 'O'.repeat(9000),
  });
  assert.strictEqual(r.event.summary.length, 500);
  assert.strictEqual(r.event.command.length, 1000);
  assert.strictEqual(r.event.output.length, 2000);
});

test('진행 이벤트에도 비밀값을 남기지 않는다', () => {
  const FAKE = fakeSecrets();
  progress.appendProgressEvent(P_DIR, 'giip-sec', {
    type: 'decision', summary: `used SLACK_BOT_TOKEN=${FAKE.slack} and ${FAKE.anthropic}`,
  });
  const raw = fs.readFileSync(progress.eventPath(P_DIR, 'giip-sec'), 'utf8');
  assert.ok(!raw.includes(FAKE.slack));
  assert.ok(!raw.includes(FAKE.anthropic));
  assert.ok(/REDACTED/.test(raw));
});

test('500개 초과 시 오래된 중복 file_read 부터 정리하고 보호 종류는 남긴다', () => {
  const events = [];
  for (let i = 0; i < 520; i++) {
    events.push({ timestamp: new Date(Date.now() + i).toISOString(), task_id: 't', attempt: 1,
                  type: 'file_read', path: 'src/dup.js' });
  }
  events.push({ timestamp: new Date().toISOString(), task_id: 't', attempt: 1,
                type: 'file_changed', path: 'src/keep.js' });
  events.push({ timestamp: new Date().toISOString(), task_id: 't', attempt: 1,
                type: 'test_result', command: 'npm test', status: 'failed' });
  const { events: kept, removed } = progress.pruneEvents(events);
  assert.ok(kept.length <= progress.LIMITS.maxEvents, `kept=${kept.length}`);
  assert.ok(removed > 0);
  assert.ok(kept.some(e => e.type === 'file_changed'), 'file_changed 를 지우면 안 된다');
  assert.ok(kept.some(e => e.type === 'test_result'), 'test_result 를 지우면 안 된다');
});

test('checkpoint 필드 상한을 지킨다(5.6)', () => {
  const lim = modelConfig.checkpointLimits();
  assert.deepStrictEqual(lim, {
    completed_steps: 30, files_read: 100, files_changed: 100, commands_run: 50, test_results: 30,
  });
  const many = [];
  for (let i = 0; i < 200; i++) {
    many.push({ timestamp: new Date(Date.now() + i).toISOString(), type: 'file_read', path: `src/f${i}.js` });
    many.push({ timestamp: new Date(Date.now() + i).toISOString(), type: 'step_completed', step_id: `s${i}` });
  }
  const sum = progress.summarizeProgressEvents(many, lim);
  assert.strictEqual(sum.files_read.length, 100);
  assert.strictEqual(sum.completed_steps.length, 30);
});

test('전용 CLI 가 입력을 검증하고 이벤트를 기록한다', () => {
  const { spawnSync } = require('child_process');
  const CLI = path.join(SB, 'tools', 'progress-event.js');
  const D = tmpdir('fde-1068cli-');
  const ok = spawnSync(process.execPath, [CLI, '--task', 'giip-1234', '--attempt', '1',
    '--type', 'file_changed', '--step', 'step-2', '--path', 'src/example.js',
    '--summary', '버튼 글자색 변경', '--base-dir', D], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  const events = progress.readProgressEvents(D, 'giip-1234');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'file_changed');
  assert.strictEqual(events[0].path, 'src/example.js');
  assert.strictEqual(events[0].step_id, 'step-2');

  const bad = spawnSync(process.execPath, [CLI, '--task', 'giip-1234', '--type', 'nope',
    '--base-dir', D], { encoding: 'utf8' });
  assert.notStrictEqual(bad.status, 0, '허용되지 않는 type 은 실패해야 한다');
});

// ── 중앙 runtime 경로 (7) ───────────────────────────────────────────────────
section('중앙 runtime 경로 통일 (giip-1068 §7)');

test('checkpoint / progress / cost 로그가 같은 runtime root 아래에 있다', () => {
  const D = tmpdir('fde-1068rt-');
  const root = runtimePaths.runtimeRoot(D).replace(/\\/g, '/');
  assert.ok(root.endsWith('.agent/runtime'), root);
  for (const p of [checkpoint.checkpointPath(D, 't'), progress.eventPath(D, 't'), costTracker.logPath(D)]) {
    assert.ok(p.replace(/\\/g, '/').startsWith(root), `${p} 가 runtime root 밖이다`);
  }
});

test('FDE_RUNTIME_DIR 로 런타임 루트를 덮어쓸 수 있다', () => {
  const D = tmpdir('fde-1068env-');
  const prev = process.env.FDE_RUNTIME_DIR;
  process.env.FDE_RUNTIME_DIR = D;
  try {
    assert.strictEqual(path.resolve(runtimePaths.runtimeRoot('/somewhere/else')), path.resolve(D));
    assert.ok(costTracker.logPath('/somewhere/else').startsWith(D));
    assert.ok(checkpoint.checkpointPath('/somewhere/else', 't').startsWith(D));
  } finally {
    if (prev === undefined) delete process.env.FDE_RUNTIME_DIR; else process.env.FDE_RUNTIME_DIR = prev;
  }
});

test('checkpoint 에 절대경로 대신 project_name + 마스킹 상대경로를 남긴다(7.2)', () => {
  const D = tmpdir('fde-1068wd-');
  const cp = checkpoint.beginAttempt(D, 'giip-1234', {
    attempt: 1, provider: 'minimax', model: 'M', taskClass: 'standard', workDir: D,
  });
  assert.ok(cp.project_name, 'project_name 이 있어야 한다');
  assert.ok(cp.work_dir && cp.work_dir.length < D.length, `work_dir=${cp.work_dir}`);
  const raw = fs.readFileSync(checkpoint.checkpointPath(D, 'giip-1234'), 'utf8');
  assert.ok(!raw.includes(D.replace(/\\/g, '\\\\')), 'checkpoint 에 절대경로 전체가 들어갔다');
});

// ── 프롬프트 함수 분리 (4.2) ────────────────────────────────────────────────
section('최초/재개 프롬프트 함수 분리 (giip-1068 §4.2)');

test('buildInitialExecutionPrompt / buildResumeExecutionPrompt 가 분리돼 있다', () => {
  assert.strictEqual(typeof prompts.buildInitialExecutionPrompt, 'function');
  assert.strictEqual(typeof prompts.buildResumeExecutionPrompt, 'function');
});

test('buildExecutionPrompt 는 하위 호환으로 최초 실행 프롬프트를 만든다', () => {
  const a = prompts.buildExecutionPrompt({ taskContent: 'T', taskId: 'x', now: '2026-01-01T00:00:00Z' });
  const b = prompts.buildInitialExecutionPrompt({ taskContent: 'T', taskId: 'x', now: '2026-01-01T00:00:00Z' });
  assert.strictEqual(a, b);
});

test('최초 프롬프트 절 순서가 4.3 그대로다', () => {
  const p = gInitialPrompt();
  const idx = [
    p.indexOf('senior software engineer'),
    p.indexOf('=== 안전 규칙 (고정) ==='),
    p.indexOf('=== 실행 프로토콜 (고정) ==='),
    p.indexOf('=== 선택된 컨텍스트'),
    p.indexOf('=== 프로젝트 정보 ==='),
    p.indexOf('=== 태스크 ==='),
    p.indexOf('=== 동적 상태 ==='),
  ];
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1] && idx[i] > 0, `절 순서가 어긋났다: ${JSON.stringify(idx)}`);
  }
});

test('재개 프롬프트 절 순서가 4.4 그대로다', () => {
  const p = prompts.buildResumeExecutionPrompt({
    taskContent: G_TASK, taskClass: 'standard', taskId: 'x', attempt: 2,
    completedSteps: ['s1'], pendingSteps: ['s2'], filesRead: ['a.js'], filesChanged: ['b.js'],
    diffSummary: 'b.js | 1 +', commandsRun: ['npm test'],
    testResults: [{ command: 'npm test', status: 'failed' }],
    errorSummary: 'boom', resumeContextText: 'RC',
  });
  const order = ['=== 재개 전용 안전 규칙', '=== 태스크 요약', '=== 완료된 단계',
    '=== 미완료 단계', '=== 이미 읽은 파일', '=== 이미 변경한 파일', '=== 변경 diff 요약',
    '=== 실행한 명령', '=== 테스트 결과', '=== 이전 오류', '=== 재개 컨텍스트', '=== 동적 상태'];
  let prev = -1;
  for (const s of order) {
    const i = p.indexOf(s);
    assert.ok(i > prev, `${s} 위치 이상 (i=${i}, prev=${prev})`);
    prev = i;
  }
});

test('태스크 요약은 4.4 상한(목적 500 / 성공 10 / 영향 20 / 금지 10 / 전체 3000)을 지킨다', () => {
  const big = ['# TASK: T', '', '## 요청 내용', '목'.repeat(3000), '', '## 실행 계획',
    ...Array.from({ length: 30 }, (_, i) => `${i + 1}. 단계 ${i}`), '', '## 영향 파일/서브시스템',
    ...Array.from({ length: 40 }, (_, i) => `- file${i}.js`), '', '## 주의사항',
    ...Array.from({ length: 30 }, (_, i) => `- 금지 ${i}`)].join('\n');
  const s = prompts.summarizeTaskSpec(big);
  assert.ok(s.length <= 3000, `summary=${s.length}`);
  const purposeLine = s.split('\n').find(l => l.startsWith('- 목적:'));
  assert.ok(purposeLine.length <= 500 + 10, `purpose=${purposeLine.length}`);
  assert.ok((s.match(/^  \d+\. /gm) || []).length <= 10, '성공 조건 10개 초과');
  assert.ok((s.match(/^  - file\d+\.js/gm) || []).length <= 20, '영향 대상 20개 초과');
});

test('실행 프롬프트에 진행 이벤트 기록 규칙이 들어간다(5.5)', () => {
  const p = gInitialPrompt({ progressEventCommand: 'node tools/progress-event.js --task x ...' });
  assert.ok(p.includes('진행 이벤트 기록'));
  for (const t of progress.EVENT_TYPES) assert.ok(p.includes(t), `${t} 안내가 없다`);
  assert.ok(p.includes('progress_event_command'), '동적 상태에 실제 명령이 있어야 한다');
});

// ── 회귀: 기존 Slack/PR 흐름 ────────────────────────────────────────────────
section('회귀: 기존 기능 (giip-1068 이후)');

test('신규 모듈이 전부 로드된다', () => {
  for (const m of ['progress-events', 'resume-context-builder', 'runtime-paths']) {
    require(path.join(SB, m));
  }
});

test('task-manager 가 최초/재개 프롬프트를 각각 호출한다', () => {
  const src = fs.readFileSync(path.join(SB, 'task-manager.js'), 'utf8');
  assert.ok(/buildInitialExecutionPrompt\(/.test(src), '최초 프롬프트 호출이 없다');
  assert.ok(/buildResumeExecutionPrompt\(/.test(src), '재개 프롬프트 호출이 없다');
  assert.ok(/shouldResume\(/.test(src), '재개 판정 호출이 없다');
  assert.ok(/changedSourceFiles\(/.test(src), '소스 변경 판정 호출이 없다');
  assert.ok(/RUNTIME_BASE_DIR/.test(src), 'checkpoint/비용 로그 루트 통일이 안 됐다');
});

test('Slack 명령/흐름 문자열이 그대로 남아 있다', () => {
  const h = fs.readFileSync(path.join(SB, 'handlers.js'), 'utf8');
  for (const needle of ["cmd === 'tasklist'", '!issues', '!klayer', '!cost', 'startExecution',
                        'commitAndPRChangedRepos', 'cancelTaskFile']) {
    assert.ok(h.includes(needle), `${needle} 가 사라졌다`);
  }
});

test('slack-bot-minimax 는 이번 최적화 대상이 아니다(별개 프로젝트용 배포)', () => {
  const envEx = path.join(SB, '..', 'slack-bot-minimax', '.env.example');
  if (!fs.existsSync(envEx)) return;   // 폴더가 없으면 검증 생략
  const txt = fs.readFileSync(envEx, 'utf8');
  assert.ok(/GITHUB_REPO=LowyShin\/smartorder-works/.test(txt),
    'slack-bot-minimax 가 다른 프로젝트(smartorder-works)를 향한다는 근거가 사라졌다');
});

// ── 결과 ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`통과 ${passed} / 실패 ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.e.stack}`);
  process.exit(1);
}
console.log('전부 통과.');
