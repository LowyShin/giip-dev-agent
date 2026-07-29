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
const minimax = require('./minimax-accounts');
const { SocketModeClient } = require('@slack/socket-mode');

// ── 機能別モジュール (index.js から behavior-preserving で切り出し) ───────────
const config = require('./config');
const { BOT_TOKEN, CHANNEL_IDS, SLACK_APP_TOKEN, AGENT_DIR, HISTORY_FILE, TASK_STATE_FILE } = config;
const { loadJSON, saveJSON, isBotEngagedThread } = require('./state');
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
    // 크래시(소켓 self-heal exit 등) 후 pending 복귀 시점에, 실행이 실제로 시작됐었다면
    // (prepareNestedBranches 로 nested repo 가 bot/task-<id> 에 남아있을 수 있음) 안전하게
    // 회수를 시도하고, 연관 giip issue 가 있으면 무슨 일이 있었는지 note 코멘트로 남긴다
    // (2026-07-28: "IN_PROGRESS 전이 전 크래시 → 아무 흔적도 안 남는" 갭 메움).
    if (resolution === 'pending' && key) {
      const entry = taskState.running[key];
      const isn = entry && entry.isn;
      const entryWorkDir = entry && entry.workDir;
      if (entryWorkDir) {
        try {
          const { restored, stranded } = tm.reclaimCrashedTaskBranches(entryWorkDir, taskId);
          if (restored.length || stranded.length) {
            console.log(`[Bot] reconcile: ${taskId} 크래시 회수 — 자동복원 ${restored.length}건, stranded ${stranded.length}건`);
          }
          if (isn) {
            const channelId = key.split(':')[0];
            const lines = [
              `[WARN] 이전 처리 시도가 봇 재시작(소켓 끊김 등 self-heal exit)으로 중단되어 PENDING으로 복귀했습니다.`,
              `실행이 시작된 뒤 완료되지 못해 이 issue 는 IN_PROGRESS 로 전이되지 못했습니다(정상 — 실행 안 되는데 IN_PROGRESS로 보이는 모순 방지).`,
            ];
            if (restored.length) lines.push(`자동 복원된 저장소(취소분 정리): ${restored.map(r => path.basename(r)).join(', ')}`);
            if (stranded.length) lines.push(`⚠️ 미커밋 변경이 남아 자동 복원하지 못한 저장소(확인 필요): ${stranded.map(r => path.basename(r)).join(', ')}`);
            lines.push(`재개하려면: \`go ${taskId}\``);
            require('./giip-task').maybeComment(channelId, isn, lines.join('\n')).catch(() => {});
          }
        } catch (e) {
          console.error(`[Bot] reconcile: ${taskId} 크래시 회수 오류:`, e.message);
        }
      }
    }
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
  // 実行エンジン優先順位を起動時に明示する。MINIMAX_API_KEY 未設定だと MiniMax は
  // 黙って skip され全部 Claude に流れるため（設定漏れが無症状になる）、ここで可視化する。
  const mmBoot = minimax.resolve();
  console.log(mmBoot
    ? `[Bot] 実行エンジン: MiniMax(${mmBoot.model}) 優先 → 失敗時 Claude フォールバック`
    : '[Bot] 実行エンジン: Claude のみ (MINIMAX_API_KEY 未設定 → MiniMax スキップ)');

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

  // 화이트리스트 접근 제어: 설정된 경우 등록되지 않은 사용자의 입력은 무시(Silent Drop)
  const isAllowedUser = (userId) => {
    if (!userId) return false;
    if (config.ALLOWED_USERS.length === 0) return true;
    return config.ALLOWED_USERS.includes(userId);
  };

  // 채널 화이트리스트: 설정된 경우 등록되지 않은 채널의 입력은 무시(DM은 항상 허용, CHANNEL_IDS 무관).
  const isAllowedChannel = (channelId) => {
    if (config.CHANNEL_IDS.length === 0) return true;
    return config.CHANNEL_IDS.includes(channelId);
  };

  // チャンネルでの @mention (app_mention イベント)
  socketClient.on('app_mention', async ({ event, ack }) => {
    await safeAck(ack);
    if (!isAllowedUser(event.user)) return; // 발신자 검증
    if (!isAllowedChannel(event.channel)) return; // 채널 검증
    console.log('[Bot] app_mention:', event.channel, (event.text || '').slice(0, 60));
    await onSlackMessage(event, conversations);
  });

  // DM・スレッド返信 (message イベント — message.im / message.channels 購読時)
  // @mention を含むチャンネルメッセージは app_mention で処理済みのためスキップ
  // giip-773 の意図は「自分が(他ボットと並んで)メンションされたら答える」であって
  // 「自分宛でなくても(他ボット宛/無メンションの雑談でも)反応する」ことではない。
  // 元の実装は「自分宛メンションでなければ全部処理」になっており、同一チャンネルに同居する
  // 別ボット宛のメッセージにまで反応して誤ったタスクを実行する事故につながる。
  // 修正: 自分宛メンション(app_mention 側で処理済み)以外は、自分が既に関与したスレッドの
  // 続きだけを処理する。
  socketClient.on('message', async ({ event, ack }) => {
    await safeAck(ack);
    if (!isAllowedUser(event.user)) return; // 발신자 검증
    if (!isAllowedChannel(event.channel)) return; // 채널 검증
    const isDM = event.channel_type === 'im';
    const mentionsBot = config.getBotUserId() && (event.text || '').includes(`<@${config.getBotUserId()}>`);
    if (!isDM) {
      if (mentionsBot) return; // app_mention ハンドラで処理済み — 重複スキップ
      if (!isBotEngagedThread(event.channel, event.thread_ts)) return; // 미관여 채널 발화는 무시
    }
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
