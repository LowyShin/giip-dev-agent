/**
 * i18n-ui.js — giip #1971: 봇 UI 전반(질문 응답 확인, 태스크 생명주기 알림, 일반 오류 등)에
 * 흩어진 하드코딩 한국어 문자열 다국어화 1차분.
 *
 * i18n-issue-reg.js(giip #1252, `issue 등록` 확인/에러 메시지 전용)와 같은 패턴을 그대로 따른다:
 * MESSAGES = { ko: {key: () => '...'}, en: {...}, ja: {...} } — 언어별 함수 객체가 보간까지
 * 끝낸 문자열을 직접 반환한다(별도 interpolate() 헬퍼 없음). 이 저장소의 기존 로컬 컨벤션을
 * 재사용하는 편이 lowyworkenv(별도 코드베이스)의 STRINGS 평면 테이블 패턴을 새로 들여오는 것보다
 * 일관적이라 판단해 그대로 확장했다.
 *
 * 범위(giip #1971 1차분): answerInChannel(Q&A 흐름) 확인/자동PR 알림, DM 일반 오류/태스크 미발견,
 * drainNextQueued 자동 기동 알림, `머지완료 <id>` 보류 태스크 재개 흐름, taskmerge 중복 없음 응답.
 * 범위(giip #1972 추가분): allowlist 설정 표시, 워크플로우 지시 모호/미일치 안내, 태스크 상태/참조
 * 조회(handleDM·handleChannelMention), 태스크 ID 배너, giip 연동 실패 라인, 라우팅(등급/컨텍스트) 라인.
 * 남은 하드코딩 문자열(task 완료/에러 헤드라인 블록 — 조건분기가 깊어 별도 세션 필요, 하드코딩 일본어
 * !help/tasklist 등 — 한글 다국어화와 별개 결함, giip-commands.js)은 이번 범위 밖 — 후속 giip issue 로 남긴다.
 *
 * 설계 원칙 — 하위호환 최우선: 미등록 프로젝트, 미번역 key, 아직 안 채운 언어(zh-CN/zh-TW 등) →
 * 반드시 기존 한글 문자열 그대로 폴백한다. 각 항목의 `ko` 값은 원래 하드코딩돼 있던 문자열과
 * 완전히 동일해야 한다(byte-for-byte). 지원 언어 코드는 config.js LANG_NAMES 와 동일
 * (ko/ja/en/zh-CN/zh-TW). 미지원/미상 코드는 ko 로 폴백.
 */

const MESSAGES = {
  ko: {
    qnaAck: () => '💬 질문을 확인했습니다. 답변을 준비 중입니다…',
    qnaAutoPrHeader: () => '📝 *답변 중 파일 변경 감지 → 자동 브랜치/PR* (질문 경로 안전망)',
    qnaAutoPrManual: ({ repo, reason }) => `⚠️ 수동 필요: ${repo} (${reason})`,
    qnaAutoPrBlocked: ({ repo, prs, branch }) => `🚧 보류: ${repo} — 미머지 PR ${prs} 과 같은 파일. 브랜치 \`${branch}\` push 됨(선행 PR 머지 후 수동 PR/rebase 필요).`,
    commonError: ({ message }) => `오류: ${message}`,
    taskNotFound: ({ taskId }) => `⚠️ 태스크 \`${taskId}\`를 찾을 수 없습니다.`,
    taskAutoStart: ({ taskId }) => `▶️ 작업트리가 비었습니다 — 대기 중이던 \`${taskId}\` 을(를) 자동 기동합니다.`,
    resumeNotBlocked: ({ taskId }) => `⚠️ \`${taskId}\` 는 보류(blocked) 상태가 아닙니다. \`tasklist all\` 로 상태를 확인하세요.`,
    resuming: ({ taskId }) => `🔄 \`${taskId}\` 재개: 선행 PR 머지 반영(base pull→rebase) 후 PR 생성 중...`,
    resumeFailed: ({ message }) => `❌ 재개 실패: ${message}`,
    resumeStillBlocked: ({ repo, reason }) => `🚧 여전히 보류: ${repo} — ${reason}`,
    resumeFailedRepo: ({ repo, reason }) => `⚠️ 실패: ${repo} — ${reason}`,
    resumePartial: ({ taskId }) => `⏸️ *\`${taskId}\` 일부 재개*`,
    resumeComplete: ({ taskId }) => `✅ *\`${taskId}\` 재개 완료*`,
    resumeNoChange: () => '(변경 없음)',
    resumeManualNote: ({ taskId }) => `여전히 conflict/실패인 저장소는 수동 해소가 필요합니다. 해소 후 다시 \`머지완료 ${taskId}\`.`,
    taskNoDuplicates: () => '🔍 통합 대상 중복 미완료 태스크가 없습니다.',
    // [giip #1972] 나머지 범위 — 태스크 상태/참조 조회, 워크플로우 지시, allowlist, 라우팅 라인
    taskIdBanner: ({ ids }) => `[태스크 \`${ids}\`]`,
    taskUnknownStatus: () => '알수없음',
    taskNoContent: () => '(내용 없음)',
    statusReportHeader: ({ taskId, status, request }) => `*태스크 \`${taskId}\` — 상태 보고*\n• 상태: ${status}\n• 내용: ${request}`,
    statusReportLog: ({ logLines }) => `\n\n*진행 로그(최근):*\n${logLines}`,
    statusReportActions: ({ taskId }) => `\n\n실행: \`go ${taskId}\` | 취소: \`cancel ${taskId}\``,
    taskRef: ({ taskId, status, request, activeFile }) => `📌 태스크 \`${taskId}\` 참조:\n• 상태: ${status}\n• 내용: ${request}\n📁 파일: \`${activeFile}\`\n\n실행: \`go ${taskId}\` | 취소: \`cancel ${taskId}\``,
    taskNotFoundShort: ({ taskId }) => `⚠️ 태스크 \`${taskId}\`를 찾을 수 없습니다.`,
    taskNotFoundTasklist: ({ taskId }) => `⚠️ Task \`${taskId}\`를 찾을 수 없습니다.\n\`tasklist\`로 목록을 확인하세요.`,
    wfAmbiguous: ({ query, list }) => `🔎 \`${query}\`에 일치하는 워크플로우가 여러 개 있습니다. 하나로 좁혀주세요:\n${list}`,
    wfNotFound: ({ projName, query, list }) => `❓ \`${projName}\`에 \`${query}\`라는 워크플로우가 없습니다.\n사용 가능:\n${list}\n\n목록: \`${projName} wflist\``,
    wfListNone: () => '(없음)',
    giipLinkFailed: ({ error }) => `\n⚠️ giip issue 연동 실패(${error}) — 로컬 태스크 번호로 진행합니다`,
    routeLine: ({ cls, fastPathSuffix, fileCount, charsSuffix }) => `\n🧭 등급: \`${cls}\`${fastPathSuffix} / 컨텍스트 ${fileCount}개 파일${charsSuffix}`,
    routeFastPath: () => ' (Fast Path — 계획 생성 호출 생략)',
    routeChars: ({ chars }) => ` · ${chars}자`,
    allowlistTitle: () => '*🔐 Allowlist 설정 (SLACK_ALLOWED_USERS / SLACK_CHANNEL_IDS)*',
    allowlistUsersLabel: () => '*허용된 유저:*',
    allowlistChannelsLabel: () => '*허용된 채널:*',
    allowlistUserLookupFail: ({ id }) => `• ${id} ⚠️ 조회 실패(존재하지 않는 ID일 수 있음)`,
    allowlistChannelLookupFail: ({ id }) => `• ${id} ⚠️ 조회 실패(존재하지 않는 채널일 수 있음)`,
    allowlistNoUsers: () => '(없음 — 화이트리스트 미설정, 전체 유저 허용됨)',
    allowlistNoChannels: () => '(없음 — 채널 제한 미설정)',
  },
  en: {
    qnaAck: () => '💬 Got your question. Preparing an answer…',
    qnaAutoPrHeader: () => '📝 *File changes detected while answering → auto branch/PR* (Q&A path safety net)',
    qnaAutoPrManual: ({ repo, reason }) => `⚠️ Manual action needed: ${repo} (${reason})`,
    qnaAutoPrBlocked: ({ repo, prs, branch }) => `🚧 Held: ${repo} — same files as unmerged PR ${prs}. Pushed to branch \`${branch}\` (manual PR/rebase needed after the earlier PR merges).`,
    commonError: ({ message }) => `Error: ${message}`,
    taskNotFound: ({ taskId }) => `⚠️ Task \`${taskId}\` not found.`,
    taskAutoStart: ({ taskId }) => `▶️ Worktree is free — auto-starting the queued task \`${taskId}\`.`,
    resumeNotBlocked: ({ taskId }) => `⚠️ \`${taskId}\` is not in blocked state. Check status with \`tasklist all\`.`,
    resuming: ({ taskId }) => `🔄 Resuming \`${taskId}\`: applying the merged base PR (pull→rebase) and generating a PR...`,
    resumeFailed: ({ message }) => `❌ Resume failed: ${message}`,
    resumeStillBlocked: ({ repo, reason }) => `🚧 Still blocked: ${repo} — ${reason}`,
    resumeFailedRepo: ({ repo, reason }) => `⚠️ Failed: ${repo} — ${reason}`,
    resumePartial: ({ taskId }) => `⏸️ *\`${taskId}\` partially resumed*`,
    resumeComplete: ({ taskId }) => `✅ *\`${taskId}\` resume complete*`,
    resumeNoChange: () => '(no change)',
    resumeManualNote: ({ taskId }) => `Repos still in conflict/failed need manual resolution. After resolving, run \`머지완료 ${taskId}\` again.`,
    taskNoDuplicates: () => '🔍 No duplicate incomplete tasks to merge.',
    // [giip #1972]
    taskIdBanner: ({ ids }) => `[task \`${ids}\`]`,
    taskUnknownStatus: () => 'unknown',
    taskNoContent: () => '(no content)',
    statusReportHeader: ({ taskId, status, request }) => `*Task \`${taskId}\` — status report*\n• Status: ${status}\n• Content: ${request}`,
    statusReportLog: ({ logLines }) => `\n\n*Progress log (recent):*\n${logLines}`,
    statusReportActions: ({ taskId }) => `\n\nRun: \`go ${taskId}\` | Cancel: \`cancel ${taskId}\``,
    taskRef: ({ taskId, status, request, activeFile }) => `📌 Task \`${taskId}\` reference:\n• Status: ${status}\n• Content: ${request}\n📁 File: \`${activeFile}\`\n\nRun: \`go ${taskId}\` | Cancel: \`cancel ${taskId}\``,
    taskNotFoundShort: ({ taskId }) => `⚠️ Task \`${taskId}\` not found.`,
    taskNotFoundTasklist: ({ taskId }) => `⚠️ Task \`${taskId}\` not found.\nCheck the list with \`tasklist\`.`,
    wfAmbiguous: ({ query, list }) => `🔎 Multiple workflows match \`${query}\`. Please narrow it down:\n${list}`,
    wfNotFound: ({ projName, query, list }) => `❓ No workflow named \`${query}\` in \`${projName}\`.\nAvailable:\n${list}\n\nList: \`${projName} wflist\``,
    wfListNone: () => '(none)',
    giipLinkFailed: ({ error }) => `\n⚠️ giip issue link failed (${error}) — proceeding with the local task number`,
    routeLine: ({ cls, fastPathSuffix, fileCount, charsSuffix }) => `\n🧭 Class: \`${cls}\`${fastPathSuffix} / context ${fileCount} file(s)${charsSuffix}`,
    routeFastPath: () => ' (Fast Path — plan-generation call skipped)',
    routeChars: ({ chars }) => ` · ${chars} chars`,
    allowlistTitle: () => '*🔐 Allowlist settings (SLACK_ALLOWED_USERS / SLACK_CHANNEL_IDS)*',
    allowlistUsersLabel: () => '*Allowed users:*',
    allowlistChannelsLabel: () => '*Allowed channels:*',
    allowlistUserLookupFail: ({ id }) => `• ${id} ⚠️ lookup failed (may be a non-existent ID)`,
    allowlistChannelLookupFail: ({ id }) => `• ${id} ⚠️ lookup failed (may be a non-existent channel)`,
    allowlistNoUsers: () => '(none — whitelist unset, all users allowed)',
    allowlistNoChannels: () => '(none — no channel restriction)',
  },
  ja: {
    qnaAck: () => '💬 質問を確認しました。回答を準備中です…',
    qnaAutoPrHeader: () => '📝 *回答中にファイル変更を検知 → 自動ブランチ/PR*（質問経路の安全網）',
    qnaAutoPrManual: ({ repo, reason }) => `⚠️ 手動対応が必要: ${repo} (${reason})`,
    qnaAutoPrBlocked: ({ repo, prs, branch }) => `🚧 保留: ${repo} — 未マージ PR ${prs} と同じファイル。ブランチ \`${branch}\` へ push 済み（先行 PR マージ後、手動 PR/rebase が必要）。`,
    commonError: ({ message }) => `エラー: ${message}`,
    taskNotFound: ({ taskId }) => `⚠️ タスク \`${taskId}\` が見つかりません。`,
    taskAutoStart: ({ taskId }) => `▶️ 作業ツリーが空きました — 待機中だった \`${taskId}\` を自動起動します。`,
    resumeNotBlocked: ({ taskId }) => `⚠️ \`${taskId}\` は保留(blocked)状態ではありません。\`tasklist all\` で状態を確認してください。`,
    resuming: ({ taskId }) => `🔄 \`${taskId}\` 再開: 先行 PR のマージを反映(base pull→rebase)して PR 生成中...`,
    resumeFailed: ({ message }) => `❌ 再開失敗: ${message}`,
    resumeStillBlocked: ({ repo, reason }) => `🚧 まだ保留: ${repo} — ${reason}`,
    resumeFailedRepo: ({ repo, reason }) => `⚠️ 失敗: ${repo} — ${reason}`,
    resumePartial: ({ taskId }) => `⏸️ *\`${taskId}\` 一部再開*`,
    resumeComplete: ({ taskId }) => `✅ *\`${taskId}\` 再開完了*`,
    resumeNoChange: () => '(変更なし)',
    resumeManualNote: ({ taskId }) => `まだ conflict/失敗の状態のリポジトリは手動対応が必要です。解消後、再度 \`머지완료 ${taskId}\` を実行してください。`,
    taskNoDuplicates: () => '🔍 統合対象の重複未完了タスクはありません。',
    // [giip #1972]
    taskIdBanner: ({ ids }) => `[タスク \`${ids}\`]`,
    taskUnknownStatus: () => '不明',
    taskNoContent: () => '(内容なし)',
    statusReportHeader: ({ taskId, status, request }) => `*タスク \`${taskId}\` — 状態レポート*\n• 状態: ${status}\n• 内容: ${request}`,
    statusReportLog: ({ logLines }) => `\n\n*進捗ログ(最近):*\n${logLines}`,
    statusReportActions: ({ taskId }) => `\n\n実行: \`go ${taskId}\` | キャンセル: \`cancel ${taskId}\``,
    taskRef: ({ taskId, status, request, activeFile }) => `📌 タスク \`${taskId}\` 参照:\n• 状態: ${status}\n• 内容: ${request}\n📁 ファイル: \`${activeFile}\`\n\n実行: \`go ${taskId}\` | キャンセル: \`cancel ${taskId}\``,
    taskNotFoundShort: ({ taskId }) => `⚠️ タスク \`${taskId}\` が見つかりません。`,
    taskNotFoundTasklist: ({ taskId }) => `⚠️ Task \`${taskId}\` が見つかりません。\n\`tasklist\` で一覧を確認してください。`,
    wfAmbiguous: ({ query, list }) => `🔎 \`${query}\` に一致するワークフローが複数あります。1つに絞ってください:\n${list}`,
    wfNotFound: ({ projName, query, list }) => `❓ \`${projName}\` に \`${query}\` というワークフローがありません。\n利用可能:\n${list}\n\n一覧: \`${projName} wflist\``,
    wfListNone: () => '(なし)',
    giipLinkFailed: ({ error }) => `\n⚠️ giip issue 連携失敗(${error}) — ローカルのタスク番号で進めます`,
    routeLine: ({ cls, fastPathSuffix, fileCount, charsSuffix }) => `\n🧭 等級: \`${cls}\`${fastPathSuffix} / コンテキスト ${fileCount}ファイル${charsSuffix}`,
    routeFastPath: () => ' (Fast Path — プラン生成呼び出しを省略)',
    routeChars: ({ chars }) => ` · ${chars}字`,
    allowlistTitle: () => '*🔐 Allowlist 設定 (SLACK_ALLOWED_USERS / SLACK_CHANNEL_IDS)*',
    allowlistUsersLabel: () => '*許可されたユーザー:*',
    allowlistChannelsLabel: () => '*許可されたチャンネル:*',
    allowlistUserLookupFail: ({ id }) => `• ${id} ⚠️ 照会失敗(存在しない ID の可能性)`,
    allowlistChannelLookupFail: ({ id }) => `• ${id} ⚠️ 照会失敗(存在しないチャンネルの可能性)`,
    allowlistNoUsers: () => '(なし — ホワイトリスト未設定、全ユーザー許可)',
    allowlistNoChannels: () => '(なし — チャンネル制限なし)',
  },
};

/** lang 코드(config.resolveLangForProject 결과) + 메시지 key + 변수로 로컬라이즈된 문자열을 얻는다. */
function t(langCode, key, vars = {}) {
  const table = MESSAGES[langCode] || MESSAGES.ko;
  const fn = table[key] || MESSAGES.ko[key];
  return fn ? fn(vars) : '';
}

module.exports = { t };
