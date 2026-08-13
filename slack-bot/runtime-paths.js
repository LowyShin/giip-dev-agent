/**
 * runtime-paths.js — 런타임 산출물(checkpoint / progress / cost log)의 중앙 경로 (giip-1068, 7)
 *
 * 기존 문제
 *   - 비용 로그는 `config.BASE_DIR` 기준, checkpoint 는 `startExecution()` 에 넘어온 `baseDir` 기준이라
 *     프로젝트 프리픽스 작업(예: `giipv3 …`)에서 두 산출물이 서로 다른 폴더로 흩어졌다.
 *
 * 여기서
 *   - `runtimeRoot()` 하나로 통일한다. 환경변수 `FDE_RUNTIME_DIR` 가 있으면 그 절대경로,
 *     없으면 `config.BASE_DIR/.agent/runtime`.
 *
 *   .agent/runtime/
 *   ├── checkpoints/
 *   ├── progress/
 *   ├── cost-usage.jsonl
 *   └── task-index.json
 *
 * 프로젝트 구분은 폴더를 쪼개지 않고 checkpoint 안의 `project_name` / `work_dir` 로 남긴다.
 * `work_dir` 은 절대경로가 아니라 마스킹된 상대경로다(7.2).
 */

const fs = require('fs');
const path = require('path');

/** config 를 지연 로드한다(순환 참조 및 dotenv 부작용 회피). 실패해도 동작해야 한다. */
function workspaceRoot() {
  try {
    const config = require('./config');
    if (config && config.BASE_DIR) return config.BASE_DIR;
  } catch { /* config 로드 실패 시 저장소 루트로 대체 */ }
  return path.join(__dirname, '..');
}

/**
 * 런타임 루트. 인자 없이도 동작한다(= 중앙 기본값).
 * @param {string} [baseDir] 명시적 기준 디렉터리(FDE_RUNTIME_DIR 가 있으면 무시된다)
 */
function runtimeRoot(baseDir) {
  const override = process.env.FDE_RUNTIME_DIR;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(baseDir || workspaceRoot(), '.agent', 'runtime');
}

function checkpointsDir(baseDir) { return path.join(runtimeRoot(baseDir), 'checkpoints'); }
function progressDir(baseDir) { return path.join(runtimeRoot(baseDir), 'progress'); }
function costLogPath(baseDir) { return path.join(runtimeRoot(baseDir), 'cost-usage.jsonl'); }
function taskIndexPath(baseDir) { return path.join(runtimeRoot(baseDir), 'task-index.json'); }

/** 파일명으로 안전한 task id. */
function safeTaskId(taskId) {
  return String(taskId == null ? 'unknown' : taskId).replace(/[^\w.\-]/g, '_').slice(0, 120) || 'unknown';
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}

/**
 * 로그·checkpoint 에 남길 작업 디렉터리 표기(7.2).
 * 절대경로 전체를 남기지 않는다 — PROJECTS_ROOT 하위면 상대경로, 아니면 `…/<basename>`.
 */
function maskWorkDir(dir) {
  const abs = String(dir || '');
  if (!abs) return '';
  let roots = [];
  try {
    const config = require('./config');
    roots = [config.PROJECTS_ROOT, config.BASE_DIR].filter(Boolean);
  } catch { /* config 없이도 동작 */ }
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.replace(/\\/g, '/');
    }
    if (rel === '') return path.basename(abs);
  }
  return `…/${path.basename(abs)}`;
}

module.exports = {
  runtimeRoot,
  checkpointsDir,
  progressDir,
  costLogPath,
  taskIndexPath,
  safeTaskId,
  ensureDir,
  maskWorkDir,
  workspaceRoot,
};
