#!/usr/bin/env node
/**
 * trace-review.js — トレース一括レビュー管理
 *
 * 使い方:
 *   node slack-bot/tools/trace-review.js export   → _review.json 生成
 *   node slack-bot/tools/trace-review.js apply    → _review.json の reward を各 JSON に反映
 *   node slack-bot/tools/trace-review.js status   → 入力状況サマリー
 */

const fs   = require('fs');
const path = require('path');

const TRACES_DIR  = path.resolve(__dirname, '../../.agent/traces');
const REVIEW_FILE = path.join(TRACES_DIR, '_review.json');

// ── ユーティリティ ─────────────────────────────────────────────────────────

function loadTraces() {
  return fs.readdirSync(TRACES_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(TRACES_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(t => t && t.trace_id)
    .sort((a, b) => a.trace_id.localeCompare(b.trace_id));
}

// ── export ─────────────────────────────────────────────────────────────────

function doExport(onlyPending) {
  const traces = loadTraces();
  const list = traces
    .filter(t => !onlyPending || t.reward === null || t.reward === undefined)
    .map(t => ({
      id:       t.trace_id,
      steps:    Array.isArray(t.steps) ? t.steps.length : 0,
      reward:   t.reward !== undefined ? t.reward : null,
      feedback: t.feedback || '',
      task:     (t.task || '').replace(/\n/g, ' ').slice(0, 120),
    }));

  fs.writeFileSync(REVIEW_FILE, JSON.stringify(list, null, 2), 'utf8');
  console.log(`[export] ${list.length} 件 → ${REVIEW_FILE}`);
  console.log('reward が null の行に 0.0〜1.0 の数値を入力し、apply を実行してください。');
}

// ── apply ──────────────────────────────────────────────────────────────────

function doApply() {
  if (!fs.existsSync(REVIEW_FILE)) {
    console.error('_review.json が見つかりません。先に export を実行してください。');
    process.exit(1);
  }

  const review = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8'));
  let updated = 0, skipped = 0, errors = 0;

  for (const entry of review) {
    const file = path.join(TRACES_DIR, `${entry.id}.json`);
    if (!fs.existsSync(file)) { errors++; continue; }

    const r = entry.reward;
    if (r === null || r === undefined) { skipped++; continue; }
    const num = parseFloat(r);
    if (isNaN(num) || num < 0 || num > 1) {
      console.warn(`[skip] ${entry.id}: reward=${r} は無効値 (0.0〜1.0)`);
      skipped++;
      continue;
    }

    const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
    trace.reward   = Math.round(num * 10) / 10;
    trace.feedback = entry.feedback || trace.feedback || '';
    fs.writeFileSync(file, JSON.stringify(trace, null, 2), 'utf8');
    updated++;
  }

  console.log(`[apply] 更新=${updated}  スキップ=${skipped}  エラー=${errors}`);
}

// ── status ─────────────────────────────────────────────────────────────────

function doStatus() {
  const traces = loadTraces();
  const total   = traces.length;
  const done    = traces.filter(t => t.reward !== null && t.reward !== undefined).length;
  const pending = total - done;
  const avg     = done
    ? (traces.filter(t => t.reward != null).reduce((s, t) => s + t.reward, 0) / done).toFixed(2)
    : '-';

  console.log(`トレース合計: ${total}`);
  console.log(`  入力済み  : ${done}  (平均 reward: ${avg})`);
  console.log(`  未入力    : ${pending}`);

  if (pending > 0) {
    console.log('\n未入力 trace 一覧:');
    traces
      .filter(t => t.reward === null || t.reward === undefined)
      .filter(t => Array.isArray(t.steps) && t.steps.length >= 1)
      .forEach(t => {
        const taskLine = (t.task || '(task未記録)').replace(/\n/g, ' ').slice(0, 80);
        console.log(`  ${t.trace_id}  steps=${Array.isArray(t.steps)?t.steps.length:0}  ${taskLine}`);
      });
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
if (cmd === 'export')        doExport(false);
else if (cmd === 'pending')  doExport(true);
else if (cmd === 'apply')    doApply();
else if (cmd === 'status')   doStatus();
else {
  console.log('使い方:');
  console.log('  node slack-bot/tools/trace-review.js export   # 全 trace を _review.json へ');
  console.log('  node slack-bot/tools/trace-review.js pending  # reward 未入力のみ export');
  console.log('  node slack-bot/tools/trace-review.js apply    # _review.json の reward を反映');
  console.log('  node slack-bot/tools/trace-review.js status   # 入力状況サマリー');
}
