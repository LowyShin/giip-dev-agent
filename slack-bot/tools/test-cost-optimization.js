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
  assert.strictEqual(prompts.PROMPT_VERSION, 'fde-cost-v1');
  assert.ok(prompts.buildExecutionPrompt({ taskContent: 'x' }).includes('prompt_version: fde-cost-v1'));
  assert.ok(prompts.buildAnalysisPrompt({ requestText: 'x' }).includes('prompt_version: fde-cost-v1'));
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
  assert.strictEqual(p.model_calls_saved, 2);
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

// ── 결과 ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`통과 ${passed} / 실패 ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.e.stack}`);
  process.exit(1);
}
console.log('전부 통과.');
