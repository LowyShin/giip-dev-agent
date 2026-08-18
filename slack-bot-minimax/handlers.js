// handlers.js — メッセージ/DM/チャンネル mention/タスク実行ハンドラ群
// index.js から behavior-preserving で切り出し（ロジック変更なし）。
// 内部の giip フック (./giip-commands, ./giip-task) は元コード通りインライン require のまま。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const config = require('./config');
const { BASE_DIR, AGENT_DIR, TASK_STATE_FILE, HISTORY_FILE, getAgentDir, parseProjectPrefix } = config;
const { loadJSON, saveJSON } = require('./state');
const { postMessage, postLong, fetchThreadTranscript } = require('./slack-api');
const { checkAllRepoStatus, isPushFailureNotice } = require('./repo-status');
const { callClaude } = require('./claude-cli');
const { isGoCmd, isCancelCmd, isForceTaskCmd, isPureGitOp, classifyRequest } = require('./intent');
const {
  extractExistingTaskIds, extractGiipIssueRef, findSimilarPendingTasks, findDuplicatePendingClusters, applyTaskMerge,
} = require('./task-dedup');
const tm = require('./task-manager');
const dashboard = require('./dashboard');
const { searchKLayer } = require('./k-layer');
const { getIssues, refreshIssues, getCacheAge } = require('./github-issues');

// LOWY_ACTION_DASHBOARD.md 자동 갱신 훅. tasklist 변화 후 호출한다.
//  - 예외/블로킹 없이(비동기 defer) 봇 흐름을 막지 않는다.
//  - base 브랜치가 아니거나(태스크 실행 중) pull 실패면 dashboard 모듈이 알아서 skip.
function refreshDashboardSafe(reason) {
  setImmediate(() => {
    try { dashboard.refreshDashboard(reason); }
    catch (e) { console.error('[Bot] dashboard refresh 훅 오류:', e.message); }
  });
}

async function handleSimpleGitOp({ channelId, replyTs, text, workDir = BASE_DIR }) {
  if (!isPureGitOp(text)) return false;
  const t = text.trim();
  if (/git\s+push/i.test(t)) {
    spawnSync('git', ['pull', '--rebase', 'origin'], { cwd: workDir, encoding: 'utf8', windowsHide: true });
    const res = spawnSync('git', ['push'], { cwd: workDir, encoding: 'utf8', windowsHide: true });
    const ok = res.status === 0;
    await postMessage(channelId, ok ? '✅ git push 完了' : `❌ git push 失敗\n\`\`\`${(res.stderr || '').slice(0, 500)}\`\`\``, replyTs);
    return true;
  }
  if (/git\s+pull/i.test(t)) {
    const res = spawnSync('git', ['pull', '--rebase', 'origin'], { cwd: workDir, encoding: 'utf8', windowsHide: true });
    const ok = res.status === 0;
    await postMessage(channelId, ok ? '✅ git pull 完了' : `❌ git pull 失敗\n\`\`\`${(res.stderr || '').slice(0, 500)}\`\`\``, replyTs);
    return true;
  }
  return false;
}

async function answerInChannel({ channelId, replyTs, text, workDir = BASE_DIR, threadTs = null }) {
  if (await handleSimpleGitOp({ channelId, replyTs, text, workDir })) return;

  // 即時受付通知: callClaude は最大20分ブロックし、その間ユーザには何も返らないため
  // 「먹통」に見える。実処理の前に受付メッセージを出して無応答体感を無くす。
  await postMessage(channelId, '💬 질문을 확인했습니다. 답변을 준비 중입니다…', replyTs);

  // スレッド内での質問なら、スレッド全体を取得して文脈として渡す。
  // Bot は mention された1件しか受け取らないため、これをやらないと
  // 「스레드를 정리해줘」に対して「대화 기록이 없습니다」と誤答してしまう。
  let threadTranscript = '';
  try {
    threadTranscript = await fetchThreadTranscript(channelId, threadTs);
  } catch (e) {
    console.error('[Bot] fetchThreadTranscript error:', e.message);
  }

  const claims = searchKLayer(text);
  let issues = [];
  if (['issue', 'bug', 'イシュー', 'バグ', 'task', 'github', '#'].some(k => text.toLowerCase().includes(k))) {
    issues = await getIssues();
  }

  const projectName = path.basename(workDir);
  const agentDir = getAgentDir(workDir);
  let prompt = `You are giipclaude, an AI assistant. Always respond in Korean.

Working project: ${projectName}
Working directory: ${workDir}
Agent context directory: ${agentDir}
  - roles/    : project role definitions
  - rules/    : coding and workflow rules
  - skills/   : available skills
  - workflows/: workflow definitions
Read relevant files from the agent context directory as needed to apply the correct role and rules.

IMPORTANT: Answer based on your knowledge of the project directory and K-Layer context below. If you do not know the answer, say "모르겠습니다" clearly.

되묻지 말고 실측: 경로·설정·사양 등 조회로 확정 가능한 값은 사용자에게 묻지 말고 직접 찾아라. giip 서비스 설정(SMTP·메일·인증 등)의 정본은 giipdb 사양서(\`giipprj/giipdb/docs/30_Specs/\`)와 DB 다. 예: SMTP 는 \`tEmailServerConfig\` 테이블 + giip API \`EmailServerConfigGetActive\`. 사람에게 묻기 전에 반드시 그곳부터 grep/조회하고, 정말 사람만 아는 값(외부 자격증명 실물)만 질문한다.

MANDATORY RULE — Task Number: If the user's message contains a 14-digit task number (e.g. 20260630170105), you MUST start your response with "[태스크 \`<task_number>\`]" on the very first line. Never omit the task number from your response.`;
  if (claims.length) prompt += '\n\nK-Layer:\n' + claims.map(c => `• ${c}`).join('\n');
  if (issues.length) prompt += '\n\nOpen Issues:\n' + issues.map(i => `• #${i.number} ${i.title}`).join('\n');
  if (threadTranscript) {
    prompt += `\n\n── 현재 Slack 스레드 전체 내용 (시간순, "화자: 발언") ──\n${threadTranscript}\n── 스레드 끝 ──\n\n위 스레드가 사용자가 말하는 "현재 스레드 / 이 대화 / 이 슬랙 메시지"입니다. 스레드 정리·요약·누가 무슨 말을 했는지·전후 확인 요청은 반드시 이 내용을 근거로 답하세요. "대화 기록이 없다"고 답하지 마세요.`;
  }
  prompt += `\n\nQuestion: ${text}\nAnswer:`;

  // ── 安全網: question 経路でも「ファイル変更 = 必ずブランチ+PR」規則を強制する ──
  // task/question 分類は flaky(LLM)なため、誤って question に落ちた作業依頼でも
  // callClaude がファイルを書けば作業ツリーに未コミットで取り残される事故が起きる
  // (giip-629 追加依頼: 未追跡ファイルのまま PR 未生成)。task 経路と同一の
  // commitAndPRChangedRepos 機械を再利用し、実行「前」に clean だったリポの
  // タスク由来変更だけを安全に commit·push·PR する(pre-dirty は触らず skip)。
  let qnaSnapshots = [];
  try { qnaSnapshots = tm.snapshotCandidateRepos(workDir); }
  catch (e) { console.error('[Bot] answer snapshot error:', e.message); }

  try {
    const reply = await callClaude(prompt, workDir);
    // 코드레벨 강제: 사용자 메시지의 태스크 ID가 응답에 없으면 첫 줄에 삽입
    const missingIds = extractExistingTaskIds(text).filter(id => !reply.includes(id));
    const finalReply = missingIds.length > 0
      ? `[태스크 \`${missingIds.join('`, `')}\`]\n\n${reply}`
      : reply;
    await postLong(channelId, finalReply, replyTs);
  } catch (err) {
    const isTimeout = err.code === 'ETIMEDOUT' || (err.message && err.message.includes('ETIMEDOUT'));
    const msg2 = isTimeout
      ? '⏱️ 処理がタイムアウトしました（20分超過）。もう少し短い要求に分けて送ってください。'
      : `回答エラー: ${err.message}`;
    await postMessage(channelId, msg2, replyTs);
  }

  // callClaude が(成功/タイムアウト問わず)ファイルを変更していたら、未コミットで
  // 放置せず自動 PR にする。変更ゼロなら静かに何もしない。
  try {
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const qtitle = String(text).replace(/\s+/g, ' ').trim().slice(0, 60);
    const multi = tm.commitAndPRChangedRepos(`qna-${stamp}`, qtitle, qnaSnapshots);
    const prLines = (multi.prs || []).map(p => `🔀 PR (${path.basename(p.repo)}): ${p.url}`);
    const skipLines = (multi.skipped || []).map(s => `⚠️ 수동 필요: ${path.basename(s.repo)} (${s.reason})`);
    const blockedLines = (multi.blocked || []).map(b =>
      `🚧 보류: ${path.basename(b.repo)} — 미머지 PR ${(b.prs || []).map(p => '#' + p.number).join(', ')} 과 같은 파일. 브랜치 \`${b.branch}\` push 됨(선행 PR 머지 후 수동 PR/rebase 필요).`);
    if (prLines.length || skipLines.length || blockedLines.length) {
      await postMessage(channelId, [
        '📝 *답변 중 파일 변경 감지 → 자동 브랜치/PR* (질문 경로 안전망)',
        ...prLines,
        ...blockedLines,
        ...skipLines,
      ].join('\n'), replyTs);
    }
  } catch (e) { console.error('[Bot] answer auto-PR error:', e.message); }
}

// ── DM 처리 (일반 Q&A) ───────────────────────────────────────────────────────
async function handleDM({ channelId, ts, threadTs, text, conversations, workDir = BASE_DIR }) {
  const convKey = channelId;
  const replyTs = threadTs || undefined;
  const cmd = text.trim().toLowerCase();

  // ── giip 커맨드 (giip api|issue|account) — DM 은 특히 account set(SK) 에 안전 ──
  try {
    const { handleGiipCommand } = require('./giip-commands');
    const gc = await handleGiipCommand(text.trim(), channelId);
    if (gc.handled) { await postMessage(channelId, gc.text, replyTs); return; }
  } catch (e) { console.error('[Bot] giip command error:', e.message); }

  if (cmd === '!help') {
    await postMessage(channelId, [
      '*giipclaude AI — DM コマンド一覧*',
      '• `!issues` — GitHub Issue 一覧',
      '• `!issues refresh` — Issue 強制更新',
      '• `!klayer <キーワード>` — K-Layer 知識検索',
      '• `!reset` — 会話履歴リセット',
      '',
      '*giip issue 連携:*',
      '• `giip account set <login_id> <sk> [csn]` — チャンネル連携（DM推奨・SK含むので channel では避ける）',
      '• `giip account show` — 現在の連携アカウント表示',
      '• `giip issue list [status]` — イシュー一覧',
      '• `giip issue get <isn>` — イシュー詳細',
      '• `giip issue new "<title>"` — イシュー新規作成',
      '• `giip issue done|review|progress <isn>` — ステータス変更',
      '• `giip issue comment <isn> <text>` — コメント追加',
      '• `giip project set <프로젝트명> <csn>` — プロジェクト名→CSN マッピング登録（`<프로젝트> issue 등록` 用）',
      '• `giip project list` / `giip project del <프로젝트명>` — マッピング一覧 / 削除',
      '• `giip api <Verb> [jsondata]` — 汎用 giip API 呼び出し',
      '',
      'チャンネルで `@ボット名 要求内容` と書くと Task ワークフローが始まります。',
    ].join('\n'), replyTs);
    return;
  }
  if (cmd === '!reset') {
    conversations[convKey] = [];
    await postMessage(channelId, '会話履歴をリセットしました。', replyTs);
    return;
  }
  if (cmd === '!issues' || cmd === '!issues refresh') {
    const issues = cmd.includes('refresh') ? await refreshIssues() : await getIssues();
    if (!issues.length) { await postMessage(channelId, 'GITHUB_TOKEN / GITHUB_REPO の設定を確認してください。', replyTs); return; }
    const lines = issues.map(i => `• #${i.number} ${i.title}`);
    await postMessage(channelId, `Issues (${issues.length}件) — ${getCacheAge()}\n${lines.join('\n')}`, replyTs);
    return;
  }
  if (cmd.startsWith('!klayer ')) {
    const kw = cmd.slice(8).trim();
    const claims = searchKLayer(kw);
    await postMessage(channelId, claims.length ? `K-Layer "${kw}":\n${claims.map(c=>`• ${c}`).join('\n')}` : `"${kw}" に関連する claim はありません`, replyTs);
    return;
  }

  // ── タスク番号による状況照会（DM）────────────────────────────────────────
  const dmTaskMatch = text.trim().match(/^(?:status\s+)?(\d{14}|giip-\d{1,6})$/);
  if (dmTaskMatch) {
    const targetId = dmTaskMatch[1];
    const taskFile = path.join(AGENT_DIR, 'tasks', `${targetId}.md`);
    if (fs.existsSync(taskFile)) {
      const fc = fs.readFileSync(taskFile, 'utf8');
      const statusM = fc.match(/^status:\s*(.+)$/m);
      const requestM = fc.match(/^request:\s*"?([^\n"]{1,120})/m);
      const status = statusM ? statusM[1].trim() : '不明';
      const request = requestM ? requestM[1].trim() : '（内容なし）';
      const logMatch = fc.match(/## 進捗ログ([\s\S]*)/);
      const logLines = logMatch ? logMatch[1].trim().split('\n').filter(l => l.startsWith('|')).slice(-5).join('\n') : null;
      let reply = `*タスク \`${targetId}\` — 状況報告*\n• ステータス: ${status}\n• 内容: ${request}`;
      if (logLines) reply += `\n\n*進捗ログ（直近）:*\n${logLines}`;
      await postMessage(channelId, reply, replyTs);
    } else {
      await postMessage(channelId, `⚠️ タスク \`${targetId}\` が見つかりません。`, replyTs);
    }
    return;
  }

  // 일반 대화
  const history = conversations[convKey] || [];
  const claims = searchKLayer(text);
  let issues = [];
  if (['issue','bug','이슈','버그','task','github','#'].some(k => text.toLowerCase().includes(k))) {
    issues = await getIssues();
  }

  const projectName = path.basename(workDir);
  const agentDirDM = getAgentDir(workDir);
  let prompt = `You are giipclaude, an AI assistant. Always respond in Korean regardless of the language the user writes in.\n\nWorking project: ${projectName}\nWorking directory: ${workDir}\nAgent context directory: ${agentDirDM} (roles/, rules/, skills/, workflows/)\nRead relevant files from the agent context directory to apply the correct role and rules.\n\nIMPORTANT: Answer based on your knowledge of the project and K-Layer context. If you do not know the answer, say "모르겠습니다" clearly.\n\n되묻지 말고 실측: 설정·사양은 직접 조회하라. giip 서비스 설정(SMTP 등)의 정본=giipdb \`docs/30_Specs/\` + DB(예: SMTP=\`tEmailServerConfig\`, API \`EmailServerConfigGetActive\`). 사람만 아는 값만 질문한다.\n\nMANDATORY RULE — Task Number: If the user's message contains a 14-digit task number (e.g. 20260630170105), you MUST start your response with "[태스크 \`<task_number>\`]" on the very first line. Never omit the task number from your response.`;
  if (claims.length) prompt += '\n\nK-Layer:\n' + claims.map(c=>`• ${c}`).join('\n');
  if (issues.length) prompt += '\n\nOpen Issues:\n' + issues.map(i=>`• #${i.number} ${i.title}`).join('\n');
  if (history.length) {
    prompt += '\n\nHistory:';
    history.slice(-10).forEach(m => { prompt += `\n${m.role==='user'?'User':'Assistant'}: ${m.content}`; });
  }
  prompt += `\n\nUser: ${text}\nAssistant:`;

  try {
    const reply = await callClaude(prompt, workDir);
    if (!conversations[convKey]) conversations[convKey] = [];
    conversations[convKey].push({ role: 'user', content: text });
    conversations[convKey].push({ role: 'assistant', content: reply });
    if (conversations[convKey].length > 20) conversations[convKey] = conversations[convKey].slice(-20);
    // 코드레벨 강제: 사용자 메시지의 태스크 ID가 응답에 없으면 첫 줄에 삽입
    const missingIdsDM = extractExistingTaskIds(text).filter(id => !reply.includes(id));
    const finalReplyDM = missingIdsDM.length > 0
      ? `[태스크 \`${missingIdsDM.join('`, `')}\`]\n\n${reply}`
      : reply;
    await postLong(channelId, finalReplyDM, replyTs);
  } catch (err) {
    await postMessage(channelId, `오류: ${err.message}`, replyTs);
  }
}

// ── 작업트리 점유가 풀렸을 때, 대기열의 다음 태스크를 자동 기동한다 ──────────────
//   busy 로 되돌려진 태스크는 pending 에 `queuedBehind` 마커와 함께 남는다.
//   태스크 완료(onComplete/onError)로 락이 풀린 직후 이 함수를 호출하면, 마커가 있는
//   대기 태스크를 FIFO(queuedAt 오름차순) 로 하나 꺼내 실행한다.
//   ※ 마커 없는 pending(=수동 `go` 대기 중인 분석 완료 태스크)은 자동 실행하지 않는다.
//   ※ 한 번에 하나만 기동(직렬). 다음 태스크는 그 태스크의 완료 시 다시 드레인된다.
async function drainNextQueued(reason = 'task-completed') {
  try {
    const ts = loadJSON(TASK_STATE_FILE, { pending: {}, running: {} });
    // 이미 다른 태스크가 실행 중(작업트리 점유)이면 드레인하지 않는다(직렬 보장).
    if (ts.running && Object.keys(ts.running).length > 0) return;
    const queued = Object.entries(ts.pending || {})
      .filter(([, t]) => t && t.queuedBehind)
      .sort((a, b) => String(a[1].queuedAt || '').localeCompare(String(b[1].queuedAt || '')));
    if (!queued.length) return;
    const [key, entry] = queued[0];
    const ch = entry.channelId;
    const rt = entry.replyTs || undefined;
    if (!ch) { console.error('[Bot] drainNextQueued: channelId 없음 → 스킵:', key); return; }
    console.log(`[Bot] drainNextQueued(${reason}): 대기 태스크 ${entry.taskId} 자동 기동`);
    await postMessage(ch,
      `▶️ 작업트리가 비었습니다 — 대기 중이던 \`${entry.taskId}\` 을(를) 자동 기동합니다.`,
      rt);
    await startTaskExecution(key, entry, ch, rt, ts, entry.workDir || BASE_DIR);
  } catch (e) {
    console.error('[Bot] drainNextQueued error:', e.message);
  }
}

// ── Task 実行共通処理 ─────────────────────────────────────────────────────────
async function startTaskExecution(pendingKey, pendingTask, channelId, replyTs, taskState, workDir = BASE_DIR) {
  // 保存された workDir を優先（go <id> はプレフィックス無しで来るため handlers 側の
  // parseProjectPrefix が BASE_DIR に潰してしまう。タスク作成時の workDir を必ず使う）。
  const effWorkDir = (pendingTask && pendingTask.workDir) || workDir;

  delete taskState.pending[pendingKey];
  const startedAt = new Date().toISOString();
  taskState.running[pendingKey] = {
    taskId: pendingTask.taskId,
    taskTitle: pendingTask.taskTitle,
    isn: pendingTask.isn || null, // 점유 중 대기 태스크가 이 이슈에 대기 코멘트를 남길 수 있게 보존
    startedAt,
  };
  saveJSON(TASK_STATE_FILE, taskState);
  tm.updateTasklistEntry(pendingTask.taskId, { status: 'running', startedAt });

  // ── 作業「前」: 候補 nested repo の base を origin 最新へ ff 同期 ──
  // giipv3 等の nested repo は誰も base を pull せず stale なまま編集され、後段 auto-PR が
  // 最新 origin/base から切ったブランチへ replay する時に既 merge 済み変更と衝突していた
  // (= ユーザ指摘「giipv3 は毎回 conflict」の根治)。clean かつ base 上の repo だけ ff 同期。
  try { tm.syncCandidateReposBase(effWorkDir); }
  catch (e) { console.error('[Bot] syncCandidateReposBase error:', e.message); }

  // ── 実行「前」: 候補 nested repo を「このタスク専用ブランチ」へ切り替える(スト孤児化の根本予防) ──
  // prepareTaskBranch が BASE_DIR だけを bot/task-<id> にしていたため、nested repo(giipv3/giipdb)は
  //   直前タスクのブランチに停留したまま編集され、後段 auto-PR が foreign branch として skip →
  //   コードが PR されず「REVIEW인데 배포 0」になっていた。ここで clean·on-base の nested repo を
  //   先に bot/task-<id> へ切り替え、編集が正しい専用ブランチに載るようにする(dirty/foreign は不触)。
  //   snapshot はこの「後」に撮る(専用ブランチ上の clean 状態を基準にするため順序が重要)。
  let nestedPrepared = [];
  try { nestedPrepared = tm.prepareNestedBranches(effWorkDir, pendingTask.taskId, [BASE_DIR]); }
  catch (e) { console.error('[Bot] prepareNestedBranches error:', e.message); }

  // ── 実行「前」に、タスクが変更しうる候補リポの dirty 状態をスナップショット ──
  // (effWorkDir を含むリポ + その配下の nested git repo。onComplete/onError で
  //  「タスクが実際に変更したリポだけ」を安全に判定・PR するための基準。)
  let repoSnapshots = [];
  try { repoSnapshots = tm.snapshotCandidateRepos(effWorkDir); }
  catch (e) { console.error('[Bot] snapshotCandidateRepos error:', e.message); }

  // ── 作業前: 最新 base(origin) から専用ブランチを用意（結果レポート = BASE_DIR）──
  // 旧: 現在ブランチを git pull --rebase（stale base だと conflict 誘発）→ 廃止。
  // 新: `git fetch origin <base>` 直後に origin/<base> を起点にブランチを作る。
  //     常に最新 base 基準なので「ブランチを作るたび merge conflict」を根本回避する。
  // 注意: 結果レポート/タスクファイルは常に BASE_DIR(lowyworkenv) 配下に生成されるため、
  //     この既存経路は BASE_DIR を対象にする。effWorkDir 本体や nested repo の
  //     コード変更は onComplete の commitAndPRChangedRepos が別途担当する。
  const branchCtx = tm.prepareTaskBranch(pendingTask.taskId, BASE_DIR);
  if (!branchCtx.ok && !branchCtx.notRepo) {
    // busy(他タスクが作業ツリー占有) or ブランチ生成失敗 → pending へ戻して中断
    const ts0 = loadJSON(TASK_STATE_FILE, { pending: {}, running: {} });
    delete ts0.running[pendingKey];

    if (branchCtx.busy) {
      // 다른 태스크가 작업트리(git)를 점유 중 → 대기열에 등록만 하고, 점유 태스크가
      // 끝나면 onComplete/onError 의 drainNextQueued 가 이 태스크를 자동 기동한다.
      // (직렬 실행은 유지: 사용자가 다시 `go` 하지 않아도 순서대로 실행됨.)
      const occupying = Object.values(ts0.running || {})[0] || null;
      const occId = (occupying && occupying.taskId) || '(불명)';
      ts0.pending[pendingKey] = {
        ...pendingTask,
        queuedBehind: occId,                 // 어떤 태스크가 점유 중이었는지(진단·표시용)
        queuedAt: new Date().toISOString(),  // FIFO 드레인 정렬 키
        channelId,                           // 자동 기동 시 회신 채널
        replyTs: replyTs || null,            // 자동 기동 시 회신 스레드
      };
      saveJSON(TASK_STATE_FILE, ts0);
      tm.updateTasklistEntry(pendingTask.taskId, { status: 'pending', startedAt: null });
      await postMessage(channelId,
        `⏸️ 지금은 \`${occId}\` 이(가) 작업트리(git)를 점유 중입니다.\n` +
        `\`${pendingTask.taskId}\` 을(를) *대기열에 등록*했습니다 — 점유 작업이 끝나면 *자동으로 기동*합니다 (다시 \`go\` 하지 않아도 됩니다).`,
        replyTs
      );
      // 점유 중인 giip 이슈에 대기 관계를 코멘트로 남긴다(best-effort, SSOT-안전한 코멘트 채널).
      try {
        if (occupying && occupying.isn) {
          await require('./giip-task').maybeComment(channelId, occupying.isn,
            `⏳ 대기 중: \`${pendingTask.taskId}\`${pendingTask.isn ? ` (giip #${pendingTask.isn})` : ''} 이(가) 작업트리 점유 해제를 기다립니다 — 이 작업(#${occupying.isn}) 완료 시 자동 기동됩니다.`);
        }
      } catch (e) { console.error('[Bot] 대기 코멘트 훅 오류:', e.message); }
      return;
    }

    // busy 이외의 브랜치 생성 실패 → 종전대로 수동 재실행 안내.
    ts0.pending[pendingKey] = pendingTask;
    saveJSON(TASK_STATE_FILE, ts0);
    tm.updateTasklistEntry(pendingTask.taskId, { status: 'pending', startedAt: null });
    await postMessage(channelId,
      `⏸️ *実行できません*: ${branchCtx.error}\n\`go ${pendingTask.taskId}\` で後ほど再実行してください。`,
      replyTs
    );
    return;
  }
  const execCtx = branchCtx.ok ? branchCtx : null; // notRepo 時は ctx=null (PR 不可、従来通り実行)
  if (execCtx) {
    await postMessage(channelId,
      `🌿 作業ブランチ作成: \`${execCtx.branch}\`\n• base: \`${execCtx.base}\`${execCtx.fetchedBase ? ' (origin 最新 fetch 済)' : ' (⚠️ fetch 失敗 — ローカル base 基準)'}`,
      replyTs
    );
  }

  await postMessage(channelId,
    `⚙️ *Task 実行開始*: \`${pendingTask.taskId}\`\n• ${pendingTask.taskTitle}\n\n_サブエージェントが作業中です。完了したら PR URL をお知らせします。_`,
    replyTs
  );

  // giip issue 연동: 실제 실행이 시작되는 이 시점에 IN_PROGRESS 로 전이한다.
  //   분석 단계에서 미리 IN_PROGRESS 를 찍지 않으므로 「issue 는 IN_PROGRESS 인데
  //   실제로는 아무것도 안 도는」 모순 상태가 생기지 않는다(사용자 지적 대응).
  if (pendingTask && pendingTask.isn) {
    try { await require('./giip-task').maybeFinish(channelId, pendingTask.isn, 'IN_PROGRESS', null); }
    catch (e) { console.error('[Bot] giip IN_PROGRESS 전이 오류:', e.message); }
  }

  // effWorkDir/nested repo の PR を Slack へ整形するヘルパ（onComplete/onError 共用）
  const renderRepoLines = (reportUrl, multi) => {
    const prLines = [];
    if (reportUrl) prLines.push(`🔀 PR: ${reportUrl}`);
    for (const p of (multi.prs || [])) prLines.push(`🔀 PR (${path.basename(p.repo)}): ${p.url}`);
    const skipLines = (multi.skipped || []).map(s => {
      const files = (s.files || []).slice(0, 6).map(f => path.basename(f)).join(', ');
      const more = (s.files || []).length > 6 ? ' 외' : '';
      return `⚠️ 수동 필요: ${path.basename(s.repo)}${files ? ` [${files}${more}]` : ''} — ${s.reason}`;
    });
    // PR 충돌 게이트로 보류된 저장소: 어떤 미머지 PR 과 어느 파일이 겹쳤는지 알린다.
    const blockedLines = [];
    for (const b of (multi.blocked || [])) {
      const prTxt = (b.prs || []).map(p => `#${p.number}`).join(', ');
      const fileTxt = (b.files || []).slice(0, 5).map(f => path.basename(f)).join(', ') + ((b.files || []).length > 5 ? ' 외' : '');
      blockedLines.push(`🚧 보류: ${path.basename(b.repo)} — 파일 [${fileTxt}] 이(가) 미머지 PR ${prTxt} 대상이라 새 PR 을 만들지 않았습니다(브랜치 \`${b.branch}\` 는 push 됨).`);
      for (const p of (b.prs || [])) blockedLines.push(`   ↳ ${p.url}`);
    }
    return { prLines, skipLines, blockedLines };
  };

  // ── 자가 치유: giip issue 태스크인데 로컬 태스크 파일이 없으면 DB 이력으로 재생성 ──
  //   giip issue 재처리 요청은 done/ 이동·타 클론 처리·워킹트리 churn 으로 로컬
  //   .agent/tasks/{giip-isn}.md 가 사라졌을 수 있다(#660 "タスクファイルが見つかりません"의 원인).
  //   이 경우 DB(SSOT)에서 이슈 본문 + 전체 코멘트를 가져와 태스크 파일을 복원해, 서브에이전트가
  //   코멘트 이력을 모두 읽고 이어서 처리하도록 한다. isn 이 있는 태스크에만 적용(best-effort).
  if (pendingTask.isn && (!pendingTask.taskFile || !fs.existsSync(pendingTask.taskFile))) {
    try {
      const hist = await require('./giip-task').fetchIssueHistory(channelId, pendingTask.isn);
      const rebuilt = tm.rebuildTaskFileFromIssue(
        pendingTask.taskId, pendingTask.isn, pendingTask.requestText || '', hist && hist.digest);
      pendingTask.taskFile = rebuilt;
      await postMessage(channelId,
        `🗄️ 로컬 태스크 파일이 없어 giip issue #${pendingTask.isn} 의 DB 이력(본문+코멘트${hist && hist.comments ? ` ${hist.comments.length}건` : ''})으로 복원해 처리합니다.`,
        replyTs);
    } catch (e) {
      console.error('[Bot] giip 태스크 파일 DB 복원 실패:', e.message);
    }
  }

  tm.startExecution(pendingTask.taskId, pendingTask.taskFile, {
    isn: pendingTask.isn || null, // giip 연동 시 서브에이전트가 진행 코멘트를 남기도록 isn 전달
    onComplete: async (resultFile) => {
      // 결과 내용을 태스크 파일에 추가하고 done/ 폴더로 이동
      let doneTaskFile = null;
      try {
        const resultContent = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '';
        doneTaskFile = tm.completeTaskFile(pendingTask.taskId, resultContent);
      } catch (e) {
        console.error('[Bot] completeTaskFile error:', e.message);
      }

      // ① 결과 보고서/기본 리포(BASE_DIR): 기존 경로 유지 (report + BASE_DIR 코드 변경).
      // ⚠️ gitPushResultAndPR 내부에서 restoreTaskBranch 를 호출해 gitTreeBusy 락을 해제한다.
      //   running 상태 삭제는 반드시 이 호출 *이후* 에 해야 한다 — 먼저 지우면 gitTreeBusy=true 인데
      //   running 은 이미 비어 있는 창(레이스 윈도우)이 생겨, 그 사이 새 태스크가 busy 로 걸리면
      //   점유자를 찾지 못해 '(불명)' 으로 표시된다(실제로는 이 태스크가 push/PR 처리 중이었음).
      const reportUrl = tm.gitPushResultAndPR(pendingTask.taskId, pendingTask.taskTitle, resultFile, doneTaskFile, execCtx, BASE_DIR);
      const ts2 = loadJSON(TASK_STATE_FILE, {});
      delete ts2.running[pendingKey];
      saveJSON(TASK_STATE_FILE, ts2);
      // ② 그 외 실제로 바뀐 저장소(effWorkDir 본체 + nested repo) 각각 커밋·push·PR.
      let multi = { prs: [], skipped: [] };
      try {
        multi = tm.commitAndPRChangedRepos(pendingTask.taskId, pendingTask.taskTitle, repoSnapshots, { excludeRoots: [BASE_DIR] });
      } catch (e) { console.error('[Bot] commitAndPRChangedRepos error:', e.message); }
      // prepareNestedBranches 로 전환한 nested repo 를 base 로 복원(드리프트 누적 차단).
      try { tm.restoreNestedBranches(nestedPrepared); }
      catch (e) { console.error('[Bot] restoreNestedBranches error:', e.message); }

      const allUrls = [reportUrl, ...multi.prs.map(p => p.url)].filter(Boolean);
      const blocked = multi.blocked || [];
      // unlanded = このタスクが変更したのに PR にできなかった repo(兄弟 giipv3 が別ブランチに停留 等)。
      //   これがあるのに素直に「완료」と言うと、コードが未反映のまま完了扱いになる(giip-720 の再発)。
      const unlanded = multi.skipped || [];
      tm.updateTasklistEntry(pendingTask.taskId, {
        // 일부 저장소가 미머지 PR 과 충돌해 PR 보류되면 'blocked' — "머지완료 <taskid>" 로 재개.
        // unlanded(이 태스크가 바꿨는데 PR 못한 repo)도 '완료'가 아니다 → 'blocked' 로 묶어
        //   대시보드/집계에서 '완료'로 세지 않게 한다(= 거짓 완료 방지).
        status: (blocked.length || unlanded.length) ? 'blocked' : 'completed',
        completedAt: new Date().toISOString(),
        resultUrl: allUrls[0] || null,
        blocked: blocked.length ? blocked : undefined,
        unlanded: unlanded.length ? unlanded.map(s => ({ repo: s.repo, files: s.files || [], reason: s.reason })) : undefined,
      });
      refreshDashboardSafe('task-completed'); // 완료 후 작업트리는 master 복귀 상태 → 갱신 가능
      // giip issue 통일: 완료 → 코멘트 + REVIEW.
      // ⚠️ 근본수정: REVIEW 는 「이 태스크가 바꾼 코드가 전부 PR 로 반영됐을 때만」 찍는다.
      //   blocked(선행 PR 충돌 보류) 뿐 아니라 unlanded(foreign branch 등으로 PR 못한 변경)가
      //   하나라도 있으면 REVIEW 로 넘기지 않는다 → IN_PROGRESS 유지 + 미반영 사유 명시.
      //   (과거: unlanded 여도 REVIEW 로 전이해 「REVIEW인데 배포 0」 거짓 완료가 양산됐다.)
      try {
        if (pendingTask.isn) {
          const gt = require('./giip-task');
          if (blocked.length) {
            const prTxt = blocked.map(b => (b.prs || []).map(p => '#' + p.number).join(',')).join(' ');
            await gt.maybeFinish(channelId, pendingTask.isn, 'IN_PROGRESS',
              `⏸️ 작업 산출물은 브랜치에 push 됐으나, 선행 미머지 PR(${prTxt})과 같은 파일이라 PR 을 보류했습니다. 선행 PR 머지 후 재개합니다.`);
          } else if (unlanded.length) {
            const unlandedTxt = unlanded.map(s => {
              const files = (s.files || []).slice(0, 6).map(f => path.basename(f)).join(', ');
              return `${path.basename(s.repo)}${files ? ` [${files}]` : ''} — ${s.reason}`;
            }).join(' / ');
            const prTxt = allUrls.length ? `\n부분 PR: ${allUrls.join(' , ')}` : '';
            await gt.maybeFinish(channelId, pendingTask.isn, 'IN_PROGRESS',
              `⚠️ 아직 완료 아님(REVIEW 보류). 이 태스크가 바꾼 다음 저장소 변경분이 PR 로 반영되지 않았습니다(수동 PR 필요): ${unlandedTxt}${prTxt}`);
          } else {
            const cmt = allUrls.length
              ? `✅ 작업 완료. PR: ${allUrls.join(' , ')}`
              : `✅ 작업 완료(push/PR 실패). 결과: .agent/tasks/done/${pendingTask.taskId}.md`;
            await gt.maybeFinish(channelId, pendingTask.isn, 'REVIEW', cmt);
          }
        }
      } catch (e) { console.error('[Bot] giip finish 훅 오류:', e.message); }

      const { prLines, skipLines, blockedLines } = renderRepoLines(reportUrl, multi);
      const resumeGuide = blocked.length
        ? ['', `⏸️ 선행 PR 머지 후 \`머지완료 ${pendingTask.taskId}\` 라고 알려주면 base 를 pull→rebase 후 PR 을 만듭니다.`]
        : [];
      // 헤드라인: 보류(blocked) > 미반영(unlanded) > 완료 の優先で正直に表示する。
      const headline = blocked.length
        ? '⏸️ *작업 완료 (일부 PR 보류)*'
        : (unlanded.length ? '⚠️ *작업 완료 — 일부 저장소 PR 미생성(수동 필요)*' : '✅ *작업 완료*');
      if (prLines.length || blockedLines.length) {
        await postMessage(channelId, [
          `${headline}: \`${pendingTask.taskId}\`${pendingTask.isn ? ` / giip #${pendingTask.isn}${(blocked.length || unlanded.length) ? '' : '→REVIEW'}` : ''}`,
          `• ${pendingTask.taskTitle}`,
          '',
          ...prLines,
          ...(blockedLines.length ? ['', ...blockedLines] : []),
          ...(skipLines.length ? ['', ...skipLines] : []),
          ...resumeGuide,
        ].join('\n'), replyTs);
      } else {
        await postMessage(channelId, [
          `${unlanded.length ? '⚠️ *작업 완료 — 일부 저장소 PR 미생성(수동 필요)*' : '✅ *작업 완료*'} (⚠️ 원격 반영된 PR 없음)`,
          `• \`${pendingTask.taskId}\`: ${pendingTask.taskTitle}`,
          `결과 파일: \`.agent/tasks/done/${pendingTask.taskId}.md\``,
          ...(skipLines.length
            ? ['', ...skipLines]
            : ['변경된 저장소가 없거나 push/PR 생성에 실패했습니다. 봇 로그의 git/gh 오류를 확인하세요.']),
        ].join('\n'), replyTs);
        if (!skipLines.length) await postLong(channelId, checkAllRepoStatus(), replyTs);
      }

      // 작업트리 락이 해제된 시점 → 대기열에 쌓인 다음 태스크를 자동 기동.
      await drainNextQueued('task-completed');
    },
    onError: async (err, resultFile) => {
      // エラー時も部分成果を push+PR し、必ず作業ツリーを原状復帰(ブランチ復元)する。
      // ⚠️ onComplete 와 동일한 이유로 running 삭제는 gitPushResultAndPR(restoreTaskBranch 포함) 이후.
      const reportUrl = tm.gitPushResultAndPR(pendingTask.taskId, pendingTask.taskTitle + ' (error)', resultFile, null, execCtx, BASE_DIR);
      const ts2 = loadJSON(TASK_STATE_FILE, {});
      delete ts2.running[pendingKey];
      saveJSON(TASK_STATE_FILE, ts2);
      let multi = { prs: [], skipped: [] };
      try {
        multi = tm.commitAndPRChangedRepos(pendingTask.taskId, pendingTask.taskTitle + ' (error)', repoSnapshots, { excludeRoots: [BASE_DIR] });
      } catch (e) { console.error('[Bot] commitAndPRChangedRepos(error) 오류:', e.message); }
      try { tm.restoreNestedBranches(nestedPrepared); }
      catch (e) { console.error('[Bot] restoreNestedBranches(error) error:', e.message); }

      const allUrls = [reportUrl, ...multi.prs.map(p => p.url)].filter(Boolean);
      tm.updateTasklistEntry(pendingTask.taskId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        resultUrl: allUrls[0] || null,
      });
      refreshDashboardSafe('task-error'); // 에러 후에도 작업트리는 master 복귀 상태
      // giip issue 통일: 에러 → 코멘트 + REVIEW(사람 판단 대기)
      try {
        if (pendingTask.isn) {
          const gt = require('./giip-task');
          await gt.maybeFinish(channelId, pendingTask.isn, 'REVIEW', `❌ 작업 에러: ${err.message}${allUrls.length ? `\nPR(부분): ${allUrls.join(' , ')}` : ''}`);
        }
      } catch (e) { console.error('[Bot] giip finish(error) 훅 오류:', e.message); }

      const { prLines, skipLines, blockedLines } = renderRepoLines(reportUrl, multi);
      await postMessage(channelId, [
        `❌ *작업 에러* (\`${pendingTask.taskId}\`)${pendingTask.isn ? ` / giip #${pendingTask.isn}→REVIEW` : ''}: ${err.message}`,
        ...(prLines.length ? ['', '🔀 부분 결과:', ...prLines] : []),
        ...(blockedLines.length ? ['', ...blockedLines] : []),
        ...(skipLines.length ? ['', ...skipLines] : []),
      ].join('\n'), replyTs);

      // 에러여도 작업트리 락은 해제됨 → 대기열의 다음 태스크를 자동 기동.
      await drainNextQueued('task-error');
    },
  }, effWorkDir, execCtx);
}

// ── チャンネル Mention 処理 (Task ワークフロー) ───────────────────────────────
async function handleChannelMention({ channelId, ts, threadTs, text, workDir = BASE_DIR, projectName = null }) {
  const convKey = `${channelId}:${threadTs || ts}`;
  const replyTs = threadTs || ts;
  const taskState = loadJSON(TASK_STATE_FILE, { pending: {}, running: {} });

  // バッククォート・全角スペース等を除去してからコマンド判定
  const cmd = text.trim().replace(/`/g, '').replace(/\s+/g, ' ').toLowerCase();
  console.log(`[Bot] handleChannelMention cmd="${cmd}" convKey="${convKey}"`);

  // ── giip 커맨드 (giip api|issue|account) — giip issue 통일 (rule 39/40) ──
  try {
    const { handleGiipCommand } = require('./giip-commands');
    const gc = await handleGiipCommand(text.trim(), channelId);
    if (gc.handled) { await postMessage(channelId, gc.text, replyTs); return; }
  } catch (e) { console.error('[Bot] giip command error:', e.message); }

  // ── "issue 등록 <내용>" — 分類器を通さず明示的に giip issue として登録 ──────
  //   利用形: `<プロジェクト名> issue 등록 <内容>` / `이슈 등록 <内容>`
  //   （プロジェクト名は parseProjectPrefix で workDir に解決済み → text は接頭辞除去済み）
  //   既存の task 自動連携(giip-task.maybeCreateIssue)は変更せず、明示登録の即時経路のみ追加。
  //   区切り(空白 / コロン / 文字列末)を必須にして「issue 등록됐어?」等の質問誤爆を防ぐ
  //   （JS の \b は ASCII 専用でハングル境界を検出できないため明示的に区切りを要求）。
  //   선두 `giip ` 도 허용: `giip issue 등록 …` == `giipprj issue 등록 …` (사용자 요청).
  //   'giip' 는 projects/ 실폴더가 아니라 parseProjectPrefix 가 못 벗겨 workDir=BASE_DIR 로 남으므로
  //   아래에서 이 형태만 workDir 을 giipprj 로 고정해 분석(작업지시서) 경로를 동일하게 탄다.
  const issueTrigger = /^(?:giip\s+)?(?:issue|이슈|イシュー)\s*(?:등록|登録|register)(?:\s+|\s*[:：]\s*|$)/i;
  if (issueTrigger.test(text.trim())) {
    const body = text.trim().replace(issueTrigger, '').trim();
    // `giip issue 등록 …`(선두 giip) → giipprj 프로젝트 등록과 동일 처리하도록 workDir 고정.
    const effWorkDir = /^giip\s+/i.test(text.trim())
      ? path.join(config.PROJECTS_ROOT, 'giipprj')
      : workDir;
    if (!body) {
      await postMessage(channelId, '사용법: `<프로젝트> issue 등록 <내용>` — 내용을 그대로 giip issue 로 등록합니다.', replyTs);
      return;
    }
    const title = body.split(/\r?\n/)[0].slice(0, 200).trim() || '(무제)';
    try {
      const giipAccounts = require('./giip-accounts');
      const giip = require('./giip-api');
      const acct = giipAccounts.resolve(channelId);
      if (!acct) {
        await postMessage(channelId,
          '⚠️ giip 계정 미설정입니다. `giip account set <login_id> <sk> [csn]` 로 먼저 등록하세요(SK 포함이라 DM 권장).',
          replyTs);
        return;
      }
      // giipprj(giipprj 폴더) 는 의뢰를 그대로 넣지 않고, 분석해 '작업지시서' 수준으로 등록한다.
      //   무인 처리기(run-gissue-claude)의 refine([B]) 를 등록 시점에 앞당겨 수행하는 셈:
      //   raw 본문은 content 로, 분석된 작업지시서는 코멘트로 붙이고 status=READY 로 두면
      //   처리기 [C](READY + 지시서 코멘트)가 다음 :20/:40 에 바로 착수한다.
      const isGiipprj = /(^|[\\/])giipprj$/i.test(String(effWorkDir).replace(/[\\/]+$/, ''));
      if (isGiipprj) {
        await postMessage(channelId, '🔍 의뢰 내용을 분석해 작업지시서로 정리 중입니다... (수십 초 소요)', replyTs);
        let planContent = null;
        try { ({ planContent } = tm.analyzeRequest(body, null, effWorkDir)); }
        catch (e) { console.error('[Bot] issue 등록 분석 실패:', e.message); }

        const specTitle = ((planContent && tm.extractTitle(planContent)) || title).slice(0, 200);
        // create 는 항상 PENDING 으로(유실 방지). 분석 성공 시에만 작업지시서 코멘트 + READY 로 승격.
        // csn: projectName이 인식 안 되면 resolveProjectCsn은 null을 반환해야 한다(effWorkDir=BASE_DIR로
        // 조용히 폴백해 엉뚱한 csn으로 새는 사고 방지, issue #813/#821 재발). 이 블록은 isGiipprj일 때만
        // 도달하므로 명시적으로 47을 쓴다.
        const csnForCreate = isGiipprj ? 47 : config.resolveProjectCsn(projectName);
        const r = await giip.issueCreate(acct, { title: specTitle, content: body.slice(0, 8000), status: 'PENDING', csn: csnForCreate });
        const isn = r && r.isn ? Number(r.isn) : null;
        let promoted = false;
        if (isn && planContent) {
          try {
            await giip.issueComment(acct, isn, `📋 작업지시서 (봇 자동 분석)\n\n${planContent}`.slice(0, 8000));
            // read-modify-write(제목·본문 보존). [giip #1211] 상태전이 코멘트(PENDING -> READY)는
            // giip.issueUpdate 내부에서 항상 자동 등록된다(giip-api.js 참고).
            await giip.issueUpdate(acct, { isn, status: 'READY' }, { reason: '봇 자동 분석: 작업지시서 첨부 후 READY 승격' });
            promoted = true;
          } catch (e) { console.error('[Bot] issue 작업지시서 첨부 실패:', e.message); }
        }
        await postMessage(channelId,
          isn
            ? [
                `✅ giip issue #${isn} 등록 완료 (${promoted ? 'READY · 작업지시서 첨부 → 자동 처리 대기' : 'PENDING · 무인 refine 대기'})`,
                `• 제목: ${specTitle}`,
                ...(promoted ? ['', '```', planContent.slice(0, 1200), '```'] : []),
              ].join('\n')
            : '⚠️ issue 등록 응답에 isn 이 없습니다. 계정/CSN 설정을 확인하세요.',
          replyTs);
        return;
      }
      // 그 외 프로젝트: 의뢰를 그대로 PENDING 으로 등록(무인 처리기가 refine 부터 수행).
      //   IN_PROGRESS 로 만들면 PENDING/READY 만 집는 처리기의 사각지대에 빠져 '먹통'이 된다.
      const r = await giip.issueCreate(acct, { title, content: body.slice(0, 8000), status: 'PENDING', csn: config.resolveProjectCsn(projectName) });
      const isn = r && r.isn ? Number(r.isn) : null;
      await postMessage(channelId,
        isn
          ? `✅ giip issue #${isn} 등록 완료 (PENDING · 대기열 등록 → 자동 처리 대기)\n• 제목: ${title}`
          : '⚠️ issue 등록 응답에 isn 이 없습니다. 계정/CSN 설정을 확인하세요.',
        replyTs);
    } catch (e) {
      console.error('[Bot] issue 등록 실패:', e.message);
      await postMessage(channelId, `❌ issue 등록 실패: ${e.message}`, replyTs);
    }
    return;
  }

  // ── 내장 명령어 ─────────────────────────────────────────────────────────────
  if (cmd === '!help') {
    await postMessage(channelId, [
      '*giipclaude AI — 使い方*',
      '`@ボット名 <質問>` → その場で回答（曖昧な内容も質問扱い）',
      '`@ボット名 <作業依頼>` → Task 分析 → 確認 → 実行 → GitHub 結果 URL',
      '`@ボット名 タスク登録: <内容>` → 強制的に Task として登録',
      '`@ボット名 <プロジェクト名> task <内容>` / `<プロジェクト名> 태스크등록 <内容>` → 先頭が task/태스크등록 なら強制 Task 登録',
      '',
      '*Task 管理:*',
      '• `tasklist` — 待機中 Task 一覧',
      '• `tasklist all` — 全 Task 一覧 (完了・キャンセル含む)',
      '• `task7days` — 直近7日間の全 Task (完了・キャンセル含む／未処理・異常検知用)',
      '• `go` — 待機中 Task の一覧を表示',
      '• `go <Task番号>` — 指定した Task を実行',
      '• `cancel` — 待機中 Task の一覧を表示',
      '• `cancel <Task番号>` — 指定した Task をキャンセル',
      '• `머지완료 <Task番号>` — 선행 PR 머지 후, 보류(⏸️)된 Task 를 rebase→PR 로 재개',
      '• `taskmerge` — 未完了の重複タスクを検出（プレビュー） *別名: 중복 정리 / dedup / マージ*',
      '• `taskmerge go` — 重複タスクを統合（代表1件に集約し残りを取消）',
      '',
      '*ワークフロー:*',
      '• `<プロジェクト名> wflist` — そのプロジェクトの .agent/workflows 一覧',
      '• `<プロジェクト名> wflist <絞り込み語>` — 名前で絞り込み',
      '• `<プロジェクト名> wflist all` — 参考ドキュメントも表示',
      '• *ワークフロー実行* — 次のどの形でもOK（実行サブエージェント経路で走るので DB/スクリプトが権限に阻まれない）:',
      '    ‣ `<プロジェクト> workflow <名>` / `wf <名>` / `wfrun <名>` / `워크플로우 <名>`  （「워크플로우」が長い時は workflow / wf でOK）',
      '    ‣ `<プロジェクト> <名> 실행` / `<プロジェクト> /<名>` / `<プロジェクト> <名>`',
      '    例) `giipprj wf errorproc` = `giipprj errorproc 실행` = `giipprj /errorproc` = `giipprj workflow errorproc`',
      '    ※ 「<名> 실행」「<名>」の形は実在ワークフロー名と完全一致した時のみ実行（誤爆防止）',
      '',
      '*giip issue 連携:*',
      '• `giip account set <login_id> <sk> [csn]` — チャンネル連携（SK含むので DM 推奨）',
      '• `giip account show` — 現在の連携アカウント表示',
      '• `giip issue list [status]` — イシュー一覧',
      '• `giip issue get <isn>` — イシュー詳細',
      '• `giip issue new "<title>"` — イシュー新規作成',
      '• `giip issue done|review|progress <isn>` — ステータス変更',
      '• `giip issue comment <isn> <text>` — コメント追加',
      '• `giip project set <프로젝트명> <csn>` — プロジェクト名→CSN マッピング登録（`<프로젝트> issue 등록` 用）',
      '• `giip project list` / `giip project del <프로젝트명>` — マッピング一覧 / 削除',
      '• `giip api <Verb> [jsondata]` — 汎用 giip API 呼び出し',
      '',
      '*情報:*',
      '• `!issues` — GitHub Issue 一覧',
      '• `!klayer <キーワード>` — K-Layer 検索',
      '• `!help` — ヘルプ',
    ].join('\n'), replyTs);
    return;
  }
  if (cmd === '!issues' || cmd === '!issues refresh') {
    const issues = cmd.includes('refresh') ? await refreshIssues() : await getIssues();
    if (!issues.length) { await postMessage(channelId, 'GITHUB_TOKEN / GITHUB_REPO の設定を確認してください。', replyTs); return; }
    const lines = issues.map(i => `• #${i.number} ${i.title}`);
    await postMessage(channelId, `Issues (${issues.length}件) — ${getCacheAge()}\n${lines.join('\n')}`, replyTs);
    return;
  }
  if (cmd.startsWith('!klayer ')) {
    const kw = cmd.slice(8).trim();
    const claims = searchKLayer(kw);
    await postMessage(channelId, claims.length ? `K-Layer "${kw}":\n${claims.map(c=>`• ${c}`).join('\n')}` : `"${kw}" に関連する claim はありません`, replyTs);
    return;
  }

  // ── wflist — 指定プロジェクトの .agent/workflows 一覧 ──────────────────────
  //   使い方: `<プロジェクト名> wflist [絞り込み語|all]`
  //   プロジェクト名は parseProjectPrefix で workDir に解決済み。
  //   例: `giipprj wflist` → giipprj/.agent/workflows を一覧表示。
  //   `all` を付けると README 等の参考ドキュメントも表示。
  if (cmd === 'wflist' || cmd.startsWith('wflist ')) {
    const filter = cmd === 'wflist' ? '' : cmd.slice('wflist '.length).trim();
    const showAll = filter === 'all';
    const agentDir = getAgentDir(workDir);
    const wfDir = path.join(agentDir, 'workflows');
    const projName = path.basename(workDir);
    const usingFallback = !fs.existsSync(path.join(workDir, '.agent'));
    let files = [];
    try { files = fs.readdirSync(wfDir).filter(f => f.toLowerCase().endsWith('.md')); } catch { files = []; }
    if (!files.length) {
      await postMessage(channelId,
        `📂 \`${projName}\` の .agent/workflows にワークフローがありません。\n探索パス: \`${wfDir}\``,
        replyTs);
      return;
    }
    const isDoc = f => /^(readme|common_|scheduling|_)/i.test(f);
    const nameOf = f => f.replace(/\.md$/i, '');
    let wf = files.filter(f => !isDoc(f)).sort();
    const docs = files.filter(isDoc).sort();
    if (filter && !showAll) wf = wf.filter(f => f.toLowerCase().includes(filter));
    const header = usingFallback
      ? `📋 *\`${projName}\` に .agent が無いため既定(${path.basename(BASE_DIR)}/.agent)を表示* (${wf.length}件)`
      : `📋 *\`${projName}\` ワークフロー一覧* (${wf.length}件${filter && !showAll ? ` / 絞り込み: "${filter}"` : ''})`;
    const lines = wf.length ? wf.map(f => `• \`${nameOf(f)}\``) : ['(該当なし)'];
    if (showAll && docs.length) lines.push('', '_参考ドキュメント:_ ' + docs.map(f => `\`${nameOf(f)}\``).join(', '));
    await postMessage(channelId, `${header}\n${lines.join('\n')}`, replyTs);
    return;
  }

  // ── ワークフロー実行 — 指定ワークフローをサブエージェントで実行 ────────────────
  //   受け付ける言い回し（すべて実行サブエージェント経路 = --dangerously-skip-permissions）:
  //     明示形（keyword-first / slash）— 部分一致も許可:
  //       `<プロジェクト> 워크플로우 <名>` / `workflow <名>` / `wfrun <名>` / `wf <名>` / `/<名>`
  //       （「워크플로우」は長いので英語別名 workflow / wf / wfrun いずれも可）
  //     ゆるい形（name-first / 単語のみ）— 一般質問の誤爆を防ぐため .agent/workflows に
  //     完全一致する時だけ実行:
  //       `<プロジェクト> <名> 실행[해/해줘]` / `<名> 워크플로우 실행` / `<名> run|start` / `<名>`
  //   例: `giipprj errorproc 실행` / `giipprj /errorproc` → giipprj/.agent/workflows/errorproc.md を実行。
  //   なぜ必須か: DB照会等の .ps1 を含むワークフローは、この実行経路（権限スキップ）
  //   でしか非対話 Slack セッションの権限ポリシーを越えられない。Q&A経路(callClaude)は
  //   skip 権限が無いため必ずブロックされる。ワークフローは必ずここへ載せること。
  {
    let wfQuery = null, looseForm = false, mWf;
    if ((mWf = cmd.match(/^(?:wfrun|workflow|wf\s+run|wf|워크플로우\s*실행|워크플로우|워크플로)\s+(.+)$/))) {
      wfQuery = mWf[1];                                   // 明示: keyword-first (wfrun/workflow/wf/워크플로우)
    } else if ((mWf = cmd.match(/^\/([\w가-힣-]+)$/))) {
      wfQuery = mWf[1];                                   // 明示: slash-command "/name"
    } else if ((mWf = cmd.match(/^(.+?)\s*(?:워크플로우\s*)?(?:실행(?:\s*해\s*주세요|\s*해\s*줘|\s*해|\s*하기)?|run|start)$/))) {
      wfQuery = mWf[1]; looseForm = true;                 // ゆるい: "<name> 実行/실행/run"
    } else if (/^[\w가-힣-]+$/.test(cmd)) {
      wfQuery = cmd; looseForm = true;                    // ゆるい: 単語のみ "<name>"
    }

    if (wfQuery) {
      const query = wfQuery.trim().replace(/\.md$/i, '');
      const agentDir = getAgentDir(workDir);
      const wfDir = path.join(agentDir, 'workflows');
      const projName = path.basename(workDir);
      let files = [];
      try { files = fs.readdirSync(wfDir).filter(f => f.toLowerCase().endsWith('.md')); } catch { files = []; }
      const isDoc = f => /^(readme|common_|scheduling|_)/i.test(f);
      const candidates = files.filter(f => !isDoc(f));
      const nameOf = f => f.replace(/\.md$/i, '');
      const q = query.toLowerCase();
      let match = candidates.find(f => nameOf(f).toLowerCase() === q);
      // 明示形のみ部分一致を許可（ゆるい形は完全一致に限定して誤爆を防ぐ）
      if (!match && !looseForm) {
        const subs = candidates.filter(f => f.toLowerCase().includes(q));
        if (subs.length === 1) match = subs[0];
        else if (subs.length > 1) {
          await postMessage(channelId,
            `🔎 \`${query}\` に一致するワークフローが複数あります。1つに絞ってください:\n${subs.map(f => `• \`${nameOf(f)}\``).join('\n')}`,
            replyTs);
          return;
        }
      }
      // ゆるい形で未一致 → ワークフロー指示ではない。通常ルーティングへフォールスルー。
      if (!match && !looseForm) {
        const list = candidates.length ? candidates.map(f => `• \`${nameOf(f)}\``).join('\n') : '(なし)';
        await postMessage(channelId,
          `❓ \`${projName}\` に \`${query}\` というワークフローが見つかりません。\n利用可能:\n${list}\n\n一覧: \`${projName} wflist\``,
          replyTs);
        return;
      }
      if (match) {
      const wfPath = path.join(wfDir, match);
      const wfName = nameOf(match);
      let wfContent = '';
      try { wfContent = fs.readFileSync(wfPath, 'utf8'); }
      catch (e) { await postMessage(channelId, `⚠️ ワークフロー読み込み失敗: ${e.message}`, replyTs); return; }
      const relWf = path.relative(workDir, wfPath).replace(/\\/g, '/');
      const taskId = tm.getTimestampId();
      const planContent = [
        `# TASK: 워크플로우 실행 — ${wfName} (${projName})`,
        '',
        '## リクエスト内容',
        `プロジェクト \`${projName}\` のワークフロー \`${wfName}\` を定義どおり実行`,
        '',
        '## 実行方針',
        `- 対象ワークフロー定義: \`${relWf}\``,
        '- 下記「ワークフロー定義」を上から順に、記載どおり忠実に実行する。',
        '- 定義が他の roles/rules/skills/workflows を参照する場合、.agent 配下の該当ファイルを読んで従う。',
        '- ファイルを変更したら実行プロンプトの共通規則に従い即コミット＆push する。',
        '',
        '## ワークフロー定義（この内容を実行）',
        `===== BEGIN WORKFLOW: ${wfName} =====`,
        wfContent.trim(),
        `===== END WORKFLOW: ${wfName} =====`,
      ].join('\n');
      const taskFile = tm.createTaskFile(taskId, `[wfrun] ${projName}/${wfName}`, planContent, [wfPath]);
      const taskTitle = tm.extractTitle(planContent);
      const taskSummary = tm.extractSummary(planContent);
      taskState.pending[convKey] = { taskId, taskTitle, taskFile, requestText: `wfrun ${wfName}`, workDir };
      saveJSON(TASK_STATE_FILE, taskState);
      tm.addToTasklist(taskId, taskTitle, taskSummary, `wfrun ${wfName}`);
      await postMessage(channelId,
        `🚀 *ワークフロー実行*: \`${wfName}\` (プロジェクト \`${projName}\`)\nTask \`${taskId}\` として開始します。`,
        replyTs);
      await startTaskExecution(convKey, taskState.pending[convKey], channelId, replyTs, taskState, workDir);
      return;
      }
    }
  }

  // ── tasklist / tasklist all ────────────────────────────────────────────────
  if (cmd === 'tasklist' || cmd === 'tasklist all') {
    const showAll = cmd === 'tasklist all';
    const tasks = tm.getTasklistByStatus(showAll ? null : 'pending');
    if (tasks.length === 0) {
      await postMessage(channelId,
        showAll ? '記録された Task はありません。' : '待機中の Task はありません。\n全履歴は `tasklist all` で確認できます。',
        replyTs
      );
      return;
    }
    const lines = tasks.map(t => {
      const emoji = tm.statusEmoji(t.status);
      const date = t.createdAt ? t.createdAt.slice(0, 10) : '';
      const taskUrl = tm.getTaskFileUrl(t.taskId);
      const taskLink = taskUrl ? `\n     📁 ${taskUrl}` : '';
      const result = t.resultUrl ? `\n     📄 ${t.resultUrl}` : '';
      return `${emoji} \`${t.taskId}\` [${t.status}] ${date}\n     *${t.title}*\n     ${t.summary}${taskLink}${result}`;
    });
    const header = showAll
      ? `*全 Task 一覧 (${tasks.length}件)*`
      : `*待機中 Task 一覧 (${tasks.length}件)*`;
    await postLong(channelId, [header, '', ...lines].join('\n'), replyTs);
    return;
  }

  // ── task7days — 直近7日間の全 Task (完了・キャンセル含む) ─────────────────
  //   未処理・異常処理された Task を洗い出すため、期間内は全ステータスを列挙する
  if (cmd === 'task7days' || cmd === 'task 7days' || cmd === 'task7d' || cmd === 'tasklist 7days') {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - 7 * DAY_MS;
    const inWindow = (t) => {
      // createdAt / startedAt / completedAt のいずれかが直近7日以内なら対象
      const stamps = [t.createdAt, t.startedAt, t.completedAt]
        .filter(Boolean)
        .map(s => Date.parse(s))
        .filter(n => !isNaN(n));
      return stamps.some(n => n >= cutoff);
    };
    const tasks = tm.getTasklistByStatus(null)
      .filter(inWindow)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (tasks.length === 0) {
      await postMessage(channelId, '直近7日間に記録された Task はありません。', replyTs);
      return;
    }
    // ステータス別に件数を集計（未処理／異常検知の手がかりに）
    const counts = tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
    const summary = ['pending', 'running', 'completed', 'cancelled']
      .filter(s => counts[s])
      .map(s => `${tm.statusEmoji(s)} ${s} ${counts[s]}`)
      .join('  ');
    const lines = tasks.map(t => {
      const emoji = tm.statusEmoji(t.status);
      const date = t.createdAt ? t.createdAt.slice(0, 10) : '';
      const taskUrl = tm.getTaskFileUrl(t.taskId);
      const taskLink = taskUrl ? `\n     📁 ${taskUrl}` : '';
      const result = t.resultUrl ? `\n     📄 ${t.resultUrl}` : '';
      return `${emoji} \`${t.taskId}\` [${t.status}] ${date}\n     *${t.title}*\n     ${t.summary}${taskLink}${result}`;
    });
    const header = `*直近7日間の全 Task 一覧 (${tasks.length}件)*\n${summary}`;
    await postLong(channelId, [header, '', ...lines].join('\n'), replyTs);
    return;
  }

  // ── taskmerge — 未完了の重複タスクを検出・統合 ─────────────────────────────
  //   `taskmerge`           → プレビュー（何を統合するか表示のみ、変更なし）
  //   `taskmerge go/실행/apply` → 実際に統合（重複を survivor に集約し残りを取消）
  const mergeCmd = cmd.match(/^(?:taskmerge|task\s*merge|merge\s*tasks|dedupe?|dupes|duplicates|consolidate|중복\s*통합|중복\s*정리|중복\s*제거|중복\s*태스크|태스크\s*정리|중복\s*찾기|타스크\s*통합|머지|タスク統合|重複統合|重複整理|マージ)(?:\s+(go|실행|실행해|확정|apply|yes|ok|はい|実行|실시))?$/);
  if (mergeCmd) {
    const doApply = !!mergeCmd[1];
    const clusters = findDuplicatePendingClusters();
    if (clusters.length === 0) {
      await postMessage(channelId, '🔍 統合対象の重複した未完了タスクはありません。', replyTs);
      return;
    }

    if (!doApply) {
      // プレビュー（dry-run）
      const blocks = clusters.map((cl, i) => {
        const merged = cl.members.filter(m => m.taskId !== cl.survivor.taskId);
        return [
          `*グループ ${i + 1}* (${cl.members.length}件)`,
          `  ✅ 維持: \`${cl.survivor.taskId}\` — ${cl.survivor.title}`,
          ...merged.map(m => `  🚫 統合→取消: \`${m.taskId}\` — ${m.title}`),
        ].join('\n');
      });
      await postLong(channelId, [
        `*🔀 重複した未完了タスク ${clusters.length}グループを検出*`,
        '',
        ...blocks,
        '',
        '統合を実行するには: `taskmerge go`',
        '（維持タスクに重複要請を統合記録し、残りは cancel フォルダへ移動します。取消済みは復元可能です。）',
      ].join('\n'), replyTs);
      return;
    }

    // 実行
    const report = applyTaskMerge(clusters, taskState);
    saveJSON(TASK_STATE_FILE, taskState);
    await postLong(channelId, report, replyTs);
    return;
  }

  // ── 머지완료 <Task番号> — 선행 PR 머지 알림 → 보류했던 저장소를 rebase 후 PR ──────
  //   PR 충돌 게이트(commitAndPRChangedRepos)로 'blocked' 된 태스크를 재개한다.
  const mergedDone = cmd.match(/^(?:머지완료|머지됨|merge완료|merged)\s+(\d{14}|giip-\d{1,6})$/);
  if (mergedDone) {
    const targetId = mergedDone[1];
    const entry = tm.getTasklistByStatus(null).find(t => t.taskId === targetId);
    if (!entry || !Array.isArray(entry.blocked) || entry.blocked.length === 0) {
      await postMessage(channelId, `⚠️ \`${targetId}\` 는 보류(blocked) 상태가 아닙니다. \`tasklist all\` 로 상태를 확인하세요.`, replyTs);
      return;
    }
    await postMessage(channelId, `🔄 \`${targetId}\` 재개: 선행 PR 머지 반영(base pull→rebase) 후 PR 생성 중...`, replyTs);
    let res;
    try { res = tm.resumeBlockedTask(targetId, entry.title || targetId, entry.blocked); }
    catch (e) { await postMessage(channelId, `❌ 재개 실패: ${e.message}`, replyTs); return; }

    const lines = [];
    for (const p of (res.prs || [])) lines.push(`🔀 PR (${path.basename(p.repo)}): ${p.url}`);
    for (const s of (res.stillBlocked || [])) lines.push(`🚧 여전히 보류: ${path.basename(s.repo)} — ${s.reason}`);
    for (const f of (res.failed || [])) lines.push(`⚠️ 실패: ${path.basename(f.repo)} — ${f.reason}`);

    // 아직 해소 안 된 저장소(재-conflict/실패)만 blocked 로 남긴다.
    const unresolved = new Set([...(res.stillBlocked || []).map(s => s.repo), ...(res.failed || []).map(f => f.repo)]);
    const remainingBlocked = entry.blocked.filter(b => unresolved.has(b.repo));
    tm.updateTasklistEntry(targetId, {
      status: remainingBlocked.length ? 'blocked' : 'completed',
      completedAt: new Date().toISOString(),
      blocked: remainingBlocked.length ? remainingBlocked : undefined,
    });
    refreshDashboardSafe('task-resumed');
    await postMessage(channelId, [
      remainingBlocked.length ? `⏸️ *\`${targetId}\` 일부 재개*` : `✅ *\`${targetId}\` 재개 완료*`,
      ...(lines.length ? lines : ['(변경 없음)']),
      ...(remainingBlocked.length ? ['', '여전히 conflict/실패인 저장소는 수동 해소가 필요합니다. 해소 후 다시 `머지완료 ' + targetId + '`.'] : []),
    ].join('\n'), replyTs);
    return;
  }

  // ── cancel <Task番号> — スレッド不問でどこからでもキャンセル ──────────────
  const cancelWithId = cmd.match(/^(?:cancel|취소|キャンセル|中断)\s+(\d{14}|giip-\d{1,6})$/);
  if (cancelWithId) {
    const targetId = cancelWithId[1];
    const entry = Object.entries(taskState.pending || {}).find(([, t]) => t.taskId === targetId);
    if (entry) {
      const [key, task] = entry;
      delete taskState.pending[key];
      saveJSON(TASK_STATE_FILE, taskState);
      tm.updateTasklistEntry(targetId, { status: 'cancelled', completedAt: new Date().toISOString() });
      try { tm.cancelTaskFile(targetId); } catch {}
      refreshDashboardSafe('task-cancelled');
      await postMessage(channelId, `🚫 Task \`${targetId}\` をキャンセルしました。\n• ${task.taskTitle}`, replyTs);
    } else {
      const runEntry = Object.entries(taskState.running || {}).find(([, t]) => t.taskId === targetId);
      if (runEntry) {
        await postMessage(channelId, `⚠️ \`${targetId}\` は実行中のためキャンセルできません。`, replyTs);
      } else {
        // taskState にないが .agent/tasks/ ファイルがあればキャンセル
        const taskFilePath = path.join(AGENT_DIR, 'tasks', `${targetId}.md`);
        if (fs.existsSync(taskFilePath)) {
          try {
            const dest = tm.cancelTaskFile(targetId);
            tm.updateTasklistEntry(targetId, { status: 'cancelled', completedAt: new Date().toISOString() });
            refreshDashboardSafe('task-cancelled');
            await postMessage(channelId, `🚫 Task \`${targetId}\` をキャンセルしました。\n📁 移動先: \`${dest}\``, replyTs);
          } catch (err) {
            await postMessage(channelId, `⚠️ キャンセル失敗: ${err.message}`, replyTs);
          }
        } else {
          await postMessage(channelId, `⚠️ Task \`${targetId}\` が見つかりません。\n\`tasklist\` で一覧を確認してください。`, replyTs);
        }
      }
    }
    return;
  }

  // ── bare cancel — 待機中 Task の一覧を表示 ───────────────────────────────
  if (isCancelCmd(text)) {
    const allPending = Object.entries(taskState.pending || {});
    if (allPending.length === 0) {
      await postMessage(channelId, '待機中の Task はありません。', replyTs);
      return;
    }
    const lines = allPending.map(([, t]) => `• \`${t.taskId}\` — ${t.taskTitle}`);
    await postMessage(channelId, [
      `*待機中 Task 一覧 (${allPending.length}件)*`,
      ...lines,
      '',
      'キャンセルするには: `cancel <Task番号>`',
      '例: `cancel ' + allPending[0][1].taskId + '`',
    ].join('\n'), replyTs);
    return;
  }

  // ── go <Task番号> [追加指示] — スレッド不問で指定 Task を実行 ──────────────
  //   末尾に $ を張らず、`go <番号>` の後ろに続くテキストを「追加指示」として許容する。
  //   （旧: $ 固定 → コメント行を付けると bare go に落ちて Task 一覧が出るバグ）
  const goWithId = cmd.match(/^(?:go|start|실행|시작|진행|実行|開始)\s+(\d{14}|giip-\d{1,6})\b/);
  if (goWithId) {
    const targetId = goWithId[1];
    // go <番号> の後ろに続くテキスト = その Task への「追加指示」。原文 text から抽出し
    //   (大小文字/改行/한글 保持)、Task ファイルへの追記は tm.appendTaskNote に委譲する。
    const extraNote = text.trim()
      .replace(/^(?:go|start|실행|시작|진행|実行|開始)\s+(?:\d{14}|giip-\d{1,6})[ \t]*/i, '')
      .trim();
    const entry = Object.entries(taskState.pending || {}).find(([, t]) => t.taskId === targetId);
    if (!entry) {
      const runEntry = Object.entries(taskState.running || {}).find(([, t]) => t.taskId === targetId);
      if (runEntry) {
        await postMessage(channelId, `⚙️ \`${targetId}\` はすでに実行中です。`, replyTs);
        return;
      }
      // .task-state.json になくても .agent/tasks/{id}.md があれば実行
      const taskFileFallback = path.join(AGENT_DIR, 'tasks', `${targetId}.md`);
      if (fs.existsSync(taskFileFallback)) {
        const fc = fs.readFileSync(taskFileFallback, 'utf8');
        const titleMatch = fc.match(/^# TASK:\s*(.+)$/m);
        const taskTitle = titleMatch ? titleMatch[1].trim() : `タスク ${targetId}`;
        const pendingKeyNew = `${channelId}:${replyTs}`;
        taskState.pending[pendingKeyNew] = { taskId: targetId, taskTitle, taskFile: taskFileFallback, requestText: '', workDir };
        saveJSON(TASK_STATE_FILE, taskState);
        if (extraNote && tm.appendTaskNote(targetId, extraNote)) {
          await postMessage(channelId, `📎 追加指示 (${extraNote.length}字) を Task \`${targetId}\` に反映しました。`, replyTs);
        }
        await startTaskExecution(pendingKeyNew, taskState.pending[pendingKeyNew], channelId, replyTs, taskState, workDir);
      } else {
        const doneFile   = path.join(AGENT_DIR, 'tasks', 'done',   `${targetId}.md`);
        const cancelFile = path.join(AGENT_DIR, 'tasks', 'cancel', `${targetId}.md`);
        if (fs.existsSync(doneFile)) {
          await postMessage(channelId, `✅ Task \`${targetId}\` はすでに完了しています。\nファイル: \`.agent/tasks/done/${targetId}.md\``, replyTs);
        } else if (fs.existsSync(cancelFile)) {
          await postMessage(channelId, `🚫 Task \`${targetId}\` はキャンセル済みです。`, replyTs);
        } else {
          await postMessage(channelId, `⚠️ Task \`${targetId}\` が見つかりません。\n\`tasklist\` で一覧を確認してください。`, replyTs);
        }
      }
      return;
    }
    const [pendingKey, pendingTask] = entry;
    if (extraNote && tm.appendTaskNote(targetId, extraNote)) {
      await postMessage(channelId, `📎 追加指示 (${extraNote.length}字) を Task \`${targetId}\` に反映しました。`, replyTs);
    }
    await startTaskExecution(pendingKey, pendingTask, channelId, replyTs, taskState, workDir);
    return;
  }

  // ── bare go — 待機中 Task の一覧を表示 ──────────────────────────────────
  if (isGoCmd(text)) {
    const allPending = Object.entries(taskState.pending || {});
    if (allPending.length === 0) {
      await postMessage(channelId, '待機中の Task はありません。新しいリクエストを入力してください。', replyTs);
      return;
    }
    const lines = allPending.map(([, t]) => `• \`${t.taskId}\` — ${t.taskTitle}`);
    await postMessage(channelId, [
      `*待機中 Task 一覧 (${allPending.length}件)*`,
      ...lines,
      '',
      '実行するには: `go <Task番号>`',
      '例: `go ' + allPending[0][1].taskId + '`',
    ].join('\n'), replyTs);
    return;
  }

  // ── タスク番号による状況照会（14桁数字のみ or "status <14桁>"） ──────────
  const taskStatusMatch = text.trim().replace(/`/g, '').match(/^(?:status\s+)?(\d{14}|giip-\d{1,6})$/);
  if (taskStatusMatch) {
    const targetId = taskStatusMatch[1];
    const taskFile = path.join(AGENT_DIR, 'tasks', `${targetId}.md`);
    if (fs.existsSync(taskFile)) {
      const fc = fs.readFileSync(taskFile, 'utf8');
      const statusM = fc.match(/^status:\s*(.+)$/m);
      const requestM = fc.match(/^request:\s*"?([^\n"]{1,120})/m);
      const status = statusM ? statusM[1].trim() : '不明';
      const request = requestM ? requestM[1].trim() : '（内容なし）';
      const logMatch = fc.match(/## 進捗ログ([\s\S]*)/);
      const logLines = logMatch ? logMatch[1].trim().split('\n').filter(l => l.startsWith('|')).slice(-5).join('\n') : null;
      let reply = `*タスク \`${targetId}\` — 状況報告*\n• ステータス: ${status}\n• 内容: ${request}`;
      if (logLines) reply += `\n\n*進捗ログ（直近）:*\n${logLines}`;
      reply += `\n\n実行: \`go ${targetId}\` | キャンセル: \`cancel ${targetId}\``;
      await postMessage(channelId, reply, replyTs);
    } else {
      await postMessage(channelId, `⚠️ タスク \`${targetId}\` が見つかりません。`, replyTs);
    }
    return;
  }

  // ── push 失敗通知 → 全リポジトリ状況を自動チェック ──────────────────────
  if (isPushFailureNotice(text)) {
    await postLong(channelId, checkAllRepoStatus(), replyTs);
    return;
  }

  // ── 既存タスクIDへの言及 → 3分岐: 質問=回答 / 修正依頼=再実行 / ID単独=状態表示 ──
  //   注意: ここでの分類結果は下流の intent 判定でも再利用し、二重の classifyRequest 呼び出しを避ける。
  let preIntent = null;        // この分岐で確定した意図（下流で再分類しないため）
  let refTaskContext = '';     // 修正依頼時に本文へ付加する親タスク文脈
  let reuseTaskId = null;      // 既存タスクID言及の修正依頼 → 新規発給せずこのIDを更新する
  let linkedIsn = null;        // 既存 giip issue 番号への言及 → 新規 task/issue を作らず #NNN に紐付ける
  const mentionedIds = extractExistingTaskIds(text);
  if (mentionedIds.length > 0) {
    const targetId = mentionedIds[0];
    const activeFile = [
      path.join(AGENT_DIR, 'tasks', `${targetId}.md`),
      path.join(AGENT_DIR, 'tasks', 'done', `${targetId}.md`),
      path.join(AGENT_DIR, 'tasks', 'cancel', `${targetId}.md`),
    ].find(f => fs.existsSync(f));

    // テキストがタスクID単独（些末な語のみ）か、指示を含むかを判定
    const isOnlyId = text.trim().replace(/`/g, '').match(/^(\d{14}|\d{8}_[\w-]+|giip-\d{1,6})$/);
    if (isOnlyId) {
      // ① ID単独 → 状態表示のみ（新規タスクは作らない）
      if (activeFile) {
        const fc = fs.readFileSync(activeFile, 'utf8');
        const statusM = fc.match(/^status:\s*(.+)$/m);
        const requestM = fc.match(/^request:\s*"?([^\n"]{1,100})/m);
        const status = statusM ? statusM[1].trim() : '不明';
        const request = requestM ? requestM[1].trim() : '（内容なし）';
        await postMessage(channelId,
          `📌 タスク \`${targetId}\` 参照:\n• ステータス: ${status}\n• 内容: ${request}\n📁 ファイル: \`${activeFile}\`\n\n実行: \`go ${targetId}\` | キャンセル: \`cancel ${targetId}\``,
          replyTs
        );
      } else {
        await postMessage(channelId, `⚠️ タスク \`${targetId}\` が見つかりません。`, replyTs);
      }
      return;
    }

    // ID以外の指示を含む → 意図を判定（下流と共有するため preIntent に保持）
    preIntent = isForceTaskCmd(text) ? 'task' : await classifyRequest(text, workDir);
    if (preIntent === 'question') {
      // ② 質問 → その場で回答（タスクファイルのパスをコンテキストとして付加）
      const taskContext = activeFile
        ? `\n\n[参考] タスク ${targetId} のファイルパス: ${activeFile}`
        : '';
      await answerInChannel({ channelId, replyTs, text: text + taskContext, workDir, threadTs });
      return;
    }

    // ③ 修正・再実行依頼（task）→ 新規タスクは作らず、参照された既存タスクIDを更新する。
    //    （ユーザ指摘: タスク番号を指定した返信は、その番号のファイルに追記すべきで、
    //      別番号の新規ファイルを量産してはならない）
    if (activeFile) {
      reuseTaskId = targetId;
      refTaskContext = `\n\n[修正対象] このリクエストは既存タスク ${targetId}（${activeFile}）に対する修正/再実行依頼です。元タスクの内容・成果物を踏まえて対応してください。`;
      await postMessage(channelId,
        `🔧 タスク \`${targetId}\` への修正依頼として受け付けました。新規タスクは作らず、このタスクを更新します。`,
        replyTs
      );
    }
    // ここで return せず、下流の「タスク確定 → 分析 → 更新/作成」フローへ落とす
  }

  // ── 既存 giip issue 番号への言及 → 新規 task 番号/新規 issue を作らず #NNN に紐付けて処理 ──
  //   ユーザ指摘(D): issue 番号を指定して処理を頼んだのに新規 task 番号が発給され、さらに #610 のような
  //   二重 issue まで作られた。既存 issue があるなら実行単位を giip-<isn> に固定(冪等)し、下流の
  //   reuseTaskId 経路に載せて maybeCreateIssue(新規 issue 作成)をスキップ、#NNN へ紐付け・状態遷移する。
  //   `admin/giip-issues/609 처리해줘` / `giip issue #609 …` 等の URL・自然文経路を拾う(番号のみ get は giip-commands 側)。
  if (!reuseTaskId) {
    const isn = extractGiipIssueRef(text);
    if (isn) {
      const forcedGiip = isForceTaskCmd(text);
      const gIntent = forcedGiip ? 'task' : (preIntent || await classifyRequest(text, workDir));
      preIntent = gIntent; // 下流の再分類を避けるため確定意図を共有
      if (gIntent === 'task') {
        linkedIsn = isn;
        reuseTaskId = `giip-${isn}`;
        // DB(SSOT)에서 이슈 본문 + 전체 코멘트 이력을 가져와 재처리 컨텍스트로 주입한다.
        //   재처리 시점엔 로컬 태스크 파일이 done/ 이동·타 클론 처리로 없을 수 있으나, 코멘트 이력은
        //   DB 에 남아 있으므로 전체를 읽어 맥락을 이어가야 한다(사용자 지적). best-effort.
        let giipHistoryBlock = '';
        try {
          const hist = await require('./giip-task').fetchIssueHistory(channelId, isn);
          if (hist && hist.digest) giipHistoryBlock =
            `\n\n[DB에서 복원한 이슈 이력 — 아래 코멘트 히스토리를 시간순으로 모두 읽고 맥락을 반영해 처리하라]\n${hist.digest}`;
        } catch (e) { console.error('[Bot] giip 이슈 이력 조회 실패(비치명):', e.message); }
        refTaskContext = `\n\n[対象 giip issue] このリクエストは既存 giip issue #${isn} の処理依頼です。まず #${isn} の内容を確認し(giip issue get ${isn} 相当)、作業後は結果を #${isn} にコメントして状態遷移してください。新しい issue は作成しないこと。${giipHistoryBlock}`;
        await postMessage(channelId,
          forcedGiip
            // 「처리해줘」等の明示的命令形 = go と等価 → 分析後そのまま自動実行（go 不要）。
            ? `🔗 giip issue #${isn} の処理依頼として受け付けました。新規 issue/タスク番号は作らず、この issue に紐付けて *そのまま実行* します（\`go\` 不要）。`
            : `🔗 giip issue #${isn} への処理依頼として受け付けました。新規 issue/タスク番号は作らず、この issue に紐付けて実行します(実行: \`go giip-${isn}\`)。`,
          replyTs
        );
      }
    }
  }

  // ── 実行中チェック ────────────────────────────────────────────────────────
  const running = taskState.running[convKey];
  if (running) {
    await postMessage(channelId,
      `⚙️ \`${running.taskId}\` の作業が進行中です。完了次第、結果をお知らせします。`,
      replyTs
    );
    return;
  }

  // ── 意図を分類してルーティング ──────────────────────────────────────────────
  // 明示的タスク作成キーワードがあれば分類器をバイパスして強制 task 化する。
  // （質問形で始まる複合文の question 誤分類 → 番号未発給を防ぐ）
  const forcedTask = isForceTaskCmd(text);
  // preIntent（既存タスクID分岐で確定済み）があれば再分類せず流用する
  const intent = forcedTask ? 'task' : (preIntent || await classifyRequest(text, workDir));
  console.log(`[Bot] intent="${intent}"${forcedTask ? ' (forced)' : preIntent ? ' (reused)' : ''} text="${text.slice(0, 60)}"`);

  if (intent === 'question') {
    // 質問・曖昧 → その場で回答（スレッド内なら全文脈を渡す）
    await answerInChannel({ channelId, replyTs, text, workDir, threadTs });
    return;
  }

  // ── タスク確定 → 類似タスク自動クローズ → Task 分析 ──────────────────────
  // 同一内容の旧タスクを自動検出してクローズ（既存タスクID更新時はクローズしない）
  const similarTasks = reuseTaskId ? [] : findSimilarPendingTasks(text);
  let closedNotice = '';
  if (similarTasks.length > 0) {
    const closedLines = [];
    for (const old of similarTasks) {
      try { tm.cancelTaskFile(old.taskId); } catch {}
      Object.keys(taskState.pending).forEach(k => {
        if ((taskState.pending[k] || {}).taskId === old.taskId) delete taskState.pending[k];
      });
      tm.updateTasklistEntry(old.taskId, { status: 'cancelled', completedAt: new Date().toISOString() });
      closedLines.push(`• \`${old.taskId}\` — ${old.title.slice(0, 50)}`);
    }
    saveJSON(TASK_STATE_FILE, taskState);
    closedNotice = `\n\n⚠️ 同一内容の旧タスクを自動クローズしました:\n${closedLines.join('\n')}`;
  }

  await postMessage(channelId, '🔍 作業内容を分析中です...', replyTs);

  // 修正依頼（既存タスクID言及）の場合は親タスク文脈を本文に付加して分析・保存する
  const taskRequestText = text + refTaskContext;

  let planContent, filesRead;
  try {
    ({ planContent, filesRead } = tm.analyzeRequest(taskRequestText, null, workDir));
  } catch (err) {
    await postMessage(channelId, `分析エラー: ${err.message}`, replyTs);
    return;
  }

  const taskTitle = tm.extractTitle(planContent);
  const taskSummary = tm.extractSummary(planContent);

  // ── giip issue 통일(rule 40): 연결돼 있으면 issue 를 "먼저" 등록(PENDING)하고 그 번호(giip-<isn>)를
  //   태스크 ID 로 삼는다 → 한 작업 = ID 하나. 미연결/실패 시에만 로컬 타임스탬프로 폴백한다.
  //   (과거: 타임스탬프를 항상 먼저 발급하고 issue 를 그 위에 덧붙여 ID 두 개[타임스탬프+isn]가 생겼다)
  //   상태전이(IN_PROGRESS)는 분석이 아니라 실행 시작(startTaskExecution)에서만 한다.
  let giipIsn = null;
  let giipIssueError = null; // API 호출 자체가 실패한 경우의 사유(csn/계정 미설정과 구분해 사용자에게 알리기 위함)
  if (linkedIsn) {
    // 既存 issue 참조: 新規作成せず #linkedIsn を再利用(reuseTaskId は既に giip-<isn>)。
    giipIsn = linkedIsn;
  } else if (!reuseTaskId) {
    try {
      const gt = require('./giip-task');
      // csn 은 처음 언급한 프로젝트명(projectName, 폴더 없어도 해석) 기준(project-csn.json). 없으면 account.csn 폴백.
      // (과거 `|| workDir` 폴백은 미해석 시 workDir=BASE_DIR이 우연히 map의 자기 프로젝트명과 매치돼
      // 엉뚱한 csn으로 새는 버그였다 — issue #813/#821 원인, 제거)
      const res = await gt.maybeCreateIssue(channelId, taskTitle, planContent, config.resolveProjectCsn(projectName));
      giipIsn = res.isn;
      giipIssueError = res.error;
    } catch (e) { console.error('[Bot] giip issue 등록 훅 오류:', e.message); }
  }

  // ID 통일: 기존 태스크 갱신이면 그 ID, 신규+issue 등록 성공이면 giip-<isn>, 그 외엔 타임스탬프.
  const taskId = reuseTaskId || (giipIsn ? `giip-${giipIsn}` : tm.getTimestampId());
  const taskFile = reuseTaskId
    ? tm.updateTaskFile(taskId, taskRequestText, planContent, filesRead)
    : tm.createTaskFile(taskId, taskRequestText, planContent, filesRead);

  taskState.pending[convKey] = { taskId, taskTitle, taskFile, requestText: taskRequestText, workDir };
  if (giipIsn) taskState.pending[convKey].isn = giipIsn;
  saveJSON(TASK_STATE_FILE, taskState);
  if (reuseTaskId) {
    tm.updateTasklistEntry(taskId, { title: taskTitle, summary: taskSummary, status: 'pending', updatedAt: new Date().toISOString() });
  } else {
    tm.addToTasklist(taskId, taskTitle, taskSummary, taskRequestText);
  }
  refreshDashboardSafe('task-created'); // 대기 항목이 바로 대시보드에 뜨도록
  // giipIssueError 가 있으면 "csn/계정 미설정으로 조용히 로컬 폴백"이 아니라 API 호출이 실제로 실패한
  //   것이므로 사유를 노출한다(과거: 둘 다 같은 타임스탬프 ID 로만 보여 원인을 구분할 수 없었다).
  const isnLine = giipIsn
    ? `\n🔗 giip issue #${giipIsn}`
    : (giipIssueError ? `\n⚠️ giip issue 연동 실패(${giipIssueError}) — 로컬 태스크 번호로 진행합니다` : '');

  // 明示的命令形(처리/수정/구현…해줘 = isForceTaskCmd)は「実行の意思確定」= go と等価。
  //   分析後そのまま実行し、redundant な二度目の `go` を要求しない(ユーザ指摘の恒久対応)。
  //   曖昧・LLM 分類による task は従来どおり plan+go ゲートを維持する。
  const autoExec = forcedTask;
  const footer = autoExec
    ? `*🚀 明示的な依頼のため自動実行します（\`go\` 不要）。中断: \`cancel ${taskId}\`*`
    : `*実行: \`go ${taskId}\` / キャンセル: \`cancel ${taskId}\`*`;

  const headline = (reuseTaskId && !linkedIsn) ? 'Task 更新完了' : 'Task 分析完了';
  await postLong(channelId,
    `📋 *${headline}* (\`${taskId}\`)${isnLine}${closedNotice}\n\n${planContent}\n\n---\n${footer}`,
    replyTs
  );

  if (autoExec) {
    // pending → running へ即遷移して実行(go <id> と等価)。作業ツリー busy 時は
    //   startTaskExecution が pending に戻し「go で後ほど再実行」を案内する(直列実行は維持)。
    await startTaskExecution(convKey, taskState.pending[convKey], channelId, replyTs, taskState, workDir);
  }
}

// pending/running task があるスレッドかどうかを確認
function isActiveTaskThread(channelId, threadTs) {
  if (!threadTs) return false;
  const taskState = loadJSON(TASK_STATE_FILE, { pending: {}, running: {} });
  const convKey = `${channelId}:${threadTs}`;
  return !!(taskState.pending[convKey] || taskState.running[convKey]);
}

// ── メッセージ1件を処理 ───────────────────────────────────────────────────────
async function processMessage({ channelId, msg, isDM, conversations, threadTs }) {
  const effectiveThreadTs = threadTs || msg.thread_ts || null;
  const mentionsBot = config.getBotUserId() && msg.text.includes(`<@${config.getBotUserId()}>`);
  const isTaskReply = isActiveTaskThread(channelId, effectiveThreadTs);
  // giip-729: 채널에서는 "명시 멘션 + 활성 태스크 스레드"만 응답한다.
  // 과거의 isBotEngagedThread(7일간 봇이 한 번이라도 말한 스레드) 자동응답은
  // 봇이 참여했던 스레드의 사람들끼리의 일반 대화(무멘션)까지 개입하게 만들어 제거.
  // 활성 태스크(pending/running)의 후속 입력은 isTaskReply 로 계속 허용된다.

  const rawCleanText = msg.text
    .replace(/<@[A-Z0-9]+>/g, '')
    // Slack tel: link <tel:0120...|0120...> → 数字だけ残す（タスク番号が電話番号リンク化される対策）
    .replace(/<tel:(\d+)\|[^>]*>/g, '$1')
    .replace(/<tel:(\d+)>/g, '$1')
    // Slack URL形式 <https://url|表示テキスト> → URL本体だけ残す
    .replace(/<(https?:\/\/[^|>]+)\|[^>]*>/g, '$1')
    // Slack URL形式 <https://url> → URL本体だけ残す
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    // Slack装飾記号を除去 (*bold* → bold, _italic_ → italic)
    .replace(/[*_~]/g, '')
    .replace(/`/g, '')
    .trim();

  // プロジェクトプレフィックス検出: "giipprj 何か" → giipprj フォルダに切り替え
  //   さらにチャンネル固定マッピング(channel-project.json)を適用: 明示接頭辞が無ければ
  //   このチャンネルの既定プロジェクトへ workDir/projectName を固定する（task giip-724）。
  //   優先順位: 明示接頭辞(Rule 32) > チャンネル固定。cleanText は不変。
  const { workDir, cleanText, projectName } =
    config.applyChannelPin(channelId, parseProjectPrefix(rawCleanText));

  const hasFiles = msg.files && msg.files.length > 0;
  if (hasFiles && !cleanText) {
    if (mentionsBot || isTaskReply) {
      await postMessage(channelId, '画像やファイルのみのメッセージは処理できません。テキストで質問してください。', effectiveThreadTs || msg.ts);
    }
    return;
  }
  if (!cleanText) return;

  if (isDM) {
    await handleDM({ channelId, ts: msg.ts, threadTs: effectiveThreadTs, text: cleanText, conversations, workDir });
  } else if (mentionsBot || isTaskReply) {
    await handleChannelMention({ channelId, ts: msg.ts, threadTs: effectiveThreadTs, text: cleanText, workDir, projectName });
  }
}

// ── Socket Mode イベントハンドラ ─────────────────────────────────────────────
async function onSlackMessage(event, conversations) {
  // 다른 봇과는 대화 가능(giip-773 후속 지시, 2026-07-26) — 자기 자신이 보낸 메시지만 걸러 무한루프 방지.
  if ((event.bot_id && event.bot_id === config.getSelfBotId()) || event.subtype || !event.text) return;
  const isDM = event.channel_type === 'im';
  try {
    await processMessage({ channelId: event.channel, msg: event, isDM, conversations });
  } catch (err) {
    console.error('[Bot] processMessage error:', err.message);
  }
  saveJSON(HISTORY_FILE, conversations);
}

module.exports = {
  handleSimpleGitOp,
  answerInChannel,
  handleDM,
  startTaskExecution,
  drainNextQueued,     // index.js の起動/定期リカバリが凍結キューを解凍するために使う
  handleChannelMention,
  isActiveTaskThread,
  processMessage,
  onSlackMessage,
};
