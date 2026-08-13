// intent.js — コマンド判定 + 意図分類（task / question）
// index.js から behavior-preserving で切り出し（ロジック変更なし）。

const { spawnAsync } = require('./claude-cli');
const accounts = require('./claude-accounts');
const { BASE_DIR } = require('./config');

// ── 確認コマンド判定 ──────────────────────────────────────────────────────────
const GO_WORDS = ['go', 'start', '시작', '실행', '진행', 'ok', 'yes', '예', '응', '開始', 'はい', 'よし', '実行', '進める'];
const CANCEL_WORDS = ['cancel', '취소', 'no', '아니', '중단', 'stop', 'キャンセル', '中断', 'やめ'];

function isGoCmd(text) {
  const t = text.trim().toLowerCase();
  // 完全一致 or 「<go語> 」で始まる場合のみ。以前は .includes('시작'/'진행') で
  // 部分一致していたため「…태스크 파일 만들어서 진행해줘」等の作業依頼文が
  // 誤って bare go コマンド扱いされていた（番号未発給の原因）。
  return GO_WORDS.some(w => t === w || t.startsWith(w + ' '));
}
function isCancelCmd(text) {
  const t = text.trim().toLowerCase();
  return CANCEL_WORDS.some(w => t === w || t.startsWith(w + ' '));
}

// ── 明示的タスク作成キーワード → 分類器をバイパスして強制 task 化 ──────────────
// 質問形で始まる複合文（「…맞아? … 태스크 파일 만들어」等）が classifyRequest で
// question に誤分類され、書込権限を持つ Q&A サブエージェントが番号を発給せずに
// ファイルを作ってしまう事故を防ぐ。これらの語があれば必ず管理タスク経路へ。
const FORCE_TASK_PATTERNS = [
  /태스크\s*등록/,
  /태스크\s*파일\s*(을|를)?\s*(만들|생성|작성)/,
  /태스크\s*(을|를)?\s*(만들|생성|작성)/,
  /작업\s*의뢰/,
  /タスク\s*(登録|作成|化)/,
  /task\s*(등록|추가|생성|作成|登録)/i,
  // 先頭が「태스크등록 …」または「task …」で始まる場合は強制タスク化。
  //   利用形: `<プロジェクト名> 태스크등록 <内容>` / `<プロジェクト名> task <内容>`
  //   （プロジェクト名は parseProjectPrefix で workDir に解決済み → ここでは cleanText の先頭）
  //   tasklist / taskmerge / task7days 等の管理コマンドや「task list」誤爆は否定先読みで除外。
  /^\s*(?:태스크\s*등록|task)\s+(?!list\b|리스트|목록|一覧|일람|merge\b|병합|7)\S/i,
  // 実行形(命令形)の指示 — 実装/修正/解決 等ディスク変更を伴う命令は task。
  //   命令形終結(…해줘/…해라/…해 주세요/…해봐)だけを対象にし、質問形(…돼 있어?/…했어?)と区別する。
  //   例: "…해결을 해라" / "구현해줘" / "수정해라" / "반영해 주세요"
  //   업데이트/갱신/번역/현행화 系(ディスク書込を伴う)も追加 — "…일본어로 업데이트 해줘"が
  //   決定的 fast-path を素通りして flaky LLM classifier で question に誤分類され、質問経路で
  //   ファイルが未コミットのまま残り PR 未生成になった事故(giip-629 追加依頼)を恒久修正する。
  /(구현|수정|해결|반영|적용|배포|개선|보완|생성|작성|처리|점검|리팩터링?|리팩토링|업데이트|업뎃|갱신|번역|현행화|일본어화)\s*(을|를|이|가)?\s*(해\s*줘|해라|하라|해\s*주세요|하세요|해봐|해다오|해\s*주라)/,
  //   고치다/만들다 系の命令形。
  /고쳐\s*(줘|라|주세요|주라)/,
  /만들어\s*(줘|라|주세요|주라)/,
  // 「計算/集計/推定 …(해서) 보여줘/표시/출력/노출」= ページに計算結果を描画する ⇒ コード変更(task)。
  //   「보여줘」単体は読み取り質問(例: "로그 보여줘" / "비용 보여줘")なので拾わず、計算系動詞との
  //   共起時のみ task 化して誤爆を防ぐ。恒久修正の契機: "이번 달 예상 금액을 계산해서 보여줘" が
  //   LLM classifier で question に誤分類され(実測 flaky: 프롬프트 예시조차 4/4 question)、giip issue
  //   未登録・PR 未生成のまま質問経路で直接編集される事故が起きた。決定的 fast-path で恒久化する。
  /(계산|집계|합산|추정|산출)\s*(을|를)?\s*(해서|하여|해\s*서|해|한|하도록)?\s*(보여|표시|노출|출력)\s*(해\s*)?(줘|주세요|주라|줄래|달라|다오|주세여)/,
];
function isForceTaskCmd(text) {
  const t = text.replace(/`/g, '');
  return FORCE_TASK_PATTERNS.some(re => re.test(t));
}

// ── 決定的 question fast-path: 純粋な「確認/照会」依頼 ─────────────────────────
// ユーザ指摘: 「…확인 가능해?」「…확인해줘」のような読み取り専用の確認依頼が
// LLM classifier(flaky)で task に誤分類され、不要な giip issue が発給された(#622)。
// ディスク書込を伴う動詞(구현/수정/저장/파일… force-task 相当)を一切含まず、
// 確認/照会マーカー(확인 가능/확인해줘/알려줘/뭐였는지/뭐야 等)のみで構成される
// メッセージは、LLM を呼ばず決定的に question として即答経路へ回す。
// 安全順序: 呼び出し側は必ず isForceTaskCmd を先に評価するため、書込を伴う命令形は
// ここに到達しない。加えて WRITE_INTENT_MARKERS で二重に除外し誤爆を防ぐ。
const CONFIRM_QUERY_MARKERS = [
  /확인\s*(가능|할\s*수\s*있|해\s*줄|해\s*줘|해\s*주세요|해\s*주라|좀|부탁|돼|되나|되니|가능해|가능한가|가능할까)/,
  /알려\s*(줘|주세요|주라|줄래|다오)/,
  /뭐(였|야|예요|냐|니|지)/,
  /뭔지|무엇\s*(인지|이야|인가)/,
  /어떻게\s*(돼|되나|됐|되었)/,
];
// これらが含まれると「単なる確認」ではない(書込/実装/計算を伴う) → fast-path 対象外。
const WRITE_INTENT_MARKERS = /(저장|파일|폴더|구현|수정|해결|반영|적용|배포|개선|보완|생성|작성|계산|집계|합산|추정|산출|만들|고쳐|고치|등록|추가|처리|점검|리팩터|리팩토|커밋|푸시|push|업데이트|업뎃|갱신|번역|현행화|일본어화)/;

function isConfirmationQuery(text) {
  const t = text.replace(/`/g, '');
  if (WRITE_INTENT_MARKERS.test(t)) return false;
  return CONFIRM_QUERY_MARKERS.some(re => re.test(t));
}

// ── 意図分類 (task / question) ────────────────────────────────────────────────
// 「タスク登録」「task登録」等の明記、または明確な作業依頼 → "task"
// 曖昧・質問・情報照会 → "question"
async function classifyRequest(text, workDir = BASE_DIR) {
  // git push / pull / stash などの単純操作はタスク不要 → 即 question
  if (/^\s*(git\s+(push|pull|stash|fetch|merge|rebase|status|log|diff)|タスク(?:一覧|リスト|確認|状況)|tasklist|task7d)/i.test(text.replace(/[^\x00-\x7Fぁ-ん亜-熙ー]/g, ' '))) {
    return 'question';
  }

  // 純粋な確認/照会依頼は LLM を呼ばず決定的に question へ（#622: 확인 요청が task 誤分類）。
  if (isConfirmationQuery(text)) return 'question';

  const prompt = `You are an assistant that classifies the intent of Slack messages.

Message: "${text}"

Classify using the following rules:
- "task": applies when the request requires creating or modifying ANY file on disk:
  1. Explicit registration instruction such as "태스크 등록", "task 추가", "작업 의뢰" etc.
  2. Code change, feature addition, bug fix, refactoring, or configuration file modification
  3. A combination like "do A, and also git push" where A involves file changes
  4. Document/spec creation and saving: "사양서 만들어 저장", "문서로 저장", "파일로 저장해줘", "작성해서 저장", "만들어서 저장"
  5. Any request that ends with saving/writing output to a file or folder on disk

  6. Imperative requests to implement, fix, solve, add, change, or "calculate and show" a
     page / feature / behavior — even when phrased as "…보여줘", "…체크하고 해결해라",
     "…고쳐줘", "구현해줘" — because fulfilling them requires modifying code or config.
     A request that reports something is missing/broken/unimplemented and then asks to fix
     or realize it ("아직 구현이 안된 거 같아 … 계산해서 보여줘") is "task".

- "question": applies when NO file needs to be created or modified:
  1. Question, information inquiry, explanation request (no file output expected)
  2. Status check, deployment check, environment check, log review
  3. File path inquiry, dashboard check, system status confirmation
  4. Investigation or research only (no file output expected)
  5. Message consisting only of "git push" or "git pull" (no other work instructions)

Key principle: If the request involves writing, saving, or creating ANY file on disk — classify as "task".
A read-only phrasing like "보여줘/확인해줘" does NOT make it a question when satisfying it
requires implementing or changing code.

Examples:
- "azure-cost 페이지에 이번 달 예상 금액을 계산해서 보여줘" → task (needs a code change to add the calculation)
- "csn 2 에 등록된 logical machine 이 사라진 원인 체크하고 문제 해결을 해라" → task (fix requires code/query change)
- "지금 배포 상태 어때?" → question
- "azure-cost 페이지 URL 이 뭐야?" → question

Reply with only one word: "task" or "question". No explanation needed.`;

  try {
    const acct = accounts.pickAccount();
    // giip-1063: 분류(task/question 1단어 판정)에 최상위 모델을 쓰지 않는다 — MODEL_CLASSIFIER.
    const result = await spawnAsync('claude', ['-p', '--model', require('./model-config').classifierModel()], {
      cwd: workDir,
      timeout: 60000,
      env: accounts.envFor(acct),
      input: prompt, // 프롬프트는 stdin 으로 (ENAMETOOLONG 회피)
    });
    if (result.status !== 0) {
      // 한도 메시지가 stdout에 찍히는 경우가 있어(giip-759) 두 스트림 모두 확인한다.
      const combinedOut = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (accounts.isUsageLimit(combinedOut)) accounts.noteUsageLimit(acct, combinedOut);
      return 'question';
    }
    const out = (result.stdout || '').trim().toLowerCase();
    return out.startsWith('task') ? 'task' : 'question';
  } catch {
    return 'question'; // timeout·오류 시 질문으로 폴백
  }
}

// ── チャンネル Q&A (質問と判定されたときのインライン回答) ────────────────────
// git push / pull のみ（他の作業を含まない）を実行して結果を返す
// 「A機能を修正して git push して」のような複合指示には反応しない
function isPureGitOp(text) {
  // Korean/Chinese/全角を除去し、残ったテキストが git コマンドとその助詞のみか確認
  const stripped = text
    .replace(/<[^>]+>/g, '')          // Slack mrkdwn タグ除去
    .replace(/[^\x00-\x7Fぁ-ん亜-熙ー]/g, ' ')  // Korean等を空白に
    .trim();
  // "git push [して/する/お願い/etc]" のみで構成されているか
  return /^git\s+(push|pull)(\s+(して|する|してください|お願い|please|원|해줘|해주세요))?$/i.test(stripped);
}

module.exports = { isGoCmd, isCancelCmd, isForceTaskCmd, isConfirmationQuery, isPureGitOp, classifyRequest };
