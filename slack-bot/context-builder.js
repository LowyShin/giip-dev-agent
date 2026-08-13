/**
 * context-builder.js — 선별 컨텍스트 로딩 (giip-1063, 3.1 / 3.7)
 *
 * 기존 문제
 *   - 분석 단계에서 관련 파일을 골라놓고, 실행 단계(startExecution)에서 `readRolesContext()` 로
 *     `.agent/roles/*.md` 전체를 다시 프롬프트에 넣었다.
 *   - 파일 본문을 `content.slice(0, 800)` 로 무조건 앞부분만 잘라 후반부의 중요한 규칙이 사라졌다.
 *   - 카탈로그를 만들려고 모든 SKILL 본문을 통째로 읽었다.
 *
 * 여기서 제공하는 것
 *   - buildContextCatalog: 파일 헤드만 읽어 name/description/trigger 를 뽑는다(+mtime/hash 캐시)
 *   - selectContextFilesStatic: LLM 호출 없이 정적 점수로 선별(Fast Path 및 LLM 실패 폴백)
 *   - readSelectedContext: 개수/길이 한도, 중복 제거, 제목 기반 섹션 축약
 *   - minimalDefaultContext: 선택 결과가 없거나 손상됐을 때 쓰는 "최소" 기본 컨텍스트
 *                            (전체 roles 를 다시 읽지 않는다)
 *   - formatContextFilesYaml / parseContextFiles: 태스크 파일에 구조화 저장/복원
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const modelConfig = require('./model-config');

const HEAD_BYTES = 4096;   // 카탈로그용으로 읽는 최대 바이트 (본문 전체를 읽지 않는다)

// ── 파일 헤드 캐시 (경로 + mtime + size 로 무효화, content hash 병기) ─────────
const _headCache = new Map();   // absPath → { mtimeMs, size, hash, meta }
const _bodyCache = new Map();   // absPath → { mtimeMs, size, hash, content }

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16);
}

/** 파일 앞부분만 읽는다(전체 로드 방지). */
function readHead(absPath, bytes = HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * SKILL/role/rule 파일의 메타(name/description/trigger)만 헤드에서 추출.
 * @returns {{name:string, description:string, trigger:string}}
 */
function extractMeta(head, fallbackName) {
  const fmMatch = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = fmMatch ? fmMatch[1] : '';
  const pick = (key) => {
    const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'im'))
           || head.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'im'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const name = pick('name') || fallbackName;
  let description = pick('description');
  if (!description) {
    const body = fmMatch ? head.slice(fmMatch[0].length) : head;
    const line = body.split(/\r?\n/).map(l => l.trim()).find(l => l && l !== '---');
    description = (line || '').replace(/^#+\s*/, '');
  }
  const trigger = pick('trigger') || pick('triggers') || pick('when-to-use');
  return {
    name: String(name).slice(0, 120),
    description: String(description).slice(0, 200),
    trigger: String(trigger).slice(0, 200),
  };
}

/** 캐시된 메타 조회. 변경되지 않은 파일은 재파싱하지 않는다(3.7-4). */
function getMeta(absPath, fallbackName) {
  const st = statSafe(absPath);
  if (!st) return null;
  const hit = _headCache.get(absPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { ...hit.meta, hash: hit.hash, cached: true };
  }
  const head = readHead(absPath);
  const meta = extractMeta(head, fallbackName);
  const hash = sha1(head);
  _headCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, hash, meta });
  return { ...meta, hash, cached: false };
}

/** 본문 캐시 조회(선택된 파일만). 해시가 같으면 재읽기 없이 재사용한다. */
function getBody(absPath) {
  const st = statSafe(absPath);
  if (!st) return null;
  const hit = _bodyCache.get(absPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { content: hit.content, hash: hit.hash, cached: true };
  }
  let content;
  try { content = fs.readFileSync(absPath, 'utf8'); } catch { return null; }
  const hash = sha1(content);
  _bodyCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, hash, content });
  return { content, hash, cached: false };
}

function resetCaches() { _headCache.clear(); _bodyCache.clear(); }

// ── 카탈로그 ────────────────────────────────────────────────────────────────
/**
 * .agent/roles·rules·skills 의 파일 목록 + (헤드에서 뽑은) name/description/trigger.
 * 본문은 읽지 않는다.
 * @returns {Array<{type,path,abs,name,desc,trigger,hash}>}
 */
function buildContextCatalog(baseDir, workspaceDir = baseDir) {
  const out = [];
  const addFile = (type, absPath) => {
    const meta = getMeta(absPath, path.basename(absPath, '.md'));
    if (!meta) return;
    out.push({
      type,
      path: path.relative(baseDir, absPath).replace(/\\/g, '/'),
      abs: absPath,
      name: meta.name,
      desc: meta.description,
      trigger: meta.trigger,
      hash: meta.hash,
    });
  };

  for (const [type, sub] of [['role', 'roles'], ['rule', 'rules']]) {
    let dir = path.join(baseDir, '.agent', sub);
    try { if (!fs.readdirSync(dir).some(f => f.endsWith('.md'))) dir = path.join(workspaceDir, '.agent', sub); }
    catch { dir = path.join(workspaceDir, '.agent', sub); }
    try { fs.readdirSync(dir).filter(f => f.endsWith('.md')).forEach(f => addFile(type, path.join(dir, f))); } catch {}
  }

  let skillsDir = path.join(baseDir, '.agent', 'skills');
  if (!fs.existsSync(skillsDir)) skillsDir = path.join(workspaceDir, '.agent', 'skills');
  try {
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const sk = path.join(skillsDir, e.name, 'SKILL.md');
        if (fs.existsSync(sk)) addFile('skill', sk);
      } else if (e.name.endsWith('.md')) {
        addFile('skill', path.join(skillsDir, e.name));
      }
    }
  } catch {}
  return out;
}

/** 카탈로그를 LLM 프롬프트용 한 줄 요약으로. 본문이 아니라 메타만 나간다(3.7-2). */
function formatCatalogForPrompt(catalog) {
  return catalog
    .map((c, i) => {
      const t = c.trigger ? ` | trigger: ${c.trigger}` : '';
      return `${i + 1}. [${c.type}] ${c.path} — ${c.desc}${t}`;
    })
    .join('\n');
}

// ── 정적 선별 (LLM 호출 없음) ────────────────────────────────────────────────
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'please', '해줘', '해라', '하고', '하는',
  '수정', '변경', '파일', '작업', '해', '를', '을', '이', '가', '에', '의', 'して', 'する', 'ください',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^0-9a-z가-힣ぁ-んァ-ヶ一-龥_.\-/]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * LLM 없이 요청과 카탈로그 메타의 키워드 겹침으로 컨텍스트 파일을 고른다.
 * Fast Path(계획 호출 생략) 및 LLM 선별 실패 시 폴백으로 쓴다.
 */
function selectContextFilesStatic(requestText, catalog, limits = modelConfig.contextLimits()) {
  if (!catalog || !catalog.length) return [];
  const terms = tokenize(requestText);
  const termSet = new Set(terms);
  const scored = catalog.map(c => {
    const hay = tokenize(`${c.path} ${c.name} ${c.desc} ${c.trigger}`);
    let score = 0;
    for (const h of hay) if (termSet.has(h)) score += 1;
    // rule 은 항상 약간의 기본 가중치(요청 범위 밖 수정 방지 등 공통 규칙)
    if (c.type === 'rule') score += 0.25;
    return { c, score };
  }).filter(x => x.score > 0.5);

  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, limits.defaultMaxFiles).map(x => ({
    path: x.c.path,
    reason: `요청 키워드와 ${x.c.type} 메타가 일치(정적 선별, score=${x.score.toFixed(2)})`,
    max_chars: limits.perFileMaxChars,
  }));
  return picked;
}

/**
 * 카탈로그가 너무 크면 선별 호출 프롬프트 자체가 비싸진다(role/rule/skill 60개 = 약 17k자).
 * 정적 점수로 상위 후보만 남겨 선별 모델에 넘긴다. 점수 0인 파일도 뒤쪽에 섞어 넣어
 * "키워드가 안 겹치는데 실제로는 필요한" 파일이 완전히 배제되지 않게 한다.
 */
function narrowCatalog(requestText, catalog, maxEntries = 30) {
  if (!catalog || catalog.length <= maxEntries) return catalog || [];
  const terms = new Set(tokenize(requestText));
  const scored = catalog.map((c, i) => {
    const hay = tokenize(`${c.path} ${c.name} ${c.desc} ${c.trigger}`);
    let score = 0;
    for (const h of hay) if (terms.has(h)) score += 1;
    if (c.type === 'rule') score += 0.25;
    return { c, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, maxEntries).sort((a, b) => a.i - b.i).map(x => x.c);
}

/**
 * 선택 결과가 없거나 손상됐을 때 쓰는 "최소" 기본 컨텍스트(3.1-4).
 * 전체 roles 를 다시 읽지 않는다 — 공통 가드레일 rule 몇 개만.
 */
const MINIMAL_DEFAULTS = [
  '.agent/rules/10_karpathy_guidelines.md',
  '.agent/rules/00_core_principles.md',
];

function minimalDefaultContext(baseDir, workspaceDir = baseDir) {
  const out = [];
  for (const rel of MINIMAL_DEFAULTS) {
    for (const root of [baseDir, workspaceDir]) {
      const abs = path.join(root, rel);
      if (fs.existsSync(abs)) {
        out.push({ path: rel, reason: '최소 기본 컨텍스트(선택 목록 없음/손상) — 요청 범위 밖 수정 방지', max_chars: 3000 });
        break;
      }
    }
  }
  return out;
}

// ── 제목 기반 축약 ───────────────────────────────────────────────────────────
/**
 * Markdown 을 제목 단위로 쪼개, 요청과 관련된 섹션을 우선 보존하며 maxChars 로 줄인다.
 * 앞부분만 자르지 않는다 — frontmatter/제목/관련 섹션을 살린다.
 */
function condenseMarkdown(content, maxChars, queryTerms = []) {
  const text = String(content || '');
  if (text.length <= maxChars) return { text, condensed: false };

  // frontmatter 는 통째로 보존(짧고 메타가 들어있다)
  let fm = '';
  let body = text;
  const fmMatch = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (fmMatch && fmMatch[0].length < Math.min(1200, maxChars / 2)) {
    fm = fmMatch[0];
    body = text.slice(fmMatch[0].length);
  }

  // 제목 단위 분할
  const lines = body.split(/\r?\n/);
  const sections = [];
  let cur = { heading: '', level: 0, lines: [] };
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (cur.lines.length || cur.heading) sections.push(cur);
      cur = { heading: line, level: h[1].length, lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.length || cur.heading) sections.push(cur);

  const termSet = new Set((queryTerms || []).map(t => String(t).toLowerCase()));
  const scoreOf = (sec) => {
    const hay = `${sec.heading}\n${sec.lines.join('\n')}`.toLowerCase();
    let s = 0;
    for (const t of termSet) if (t.length >= 2 && hay.includes(t)) s += 1;
    // 규칙/금지/필수 같은 핵심 규칙 섹션은 가중
    if (/금지|필수|반드시|mandatory|must|never|규칙|rule/i.test(hay)) s += 1.5;
    return s;
  };

  const budget = maxChars - fm.length - 80;
  const chosen = [];
  let used = 0;

  // 1) 첫 섹션(제목/개요)은 항상 포함
  if (sections.length) {
    const first = sections[0];
    const t = `${first.heading}\n${first.lines.join('\n')}`.trim();
    const clipped = t.length > budget * 0.4 ? `${t.slice(0, Math.floor(budget * 0.4))}\n…(중략)` : t;
    chosen.push({ idx: 0, text: clipped });
    used += clipped.length + 2;
  }

  // 2) 나머지는 점수 순으로 채운다(원문 순서는 나중에 복원)
  const rest = sections.map((s, i) => ({ s, i })).slice(1)
    .map(x => ({ ...x, score: scoreOf(x.s) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  for (const r of rest) {
    if (used >= budget) break;
    const t = `${r.s.heading}\n${r.s.lines.join('\n')}`.trim();
    if (!t) continue;
    const room = budget - used;
    const clipped = t.length > room ? `${t.slice(0, Math.max(0, room - 12))}\n…(중략)` : t;
    if (clipped.trim().length < 10) break;
    chosen.push({ idx: r.i, text: clipped });
    used += clipped.length + 2;
  }

  chosen.sort((a, b) => a.idx - b.idx);
  const outText = `${fm}${chosen.map(c => c.text).join('\n\n')}`.trim();
  return { text: `${outText}\n\n…(관련도 낮은 섹션 생략 — 원문: 위 경로 참조)`, condensed: true };
}

// ── 선택 파일 읽기 ───────────────────────────────────────────────────────────
/**
 * 선택된 파일 내용을 한도 안에서 읽어 프롬프트용 문자열을 만든다.
 *
 * @param {Array<{path:string,reason?:string,max_chars?:number}>} selected
 * @param {string} baseDir
 * @param {object} [opts] { workspaceDir, queryText, limits }
 * @returns {{context:string, filesRead:Array, stats:object}}
 */
function readSelectedContext(selected, baseDir, opts = {}) {
  const limits = opts.limits || modelConfig.contextLimits();
  const workspaceDir = opts.workspaceDir || baseDir;
  const queryTerms = tokenize(opts.queryText || '');

  const parts = [];
  const filesRead = [];
  const seenPath = new Set();
  const seenHash = new Set();   // 같은 내용이 다른 경로로 들어오면 한 번만
  let totalChars = 0;
  let skippedForLimit = 0;
  let cacheHits = 0;

  const list = (selected || []).slice(0, limits.hardMaxFiles);

  for (const s of list) {
    const rel = String(s && s.path || '').replace(/\\/g, '/');
    if (!rel) continue;

    // 같은 파일이 여러 경로 표기로 선택되면 한 번만
    let abs = path.resolve(baseDir, rel);
    if (!fs.existsSync(abs)) abs = path.resolve(workspaceDir, rel);
    let key;
    try { key = fs.realpathSync(abs); } catch { key = abs; }
    if (seenPath.has(key)) continue;

    const body = getBody(abs);
    if (!body) continue;
    if (seenHash.has(body.hash)) continue;   // 동일 내용 중복 규칙 제거
    if (body.cached) cacheHits += 1;

    const perFile = Math.min(Number(s.max_chars) || limits.perFileMaxChars, limits.perFileMaxChars);
    const room = limits.totalMaxChars - totalChars;
    if (room <= 200) { skippedForLimit += 1; continue; }

    const { text, condensed } = condenseMarkdown(body.content, Math.min(perFile, room), queryTerms);
    const reason = (s.reason && String(s.reason).trim()) || '(사유 미기재)';
    parts.push(`### ${rel} (로드 사유: ${reason})\n${text}`);
    totalChars += text.length;
    seenPath.add(key);
    seenHash.add(body.hash);
    filesRead.push({
      path: rel,
      reason,
      max_chars: perFile,
      chars: text.length,
      condensed,
      hash: body.hash,
      cached: body.cached,
    });
  }

  return {
    context: parts.join('\n\n---\n\n'),
    filesRead,
    stats: {
      files: filesRead.length,
      chars: totalChars,
      skipped_for_limit: skippedForLimit,
      cache_hits: cacheHits,
      limits,
    },
  };
}

// ── 태스크 파일에 구조화 저장/복원 ───────────────────────────────────────────
/** context_files 를 태스크 파일 frontmatter 에 넣을 YAML 블록으로. */
function formatContextFilesYaml(files) {
  const norm = normalize(files);
  if (!norm.length) return 'context_files: []';
  const esc = s => String(s).replace(/"/g, '\\"');
  return ['context_files:'].concat(
    norm.map(f => [
      `  - path: ${f.path}`,
      `    reason: "${esc(f.reason)}"`,
      `    max_chars: ${f.max_chars || modelConfig.contextLimits().perFileMaxChars}`,
    ].join('\n'))
  ).join('\n');
}

/**
 * 태스크 파일 본문에서 선택 컨텍스트 목록을 복원한다.
 * 신규 형식(context_files: YAML) 우선, 없으면 구 형식(`#   - path — reason` 주석)도 읽는다(하위 호환).
 */
function parseContextFiles(taskContent) {
  const text = String(taskContent || '');

  const block = text.match(/^context_files:\s*(\[\]|\r?\n(?:[ \t]+.*\r?\n?)*)/m);
  if (block) {
    if (block[1].trim() === '[]') return [];
    const out = [];
    let cur = null;
    for (const raw of block[1].split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      const p = line.match(/^\s*-\s*path:\s*(.+)$/);
      if (p) { if (cur) out.push(cur); cur = { path: p[1].trim(), reason: '', max_chars: undefined }; continue; }
      if (!cur) continue;
      const r = line.match(/^\s*reason:\s*(.+)$/);
      if (r) { cur.reason = r[1].trim().replace(/^"|"$/g, '').replace(/\\"/g, '"'); continue; }
      const m = line.match(/^\s*max_chars:\s*(\d+)\s*$/);
      if (m) { cur.max_chars = Number(m[1]); continue; }
    }
    if (cur) out.push(cur);
    if (out.length) return out;
  }

  // 하위 호환: `#   - <path> — <reason>` 주석 형식
  const legacy = [];
  const legacyBlock = text.match(/#\s*분석에 로드된 컨텍스트 파일[^\n]*\n((?:#\s+-\s+[^\n]*\n?)+)/);
  if (legacyBlock) {
    for (const line of legacyBlock[1].split(/\r?\n/)) {
      const m = line.match(/^#\s+-\s+(\S+)\s+—\s*(.*)$/);
      if (m) legacy.push({ path: m[1], reason: m[2].trim() });
    }
  }
  return legacy;
}

/** filesRead 항목을 {path, reason, max_chars} 로 정규화(문자열/절대경로 입력 후방호환). */
function normalize(files, baseDir = null) {
  const per = modelConfig.contextLimits().perFileMaxChars;
  return (files || []).map(f => {
    if (typeof f === 'string') {
      const rel = (baseDir && path.isAbsolute(f))
        ? path.relative(baseDir, f).replace(/\\/g, '/')
        : f.replace(/\\/g, '/');
      return { path: rel, reason: '(직접 지정)', max_chars: per };
    }
    return {
      path: String((f && f.path) || '').replace(/\\/g, '/'),
      reason: (f && f.reason) || '(사유 미기재)',
      max_chars: (f && Number(f.max_chars)) || per,
    };
  }).filter(f => f.path);
}

module.exports = {
  buildContextCatalog,
  formatCatalogForPrompt,
  selectContextFilesStatic,
  narrowCatalog,
  readSelectedContext,
  minimalDefaultContext,
  condenseMarkdown,
  formatContextFilesYaml,
  parseContextFiles,
  normalize,
  tokenize,
  getMeta,
  getBody,
  resetCaches,
  MINIMAL_DEFAULTS,
};
