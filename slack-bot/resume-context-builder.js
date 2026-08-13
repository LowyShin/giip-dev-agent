/**
 * resume-context-builder.js — fallback 재개 프롬프트에 실을 최소 컨텍스트 선택 (giip-1068, 4.5)
 *
 * 재개 프롬프트에는 최초 선택 컨텍스트 전체를 다시 넣지 않는다.
 * 다음 우선순위로 최대 3개(critical 4개) 파일/섹션만 고른다.
 *
 *   1. 실패한 단계와 직접 연결된 rule/skill
 *   2. 다음 미완료 단계에 필요한 role/skill
 *   3. 실패한 파일과 직접 연결된 프로젝트 규칙
 *
 * 상한(일반 / critical)
 *   파일 수      3 / 4
 *   파일당 문자   3,000 / 4,000
 *   전체 문자     8,000 / 14,000
 */

const path = require('path');

const modelConfig = require('./model-config');
const ctxBuilder = require('./context-builder');

/** 파일 확장 없는 이름 토큰(경로 매칭용). */
function baseTokens(p) {
  const b = path.basename(String(p || '')).toLowerCase();
  return [b, b.replace(/\.[^.]+$/, '')].filter(Boolean);
}

/**
 * 재개에 필요한 컨텍스트 파일을 고른다.
 *
 * @param {object} p
 *  - initialSelection {Array<{path,reason,max_chars}>} 최초 실행에서 선택했던 컨텍스트
 *  - failedStep       {string}   실패한 단계 설명
 *  - pendingSteps     {string[]} 미완료 단계
 *  - changedFiles     {string[]} 이미 변경한 소스 파일
 *  - errorSummary     {string}   이전 오류 요약
 *  - taskClass        {string}
 * @returns {Array<{path, reason, max_chars, priority}>}
 */
function selectResumeContext(p = {}) {
  const limits = modelConfig.resumeContextLimits(p.taskClass);
  const initial = (p.initialSelection || []).filter(f => f && f.path);
  if (!initial.length) return [];

  const failText = [p.failedStep || '', (p.pendingSteps || []).join(' '), p.errorSummary || '']
    .join(' ').toLowerCase();
  const failTerms = new Set(ctxBuilder.tokenize(failText));
  const changed = (p.changedFiles || []).map(f => String(f).toLowerCase());
  const changedTerms = new Set();
  for (const f of changed) for (const t of baseTokens(f)) changedTerms.add(t);

  const scored = initial.map((f, i) => {
    const rel = String(f.path).replace(/\\/g, '/');
    const low = rel.toLowerCase();
    const isRule = /\/rules?\//.test(low) || /\brule/.test(low);
    const isSkill = /\/skills?\//.test(low) || /skill\.md$/.test(low);
    const isRole = /\/roles?\//.test(low);

    const hay = new Set(ctxBuilder.tokenize(`${rel} ${f.reason || ''}`));
    let overlap = 0;
    for (const t of hay) if (failTerms.has(t)) overlap += 1;

    let priority = 4;                       // 기본: 우선순위 밖
    let reason = f.reason || '(사유 미기재)';
    if (overlap > 0 && (isRule || isSkill)) {
      priority = 1;
      reason = `실패한 단계와 직접 연결된 ${isRule ? 'rule' : 'skill'} — ${reason}`;
    } else if (overlap > 0 && (isRole || isSkill)) {
      priority = 2;
      reason = `다음 미완료 단계에 필요한 ${isRole ? 'role' : 'skill'} — ${reason}`;
    } else {
      let touches = 0;
      for (const t of hay) if (changedTerms.has(t)) touches += 1;
      if (touches > 0) {
        priority = 3;
        reason = `이미 변경한 파일과 직접 연결된 규칙 — ${reason}`;
      } else if (isRule) {
        // 실패와 직접 연결되진 않지만 "요청 범위 밖 수정 금지" 같은 공통 가드레일은 남긴다.
        priority = 3.5;
        reason = `재개 시에도 지켜야 할 공통 규칙 — ${reason}`;
      }
    }
    return { f, i, priority, overlap, reason };
  });

  scored.sort((a, b) => a.priority - b.priority || b.overlap - a.overlap || a.i - b.i);

  return scored
    .filter(s => s.priority <= 3.5)
    .slice(0, limits.maxFiles)
    .map(s => ({
      path: String(s.f.path).replace(/\\/g, '/'),
      reason: s.reason,
      max_chars: limits.perFileMaxChars,
      priority: s.priority,
    }));
}

/**
 * 고른 파일을 실제로 읽어 재개 프롬프트용 문자열을 만든다.
 * @returns {{context:string, filesRead:Array, stats:object, limits:object}}
 */
function readResumeContext(selected, baseDir, opts = {}) {
  const limits = modelConfig.resumeContextLimits(opts.taskClass);
  if (!selected || !selected.length) {
    return { context: '', filesRead: [], stats: { files: 0, chars: 0 }, limits };
  }
  const r = ctxBuilder.readSelectedContext(selected.slice(0, limits.maxFiles), baseDir, {
    workspaceDir: opts.workspaceDir || baseDir,
    queryText: opts.queryText || '',
    limits: {
      minFiles: 0,
      defaultMaxFiles: limits.maxFiles,
      hardMaxFiles: limits.maxFiles,
      perFileMaxChars: limits.perFileMaxChars,
      totalMaxChars: limits.totalMaxChars,
    },
  });
  // 상한을 1자라도 넘지 않도록 최종 방어 클립(테스트 F 기준).
  let context = r.context;
  if (context.length > limits.totalMaxChars) {
    context = `${context.slice(0, limits.totalMaxChars - 30)}\n…(재개 컨텍스트 상한 초과分 생략)`;
  }
  return { context, filesRead: r.filesRead, stats: { ...r.stats, chars: context.length }, limits };
}

module.exports = { selectResumeContext, readResumeContext };
