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
 * 봇 UI 전반의 나머지 하드코딩 한글 문자열(!help, allowlist, 워크플로우 트리거, task
 * 완료/에러 헤드라인 등)은 이번 PR 범위 밖 — 후속 giip issue 로 남긴다(PR/코멘트 참고).
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
  },
};

/** lang 코드(config.resolveLangForProject 결과) + 메시지 key + 변수로 로컬라이즈된 문자열을 얻는다. */
function t(langCode, key, vars = {}) {
  const table = MESSAGES[langCode] || MESSAGES.ko;
  const fn = table[key] || MESSAGES.ko[key];
  return fn ? fn(vars) : '';
}

module.exports = { t };
