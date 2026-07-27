const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '.issues-cache.json');
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function fetchFromGitHub() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // e.g. 'LowyShin/smartorder-works'

  if (!token || !repo) return null;

  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${repo}/issues?state=open&per_page=30&sort=updated`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'smartorder-slack-bot/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          if (!Array.isArray(raw)) { resolve(null); return; }
          resolve(raw.map(i => ({
            number: i.number,
            title: i.title,
            state: i.state,
            labels: (i.labels || []).map(l => l.name),
            url: i.html_url,
            updated_at: i.updated_at,
          })));
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function refreshIssues() {
  const issues = await fetchFromGitHub();
  if (issues !== null) {
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), issues }));
    } catch {}
  }
  return issues || [];
}

async function getIssues() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - cache.timestamp < CACHE_TTL_MS) {
        return cache.issues || [];
      }
    }
  } catch {}
  return refreshIssues();
}

function getCacheAge() {
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const ageMs = Date.now() - cache.timestamp;
    const ageMins = Math.floor(ageMs / 60000);
    return `${ageMins}분 전 캐시`;
  } catch {
    return '캐시 없음';
  }
}

module.exports = { getIssues, refreshIssues, getCacheAge };
