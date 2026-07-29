// task-dedup.js — 既存タスクID抽出 + 類似/重複タスク検出・統合
// index.js から behavior-preserving で切り出し（ロジック変更なし）。

const fs = require('fs');
const path = require('path');
const { AGENT_DIR } = require('./config');
const tm = require('./task-manager');

// ── 既存タスクIDをメッセージから抽出 ────────────────────────────────────────
// 14桁数字 (自動生成) と YYYYMMDD_名前形式 (手動作成) の両方に対応
function extractExistingTaskIds(text) {
  const numericIds = text.match(/\b(\d{14})\b/g) || [];
  const namedIds   = text.match(/\b(\d{8}_[\w-]+)\b/g) || [];
  const candidates = [...new Set([...numericIds, ...namedIds])];
  return candidates.filter(id => {
    return [
      path.join(AGENT_DIR, 'tasks', `${id}.md`),
      path.join(AGENT_DIR, 'tasks', 'done', `${id}.md`),
      path.join(AGENT_DIR, 'tasks', 'cancel', `${id}.md`),
    ].some(f => fs.existsSync(f));
  });
}

// ── 既存 giip issue 番号をメッセージから抽出 ─────────────────────────────────
//   `admin/giip-issues/609`, `giip issue #609`, `issue 609`, `이슈 #609` 等から ISN を得る。
//   ユーザ指摘(D): issue 番号が既にあるなら task 番号を新規発給せず、二重 issue(#610 等)も作らない。
//   ISN は小さい整数(1〜6桁)に限定し、14桁タスクIDや電話番号等の誤検知を防ぐ。無ければ null。
function extractGiipIssueRef(text) {
  const t = String(text || '').replace(/`/g, '');
  // issue/이슈/giip の明示的な文脈を必須にする(bare `#609` は `PR #123` 等の誤検知源なので拾わない)。
  const patterns = [
    /giip[-\s]?issues?\s*[/#]?\s*(\d{1,6})\b/i, // giip-issues/609, giip issue #609, giip issue 609
    /\bissues?\s*#?\s*(\d{1,6})\b/i,            // issue #609, issue 609
    /이슈\s*#?\s*(\d{1,6})\b/,                  // 이슈 609, 이슈 #609
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

// ── 類似 pending タスクを検索 ──────────────────────────────────────────────
function findSimilarPendingTasks(requestText) {
  const taskDir = path.join(AGENT_DIR, 'tasks');
  let files;
  try { files = fs.readdirSync(taskDir).filter(f => /^\d{14}\.md$/.test(f)); }
  catch { return []; }

  // ブラケット記法から内容を抽出: [SO/SS売上集計リデザイン] → "SO/SS売上集計リデザイン"
  const bracketM = requestText.match(/\[([^\]]{4,})\]/);
  const bracketKey = bracketM ? bracketM[1].slice(0, 20) : null;

  // 4文字以上の単語を抽出（日本語・英数字）
  const words = [...new Set(
    requestText.replace(/[^\w぀-鿿a-zA-Z0-9]/g, ' ')
      .split(/\s+/).filter(w => w.length >= 4)
  )];

  const similar = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(taskDir, file), 'utf8');
      const statusM = content.match(/^status:\s*(.+)$/m);
      const status = (statusM ? statusM[1].trim() : 'pending');
      if (status !== 'pending') continue;

      const reqLine = (content.match(/request:\s*"?([^\n"]{1,300})/) || [])[1] || '';
      const titleLine = (content.match(/# TASK:\s*(.+)/) || [])[1] || '';
      const combined = reqLine + ' ' + titleLine;

      let matched = false;
      if (bracketKey && combined.includes(bracketKey)) matched = true;
      if (!matched && words.length >= 2) {
        const hits = words.filter(w => combined.includes(w)).length;
        if (hits / words.length >= 0.5) matched = true;
      }

      if (matched) {
        const title = titleLine || reqLine.slice(0, 50);
        similar.push({ taskId: file.replace('.md', ''), title });
      }
    } catch {}
  }
  return similar;
}

// ── 未完了(pending)タスクのメタ情報を全件読み込む ────────────────────────────
// taskmerge 用。各タスクの request/title と、類似判定用の単語集合・ブラケットキーを返す。
function loadPendingTaskMeta() {
  const taskDir = path.join(AGENT_DIR, 'tasks');
  let files;
  try { files = fs.readdirSync(taskDir).filter(f => /^\d{14}\.md$/.test(f)); }
  catch { return []; }

  const metas = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(taskDir, file), 'utf8');
      const statusM = content.match(/^status:\s*(.+)$/m);
      const status = statusM ? statusM[1].trim() : 'pending';
      if (status !== 'pending') continue;

      const request = (content.match(/request:\s*"?([^\n"]{1,300})/) || [])[1] || '';
      const titleLine = (content.match(/# TASK:\s*(.+)/) || [])[1] || '';
      const title = (titleLine || request.slice(0, 50)).trim();
      const combined = `${request} ${titleLine}`;
      const bracketM = combined.match(/\[([^\]]{4,})\]/);
      const bracketKey = bracketM ? bracketM[1].slice(0, 20) : null;
      // Hangul(가-힣) を含めて分割する。旧 findSimilarPendingTasks の `぀-鿿` は
      // Hangul(U+AC00〜) を範囲外にしてしまい韓国語タスクが全く語を持たず重複判定できなかった。
      const words = new Set(
        combined.replace(/[^0-9A-Za-z가-힣ぁ-んァ-ヶー一-龥]/g, ' ')
          .split(/\s+/).filter(w => w.length >= 2)
      );
      metas.push({ taskId: file.replace('.md', ''), title, request: request.trim(), words, bracketKey });
    } catch {}
  }
  return metas;
}

// ── 2つのタスクmetaが重複（類似）かを判定 ────────────────────────────────────
// findSimilarPendingTasks と同じ発想: ブラケットキー一致 or 単語集合の重なり >= 50%。
function tasksAreSimilar(a, b) {
  if (a.bracketKey && b.bracketKey && a.bracketKey === b.bracketKey) return true;
  const smaller = a.words.size <= b.words.size ? a.words : b.words;
  const larger  = smaller === a.words ? b.words : a.words;
  if (smaller.size < 2) return false;
  let hits = 0;
  for (const w of smaller) if (larger.has(w)) hits++;
  // 共有語 >= 2（generic な1語だけの誤マッチ防止）かつ 重なり率 >= 50%
  return hits >= 2 && hits / smaller.size >= 0.5;
}

// ── 未完了の重複タスクをクラスタリング ──────────────────────────────────────
// 貪欲法で similar なもの同士をまとめ、2件以上のクラスタのみ返す。
// survivor（残す代表）= タスク番号が最も新しい（=最新の意図を反映）もの。
function findDuplicatePendingClusters() {
  const metas = loadPendingTaskMeta();
  const assigned = new Set();
  const clusters = [];
  for (let i = 0; i < metas.length; i++) {
    if (assigned.has(metas[i].taskId)) continue;
    const members = [metas[i]];
    assigned.add(metas[i].taskId);
    for (let j = i + 1; j < metas.length; j++) {
      if (assigned.has(metas[j].taskId)) continue;
      if (members.some(m => tasksAreSimilar(m, metas[j]))) {
        members.push(metas[j]);
        assigned.add(metas[j].taskId);
      }
    }
    if (members.length >= 2) {
      const survivor = [...members].sort((a, b) => b.taskId.localeCompare(a.taskId))[0];
      clusters.push({ members, survivor });
    }
  }
  return clusters;
}

// ── 重複クラスタを実際に統合する ────────────────────────────────────────────
// survivor に重複分の request を「統合された重複タスク」節として追記し、
// 残りは統合案内を書いてから cancel/ へ移動・tasklist を cancelled 化・pending state から除去。
function applyTaskMerge(clusters, taskState) {
  const now = new Date().toISOString();
  const lines = [`*🔀 タスク統合完了 — ${clusters.length}グループ*`, ''];

  for (const cl of clusters) {
    const survivor = cl.survivor;
    const merged = cl.members.filter(m => m.taskId !== survivor.taskId);

    // ① survivor ファイルに統合記録を追記
    const survivorFile = path.join(AGENT_DIR, 'tasks', `${survivor.taskId}.md`);
    try {
      let sc = fs.readFileSync(survivorFile, 'utf8');
      const section = [
        '',
        '## 🔀 統合された重複タスク',
        `統合日時: ${now}`,
        ...merged.map(m => `- \`${m.taskId}\` — ${m.title}${m.request ? `\n  - 요청: ${m.request}` : ''}`),
        '',
      ].join('\n');
      fs.writeFileSync(survivorFile, `${sc.trimEnd()}\n${section}`);
    } catch {}

    // ② 残りを統合案内付きで取り消し
    const cancelledIds = [];
    for (const m of merged) {
      try {
        const mf = path.join(AGENT_DIR, 'tasks', `${m.taskId}.md`);
        if (fs.existsSync(mf)) {
          const mc = fs.readFileSync(mf, 'utf8');
          fs.writeFileSync(mf, `${mc.trimEnd()}\n\n## 統合案内\n${now} — このタスクは \`${survivor.taskId}\` へ統合され取り消されました。\n`);
        }
        tm.cancelTaskFile(m.taskId);
        tm.updateTasklistEntry(m.taskId, { status: 'cancelled', completedAt: now });
        Object.keys(taskState.pending || {}).forEach(k => {
          if ((taskState.pending[k] || {}).taskId === m.taskId) delete taskState.pending[k];
        });
        cancelledIds.push(m.taskId);
      } catch {}
    }

    lines.push(`• 維持 \`${survivor.taskId}\` — ${survivor.title}`);
    cancelledIds.forEach(id => lines.push(`    ↳ 統合取消 \`${id}\``));
  }

  lines.push('', '維持されたタスクは `go <番号>` で実行してください。');
  return lines.join('\n');
}

module.exports = {
  extractExistingTaskIds,
  extractGiipIssueRef,
  findSimilarPendingTasks,
  loadPendingTaskMeta,
  tasksAreSimilar,
  findDuplicatePendingClusters,
  applyTaskMerge,
};
