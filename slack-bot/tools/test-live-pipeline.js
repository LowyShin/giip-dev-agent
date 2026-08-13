#!/usr/bin/env node
/**
 * test-live-pipeline.js — 라이브 통합 테스트 (giip-1068 §12)
 *
 *   node slack-bot/tools/test-live-pipeline.js
 *
 * 실제 Slack → 모델 → 파일 변경 → PR 생성 경로를 검증한다. 외부 자격증명과 테스트용 Slack 채널이
 * 있어야 하므로 단위 테스트(test-cost-optimization.js)와 분리했다.
 *
 * 결과 등급은 §12.2 의 다섯 가지만 쓴다.
 *   PASS / FAIL / SKIP_NO_CREDENTIAL / SKIP_NO_TEST_CHANNEL / SKIP_PROVIDER_UNAVAILABLE
 *
 * SKIP 을 PASS 에 포함하지 않는다. 자격증명이 없으면 성공으로 처리하지 않고 SKIP 으로 남긴다.
 *
 * 필요한 환경변수
 *   SLACK_BOT_TOKEN / SLACK_APP_TOKEN   Slack 자격증명 (slack-bot/.env)
 *   FDE_TEST_SLACK_CHANNEL              테스트 전용 채널 ID (운영 채널을 쓰지 마라)
 *   MINIMAX_API_KEY 또는 claude-accounts.json  모델 공급자
 *   GITHUB_TOKEN 또는 gh CLI 로그인       PR 생성 확인용
 *
 * 이 스크립트는 봇 프로세스를 대신 돌리지 않는다. 시나리오별로
 *   (a) 사전 조건을 실측하고
 *   (b) 조건이 갖춰졌을 때만 테스트 채널에 요청을 올린 뒤 결과를 폴링한다.
 * 조건이 없으면 그 시나리오는 SKIP 사유와 함께 기록된다.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SB = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(SB, '.env') }); } catch { /* dotenv 없으면 env 그대로 */ }

const GRADES = ['PASS', 'FAIL', 'SKIP_NO_CREDENTIAL', 'SKIP_NO_TEST_CHANNEL', 'SKIP_PROVIDER_UNAVAILABLE'];
const results = [];

function record(scenario, grade, detail) {
  if (!GRADES.includes(grade)) throw new Error(`허용되지 않는 결과 등급: ${grade}`);
  results.push({ scenario, grade, detail: detail || '' });
  console.log(`  ${grade.padEnd(26)} ${scenario}${detail ? ` — ${detail}` : ''}`);
}

// ── 사전 조건 실측 ───────────────────────────────────────────────────────────
function haveSlackCredentials() {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
}

function haveTestChannel() {
  return !!(process.env.FDE_TEST_SLACK_CHANNEL && String(process.env.FDE_TEST_SLACK_CHANNEL).trim());
}

function haveProvider() {
  const minimax = !!process.env.MINIMAX_API_KEY;
  let claude = false;
  try {
    const accounts = require(path.join(SB, 'claude-accounts'));
    claude = accounts.count() > 0;
  } catch { claude = false; }
  const cli = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'],
    { encoding: 'utf8', windowsHide: true }).status === 0;
  return { minimax, claude, cli, any: (minimax || claude) && cli };
}

function haveGitHub() {
  if (process.env.GITHUB_TOKEN) return true;
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

function preflight() {
  const provider = haveProvider();
  return {
    slack: haveSlackCredentials(),
    channel: haveTestChannel(),
    provider,
    github: haveGitHub(),
  };
}

/**
 * 시나리오별 SKIP 사유를 우선순위대로 판정한다.
 * @returns {string|null} SKIP 등급 또는 null(실행 가능)
 */
function skipReason(pre, needs = {}) {
  if (needs.slack && !pre.slack) return 'SKIP_NO_CREDENTIAL';
  if (needs.channel && !pre.channel) return 'SKIP_NO_TEST_CHANNEL';
  if (needs.provider && !pre.provider.any) return 'SKIP_PROVIDER_UNAVAILABLE';
  // 429 재현은 MiniMax 테스트 계정(또는 mock provider)이 있어야만 가능하다.
  if (needs.minimax && !pre.provider.minimax) return 'SKIP_PROVIDER_UNAVAILABLE';
  if (needs.github && !pre.github) return 'SKIP_NO_CREDENTIAL';
  return null;
}

// ── Slack 왕복 (자격증명이 있을 때만 실제로 호출) ────────────────────────────
async function postToTestChannel(text) {
  const slack = require(path.join(SB, 'slack-api'));
  const channel = String(process.env.FDE_TEST_SLACK_CHANNEL).trim();
  return slack.postMessage(channel, text);
}

async function runScenario(name, needs, pre, fn, note) {
  const skip = skipReason(pre, needs);
  if (skip) { record(name, skip, note || missingDetail(pre, needs)); return; }
  try {
    const r = await fn();
    record(name, r.ok ? 'PASS' : 'FAIL', r.detail);
  } catch (e) {
    record(name, 'FAIL', e.message);
  }
}

function missingDetail(pre, needs) {
  const missing = [];
  if (needs.slack && !pre.slack) missing.push('SLACK_BOT_TOKEN/SLACK_APP_TOKEN 미설정');
  if (needs.channel && !pre.channel) missing.push('FDE_TEST_SLACK_CHANNEL 미설정');
  if (needs.provider && !pre.provider.any) {
    missing.push(`모델 공급자 없음(minimax=${pre.provider.minimax}, claude=${pre.provider.claude}, claude CLI=${pre.provider.cli})`);
  }
  if (needs.minimax && !pre.provider.minimax) {
    missing.push('MINIMAX_API_KEY 미설정 — 429 재현용 테스트 계정/mock provider 없음');
  }
  if (needs.github && !pre.github) missing.push('GITHUB_TOKEN/gh 인증 없음');
  return missing.join(', ');
}

// ── 시나리오 ────────────────────────────────────────────────────────────────
async function main() {
  const pre = preflight();
  console.log('라이브 통합 테스트 (giip-1068 §12)');
  console.log(`사전 조건: slack=${pre.slack} testChannel=${pre.channel}`
    + ` minimax=${pre.provider.minimax} claude=${pre.provider.claude} claudeCLI=${pre.provider.cli}`
    + ` github=${pre.github}\n`);

  // 시나리오 1: trivial (Fast Path, 모델 호출 1회, PR 생성)
  await runScenario('시나리오 1: trivial (Fast Path → PR)',
    { slack: true, channel: true, provider: true, github: true }, pre, async () => {
      const req = 'README.md의 "Zero Tool Setup"을 "Minimal Tool Setup"으로 변경해줘.';
      await postToTestChannel(req);
      return {
        ok: false,
        detail: '요청은 테스트 채널에 올렸다. 봇 프로세스의 처리 완료(Fast Path/모델 호출 1회/PR 생성/'
          + '결과 보고서/전체 role 미로딩)는 `!cost task <id>` 와 PR 목록으로 사람이 확인해야 한다 — '
          + '자동 판정 미구현이므로 PASS 로 올리지 않는다',
      };
    });

  // 시나리오 2: standard (컨텍스트 최대 6개, MiniMax 우선, Sonnet fallback, PR)
  await runScenario('시나리오 2: standard (컨텍스트 6개/MiniMax 우선/PR)',
    { slack: true, channel: true, provider: true, github: true }, pre, async () => {
      await postToTestChannel('slack-bot/repo-status.js 의 미사용 변수 경고를 하나 고쳐줘');
      return { ok: false, detail: '요청 게시 완료 — 결과 판정은 사람이 PR/로그로 확인' };
    });

  // 시나리오 3: fallback (429 → checkpoint → Claude, 부분 작업 유무에 따른 프롬프트 선택)
  await runScenario('시나리오 3: fallback (429 → checkpoint → resume prompt)',
    { provider: true, minimax: true }, pre, async () => {
      // 이 시나리오는 MiniMax 를 실제로 429 상태로 만들거나 mock provider 가 필요하다.
      return {
        ok: false,
        detail: 'MiniMax 테스트 계정의 429 재현 또는 mock provider 주입 경로가 이 환경에 없다 — '
          + '단위 테스트 A/B/C 가 같은 판정 로직(shouldResume/hasRealWork/재개 프롬프트 60%)을 '
          + '검증하지만, 라이브 왕복은 NOT_MEASURED',
      };
    });

  // 시나리오 4: cancel (실행 중 취소 → checkpoint 보존)
  await runScenario('시나리오 4: cancel (실행 중 취소 → checkpoint 보존)',
    { slack: true, channel: true, provider: true }, pre, async () => {
      await postToTestChannel('cancel <task-id>');
      return { ok: false, detail: '요청 게시 완료 — 프로세스 중단/checkpoint 보존/재실행 감지는 사람이 확인' };
    });

  // ── 결과 ──────────────────────────────────────────────────────────────────
  const pass = results.filter(r => r.grade === 'PASS').length;
  const fail = results.filter(r => r.grade === 'FAIL').length;
  const skip = results.filter(r => r.grade.startsWith('SKIP')).length;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`PASS ${pass} / FAIL ${fail} / SKIP ${skip}  (SKIP 은 PASS 에 포함하지 않는다)`);
  console.log(JSON.stringify(results, null, 2));
  // SKIP 만 있는 경우도 성공 종료로 처리하지 않는다 — 검증되지 않았음을 종료코드로 남긴다.
  process.exit(fail > 0 || pass === 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { preflight, skipReason, GRADES };
