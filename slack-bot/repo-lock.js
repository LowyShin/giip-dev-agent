// repo-lock.js — lowyworkenv 저장소 루트에 대한 프로세스 간 git 작업 상호배제 락.
// scripts/repo-lock.ps1(PowerShell 쪽 정본)과 같은 락 파일(.agent/locks/lowyworkenv-repo.lock,
// 같은 JSON 스키마: {pid, holder, purpose, startedAt})을 공유해 언어와 무관하게 동일한 락으로
// 취급된다. 이 모듈은 slack-bot(Node, pm2 상시 데몬) 쪽에서 쓰기 위한 동기(sync) 구현이다.
//
// task-manager.js의 gitPushResult()가 기존에 이미 spawnSync로 완전 동기 실행되므로 스타일을
// 맞췄다. 다만 slack-bot은 단일 이벤트 루프에서 다른 Slack 요청도 같이 처리해야 하므로,
// PowerShell 쪽(push_with_auth.ps1, 기본 15분 대기)보다 훨씬 짧은 기본 대기 예산을 쓰고,
// 예산을 넘기면 "실패로 막지 않고 경고만 남긴 채 진행"한다(fail-open) — gitPushResult 자체가
// 이미 pull --rebase --autostash + push 실패 시 재시도를 갖추고 있어 락 없이도 어느 정도
// 회복력이 있고, 몇 분씩 봇 전체를 얼리는 것이 더 나쁘기 때문이다.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const LOCK_DIR = path.join(REPO_ROOT, '.agent', 'locks');
const LOCK_PATH = path.join(LOCK_DIR, 'lowyworkenv-repo.lock');

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeLock(holder, purpose) {
  if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
  const obj = { pid: process.pid, holder, purpose, startedAt: new Date().toISOString() };
  fs.writeFileSync(LOCK_PATH, JSON.stringify(obj, null, 4), 'utf8');
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStale(lock, staleMinutes) {
  if (!lock) return true;
  if (!isPidAlive(lock.pid)) return true;
  const ageMs = Date.now() - new Date(lock.startedAt).getTime();
  return ageMs >= staleMinutes * 60 * 1000;
}

/**
 * 락 획득을 시도한다. 이미 내가 쥔 락이면 즉시 성공, 죽었거나 오래된 락이면 회수 후 성공.
 * 남이 쥔 살아있는 락이면 waitMs 예산 안에서 pollMs 간격으로 재확인하다가, 예산을 넘기면
 * false를 반환한다(예외를 던지지 않는다 — 호출자가 fail-open 판단).
 * @returns {boolean} 락을 실제로 획득했는지
 */
function acquireRepoLock(holder, purpose, { waitMs = 120000, staleMinutes = 120, pollMs = 3000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = readLock();
    if (!lock || lock.holder === holder || isStale(lock, staleMinutes)) {
      writeLock(holder, purpose);
      return true;
    }
    if (Date.now() >= deadline) {
      console.warn(`[repo-lock] 대기 시간 초과(${waitMs}ms) — holder=${lock.holder}, purpose=${lock.purpose}. 락 없이 진행합니다.`);
      return false;
    }
    // task-manager.js와 동일하게 완전 동기 방식을 유지한다(spawnSync 기반 git 파이프라인 중간
    // 삽입이라 async로 바꾸려면 호출부 전체를 리팩터링해야 함). execSync 기반 짧은 sleep.
    try {
      execSync(process.platform === 'win32'
        ? `powershell -NoProfile -Command "Start-Sleep -Milliseconds ${pollMs}"`
        : `sleep ${pollMs / 1000}`);
    } catch { /* ignore */ }
  }
}

/** 내가 쥔 락만 해제한다(남의 락은 절대 건드리지 않음). */
function releaseRepoLock(holder) {
  const lock = readLock();
  if (!lock) return;
  if (lock.holder !== holder) return;
  try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
}

module.exports = { acquireRepoLock, releaseRepoLock, LOCK_PATH };
