// state.js — JSON I/O + ボット関与スレッド追跡
// index.js から behavior-preserving で切り出し（ロジック変更なし）。

const fs = require('fs');
const { BOT_THREADS_FILE } = require('./config');

// ── JSON I/O ─────────────────────────────────────────────────────────────────
function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

// ── ボットが返答したスレッドを追跡 ───────────────────────────────────────────
function markThreadEngaged(channelId, threadTs) {
  if (!threadTs) return;
  const threads = loadJSON(BOT_THREADS_FILE, {});
  const key = `${channelId}:${threadTs}`;
  threads[key] = Date.now();
  // 7日以上前のエントリを削除
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const k of Object.keys(threads)) {
    if (threads[k] < cutoff) delete threads[k];
  }
  saveJSON(BOT_THREADS_FILE, threads);
}

function isBotEngagedThread(channelId, threadTs) {
  if (!threadTs) return false;
  const threads = loadJSON(BOT_THREADS_FILE, {});
  return !!threads[`${channelId}:${threadTs}`];
}

module.exports = { loadJSON, saveJSON, markThreadEngaged, isBotEngagedThread };
