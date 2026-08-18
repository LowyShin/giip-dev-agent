/**
 * giip-commands.js — Slack `giip ...` 커맨드 핸들러 (자립 모듈).
 * index.js 는 한 줄 훅으로 연결:
 *   const gc = await handleGiipCommand(text, channelId); if (gc.handled) { await reply(gc.text); return; }
 * 설계: docs/DESIGN_slackbot_giip_issue_integration.md §5. 규칙 39/40.
 */
const accounts = require('./giip-accounts');
const giip = require('./giip-api');
const config = require('./config');

function code(obj, max = 1800) {
  return '```\n' + JSON.stringify(obj, null, 2).slice(0, max) + '\n```';
}

// Slack이 이메일/URL 같은 토큰을 자동으로 `<mailto:x|y>`/`<url|label>` 형태로 링크화해서
// 보내는 경우가 있다. 이걸 안 벗기면 login_id 등에 꺾쇠·파이프가 그대로 저장된다.
function stripSlackAutolink(s) {
  if (!s) return s;
  return String(s)
    .replace(/^<mailto:([^|>]+)\|[^>]*>$/i, '$1')
    .replace(/^<mailto:([^>]+)>$/i, '$1')
    .replace(/^<([^|>]+)\|[^>]*>$/, '$1')
    .replace(/^<([^>]+)>$/, '$1');
}

/**
 * @returns {Promise<{handled:boolean, text?:string}>}
 */
async function handleGiipCommand(rawText, channelId) {
  const text = (rawText || '').trim();
  const m = text.match(/^giip\s+(\S+)\s*([\s\S]*)$/i);
  if (!m) return { handled: false };
  const sub = m[1].toLowerCase();
  const rest = (m[2] || '').trim();

  // ── giip account ... — 채널 계정 매핑(대화로 변경 → .secrets 영속화) ──
  if (sub === 'account') {
    const setM = rest.match(/^set(-default)?\s+(\S+)\s+(\S+)\s*(\d+)?/i);
    if (setM) {
      const asDefault = !!setM[1];
      const login_id = stripSlackAutolink(setM[2]);
      const sk = stripSlackAutolink(setM[3]);
      const csn = setM[4] || null;
      accounts.setAccount(asDefault ? null : channelId, { login_id, sk, csn }, asDefault);
      return {
        handled: true,
        text: `✅ giip 계정 저장(${asDefault ? 'default' : channelId}) — login=${login_id}${csn ? `, csn=${csn}` : ''}.\n⚠️ 보안: SK 가 포함된 이 메시지는 삭제하세요.`,
      };
    }
    if (/^(show|status)/i.test(rest)) {
      const acct = accounts.resolve(channelId);
      return {
        handled: true,
        text: acct ? `login=${acct.login_id}, csn=${acct.csn ?? '-'} (SK 숨김)` : '계정 미설정',
      };
    }
    return {
      handled: true,
      text: '사용법: `giip account set <login_id> <sk> [csn]` | `set-default <login_id> <sk> [csn]` | `show`',
    };
  }

  // ── giip project ... — 프로젝트명 ↔ csn 매핑 관리(project-csn.json, 재시작 불필요) ──
  //   giip 계정과 무관하므로 account 확인 게이트보다 먼저 처리한다.
  //   `<프로젝트명> issue 등록 <내용>` 이 어떤 csn 으로 등록되는지를 여기서 관리.
  if (sub === 'project' || sub === 'proj' || sub === 'csn') {
    // ── giip project lang ... — 프로젝트별 AI 응답 언어 관리(project-lang.json, 재시작 불필요) ──
    //   giip-974: "Always respond in Korean" 전역 하드코딩을 대체 — 미등록 프로젝트는 ko 로 폴백.
    const langMatch = rest.match(/^lang\s+(set|del|delete|rm|remove|list|ls|show)?\s*([\s\S]*)$/i);
    if (langMatch) {
      const langAction = (langMatch[1] || 'list').toLowerCase();
      const largs = (langMatch[2] || '').trim();
      const LANG_USAGE = '사용법: `giip project lang set <프로젝트명> <언어코드(ko/ja/en/zh-CN/zh-TW)>` | `giip project lang list` | `giip project lang del <프로젝트명>`';
      try {
        if (langAction === 'set') {
          const sm = largs.match(/^(\S+)\s+(\S+)$/);
          if (!sm) return { handled: true, text: LANG_USAGE };
          const { name, lang } = config.setProjectLang(sm[1], sm[2]);
          return {
            handled: true,
            text: `✅ 프로젝트 언어 설정 저장: \`${name}\` → \`${lang}\`\n이제 \`${name}\` 프로젝트의 AI 응답은 이 언어로 지정됩니다(봇 재시작 불필요).`,
          };
        }
        if (langAction === 'del' || langAction === 'delete' || langAction === 'rm' || langAction === 'remove') {
          const name = largs.split(/\s+/)[0];
          if (!name) return { handled: true, text: LANG_USAGE };
          const ok = config.deleteProjectLang(name);
          return { handled: true, text: ok ? `✅ 언어 설정 삭제: \`${name.toLowerCase()}\`(기본값 ko로 폴백)` : `⚠️ \`${name.toLowerCase()}\` 언어 설정이 없습니다.` };
        }
        const lmap = config.listProjectLang();
        const lkeys = Object.keys(lmap);
        const lbody = lkeys.length ? lkeys.map((k) => `• \`${k}\` → \`${lmap[k]}\``).join('\n') : '(등록된 언어 설정 없음, 전부 기본값 ko)';
        return { handled: true, text: `📋 프로젝트 → 응답언어 매핑 (project-lang.json)\n${lbody}\n\n${LANG_USAGE}` };
      } catch (e) {
        return { handled: true, text: `❌ ${e.message}\n${LANG_USAGE}` };
      }
    }
    const pm = rest.match(/^(set|add|del|delete|rm|remove|list|ls|show)?\s*([\s\S]*)$/i);
    const action = (pm && pm[1] ? pm[1].toLowerCase() : 'list');
    const pargs = pm ? (pm[2] || '').trim() : '';
    const USAGE = '사용법: `giip project set <프로젝트명> <csn>` | `giip project list` | `giip project del <프로젝트명>`';
    try {
      if (action === 'set' || action === 'add') {
        const sm = pargs.match(/^(\S+)\s+(-?\d+)$/);
        if (!sm) return { handled: true, text: USAGE };
        const { name, csn } = config.setProjectCsn(sm[1], sm[2]);
        // ── DB 멤버십 자동 부여 ──
        // map 저장만으로는 pApiGiipIssuePutbyAK 의 멤버십 게이트가 홈 CSN(47)으로 클램프한다.
        // 봇 SK 로 pApiUserPerCorpGrantBotbySk 를 호출해 tUserPerCorp 에 (봇usn, csn) 을 멱등 부여하면
        // 그 즉시 그 csn 으로 라우팅된다(수동 시드/재배포 불필요). 계정 미설정·실패는 비치명(map 은 저장됨).
        let grantLine = '';
        const acctForGrant = accounts.resolve(channelId);
        if (Number(csn) === 47) {
          grantLine = '\n(홈 CSN 47 은 항상 허용되므로 멤버십 부여 불필요)';
        } else if (!acctForGrant) {
          grantLine = '\n⚠️ giip 계정 미설정이라 DB 멤버십은 부여하지 못했습니다. `giip account set ...` 후 다시 `set` 하세요.';
        } else {
          try {
            const g = await giip.grantBotCsn(acctForGrant, csn);
            if (g.ok) grantLine = g.already
              ? `\n🟢 DB 멤버십 이미 존재 (tUserPerCorp usn↔csn ${csn}).`
              : `\n🟢 DB 멤버십 부여 완료 (tUserPerCorp += csn ${csn}). 다음 등록부터 바로 반영.`;
            else grantLine = `\n⚠️ DB 멤버십 부여 실패(RstVal=${g.rstVal ?? '?'}): ${g.msg || '알 수 없음'}. map 은 저장됨.`;
          } catch (e) {
            grantLine = `\n⚠️ DB 멤버십 부여 호출 오류: ${e.message}. map 은 저장됨.`;
          }
        }
        return {
          handled: true,
          text: `✅ 프로젝트 CSN 매핑 저장: \`${name}\` → csn ${csn}\n이제 \`${name} issue 등록 <내용>\` 은 csn ${csn} 로 등록됩니다(봇 재시작 불필요).${grantLine}`,
        };
      }
      if (action === 'del' || action === 'delete' || action === 'rm' || action === 'remove') {
        const name = pargs.split(/\s+/)[0];
        if (!name) return { handled: true, text: USAGE };
        const ok = config.deleteProjectCsn(name);
        return { handled: true, text: ok ? `✅ 매핑 삭제: \`${name.toLowerCase()}\`` : `⚠️ \`${name.toLowerCase()}\` 매핑이 없습니다.` };
      }
      // list / ls / show / (인자 없음)
      const map = config.listProjectCsn();
      const keys = Object.keys(map);
      const body = keys.length ? keys.map((k) => `• \`${k}\` → csn ${map[k]}`).join('\n') : '(등록된 매핑 없음)';
      return { handled: true, text: `📋 프로젝트 → CSN 매핑 (project-csn.json)\n${body}\n\n${USAGE}` };
    } catch (e) {
      return { handled: true, text: `❌ ${e.message}\n${USAGE}` };
    }
  }

  // ── giip channel ... — 채널 → 기본 프로젝트 고정 매핑(channel-project.json, 재시작 불필요) ──
  //   「이 채널의 발화는 모두 <project> 로 처리」. giip 계정과 무관하므로 account 게이트보다 먼저 처리.
  //   채널ID 생략 시 현재 채널에 적용. Rule 32 우선순위: 명시적 접두어 > 채널 고정.
  if (sub === 'channel' || sub === 'ch') {
    const cm = rest.match(/^(set|del|delete|rm|remove|list|ls|show)?\s*([\s\S]*)$/i);
    const action = (cm && cm[1] ? cm[1].toLowerCase() : 'list');
    const cargs = cm ? (cm[2] || '').trim() : '';
    const USAGE = '사용법: `giip channel set <프로젝트명> [채널ID]` | `giip channel list` | `giip channel del [채널ID]`';
    try {
      if (action === 'set') {
        // `set <프로젝트명> [채널ID]` — 채널ID 생략 시 현재 채널.
        const sm = cargs.match(/^(\S+)(?:\s+(\S+))?$/);
        if (!sm) return { handled: true, text: USAGE };
        const project = sm[1];
        const target = sm[2] || channelId;
        if (!target) return { handled: true, text: '채널ID를 확인할 수 없습니다. `giip channel set <프로젝트명> <채널ID>` 로 명시하세요.' };
        const { channelId: cid, project: pj } = config.setChannelProject(target, project);
        const csn = config.resolveProjectCsn(pj);
        return {
          handled: true,
          text: `✅ 채널 고정 매핑 저장: \`${cid}\` → \`${pj}\`${csn != null ? ` (csn ${csn})` : ' (project-csn.json 미등록 → account 기본 csn)'}\n이제 이 채널의 접두어 없는 메시지는 모두 \`${pj}\` 로 처리됩니다(봇 재시작 불필요). 명시적 프로젝트 접두어는 계속 우선합니다.`,
        };
      }
      if (action === 'del' || action === 'delete' || action === 'rm' || action === 'remove') {
        const target = cargs.split(/\s+/)[0] || channelId;
        if (!target) return { handled: true, text: USAGE };
        const ok = config.deleteChannelProject(target);
        return { handled: true, text: ok ? `✅ 채널 매핑 삭제: \`${target}\`` : `⚠️ \`${target}\` 매핑이 없습니다.` };
      }
      // list / ls / show / (인자 없음)
      const map = config.listChannelProject();
      const keys = Object.keys(map);
      const body = keys.length
        ? keys.map((k) => {
            const csn = config.resolveProjectCsn(map[k]);
            return `• \`${k}\` → \`${map[k]}\`${csn != null ? ` (csn ${csn})` : ''}${k === channelId ? ' ← 현재 채널' : ''}`;
          }).join('\n')
        : '(등록된 매핑 없음)';
      return { handled: true, text: `📌 채널 → 기본 프로젝트 매핑 (channel-project.json)\n${body}\n\n${USAGE}` };
    } catch (e) {
      return { handled: true, text: `❌ ${e.message}\n${USAGE}` };
    }
  }

  const acct = accounts.resolve(channelId);
  if (!acct) {
    return {
      handled: true,
      text: '⚠️ giip 계정 미설정. `giip account set <login_id> <sk> [csn]` 로 등록하세요(DM 권장).',
    };
  }

  // ── giip issue ... ──
  if (sub === 'issue') {
    // 자연어 의뢰 감지: `giip issue #604 <자연어 작업 지시>` 형식(에이전트 보고문을 그대로 복붙).
    //   - 번호만 → get(상세 조회)
    //   - 번호 뒤에 지시문이 붙으면 → 커맨드로 소비하지 않고(handled:false) 태스크 라우팅으로 넘겨
    //     에이전트가 "이슈 내용 확인 → 작업 → 코멘트"까지 수행하게 한다.
    //   (기존엔 '#604 …' 가 알 수 없는 action → list 로 떨어져 rest 전체가 status 필터가 되고,
    //    존재하지 않는 status 라 목록 0건 → '(이슈 없음)' 오답을 냈다. rule 39/40.)
    const leadNum = rest.match(/^#?(\d+)\b\s*([\s\S]*)$/);
    if (leadNum) {
      const after = (leadNum[2] || '').trim();
      if (after) return { handled: false }; // 자연어 지시 → 태스크 경로(handleChannelMention 이 이어서 처리)
      try { const i = await giip.issueGet(acct, Number(leadNum[1])); return { handled: true, text: code(i, 1500) }; }
      catch (e) { return { handled: true, text: `❌ ${e.message}` }; }
    }
    // `giip issue 등록 <내용>` → giipprj 등록 경로와 '동일하게' 위임(handled:false).
    //   등록/登録/register 는 list status 필터가 아니라 '등록 동사'다. 여기서 소비하면
    //   im 의 (\w+) 가 한글 '등록'을 못 잡아 action=list, arg='등록 …' 이 되고 status 0건 →
    //   '(이슈 없음)' 오답을 냈다(rule 39/40). handleChannelMention 의 issueTrigger 가 이어받아
    //   분석→작업지시서→READY 등록한다. 구분자(공백/콜론/말미) 필수로 '등록됐어?' 질문 오폭 방지
    //   (JS \b 는 ASCII 전용이라 한글 경계 미검출 → 명시 구분자 요구).
    if (/^(?:등록|登録|register)(?:\s+|\s*[:：]\s*|$)/i.test(rest)) return { handled: false };
    const im = rest.match(/^(\w+)?\s*([\s\S]*)$/);
    const action = (im && im[1] ? im[1] : 'list').toLowerCase();
    const arg = im ? (im[2] || '').trim() : '';
    try {
      if (action === 'new' || action === 'create') {
        const title = arg.replace(/^["']|["']$/g, '').trim() || '(무제)';
        const r = await giip.issueCreate(acct, { title, content: title, status: 'IN_PROGRESS' });
        return { handled: true, text: `✅ 이슈 생성 #${r.isn} — ${title}` };
      }
      // [giip #1211] 상태전이 코멘트는 giip.issueUpdate 내부에서 항상 자동 등록된다(giip-api.js 참고) —
      // 여기서는 어떤 Slack 명령이 트리거했는지만 reason 으로 넘긴다.
      if (action === 'done') { await giip.issueUpdate(acct, { isn: Number(arg), status: 'DONE' }, { reason: 'Slack 명령: giip issue done' }); return { handled: true, text: `✅ #${arg} → DONE` }; }
      if (action === 'review') { await giip.issueUpdate(acct, { isn: Number(arg), status: 'REVIEW' }, { reason: 'Slack 명령: giip issue review' }); return { handled: true, text: `✅ #${arg} → REVIEW` }; }
      if (action === 'progress' || action === 'start') { await giip.issueUpdate(acct, { isn: Number(arg), status: 'IN_PROGRESS' }, { reason: `Slack 명령: giip issue ${action}` }); return { handled: true, text: `✅ #${arg} → IN_PROGRESS` }; }
      if (action === 'get' || action === 'show') { const i = await giip.issueGet(acct, Number(arg)); return { handled: true, text: code(i, 1500) }; }
      if (action === 'comment') {
        const cm = arg.match(/^(\d+)\s+([\s\S]+)$/);
        if (cm) { await giip.issueComment(acct, Number(cm[1]), cm[2]); return { handled: true, text: `✅ #${cm[1]} 코멘트 추가` }; }
        return { handled: true, text: '사용법: `giip issue comment <isn> <내용>`' };
      }
      if (action === 'list') {
        const list = await giip.issueList(acct, { status: arg || '', csn: acct.csn || '' });
        return {
          handled: true,
          text: list.length ? list.slice(0, 20).map((i) => `#${i.isn} [${i.status}] ${i.title}`).join('\n') : '(이슈 없음)',
        };
      }
      return { handled: true, text: '사용법: `giip issue new "<title>"` | `list [status]` | `get <isn>` | `done|review|progress <isn>` | `comment <isn> <text>`' };
    } catch (e) {
      return { handled: true, text: `❌ ${e.message}` };
    }
  }

  // ── giip api <Verb> [jsondata] — 범용 giip API 호출 ──
  if (sub === 'api') {
    const am = rest.match(/^(\S+)\s*([\s\S]*)$/);
    if (!am) return { handled: true, text: '사용법: `giip api <Verb> [jsondata]`' };
    const verb = am[1];
    let jsondata = null;
    const jsonPart = (am[2] || '').trim();
    if (jsonPart) {
      try { jsondata = JSON.parse(jsonPart); } catch { return { handled: true, text: 'jsondata JSON 파싱 실패' }; }
    }
    try {
      const r = await giip.apiCall(acct, verb, jsondata);
      return { handled: true, text: code(r) };
    } catch (e) {
      return { handled: true, text: `❌ ${e.message}` };
    }
  }

  return { handled: false };
}

module.exports = { handleGiipCommand };
