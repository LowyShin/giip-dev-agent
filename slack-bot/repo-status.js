// repo-status.js — git リポジトリスキャン + push 状況チェック
// index.js から behavior-preserving で切り出し（ロジック変更なし）。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROJECTS_ROOT } = require('./config');

// ── PROJECTS_ROOT 直下の git リポジトリを動的スキャン ────────────────────────
function discoverGitRepos() {
  let entries;
  try { entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }); }
  catch { return []; }

  return entries
    .filter(e => e.isDirectory() && fs.existsSync(path.join(PROJECTS_ROOT, e.name, '.git')))
    .map(e => {
      const dir = path.join(PROJECTS_ROOT, e.name);
      const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      const branch = (branchRes.stdout || '').trim() || 'main';
      return { name: e.name, dir, branch };
    });
}

// ── 全リポジトリ push 状況チェック ───────────────────────────────────────────
function checkAllRepoStatus() {
  const repos = discoverGitRepos();

  const lines = ['*📊 全リポジトリ push 状況チェック*', ''];
  let hasIssues = false;

  for (const repo of repos) {
    const unpushed = spawnSync('git', ['log', `origin/${repo.branch}..HEAD`, '--oneline'], {
      cwd: repo.dir, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const unpushedLines = (unpushed.stdout || '').trim().split('\n').filter(Boolean);

    const dirty = spawnSync('git', ['status', '--short'], {
      cwd: repo.dir, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const dirtyLines = (dirty.stdout || '').trim().split('\n').filter(Boolean);

    if (unpushedLines.length === 0 && dirtyLines.length === 0) {
      lines.push(`✅ \`${repo.name}\` — clean`);
    } else {
      hasIssues = true;
      lines.push(`⚠️ \`${repo.name}\`:`);
      if (unpushedLines.length > 0) {
        lines.push(`  • 未 push コミット: ${unpushedLines.length}件`);
        unpushedLines.slice(0, 3).forEach(l => lines.push(`    \`${l.slice(0, 72)}\``));
        if (unpushedLines.length > 3) lines.push(`    …他 ${unpushedLines.length - 3}件`);
      }
      if (dirtyLines.length > 0) {
        lines.push(`  • 未コミット変更: ${dirtyLines.length}ファイル`);
      }
    }
  }

  if (repos.length === 0) lines.push('_(git リポジトリが見つかりません)_');
  lines.push('');
  lines.push(hasIssues
    ? '🔧 未 push の変更があります。確認してください。'
    : '✅ 全リポジトリ最新 — push 漏れなし'
  );
  return lines.join('\n');
}

function isPushFailureNotice(text) {
  return /git\s*push\s*(失敗|failed|エラー|error)/i.test(text)
    || /push\s*(失敗|failed)/i.test(text)
    || /作業完了[^\n]*git\s*push\s*失敗/i.test(text);
}

module.exports = { discoverGitRepos, checkAllRepoStatus, isPushFailureNotice };
