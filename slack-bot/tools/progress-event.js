#!/usr/bin/env node
/**
 * progress-event.js — 실행 중인 모델이 진행 이벤트를 남기는 전용 CLI (giip-1068, 5.5)
 *
 * 모델이 JSON 파일을 직접 편집하게 하지 않는다. 이 CLI 가 입력 검증 + secret 마스킹 + 길이 제한 +
 * 파일 정리(500건/1MB)를 모두 책임진다.
 *
 * 사용법:
 *   node slack-bot/tools/progress-event.js \
 *     --task giip-1234 --attempt 1 --type file_changed \
 *     --step step-2 --path src/example.js --summary "버튼 글자색 변경"
 *
 * 옵션:
 *   --task     <id>        (필수) 태스크 ID
 *   --type     <type>      (필수) step_started|step_completed|file_read|file_changed|
 *                                 command_run|test_result|decision|blocked
 *   --attempt  <n>         시도 번호(기본 1)
 *   --step     <id>        단계 ID
 *   --path     <path>      대상 파일 경로(저장소 기준 상대경로 권장 — 절대경로는 마스킹된다)
 *   --summary  <text>      한 줄 요약(최대 500자)
 *   --status   <text>      passed|failed|completed 등
 *   --command  <text>      실행한 명령(최대 1,000자)
 *   --output   <text>      명령 출력(최대 2,000자)
 *   --result   <text>      테스트 결과(최대 2,000자)
 *   --base-dir <path>      런타임 루트 기준 디렉터리(기본: WORKSPACE_DIR)
 *   --json                 결과를 JSON 으로 출력
 *
 * 종료코드: 0 = 기록 성공, 1 = 검증 실패/기록 실패
 */

const path = require('path');

const SB = path.join(__dirname, '..');
const progress = require(path.join(SB, 'progress-events'));
const runtimePaths = require(path.join(SB, 'runtime-paths'));

const ALIASES = {
  task: 'task_id', 'task-id': 'task_id', taskid: 'task_id',
  type: 'type', attempt: 'attempt', step: 'step_id', 'step-id': 'step_id',
  path: 'path', file: 'path', summary: 'summary', status: 'status',
  command: 'command', cmd: 'command', output: 'output', result: 'result',
  'base-dir': 'base_dir', basedir: 'base_dir',
};

function parseArgs(argv) {
  const out = { _json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out._json = true; continue; }
    if (a === '--help' || a === '-h') { out._help = true; continue; }
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const rawKey = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
    const key = ALIASES[rawKey];
    if (!key) { out._unknown = (out._unknown || []).concat([rawKey]); continue; }
    const value = eq > 0 ? a.slice(eq + 1) : (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : '');
    out[key] = value;
  }
  return out;
}

function usage() {
  console.log(require('fs').readFileSync(__filename, 'utf8')
    .split('\n').slice(1, 33).map(l => l.replace(/^ \* ?/, '').replace(/^\/\*\*?/, '')).join('\n'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._help) { usage(); return 0; }
  if (args._unknown && args._unknown.length) {
    console.error(`[progress-event] 알 수 없는 옵션: --${args._unknown.join(', --')}`);
    return 1;
  }
  if (!args.task_id) { console.error('[progress-event] --task 는 필수다.'); return 1; }
  if (!args.type) { console.error('[progress-event] --type 은 필수다.'); return 1; }
  if (!progress.EVENT_TYPES.includes(args.type)) {
    console.error(`[progress-event] 허용되지 않는 --type "${args.type}". 허용: ${progress.EVENT_TYPES.join(', ')}`);
    return 1;
  }

  const baseDir = args.base_dir ? path.resolve(args.base_dir) : runtimePaths.workspaceRoot();
  const res = progress.appendProgressEvent(baseDir, args.task_id, {
    task_id: args.task_id,
    attempt: args.attempt,
    type: args.type,
    step_id: args.step_id,
    path: args.path,
    summary: args.summary,
    status: args.status,
    command: args.command,
    output: args.output,
    result: args.result,
  });

  if (!res.ok) {
    console.error(`[progress-event] 기록 실패: ${res.reason}`);
    return 1;
  }
  if (args._json) console.log(JSON.stringify(res.event));
  else console.log(`[progress-event] ${res.event.type} 기록 (task=${res.event.task_id}, attempt=${res.event.attempt}${res.pruned ? `, 오래된 이벤트 ${res.pruned}건 정리` : ''})`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { parseArgs, main };
