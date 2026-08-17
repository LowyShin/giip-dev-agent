// claude-cli.js — claude CLI 呼び出し（非同期 spawn ラッパ + 認証 + callClaude）
// index.js から behavior-preserving で切り出し（ロジック変更なし）。

const { spawn } = require('child_process');
const accounts = require('./claude-accounts');
const minimax = require('./minimax-accounts');
const { getAgentDir, BASE_DIR, PROJECTS_ROOT } = require('./config');

// ── spawn → Promise 래퍼 (이벤트 루프 비차단) ────────────────────────────────
function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env || process.env, // 계정 라우팅: CLAUDE_CONFIG_DIR 주입용
      windowsHide: opts.windowsHide !== false, // 기본 true; false 명시 시 브라우저 팝업 허용
    });
    // opts.input 이 있으면 프롬프트를 argv 대신 stdin 으로 전달한다.
    // (긴 프롬프트를 커맨드라인에 실으면 Windows 길이 한계로 spawn ENAMETOOLONG 발생)
    if (opts.input != null && child.stdin) {
      child.stdin.on('error', () => {}); // 자식이 먼저 종료하면 EPIPE — 무시
      child.stdin.end(opts.input);
    }
    const stdout = [], stderr = [];
    if (child.stdout) child.stdout.on('data', d => stdout.push(d));
    if (child.stderr) child.stderr.on('data', d => stderr.push(d));
    let timer;
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill();
        const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT';
        reject(e);
      }, opts.timeout);
    }
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        status: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

// ── Claude 인증 상태 확인 (계정별 env) ─────────────────────────────────────────
async function isClaudeAuthed(env = process.env) {
  try {
    const r = await spawnAsync('claude', ['auth', 'status'], { timeout: 10000, env });
    return JSON.parse(r.stdout || '{}').loggedIn === true;
  } catch { return true; } // 확인 실패 시 인증됨으로 간주
}

// ── Claude 웹 재인증 (브라우저 팝업, 계정별) ───────────────────────────────────
async function reAuthClaude(account = null) {
  const label = account?.name || 'default';
  const email = account?.email || 'sample@example.com';
  console.log(`[Auth] claude(${label}) 인증 만료 감지 — 브라우저 인증 시작...`);
  try {
    const r = await spawnAsync('claude', ['auth', 'login', '--email', email], {
      timeout: 5 * 60 * 1000,
      windowsHide: false, // 브라우저가 열릴 수 있도록
      env: accounts.envFor(account),
    });
    const ok = r.status === 0;
    console.log(`[Auth] 재인증 ${ok ? '성공' : '실패'} (exit ${r.status})`);
    return ok;
  } catch (e) {
    console.log(`[Auth] 재인증 오류: ${e.message}`);
    return false;
  }
}

// ── claude CLI (비동기 — 이벤트 루프 비차단) ──────────────────────────────────
async function callClaude(prompt, workDir = BASE_DIR) {
  const agentDir = getAgentDir(workDir);
  const baseArgs = [
    '-p', // プロンプトは argv ではなく stdin で渡す（ENAMETOOLONG 回避）→ spawnAsync opts.input
    // callClaude は Q&A（answerInChannel / handleDM）専用。ファイル変更は
    // 管理タスク経路（tm.createTaskFile 等）でのみ行う。ここで書込系ツールを
    // 禁止し、質問に誤分類された作業依頼がサブエージェント経由で番号未発給の
    // ままファイルを作ってしまう事故を防ぐ。（variadic → 次フラグ --model で停止）
    '--disallowedTools', 'Write', 'Edit', 'NotebookEdit',
    // このbotはユーザー指示専用 → Q&A経路も権限プロンプト無しで全ツール素通し
    // (スクリプト/DB/読取すべて実行可、権限punt廃止)。書込系(Write/Edit/NotebookEdit)
    // だけは上のdisallowedToolsで無効のまま = 番号未発給のファイル作成事故だけ防ぐ。
    '--dangerously-skip-permissions',
    '--add-dir', workDir,        // プロジェクトディレクトリ (サンドボックスに明示追加)
    '--add-dir', agentDir,       // roles/rules/skills/workflows アクセス
    '--add-dir', PROJECTS_ROOT,  // 全プロジェクト横断アクセス
  ];
  // 우선순위(사용자 지정): MiniMax 먼저 시도 → 실패해야만 Claude 계정 풀로 폴백.
  let mmExhausted = false;
  const mm = minimax.resolve();
  if (mm) {
    console.log(`[Bot] MiniMax(${mm.model}) 로 실행(Q&A)`);
    const result = await spawnAsync('claude', [...baseArgs, '--model', mm.model], {
      cwd: workDir,
      timeout: 20 * 60 * 1000,
      env: minimax.envFor(mm),
      input: prompt,
    });
    if (result.status === 0) return (result.stdout || '').trim();
    const mmOut = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (minimax.isUsageLimit(mmOut)) minimax.noteUsageLimit();
    mmExhausted = true;
    console.log('[Bot] MiniMax 실패 → Claude 폴백으로 전환');
  }

  // 계정 라우팅: weight 비율대로 계정 선택 → 한도면 다음 계정, 인증 만료면 1회 재인증
  const maxTries = accounts.count() + 1; // 계정 수 + 인증 재시도 여유분
  let authRetried = false;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const acct = accounts.pickAccount();
    if (!acct) break; // 전 계정 쿨다운
    const env = accounts.envFor(acct);
    const args = [...baseArgs, '--model', 'claude-opus-4-8'];

    const result = await spawnAsync('claude', args, {
      cwd: workDir,
      timeout: 20 * 60 * 1000, // 20分
      env,
      input: prompt, // 프롬프트는 stdin 으로 (ENAMETOOLONG 회피)
    }); // ETIMEDOUT 등은 그대로 throw

    if (result.status === 0) return (result.stdout || '').trim();

    // 사용량 한도 → 해당 계정 쿨다운 후 다음 계정으로
    // 한도 메시지("You've hit your weekly limit ...")는 stderr가 아니라 stdout에
    // 찍히는 경우가 있어(giip-759) 두 스트림을 모두 확인한다.
    const combinedOut = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (accounts.isUsageLimit(combinedOut)) {
      accounts.noteUsageLimit(acct, combinedOut);
      continue;
    }
    // 그 외 실패 — 인증 만료 여부 확인 후 자동 재인증 (계정별 1회)
    if (!authRetried && !(await isClaudeAuthed(env))) {
      authRetried = true;
      const ok = await reAuthClaude(acct);
      if (!ok) throw new Error(`claude(${acct.name}) 인증 재시도 실패 — CLAUDE_CONFIG_DIR=${acct.dir || 'default'} 로 \`claude auth login\` 실행 필요`);
      continue;
    }
    throw new Error(`claude exit ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
  }

  if (mmExhausted) throw new Error('claude 호출 실패 — MiniMax + Claude 전 계정/재시도 소진');

  throw new Error('claude 호출 실패 — 모든 계정/재시도 소진');
}

module.exports = { spawnAsync, isClaudeAuthed, reAuthClaude, callClaude };
