/**
 * config.js — 共有定数・プロジェクトパス解決・botUserId アクセサ
 *
 * index.js から behavior-preserving に切り出したモジュール。
 * 定数の計算式は index.js のものをそのまま踏襲する。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── 設定 ─────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_IDS = (process.env.SLACK_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// SLACK_ALLOWED_USERS: Slack user ID whitelist (comma-separated). Empty = allow everyone.
const ALLOWED_USERS = (process.env.SLACK_ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

const BOT_NAME        = process.env.BOT_NAME || 'giipclaude Bot'; // Slack 표시용 봇 이름 (BOT_NAME 환경변수로 변경 가능)
// WORKSPACE_DIR: 기본 작업 폴더(.agent 위치 / git push 대상). 미설정 시 slack-bot 상위 폴더로 자동 결정.
const BASE_DIR        = process.env.WORKSPACE_DIR ? path.resolve(process.env.WORKSPACE_DIR) : path.join(__dirname, '..');
// PROJECTS_ROOT: 여러 프로젝트의 상위 폴더(프로젝트 프리픽스 전환용). 미설정 시 BASE_DIR의 상위 폴더.
const PROJECTS_ROOT   = process.env.PROJECTS_ROOT || path.dirname(BASE_DIR);
const AGENT_DIR       = path.join(BASE_DIR, '.agent');           // 기본 .agent (BASE_DIR/.agent)
const HISTORY_FILE    = path.join(__dirname, '.conversations.json');
const TASK_STATE_FILE = path.join(__dirname, '.task-state.json');
const BOT_THREADS_FILE = path.join(__dirname, '.bot-threads.json');
const PROJECT_CSN_FILE = path.join(__dirname, 'project-csn.json');
const CHANNEL_PROJECT_FILE = path.join(__dirname, 'channel-project.json');

// ── botUserId (main() で auth.test 後にセット、processMessage / socket handler で参照) ──
let botUserId = null;
function getBotUserId() { return botUserId; }
function setBotUserId(id) { botUserId = id; }

// selfBotId: bot-to-bot conversation support — used to filter out the bot's own
// messages (by bot_id) so it doesn't reply to itself in an infinite loop.
let selfBotId = null;
function getSelfBotId() { return selfBotId; }
function setSelfBotId(id) { selfBotId = id; }

// ── プロジェクトの .agent ディレクトリを解決 ─────────────────────────────────
// workDir 内に .agent があればそれを使い、なければ BASE_DIR/.agent にフォールバック
function getAgentDir(workDir) {
  const d = path.join(workDir, '.agent');
  return fs.existsSync(d) ? d : AGENT_DIR;
}

// ── プロジェクトプレフィックス検出 ────────────────────────────────────────────
// メッセージの先頭がプロジェクト名（PROJECTS_ROOT 直下のフォルダ名）なら
// そのフォルダを workDir として返し、プレフィックスを除去した本文を返す
function parseProjectPrefix(text) {
  const words = text.trim().split(/\s+/);
  if (words.length < 1) return { workDir: BASE_DIR, cleanText: text, projectName: null };
  // 助詞・接尾語を除去してプロジェクト名を抽出 (giipprj에서 → giipprj)
  const raw = words[0];
  const candidate = raw.toLowerCase().replace(/(에서|에서는|에서도|에서만|에게서|한테서|의|에|는|이|가|를|을|로|으로|와|과|도|만|까지|부터|처럼|라고|이라고|에서라도|에도)$/u, '');
  const projectDir = path.join(PROJECTS_ROOT, candidate);
  // 認識したプレフィックス（助詞含む）を除いた本文を返すヘルパ
  const stripPrefix = () => {
    const suffix = raw.slice(candidate.length); // 除去した助詞部分
    const rest = suffix ? [suffix, ...words.slice(1)] : words.slice(1);
    return rest.join(' ').trim() || text;
  };
  try {
    if (fs.statSync(projectDir).isDirectory()) {
      console.log(`[Bot] プロジェクト切り替え: ${projectDir}`);
      return { workDir: projectDir, cleanText: stripPrefix(), projectName: candidate };
    }
  } catch {}
  // フォルダは無いが project-csn.json に登録済みのプロジェクト名なら、CSN ルーティング用に
  // projectName だけ解決する。workDir は cwd として使われるため安全な BASE_DIR に固定し、
  // コマンド実行が存在しないフォルダを cwd にするのを防ぐ（CSN ルーティングのみ有効化）。
  if (candidate && Object.prototype.hasOwnProperty.call(loadProjectCsnMap(), candidate)) {
    console.log(`[Bot] プロジェクト名(フォルダ無し) 認識: ${candidate} → CSN ルーティング`);
    return { workDir: BASE_DIR, cleanText: stripPrefix(), projectName: candidate };
  }
  return { workDir: BASE_DIR, cleanText: text, projectName: null };
}

// ── プロジェクト名 → giip csn マッピング（project-csn.json 駆動） ──────────────
// `<プロジェクト名> issue 등록 <内容>` を、そのプロジェクトの csn で登録するための対応表。
// ハードコードせず project-csn.json で管理し、呼び出しごとに読み直す（再起動なしで反映）。
function loadProjectCsnMap() {
  try {
    const j = JSON.parse(fs.readFileSync(PROJECT_CSN_FILE, 'utf8'));
    return (j && j.map) || {};
  } catch {
    return {};
  }
}

// workDir（またはプロジェクト名）→ csn(Number) or null。未登録なら null を返し、
// 呼び出し側は issueCreate 内の `csn ?? account.csn` で既定 csn にフォールバックする。
function resolveProjectCsn(workDirOrName) {
  if (!workDirOrName) return null;
  const name = path.basename(String(workDirOrName)).toLowerCase();
  const v = loadProjectCsnMap()[name];
  return (v === 0 || v) ? Number(v) : null;
}

// ── project-csn.json の読み書き（Slack `giip project` コマンドから利用） ──────
// _comment 等 map 以外のフィールドを保存したまま map だけ更新する。読み込みは
// loadProjectCsnMap と同じく毎回読み直すので再起動なしで即時反映される。
function readProjectCsnFile() {
  try {
    const j = JSON.parse(fs.readFileSync(PROJECT_CSN_FILE, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch {
    return {};
  }
}
function writeProjectCsnFile(obj) {
  fs.writeFileSync(PROJECT_CSN_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  autoCommitProjectCsnFile();
}

// `giip project set/del`은 로컬 디스크에만 fs.writeFileSync 하고 git에는 반영하지 않아,
// 이 봇 프로세스가 실제로 돌아가는 호스트의 로컬 파일과 git 저장소가 조용히 어긋나는 문제가 있었다
// (issue #821: giipprj로 명시했는데 map이 git상 {}로 비어있어 csn 33으로 폴백된 원인).
// 파일이 바뀔 때마다 즉시 commit+push해서 두 상태를 동일하게 유지한다. 실패해도 map 저장 자체는
// 이미 끝난 뒤라 치명적이지 않음 — 조용히 로그만 남긴다.
function autoCommitProjectCsnFile() {
  try {
    const repoRoot = path.join(__dirname, '..');
    const rel = 'slack-bot/project-csn.json';
    spawnSync('git', ['add', rel], { cwd: repoRoot });
    const commitRes = spawnSync('git', ['commit', '-m', 'chore(project-csn): giip project set/del 자동 반영'], { cwd: repoRoot });
    if (commitRes.status === 0) {
      const pushRes = spawnSync('git', ['push'], { cwd: repoRoot });
      if (pushRes.status !== 0) {
        console.error('[project-csn] git push 실패:', pushRes.stderr && pushRes.stderr.toString());
      }
    }
    // commit status !== 0 인 경우 대부분 "변경사항 없음"(이미 최신) — 정상.
  } catch (e) {
    console.error('[project-csn] git 자동 커밋 실패:', e && e.message);
  }
}

// 全マッピングを { name: csn } で返す。
function listProjectCsn() {
  return loadProjectCsnMap();
}

// プロジェクト名 → csn を追加/更新。name は小文字化して保存（parseProjectPrefix と整合）。
function setProjectCsn(name, csn) {
  const key = String(name || '').trim().toLowerCase();
  const n = Number(csn);
  if (!key) throw new Error('프로젝트명이 필요합니다.');
  if (!Number.isInteger(n)) throw new Error('csn 은 정수여야 합니다.');
  const j = readProjectCsnFile();
  if (!j.map || typeof j.map !== 'object') j.map = {};
  j.map[key] = n;
  writeProjectCsnFile(j);
  return { name: key, csn: n };
}

// プロジェクト名のマッピングを削除。存在して削除したら true、無ければ false。
function deleteProjectCsn(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  const j = readProjectCsnFile();
  if (j.map && Object.prototype.hasOwnProperty.call(j.map, key)) {
    delete j.map[key];
    writeProjectCsnFile(j);
    return true;
  }
  return false;
}

// ── チャンネル → 既定プロジェクト固定マッピング（channel-project.json 駆動） ──────
// 「このチャンネルの発話はすべて <project> として扱う」を実現する。project-csn.json と同じく
// 呼び出しごとに読み直す（再起動なしで反映）。giip csn とは独立に channelId → プロジェクト名を持つ。
function loadChannelProjectMap() {
  try {
    const j = JSON.parse(fs.readFileSync(CHANNEL_PROJECT_FILE, 'utf8'));
    return (j && j.map) || {};
  } catch {
    return {};
  }
}

// channelId → プロジェクト名(小文字) or null。未登録なら null。
function resolveChannelProject(channelId) {
  if (!channelId) return null;
  const v = loadChannelProjectMap()[channelId];
  return v ? String(v).toLowerCase() : null;
}

// プロジェクト名 → workDir。PROJECTS_ROOT 直下に同名フォルダがあればそれ、無ければ BASE_DIR に
// 安全フォールバック（存在しないフォルダを cwd にしない）。parseProjectPrefix のフォルダ解決と整合。
function projectWorkDir(name) {
  const candidate = String(name || '').trim().toLowerCase();
  if (!candidate) return BASE_DIR;
  const dir = path.join(PROJECTS_ROOT, candidate);
  try { if (fs.statSync(dir).isDirectory()) return dir; } catch {}
  return BASE_DIR;
}

// チャンネル固定マッピングを parseProjectPrefix の結果に適用する。
//   優先順位（設計判断）: 明示的プロジェクト接頭辞 > チャンネル固定。
//   メッセージ先頭に実フォルダ / project-csn.json 登録名の接頭辞があれば（parsed.projectName != null）
//   それを尊重する（Rule 32 の絶対規則を維持）。接頭辞が無いときだけ、本来 BASE_DIR に
//   潰れていた workDir/projectName をチャンネルの既定プロジェクトで埋める。cleanText は変更しない。
function applyChannelPin(channelId, parsed) {
  const p = parsed || { workDir: BASE_DIR, cleanText: '', projectName: null };
  if (p.projectName) return p; // 明示接頭辞が優先
  const pinned = resolveChannelProject(channelId);
  if (!pinned) return p;
  return { ...p, workDir: projectWorkDir(pinned), projectName: pinned };
}

// ── channel-project.json の読み書き（Slack `giip channel` コマンドから利用） ────
function readChannelProjectFile() {
  try {
    const j = JSON.parse(fs.readFileSync(CHANNEL_PROJECT_FILE, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch {
    return {};
  }
}
function writeChannelProjectFile(obj) {
  fs.writeFileSync(CHANNEL_PROJECT_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function listChannelProject() { return loadChannelProjectMap(); }
// channelId → プロジェクト名 を追加/更新。プロジェクト名は小文字化して保存。
function setChannelProject(channelId, name) {
  const key = String(channelId || '').trim();
  const val = String(name || '').trim().toLowerCase();
  if (!key) throw new Error('channelId 가 필요합니다.');
  if (!val) throw new Error('프로젝트명이 필요합니다.');
  const j = readChannelProjectFile();
  if (!j.map || typeof j.map !== 'object') j.map = {};
  j.map[key] = val;
  writeChannelProjectFile(j);
  return { channelId: key, project: val };
}
// channelId のマッピングを削除。存在して削除したら true、無ければ false。
function deleteChannelProject(channelId) {
  const key = String(channelId || '').trim();
  if (!key) return false;
  const j = readChannelProjectFile();
  if (j.map && Object.prototype.hasOwnProperty.call(j.map, key)) {
    delete j.map[key];
    writeChannelProjectFile(j);
    return true;
  }
  return false;
}

module.exports = {
  BOT_TOKEN,
  CHANNEL_IDS,
  ALLOWED_USERS,
  SLACK_APP_TOKEN,
  BOT_NAME,
  BASE_DIR,
  PROJECTS_ROOT,
  AGENT_DIR,
  HISTORY_FILE,
  TASK_STATE_FILE,
  BOT_THREADS_FILE,
  getBotUserId,
  setBotUserId,
  getSelfBotId,
  setSelfBotId,
  getAgentDir,
  parseProjectPrefix,
  resolveProjectCsn,
  listProjectCsn,
  setProjectCsn,
  deleteProjectCsn,
  resolveChannelProject,
  projectWorkDir,
  applyChannelPin,
  listChannelProject,
  setChannelProject,
  deleteChannelProject,
};
