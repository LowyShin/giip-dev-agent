/**
 * dashboard.js
 * LOWY_ACTION_DASHBOARD.md 의 "slack-bot 요청 처리 현황" 섹션을 봇이 자동 갱신한다.
 *
 * 요구사항(사용자 지시):
 *   - slack-bot 이 처리한 요청(태스크)을 Lowy 가 체크할 수 있게 체크리스트로 유지.
 *     · 대기/진행(pending/running) → 미체크 `- [ ]`
 *     · 최근 완료(completed)       → 체크 `- [x]` (검수 후 직접 해제/삭제)
 *   - 상세 내용은 전부 GitHub 링크(클릭). 완료=PR URL, 대기=태스크 파일 blob(미추적이면 폴더).
 *   - **이 파일은 온라인에서도 사용자가 수시로 수정하므로, 수정 전 반드시 최신본을 반영한다.**
 *
 * 안전 설계 (공유 작업트리에서 다른 세션/봇 작업을 절대 유실시키지 않음):
 *   - 자동 섹션은 마커(<!-- SLACKBOT-TASKS:START/END -->) 사이만 교체 → 사용자의 수동 내용은 보존.
 *   - 작업트리가 base 브랜치(master)에 있고 태스크가 점유(bot/task-*)하지 않을 때만 실행.
 *     (태스크 실행 중에는 skip → 다음 완료 시점(항상 master 복귀)에서 갱신되어 결과적으로 일관.)
 *   - **최신화는 stash 없이 `fetch` + `merge --ff-only` 로만.** tracked 미커밋 변경이 있으면
 *     사전 가드(hasTrackedChanges)로 즉시 skip → 다른 세션의 작업을 stash 로 쓸어담지 않는다.
 *     (`--autostash` 는 유실은 아니어도 남의 tracked 변경을 잠시 stash 로 옮기므로 쓰지 않음.)
 *   - tasklist.json(런타임, gitignore)을 소스로 하고, 커밋 대상은 대시보드 파일 1개뿐.
 *   - 예외를 절대 밖으로 던지지 않는다(봇 흐름을 막지 않음).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tm = require('./task-manager');

const BASE_DIR = path.join(__dirname, '..');
const DASH_REL = 'LOWY_ACTION_DASHBOARD.md';
const DASH_FILE = path.join(BASE_DIR, DASH_REL);
const TASKS_DIR = path.join(BASE_DIR, '.agent', 'tasks');

const MARK_START = '<!-- SLACKBOT-TASKS:START -->';
const MARK_END = '<!-- SLACKBOT-TASKS:END -->';

const MAX_COMPLETED = 12; // 최근 완료 표시 개수

// 겹치는 갱신 호출을 직렬화(sync spawn 이라 실제 병렬은 없지만 중복 no-op 방지)
let running = false;

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: BASE_DIR, encoding: 'utf8', windowsHide: true, ...opts });
}

function currentBranch() {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return (r.stdout || '').trim() || 'master';
}

// tracked 미커밋 변경(스테이지/워킹)이 하나라도 있으면 true. untracked(??)는 무시.
// 다른 세션/봇의 진행 중 작업을 stash 로 건드리지 않기 위한 사전 가드에 쓴다.
function hasTrackedChanges() {
  const r = git(['status', '--porcelain', '--untracked-files=no']);
  return (r.stdout || '').trim().length > 0;
}

// origin/base 최신을 로컬 base 로 **fast-forward 로만** 반영한다.
//  - stash/pop 을 절대 쓰지 않는다 → 다른 세션의 tracked 미커밋 작업을 sweep 하지 않음.
//  - 로컬이 앞서(diverged) 있거나, ff 가 로컬 미커밋을 덮어쓸 상황이면 git 이 스스로 거부 → skip.
//    (덮어쓰기 대신 "안 함"을 택함 = 데이터 안전 최우선.)
// 반환: { ok:true } | { ok:false, reason }
function fastForwardBase(base) {
  const f = git(['fetch', 'origin', base]);
  if (f.status !== 0) return { ok: false, reason: 'fetch-failed' };
  // 이미 최신이면 no-op 성공. 로컬 미커밋이 걸리거나 non-ff 면 status!=0 로 거부됨.
  const m = git(['merge', '--ff-only', `origin/${base}`]);
  if (m.status !== 0) return { ok: false, reason: 'not-fast-forwardable' };
  return { ok: true };
}

// origin remote → https://github.com/Owner/Repo
function repoWebBase() {
  const r = git(['remote', 'get-url', 'origin']);
  const remote = (r.stdout || '').trim();
  return remote
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^git@ssh\.github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

function isTracked(relPath) {
  const r = git(['ls-files', '--error-unmatch', relPath]);
  return r.status === 0;
}

// 태스크 파일 GitHub 링크. 추적 중이면 blob URL, 아니면(아직 master 미반영) 태스크 폴더 링크.
function taskLink(taskId, branch, web) {
  const candidates = [
    path.join(TASKS_DIR, `${taskId}.md`),
    path.join(TASKS_DIR, 'done', `${taskId}.md`),
    path.join(TASKS_DIR, 'cancel', `${taskId}.md`),
  ];
  const found = candidates.find(f => fs.existsSync(f));
  if (found) {
    const rel = path.relative(BASE_DIR, found).replace(/\\/g, '/');
    if (isTracked(rel)) return `${web}/blob/${branch}/${rel}`;
  }
  // 미추적이거나 파일 없음 → 태스크 폴더로 폴백(항상 유효)
  return `${web}/tree/${branch}/.agent/tasks`;
}

function esc(s) {
  // 마크다운/링크 라벨 깨짐 방지: 개행 제거, 링크문자 완화, 길이 제한
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .trim()
    .slice(0, 80);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = String(iso).slice(0, 10);
  return d;
}

const EMOJI = { pending: '🕐', running: '⚙️' };

// tasklist 배열 → 자동 섹션 마크다운 문자열(마커 포함)
function buildSection(list, { branch, web, now }) {
  const active = list
    .filter(t => t.status === 'pending' || t.status === 'running')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const completed = list
    .filter(t => t.status === 'completed')
    .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')))
    .slice(0, MAX_COMPLETED);

  const lines = [];
  lines.push(MARK_START);
  lines.push('## 🤖 slack-bot 요청 처리 현황');
  lines.push('');
  lines.push(`> 봇 자동 갱신: ${now} · 이 블록은 봇이 관리하므로 직접 수정하지 마세요(마커 밖은 자유).`);
  lines.push('> 상세는 각 항목의 GitHub 링크(클릭). 완료 항목은 검수 후 체크를 해제하거나 삭제하세요.');
  lines.push('');

  lines.push('### ✅ 확인 필요 — 대기/진행 중');
  if (active.length === 0) {
    lines.push('- _(대기/진행 중인 요청 없음)_');
  } else {
    for (const t of active) {
      const emoji = EMOJI[t.status] || '🕐';
      const title = esc(t.title || t.summary || t.taskId);
      const link = taskLink(t.taskId, branch, web);
      lines.push(`- [ ] ${emoji} \`${t.taskId}\` ${title} — [상세](${link})`);
    }
  }
  lines.push('');

  lines.push(`### 🗂️ 최근 완료 — 검수 후 체크 (최대 ${MAX_COMPLETED}건)`);
  if (completed.length === 0) {
    lines.push('- _(완료된 요청 없음)_');
  } else {
    for (const t of completed) {
      const title = esc(t.title || t.summary || t.taskId);
      const link = t.resultUrl || taskLink(t.taskId, branch, web);
      const date = fmtDate(t.completedAt);
      const dateStr = date ? ` _(${date})_` : '';
      lines.push(`- [x] \`${t.taskId}\` ${title}${dateStr} — [결과](${link})`);
    }
  }
  lines.push('');
  lines.push(`전체 태스크 이력: [\`.agent/tasks/\`](${web}/tree/${branch}/.agent/tasks)`);
  lines.push(MARK_END);
  return lines.join('\n');
}

// 파일 내용에 섹션을 삽입/교체한다. 마커가 있으면 그 사이만, 없으면 상단 첫 `---` 뒤에 삽입.
function applySection(content, section) {
  const s = content.indexOf(MARK_START);
  const e = content.indexOf(MARK_END);
  if (s >= 0 && e > s) {
    const before = content.slice(0, s);
    const after = content.slice(e + MARK_END.length);
    return before + section + after;
  }
  // 마커 없음 → 최초 삽입: 상단 인트로(첫 '---') 뒤에 넣는다.
  const hr = content.indexOf('\n---\n');
  if (hr >= 0) {
    const cut = hr + '\n---\n'.length;
    return content.slice(0, cut) + '\n' + section + '\n' + content.slice(cut);
  }
  // '---' 도 없으면 상단에 프리펜드
  return section + '\n\n' + content;
}

// tasklist 를 읽어 대시보드 파일을 갱신(디스크에만 write). git 은 건드리지 않는다.
// 반환: { changed, path }
function writeDashboardFile({ branch, web, now } = {}) {
  branch = branch || currentBranch();
  web = web || repoWebBase();
  now = now || new Date().toISOString();

  const list = tm.getTasklistByStatus(null) || [];
  const section = buildSection(list, { branch, web, now });

  let content = '';
  try { content = fs.readFileSync(DASH_FILE, 'utf8'); } catch { content = '# Lowy 확인 필요 안건 대시보드\n\n---\n'; }

  const next = applySection(content, section);
  if (next === content) return { changed: false, path: DASH_FILE };
  fs.writeFileSync(DASH_FILE, next);
  return { changed: true, path: DASH_FILE };
}

// ── 메인: pull → 섹션 갱신 → 커밋 → push. base 브랜치에서만, 예외를 삼킨다. ──────
// opts.push=false 면 디스크 갱신만(테스트/시드용).
function refreshDashboard(reason = '', opts = {}) {
  const doPush = opts.push !== false;
  if (running) return { skipped: 'already-running' };
  running = true;
  try {
    // 1) 작업트리가 base 브랜치인지 확인(태스크가 bot/task-* 로 점유 중이면 skip)
    const base = tm.getBaseBranch(BASE_DIR);
    const cur = currentBranch();
    if (doPush && cur !== base) {
      return { skipped: `not-on-base(${cur})` };
    }

    // 2) **수정 전 반드시 pull** — 온라인에서 사용자가 수정한 최신본을 먼저 반영
    if (doPush) {
      // 사전 가드: tracked 미커밋 변경이 있으면(다른 세션/봇이 작업 중일 수 있음) 이번 회차 skip.
      //   → 어차피 뒤의 ff-only 도 거부되지만, 여기서 먼저 빠져 남의 작업 근처에서 아무 git 도 안 만짐.
      if (hasTrackedChanges()) {
        return { skipped: 'tree-dirty(tracked)' };
      }
      // **수정 전 반드시 최신 반영** — 단, stash 없이 fast-forward 로만(남의 작업 안전).
      const sync = fastForwardBase(base);
      if (!sync.ok) {
        console.error(`[Dashboard] base 최신화 skip(${sync.reason}) — 다음 이벤트에서 재시도`);
        return { skipped: sync.reason };
      }
    }

    // 3) 섹션 재생성(디스크)
    const web = repoWebBase();
    const { changed } = writeDashboardFile({ branch: base, web });
    if (!changed) return { skipped: 'no-change' };
    if (!doPush) return { ok: true, pushed: false };

    // 4) 대시보드 파일만 커밋
    git(['add', DASH_REL]);
    const msg = `docs(dashboard): slack-bot 요청 처리 현황 자동 갱신${reason ? ` (${reason})` : ''}\n\nAuto-updated by giipclaude Bot`;
    const commit = git(['commit', '-m', msg]);
    if (commit.status !== 0 && !/nothing to commit/.test(commit.stdout || '')) {
      console.error('[Dashboard] git commit 실패:', (commit.stderr || '').trim().slice(0, 200));
      return { error: 'commit-failed' };
    }

    // 5) push (원격이 앞서 거부되면 우리 대시보드 단일 커밋만 rebase 로 얹어 1회 재시도)
    //   - autostash 미사용. 이 시점 작업트리는 위 사전 가드로 clean 이 보장되므로
    //     rebase 가 남의 미커밋을 건드릴 일이 없다(더러웠다면 애초에 여기 도달 못 함).
    let push = git(['push', 'origin', base]);
    if (push.status !== 0) {
      git(['fetch', 'origin', base]);
      const rb = git(['rebase', `origin/${base}`]);
      if (rb.status !== 0) {
        git(['rebase', '--abort']); // 충돌 시 우리 커밋은 로컬 보존(유실 없음)
        console.error('[Dashboard] push 재시도 rebase 실패 → 이번 회차 skip(커밋은 로컬 보존)');
        return { skipped: 'push-retry-rebase-failed' };
      }
      push = git(['push', 'origin', base]);
    }
    if (push.status !== 0) {
      console.error('[Dashboard] git push 실패:', (push.stderr || '').trim().slice(0, 200));
      return { error: 'push-failed' };
    }
    console.log(`[Dashboard] 갱신 완료${reason ? ` (${reason})` : ''} → origin/${base}`);
    return { ok: true, pushed: true };
  } catch (e) {
    console.error('[Dashboard] refreshDashboard 예외:', e.message);
    return { error: e.message };
  } finally {
    running = false;
  }
}

module.exports = { refreshDashboard, writeDashboardFile, buildSection, applySection };

// CLI: `node dashboard.js`         → pull+갱신+push (base 브랜치에서)
//      `node dashboard.js --local` → 디스크만 갱신(테스트/시드용, git 미조작)
if (require.main === module) {
  const local = process.argv.includes('--local');
  const res = refreshDashboard('manual', { push: !local });
  console.log('[Dashboard]', JSON.stringify(res));
}
