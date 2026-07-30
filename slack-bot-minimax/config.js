// config.js — 共有定数 + プロジェクトパスヘルパ + 可変 botUserId アクセサ
// index.js から behavior-preserving で切り出し（ロジック変更なし）。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── 設定 ─────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_IDS = (process.env.SLACK_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

const PROJECTS_ROOT   = 'C:\\Users\\lowys\\Downloads\\projects';
const BASE_DIR        = path.join(PROJECTS_ROOT, 'lowyworkenv'); // 기본 작업 폴더
const AGENT_DIR       = path.join(BASE_DIR, '.agent');            // 기본 .agent (lowyworkenv/.agent)
const HISTORY_FILE    = path.join(__dirname, '.conversations.json');
const TASK_STATE_FILE = path.join(__dirname, '.task-state.json');
const BOT_THREADS_FILE = path.join(__dirname, '.bot-threads.json');
const PROJECT_CSN_FILE = path.join(__dirname, 'project-csn.json');
const CHANNEL_PROJECT_FILE = path.join(__dirname, 'channel-project.json');

// ── 可変ランタイム: BOT_USER_ID を getter/setter で共有 ───────────────────────
// main() 内の auth.test 後に setBotUserId で設定し、複数モジュールから getBotUserId で読む。
let botUserId = null;
function getBotUserId() { return botUserId; }
function setBotUserId(id) { botUserId = id; }

// 봇끼리 대화 허용(2026-07-26, giip-773 후속) 시 "자기 자신이 보낸 메시지"만 걸러 무한루프를 막기 위한 bot_id.
let selfBotId = null;
function getSelfBotId() { return selfBotId; }
function setSelfBotId(id) { selfBotId = id; }

// ── プロジェクトの .agent ディレクトリを解決 ─────────────────────────────────
// workDir 内に .agent があればそれを使い、なければ lowyworkenv/.agent にフォールバック
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

// ── プロジェクト名 → giip csn マッピング（設定ファイル駆動） ──────────────────
// Slack で最初に言及したプロジェクト名（= parseProjectPrefix が解決する workDir の
// フォルダ名）を giip csn に対応づける。ハードコードせず project-csn.json で管理し、
// giip-accounts.js と同様に呼び出しごとに読み直す（再起動なしで反映）。
function loadProjectCsnMap() {
  try {
    const j = JSON.parse(fs.readFileSync(PROJECT_CSN_FILE, 'utf8'));
    return (j && j.map) || {};
  } catch {
    return {};
  }
}

// workDir（またはプロジェクト名）→ csn(Number) or null。
// 未登録なら null を返し、呼び出し側は issueCreate 内の `csn ?? account.csn` で
// 既定 csn にフォールバックする。
function resolveProjectCsn(workDirOrName) {
  if (!workDirOrName) return null;
  const name = path.basename(String(workDirOrName)).toLowerCase();
  const v = loadProjectCsnMap()[name];
  return (v === 0 || v) ? Number(v) : null;
}

// ── project-csn.json の読み書き（Slack `giip project` コマンドから利用） ──────
// _comment 等 map 以外のフィールドを保存したまま map だけ更新する。書き込みは
// loadProjectCsnMap と同じく呼び出しごとに読み直すので再起動なしで即時反映される。
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
  autoCommitFile('slack-bot-minimax/project-csn.json', 'chore(project-csn): giip project set/del 자동 반영');
}

// `giip project/channel set/del`이 로컬 디스크에만 fs.writeFileSync하고 git에는 반영 안 돼,
// 이 봇이 돌아가는 호스트의 로컬 파일과 git 저장소가 조용히 어긋나는 문제 방지
// (issue #821: giipprj로 명시했는데 map이 git상 비어있어 csn 33으로 폴백된 사고와 동일 계열).
// 파일이 바뀔 때마다 즉시 commit+push. 실패해도 파일 저장 자체는 이미 끝난 뒤라 비치명적 —
// 조용히 로그만 남긴다.
function autoCommitFile(relPath, message) {
  try {
    const repoRoot = path.join(__dirname, '..');
    spawnSync('git', ['add', relPath], { cwd: repoRoot });
    const commitRes = spawnSync('git', ['commit', '-m', message], { cwd: repoRoot });
    if (commitRes.status === 0) {
      const pushRes = spawnSync('git', ['push'], { cwd: repoRoot });
      if (pushRes.status !== 0) {
        console.error(`[${relPath}] git push 실패:`, pushRes.stderr && pushRes.stderr.toString());
      }
    }
  } catch (e) {
    console.error(`[${relPath}] git 자동 커밋 실패:`, e && e.message);
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
//   優先順位（設計判断・task giip-724）: 明示的プロジェクト接頭辞 > チャンネル固定。
//   メッセージ先頭に実フォルダ / project-csn.json 登録名の接頭辞があれば（parsed.projectName != null）
//   それを尊重する（Rule 32 の絶対規則を維持）。接頭辞が無いときだけ、本来 BASE_DIR(lowyworkenv) に
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
  autoCommitFile('slack-bot-minimax/channel-project.json', 'chore(channel-project): giip channel set/del 자동 반영');
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
  SLACK_APP_TOKEN,
  PROJECTS_ROOT,
  BASE_DIR,
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
