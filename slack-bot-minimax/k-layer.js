const fs = require('fs');
const path = require('path');

const NOTES_DIR = path.join(__dirname, '..', '.agent', 'knowledge', 'notes');

const KEYWORDS = {
  'auth': ['auth', '인증', 'login', '로그인', 'jwt', 'token', 'sso'],
  'mobile-order': ['order', '주문', 'code', 'access', 'mobile', '코드'],
  'deployment': ['deploy', '배포', 'azure', 'git push', 'static', 'css'],
  'debug': ['error', 'bug', 'fail', '오류', '에러', '버그', '실패', '무효'],
  'api': ['api', 'endpoint', 'request', 'response', '엔드포인트'],
  'storage': ['storage', 'blob', 'file', '파일', 'upload'],
  'agent-setup': ['hook', 'trace', 'k-layer', 'skill', 'klayer'],
  'design-references': ['pjcatapult', 'design', 'デザイン', 'mock', 'html', 'kashiwa', 'top page', 'トップ', 'ローカル', 'local', 'github', 'raw.github'],
};

function searchKLayer(prompt) {
  const text = (prompt || '').toLowerCase();
  const matchedTopics = new Set();

  for (const [topic, keys] of Object.entries(KEYWORDS)) {
    if (keys.some(k => text.includes(k))) matchedTopics.add(topic);
  }

  const relevantClaims = [];
  try {
    const noteFiles = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.md'));
    for (const file of noteFiles) {
      const topicKey = file.replace('.md', '');
      const isRelevant =
        matchedTopics.size === 0 ||
        [...matchedTopics].some(t => file.includes(t) || topicKey.includes(t));

      if (!isRelevant) continue;

      const content = fs.readFileSync(path.join(NOTES_DIR, file), 'utf8');
      const claimBlocks = content.split(/\n(?=CLAIM-\d+:)/);
      for (const block of claimBlocks) {
        if (!block.startsWith('CLAIM-')) continue;
        if (block.includes('invalidated_at**: null') || block.includes('invalidated_at: null')) {
          const firstLine = block.split('\n')[0];
          relevantClaims.push(`[${file}] ${firstLine}`);
          if (relevantClaims.length >= 10) break;
        }
      }
      if (relevantClaims.length >= 10) break;
    }
  } catch {}

  return relevantClaims;
}

module.exports = { searchKLayer };
