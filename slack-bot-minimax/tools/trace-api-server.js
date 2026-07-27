#!/usr/bin/env node
/**
 * trace-api-server.js — ローカル Trace Review API サーバー
 * ポータル(Azure)からローカルのtraceファイルを読み書きする
 * 起動: node slack-bot/tools/trace-api-server.js
 * 接続: http://localhost:3001
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const TRACES_DIR = path.resolve(__dirname, '../../.agent/traces');
const PORT = 3001;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /traces — steps>=1 かつ completed_at あるものを返す
  if (req.method === 'GET' && req.url === '/traces') {
    try {
      const files = fs.readdirSync(TRACES_DIR)
        .filter(f => f.endsWith('.json') && f !== '.current');
      const traces = files
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(TRACES_DIR, f), 'utf8')); }
          catch { return null; }
        })
        .filter(t => t && t.completed_at && Array.isArray(t.steps) && t.steps.length >= 1)
        .sort((a, b) => b.trace_id.localeCompare(a.trace_id));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(traces));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // PATCH /traces/:id — reward と feedback を更新
  const m = req.url.match(/^\/traces\/(\d+)$/);
  if (req.method === 'PATCH' && m) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const file = path.join(TRACES_DIR, `${m[1]}.json`);
        if (!fs.existsSync(file)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'trace not found' }));
          return;
        }
        const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
        const update = JSON.parse(body);
        if (update.reward !== undefined) trace.reward = update.reward;
        if (update.feedback !== undefined) trace.feedback = update.feedback;
        fs.writeFileSync(file, JSON.stringify(trace, null, 2));
        console.log(`[PATCH] ${m[1]} → reward=${trace.reward}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Trace API] http://localhost:${PORT}`);
  console.log(`[Traces]   ${TRACES_DIR}`);
  console.log(`Ctrl+C で停止`);
});
