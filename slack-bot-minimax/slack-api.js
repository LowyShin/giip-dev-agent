// slack-api.js — Slack Web API 呼び出し + メッセージ整形/スレッド取得
// index.js から behavior-preserving で切り出し（ロジック変更なし）。

const https = require('https');
const config = require('./config');
const { BOT_TOKEN } = config;
const { markThreadEngaged } = require('./state');

// ── Slack API ─────────────────────────────────────────────────────────────────
function slackGet(method, params = {}) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams(params).toString();
    const req = https.get({
      hostname: 'slack.com',
      path: `/api/${method}${qs ? '?' + qs : ''}`,
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'User-Agent': 'giipclaude-bot/1.0' },
    }, (res) => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false }); });
  });
}

function slackPost(method, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'slack.com', path: `/api/${method}`, method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'giipclaude-bot/1.0',
      },
    }, (res) => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(payload); req.end();
  });
}

async function postMessage(channel, text, thread_ts) {
  const body = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  const res = await slackPost('chat.postMessage', body);
  if (!res.ok) console.error(`[Bot] postMessage error: ${res.error}`);
  // ボットが返答したスレッドを記録 → 以降の返信にも反応する
  if (res.ok && res.ts) markThreadEngaged(channel, thread_ts || res.ts);
  return res;
}

async function postLong(channel, text, thread_ts) {
  const MAX = 3800;
  if (text.length <= MAX) { await postMessage(channel, text, thread_ts); return; }
  let remaining = text;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf('\n', MAX);
    if (cut < MAX * 0.6) cut = MAX;
    await postMessage(channel, remaining.slice(0, cut), thread_ts);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) await postMessage(channel, remaining, thread_ts);
}

// ── スレッド全体を読み取る (conversations.replies) ───────────────────────────
// Bot は mention された1件のメッセージしか event で受け取らないため、スレッドの
// 前後文脈は Slack API で明示的に取得しないと Claude からは全く見えない。
// これを行わないと「이전 대화 기록이 없습니다」等の誤答になる（本 fix の主眼）。
const _userNameCache = new Map();
let _usersReadMissing = false; // users:read スコープ無し → users.info 呼び出しを打ち切る
async function resolveUserName(userId) {
  if (!userId) return null;
  if (config.getBotUserId() && userId === config.getBotUserId()) return 'giipclaude';
  if (_userNameCache.has(userId)) return _userNameCache.get(userId);
  // users:read が無い環境では users.info が missing_scope になる。一度失敗したら
  // 以降は API を叩かず ID をそのまま話者ラベルにフォールバック（同一話者は同一IDで一貫）。
  if (_usersReadMissing) { _userNameCache.set(userId, userId); return userId; }
  const res = await slackGet('users.info', { user: userId });
  if (res && res.ok === false && res.error === 'missing_scope') _usersReadMissing = true;
  const name = (res.ok && res.user)
    ? ((res.user.profile && res.user.profile.display_name) || res.user.real_name || res.user.name || userId)
    : userId;
  _userNameCache.set(userId, name);
  return name;
}

// Slack メッセージ本文を人間可読テキストへ整形（mention/tel/url/装飾記号を除去）
function cleanThreadText(t) {
  return (t || '')
    .replace(/<@[A-Z0-9]+>/g, '@멘션')
    .replace(/<tel:(\d+)\|[^>]*>/g, '$1')
    .replace(/<tel:(\d+)>/g, '$1')
    .replace(/<(https?:\/\/[^|>]+)\|[^>]*>/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/`/g, '')
    .trim();
}

// threadTs のスレッド全体を「話者: 発言」形式のテキストで返す。取得不可なら ''。
// 他の bot/app（giipgravity, Manus 등）の発言も username 付きで含める。
async function fetchThreadTranscript(channelId, threadTs) {
  if (!threadTs) return '';
  const res = await slackGet('conversations.replies', {
    channel: channelId, ts: threadTs, limit: 200,
  });
  if (!res.ok || !Array.isArray(res.messages) || res.messages.length === 0) {
    if (res && res.ok === false) console.error(`[Bot] conversations.replies error: ${res.error}`);
    return '';
  }
  const lines = [];
  for (const m of res.messages) {
    let name = m.username || null;
    if (!name && m.user) name = await resolveUserName(m.user);
    if (!name) name = m.bot_id ? 'bot' : 'unknown';
    let body = cleanThreadText(m.text);
    if (!body && m.files && m.files.length) body = `(첨부파일 ${m.files.length}건)`;
    if (!body && m.attachments && m.attachments.length) {
      body = cleanThreadText(m.attachments.map(a => a.text || a.fallback || '').join(' '));
    }
    if (!body) continue;
    lines.push(`${name}: ${body}`);
  }
  let transcript = lines.join('\n');
  const MAX = 12000; // プロンプト肥大を防ぐ上限（超過分は古い側を切る）
  if (transcript.length > MAX) transcript = '…(앞부분 생략)\n' + transcript.slice(-MAX);
  return transcript;
}

module.exports = {
  slackGet,
  slackPost,
  postMessage,
  postLong,
  resolveUserName,
  cleanThreadText,
  fetchThreadTranscript,
};
