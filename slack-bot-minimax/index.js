/**
 * giipclaude Bot — Task workflow mode
 *
 * 채널 mention 흐름:
 *   1. mention 수신 → claude 로 TASK 파일 분석/생성 → Slack에 확인 요청
 *   2. 사용자 "시작/go" → subagent (claude -p) 실행
 *   3. 완료 → 결과 doc git push → GitHub URL을 Slack에 보고
 *
 * DM:
 *   일반 Q&A 대화 (claude -p)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tm = require('./task-manager');
const { SocketModeClient } = require('@slack/socket-mode');

// ── 機能別モジュール (index.js から behavior-preserving で切り出し) ───────────
const config = require('./config');
const { BOT_TOKEN, CHANNEL_IDS, SLACK_APP_TOKEN, AGENT_DIR, HISTORY_FILE, TASK_STATE_FILE } = config;
const { loadJSON, saveJSON } = require('./state');
const { slackGet } = require('./slack-api');
const { onSlackMessage, drainNextQueued } = require('./handlers');

// ── 重複プロセス検出・自己終了 ───────────────────────────────────────────────
function killDuplicateBots() {
  const myPid = process.pid;
  const result = spawnSync('powershell', [
    '-NonInteractive', '-NoProfile', '-Command',
    `Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*index.js*' } | Select-Object -ExpandProperty ProcessId`,
  ], { encoding: 'utf8', timeout: 6000, windowsHide: true });

  if (result.error) return;

  const otherPids = (result.stdout || '')
    .split(/\r?\n/)
    .map(l => parseInt(l.trim(), 10))
    .filter(p => !isNaN(p) && p !== myPid);

  if (otherPids.length === 0) return;

  console.log(`[Bot] 重複インスタンス検出: PID ${otherPids.join(', ')} → 終了します`);
  otherPids.forEach(p => {
    spawnSync('taskkill', ['/F', '/PID', String(p)], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  });
}

// ── stale タスク状態のクリーンアップ（起動時 + 定期実行） ─────────────────────
// running のまま滞留したタスクを実ファイルの位置と経過時間で最終化する。
// 判定ソース = tasklist.json の running + .task-state.json の running（ライブロック）。
//   - done/   にファイルあり → completed（resultUrl 付与）
//   - cancel/ にファイルあり → cancelled（resultUrl 付与）
//   - どちらでもない（tasks/ 直下に残る or 消失）＝ 中断された未完了タスク:
//       経過が staleMinutes 以上なら pending へ復帰（再実行待ち）、未満なら実行中の可能性ありとして触らない。
//
// staleMinutes:
//   0  … 起動時。再起動直後の running は全て孤児（サブプロセスは死んでいる）→ 即 reconcile。
//   30 … 定期実行。生きている実行を巻き込まないよう 30 分以上経過したものだけ pending 復帰。
function reconcileTaskState({ staleMinutes = 0 } = {}) {
  const taskState = loadJSON(TASK_STATE_FILE, { pending: {}, running: {} });
  const TASKS_DIR = path.join(AGENT_DIR, 'tasks');
  const nowMs = Date.now();
  let stateChanged = false;

  // ── pending 스윕(신규) ────────────────────────────────────────────────────
  // reconcile 은 원래 running 만 청소해 pending 은 무한 누적됐다(orphan). 세션·수동
  // 처리 등 다른 경로로 이미 해소돼 task 파일이 done/·cancel/ 로 이동된 pending 항목을
  // 여기서 정리한다. 파일이 tasks/ 직하에 남은 = 진짜 미착수 backlog 는 건드리지 않는다
  // (마커 없는 pending = 수동 `go` 대기라는 drainNextQueued 설계를 존중).
  const isResolved = (tid) =>
    fs.existsSync(path.join(TASKS_DIR, 'done', `${tid}.md`)) ||
    fs.existsSync(path.join(TASKS_DIR, 'cancel', `${tid}.md`));
  for (const [key, entry] of Object.entries(taskState.pending || {})) {
    if (entry && entry.taskId && isResolved(entry.taskId)) {
      delete taskState.pending[key];
      stateChanged = true;
      console.log(`[Bot] reconcile: stale pending ${entry.taskId} 제거 (done/cancel 로 이미 해소)`);
    }
  }

  // taskId → .task-state.running のキー（ライブロック除去用）
  const runningKeyByTaskId = {};
  for (const [key, entry] of Object.entries(taskState.running || {})) {
    if (entry && entry.taskId) runningKeyByTaskId[entry.taskId] = key;
  }

  // 対象 = tasklist.json の running ∪ .task-state.json の running（片方漏れ対策）
  const runningList = tm.getTasklistByStatus('running');
  const startedAtByTaskId = {};
  const runningTaskIds = new Set();
  for (const t of runningList) {
    runningTaskIds.add(t.taskId);
    startedAtByTaskId[t.taskId] = t.startedAt || null;
  }
  for (const [taskId, key] of Object.entries(runningKeyByTaskId)) {
    runningTaskIds.add(taskId);
    if (!(taskId in startedAtByTaskId)) {
      const e = taskState.running[key];
      startedAtByTaskId[taskId] = (e && e.startedAt) || null;
    }
  }
  if (!runningTaskIds.size) { if (stateChanged) saveJSON(TASK_STATE_FILE, taskState); return; }

  for (const taskId of runningTaskIds) {
    const inDone   = fs.existsSync(path.join(TASKS_DIR, 'done',   `${taskId}.md`));
    const inCancel = fs.existsSync(path.join(TASKS_DIR, 'cancel', `${taskId}.md`));

    let resolution;
    if (inDone) {
      resolution = 'completed';
    } else if (inCancel) {
      resolution = 'cancelled';
    } else {
      // tasks/ 直下に残る or 消失 = 中断された未完了。経過時間で pending 復帰を判断。
      const started = startedAtByTaskId[taskId] ? Date.parse(startedAtByTaskId[taskId]) : NaN;
      const ageMin = isNaN(started) ? Infinity : (nowMs - started) / 60000;
      if (ageMin < staleMinutes) continue; // まだ実行中の可能性 → 触らない
      resolution = 'pending';
    }

    if (resolution === 'completed' || resolution === 'cancelled') {
      tm.updateTasklistEntry(taskId, {
        status: resolution,
        completedAt: new Date().toISOString(),
        resultUrl: tm.getTaskFileUrl(taskId) || null,
      });
    } else { // pending 復帰
      tm.updateTasklistEntry(taskId, { status: 'pending', startedAt: null, completedAt: null });
    }

    const key = runningKeyByTaskId[taskId];
    if (key && taskState.running[key]) {
      delete taskState.running[key];
      stateChanged = true;
    }
    console.log(
      `[Bot] reconcile: task ${taskId} → ${resolution}` +
      (resolution === 'pending' ? ` (running ${staleMinutes}m+ 정체 → 재실행 대기)` : '')
    );
  }

  if (stateChanged) saveJSON(TASK_STATE_FILE, taskState);
}

// ── 凍結キューのリカバリ（ghost-occupier freeze 対策） ────────────────────────
// 直列実行のため、他タスクが作業ツリーを占有中に来たタスクは pending に
// `queuedBehind` マーカ付きで積まれ、占有タスクの onComplete/onError が
// drainNextQueued を呼んで初めて自動起動する。ところが占有タスク実行中にボットが
// 再起動すると、そのサブプロセスは死に onComplete が永遠に発火しない＝
// queuedBehind の待機タスクは誰にも起動されず「凍結」する（ユーザ報告の“멈춤”の主因）。
// running が空なのに queuedBehind 待機タスクがある＝この凍結状態なので、ここで一度
// drainNextQueued を叩いて直列キューを解凍する。running が生きていれば通常経路に任せる。
async function recoverQueuedOnStartup(reason = 'startup-recovery') {
  try {
    const ts = loadJSON(TASK_STATE_FILE, { pending: {}, running: {} });
    if (Object.keys(ts.running || {}).length > 0) return; // 実行中 → 通常の drain 経路が処理
    const queued = Object.values(ts.pending || {}).filter(t => t && t.queuedBehind);
    if (!queued.length) return;
    console.log(`[Bot] ${reason}: 凍結された待機タスク ${queued.length}件 감지 → drain 시도`);
    await drainNextQueued(reason);
  } catch (e) {
    console.error('[Bot] recoverQueuedOnStartup error:', e.message);
  }
}

// ── 起動 ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!BOT_TOKEN) { console.error('[Bot] SLACK_BOT_TOKEN が .env にありません'); process.exit(1); }
  if (!SLACK_APP_TOKEN) { console.error('[Bot] SLACK_APP_TOKEN が .env にありません'); process.exit(1); }

  const ver = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (ver.error) { console.error('[Bot] claude CLI が見つかりません (PATH 確認)'); process.exit(1); }

  const auth = await slackGet('auth.test');
  if (!auth.ok) { console.error('[Bot] SLACK_BOT_TOKEN 無効:', auth.error); process.exit(1); }
  config.setBotUserId(auth.user_id);
  config.setSelfBotId(auth.bot_id || null);

  console.log('[giipclaude Bot] 起動 — Socket Mode');
  console.log(`[Bot] ID: ${config.getBotUserId()} (${auth.user}) PID: ${process.pid}`);
  console.log(`[Bot] 監視チャンネル: ${CHANNEL_IDS.join(', ') || '(DM のみ)'}`);

  killDuplicateBots();
  // 起動時: 再起動で孤児化した running を即 reconcile（サブプロセスは既に死亡）
  reconcileTaskState({ staleMinutes: 0 });
  // 起動時: 占有タスクの死で凍結した queuedBehind 待機タスクを解凍（ghost-occupier freeze）
  await recoverQueuedOnStartup('startup-recovery');

  // 定期 reconcile: 30分以上 running のまま滞留したタスクを最終化 or pending 復帰。
  // reconcileTaskState() が「루트에 남은 running」を拾えず再起動しても自動復旧しなかった空白を埋める。
  const RECONCILE_INTERVAL_MS = 10 * 60 * 1000; // 10分ごと
  const RECONCILE_STALE_MIN = 30;               // 30分以上経過した running が対象
  setInterval(() => {
    try {
      reconcileTaskState({ staleMinutes: RECONCILE_STALE_MIN });
      // reconcile で running が空になった直後にも凍結キューが残りうるので続けて解凍を試みる。
      recoverQueuedOnStartup('periodic-recovery').catch(() => {});
    } catch (e) {
      console.error('[Bot] periodic reconcile error:', e.message);
    }
  }, RECONCILE_INTERVAL_MS);

  const conversations = loadJSON(HISTORY_FILE, {});

  const socketClient = new SocketModeClient({
    appToken: SLACK_APP_TOKEN,
    clientPingTimeout: 10000,  // 10s
    serverPingTimeout: 60000,  // 1min
  });

  // ---- Self-healing watchdog (event-driven, zero polling) -----------------
  // The process can stay "online" while the Slack WebSocket silently dies
  // (ping/pong timeouts -> "no active connection"); pm2 cannot detect that
  // because the process itself is alive. We exit(1) on a confirmed dead/stuck
  // socket so pm2 restarts us with a fresh connection.
  const RECONNECT_GRACE_MS = 120 * 1000; // must recover within 2min of losing the socket
  const ACK_FAIL_LIMIT = 6;              // consecutive ack failures => socket is stuck
  let ackFailStreak = 0;
  let reconnectTimer = null;
  const dieAndRestart = (why) => {
    console.error(`[Bot] self-heal: ${why}. Exiting so pm2 restarts.`);
    process.exit(1);
  };
  const markAlive = () => {
    ackFailStreak = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  const armReconnectWatch = (evt) => {
    if (reconnectTimer) return;
    console.warn(`[Bot] socket '${evt}' — must recover within ${RECONNECT_GRACE_MS / 1000}s...`);
    reconnectTimer = setTimeout(() => dieAndRestart(`no reconnect after '${evt}'`), RECONNECT_GRACE_MS);
  };
  // Losing the socket arms a grace timer; recovering (or any inbound frame) clears it.
  ['disconnecting', 'disconnected', 'reconnecting'].forEach(ev => socketClient.on(ev, () => armReconnectWatch(ev)));
  ['connected', 'authenticated'].forEach(ev => socketClient.on(ev, markAlive));

  const safeAck = async (ack) => {
    try {
      await ack();
      markAlive();
    } catch (e) {
      ackFailStreak++;
      console.warn(`[Bot] ack failed (${ackFailStreak}/${ACK_FAIL_LIMIT}):`, e.message);
      if (ackFailStreak >= ACK_FAIL_LIMIT) dieAndRestart('too many consecutive ack failures (socket stuck)');
    }
  };

  // チャンネルでの @mention (app_mention イベント)
  socketClient.on('app_mention', async ({ event, ack }) => {
    await safeAck(ack);
    console.log('[Bot] app_mention:', event.channel, (event.text || '').slice(0, 60));
    await onSlackMessage(event, conversations);
  });

  // DM・スレッド返信 (message イベント — message.im / message.channels 購読時)
  // @mention を含むチャンネルメッセージは app_mention で処理済みのためスキップ
  socketClient.on('message', async ({ event, ack }) => {
    await safeAck(ack);
    const isDM = event.channel_type === 'im';
    const mentionsBot = config.getBotUserId() && (event.text || '').includes(`<@${config.getBotUserId()}>`);
    if (!isDM && mentionsBot) return; // app_mention ハンドラで処理済み — 重複スキップ
    console.log('[Bot] message:', event.channel_type, (event.text || '').slice(0, 60));
    await onSlackMessage(event, conversations);
  });

  // 全WebSocketメッセージをデバッグログ
  socketClient.on('ws_message', (data) => {
    // NOTE: do NOT markAlive() here. Inbound frames only prove we can RECEIVE.
    // The failure mode is a half-open socket that receives but cannot SEND (ack),
    // so liveness must be confirmed by a successful ack or a 'connected' event only.
    try {
      const p = JSON.parse(data.toString());
      if (p.type !== 'hello' && p.type !== 'disconnect') {
        console.log('[Debug ws]', p.type, p.payload?.event?.type || '', p.payload?.event?.channel_type || '');
      }
    } catch {}
  });

  socketClient.on('error', (error) => {
    console.error('[Bot] Socket Mode error:', error.message || error);
  });

  await socketClient.start();
  console.log('[Bot] Socket Mode 接続完了 — イベント待機中');
}

if (require.main === module) {
  main().catch(err => { console.error('[Bot] Fatal:', err); process.exit(1); });
}
