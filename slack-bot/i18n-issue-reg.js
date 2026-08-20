/**
 * i18n-issue-reg.js — giip #1252: `issue 등록` 트리거(handlers.js handleChannelMention)의
 * 확인/에러 메시지 다국어화.
 *
 * 범위 한정(rule): 이슈 등록 성공/실패, 계정·csn 안내 메시지만. 봇 UI 전반에 흩어진 다른 하드코딩
 * 한국어 문자열(!help, giip project/channel 안내 등)은 이번 PR 범위 밖 — 후속 이슈 후보로 남긴다
 * (PR 본문 참고). 트리거 자체(등록/登録/register, issue/이슈/イシュー)와 등록되는 내용(content)은
 * 이미 언어 무관하게 그대로 통과되므로 손대지 않는다.
 *
 * 지원 언어 코드는 config.js LANG_NAMES 와 동일(ko/ja/en/zh-CN/zh-TW). 미지원/미상 코드는 ko 로 폴백.
 */

const MESSAGES = {
  ko: {
    usage: () => '사용법: `<프로젝트> issue 등록 <내용>` — 내용을 그대로 giip issue 로 등록합니다.',
    noAccount: () => '⚠️ giip 계정 미설정입니다. `giip account set <login_id> <sk> [csn]` 로 먼저 등록하세요(SK 포함이라 DM 권장).',
    analyzing: () => '🔍 의뢰 내용을 분석해 작업지시서로 정리 중입니다... (수십 초 소요)',
    doneReady: ({ isn, title, plan }) => [
      `✅ giip issue #${isn} 등록 완료 (READY · 작업지시서 첨부 → 자동 처리 대기)`,
      `• 제목: ${title}`,
      '',
      '```',
      plan,
      '```',
    ].join('\n'),
    donePending: ({ isn, title }) => `✅ giip issue #${isn} 등록 완료 (PENDING · 무인 refine 대기)\n• 제목: ${title}`,
    doneQueued: ({ isn, title }) => `✅ giip issue #${isn} 등록 완료 (PENDING · 대기열 등록 → 자동 처리 대기)\n• 제목: ${title}`,
    noIsn: () => '⚠️ issue 등록 응답에 isn 이 없습니다. 계정/CSN 설정을 확인하세요.',
    error: ({ message }) => `❌ issue 등록 실패: ${message}`,
  },
  en: {
    usage: () => 'Usage: `<project> issue register <content>` — registers the content as-is as a giip issue.',
    noAccount: () => '⚠️ No giip account configured. Run `giip account set <login_id> <sk> [csn]` first (contains a secret key — DM is recommended).',
    analyzing: () => '🔍 Analyzing the request and drafting a work order... (can take tens of seconds)',
    doneReady: ({ isn, title, plan }) => [
      `✅ giip issue #${isn} registered (READY · work order attached → queued for automatic processing)`,
      `• Title: ${title}`,
      '',
      '```',
      plan,
      '```',
    ].join('\n'),
    donePending: ({ isn, title }) => `✅ giip issue #${isn} registered (PENDING · awaiting unattended refine)\n• Title: ${title}`,
    doneQueued: ({ isn, title }) => `✅ giip issue #${isn} registered (PENDING · queued → awaiting automatic processing)\n• Title: ${title}`,
    noIsn: () => '⚠️ The issue registration response had no isn. Check your account/CSN configuration.',
    error: ({ message }) => `❌ Issue registration failed: ${message}`,
  },
  ja: {
    usage: () => '使い方: `<プロジェクト> issue 登録 <内容>` — 内容をそのまま giip issue として登録します。',
    noAccount: () => '⚠️ giip アカウント未設定です。先に `giip account set <login_id> <sk> [csn]` で登録してください(SK を含むため DM 推奨)。',
    analyzing: () => '🔍 依頼内容を分析して作業指示書にまとめています…(数十秒かかります)',
    doneReady: ({ isn, title, plan }) => [
      `✅ giip issue #${isn} 登録完了 (READY・作業指示書添付 → 自動処理待ち)`,
      `• タイトル: ${title}`,
      '',
      '```',
      plan,
      '```',
    ].join('\n'),
    donePending: ({ isn, title }) => `✅ giip issue #${isn} 登録完了 (PENDING・無人 refine 待ち)\n• タイトル: ${title}`,
    doneQueued: ({ isn, title }) => `✅ giip issue #${isn} 登録完了 (PENDING・キュー登録 → 自動処理待ち)\n• タイトル: ${title}`,
    noIsn: () => '⚠️ issue 登録応答に isn がありません。アカウント/CSN 設定を確認してください。',
    error: ({ message }) => `❌ issue 登録失敗: ${message}`,
  },
  'zh-CN': {
    usage: () => '用法: `<项目> issue register <内容>` — 将内容原样注册为 giip issue。',
    noAccount: () => '⚠️ 尚未配置 giip 账户。请先执行 `giip account set <login_id> <sk> [csn]`(含密钥,建议使用私信)。',
    analyzing: () => '🔍 正在分析请求内容并整理成工单...(可能需要几十秒)',
    doneReady: ({ isn, title, plan }) => [
      `✅ giip issue #${isn} 注册完成 (READY · 已附工单 → 等待自动处理)`,
      `• 标题: ${title}`,
      '',
      '```',
      plan,
      '```',
    ].join('\n'),
    donePending: ({ isn, title }) => `✅ giip issue #${isn} 注册完成 (PENDING · 等待无人值守整理)\n• 标题: ${title}`,
    doneQueued: ({ isn, title }) => `✅ giip issue #${isn} 注册完成 (PENDING · 已加入队列 → 等待自动处理)\n• 标题: ${title}`,
    noIsn: () => '⚠️ issue 注册响应中没有 isn。请检查账户/CSN 设置。',
    error: ({ message }) => `❌ issue 注册失败: ${message}`,
  },
  'zh-TW': {
    usage: () => '用法: `<專案> issue register <內容>` — 將內容原樣註冊為 giip issue。',
    noAccount: () => '⚠️ 尚未設定 giip 帳戶。請先執行 `giip account set <login_id> <sk> [csn]`(含密鑰,建議使用私訊)。',
    analyzing: () => '🔍 正在分析請求內容並整理成工單...(可能需要幾十秒)',
    doneReady: ({ isn, title, plan }) => [
      `✅ giip issue #${isn} 註冊完成 (READY · 已附工單 → 等待自動處理)`,
      `• 標題: ${title}`,
      '',
      '```',
      plan,
      '```',
    ].join('\n'),
    donePending: ({ isn, title }) => `✅ giip issue #${isn} 註冊完成 (PENDING · 等待無人值守整理)\n• 標題: ${title}`,
    doneQueued: ({ isn, title }) => `✅ giip issue #${isn} 註冊完成 (PENDING · 已加入佇列 → 等待自動處理)\n• 標題: ${title}`,
    noIsn: () => '⚠️ issue 註冊回應中沒有 isn。請檢查帳戶/CSN 設定。',
    error: ({ message }) => `❌ issue 註冊失敗: ${message}`,
  },
};

/** lang 코드(config.resolveLangForProject 결과) + 메시지 key + 변수로 로컬라이즈된 문자열을 얻는다. */
function t(langCode, key, vars = {}) {
  const table = MESSAGES[langCode] || MESSAGES.ko;
  const fn = table[key] || MESSAGES.ko[key];
  return fn ? fn(vars) : '';
}

module.exports = { t };
