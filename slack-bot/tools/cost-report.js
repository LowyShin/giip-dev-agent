#!/usr/bin/env node
/**
 * cost-report.js — 토큰·비용 리포트 CLI (giip-1063, 3.9)
 *
 * Slack 의 `!cost` 계열과 같은 백엔드(cost-tracker.js)를 쓴다.
 *
 * 사용법 (slack-bot/ 에서):
 *   node tools/cost-report.js                # 전체
 *   node tools/cost-report.js today          # 오늘
 *   node tools/cost-report.js task giip-1063 # 특정 태스크
 *   node tools/cost-report.js models         # 모델별
 *   node tools/cost-report.js --json         # 집계 결과를 JSON 으로
 *
 * 로그 위치: <WORKSPACE_DIR>/.agent/runtime/cost-usage.jsonl
 */

const path = require('path');
const costTracker = require('../cost-tracker');

const BASE_DIR = process.env.WORKSPACE_DIR
  ? path.resolve(process.env.WORKSPACE_DIR)
  : path.join(__dirname, '..', '..');

const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const arg = argv.filter(a => a !== '--json').join(' ');

if (jsonMode) {
  const opts = {};
  if (/^today$/i.test(arg)) { const d = new Date(); d.setHours(0, 0, 0, 0); opts.since = d; }
  const m = arg.match(/^task\s+(\S+)$/i);
  if (m) opts.taskId = m[1];
  console.log(JSON.stringify(costTracker.summarize(BASE_DIR, opts), null, 2));
} else {
  console.log(`로그: ${costTracker.logPath(BASE_DIR)}\n`);
  console.log(costTracker.report(BASE_DIR, arg));
}
