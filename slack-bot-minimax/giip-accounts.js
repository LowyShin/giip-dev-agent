/**
 * giip-accounts.js — Slack 채널별 giip 계정 매핑(로그인ID + SK + csn) 로드/저장.
 * 설계: docs/DESIGN_slackbot_giip_issue_integration.md §3-2·§3-3. 규칙: .agent/rules/39,40.
 *
 * 비밀(SK)은 .secrets/giip-accounts.json(비커밋)에만. 샘플은 giip-accounts.sample.json.
 * AK 는 저장하지 않는다(로그인마다 바뀜) — 런타임에 giip-api.getAK 로 도출.
 */
const fs = require('fs');
const path = require('path');

const SECRETS_DIR = path.join(__dirname, '.secrets');
const ACCOUNTS_FILE = path.join(SECRETS_DIR, 'giip-accounts.json');
const DEFAULT_API_BASE = 'https://giipfaw.azurewebsites.net/api';

function load() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch {
    return { GIIP_API_BASE: DEFAULT_API_BASE, default: null, channels: {} };
  }
}

function save(cfg) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(cfg, null, 2));
}

function apiBase() {
  return load().GIIP_API_BASE || process.env.GIIP_API_BASE || DEFAULT_API_BASE;
}

/**
 * 채널 → 계정 {login_id, sk, csn, apiBase} 해석.
 * 순서: 채널 매핑 → default → env(GIIP_LOGIN_ID/GIIP_SK/GIIP_CSN). 없으면 null(=미연결).
 */
function resolve(channelId) {
  const cfg = load();
  const base = cfg.GIIP_API_BASE || process.env.GIIP_API_BASE || DEFAULT_API_BASE;
  const acct =
    (channelId && cfg.channels && cfg.channels[channelId]) ||
    cfg.default ||
    null;
  if (acct && acct.login_id && acct.sk) {
    return { login_id: acct.login_id, sk: acct.sk, csn: acct.csn ?? null, apiBase: base };
  }
  if (process.env.GIIP_LOGIN_ID && process.env.GIIP_SK) {
    return {
      login_id: process.env.GIIP_LOGIN_ID,
      sk: process.env.GIIP_SK,
      csn: process.env.GIIP_CSN ? Number(process.env.GIIP_CSN) : null,
      apiBase: base,
    };
  }
  return null;
}

/** giip issue 연결 가능 여부(계정 존재). */
function isConnected(channelId) {
  return !!resolve(channelId);
}

/**
 * 대화로 계정 설정/변경 → 파일 영속화. channelId 없거나 asDefault=true 면 default 갱신.
 */
function setAccount(channelId, { login_id, sk, csn } = {}, asDefault = false) {
  const cfg = load();
  cfg.GIIP_API_BASE = cfg.GIIP_API_BASE || DEFAULT_API_BASE;
  const acct = { login_id, sk };
  if (csn != null && csn !== '') acct.csn = Number(csn);
  if (asDefault || !channelId) {
    cfg.default = acct;
  } else {
    cfg.channels = cfg.channels || {};
    cfg.channels[channelId] = acct;
  }
  save(cfg);
  return acct;
}

module.exports = { load, save, resolve, isConnected, setAccount, apiBase, ACCOUNTS_FILE };
