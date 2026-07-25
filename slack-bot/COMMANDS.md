# giipclaude Bot — カスタムコマンド一覧 (Custom Command Reference)

> このファイルは Bot が実際に応答するカスタムコマンドの一覧です。
> Slack で `@ボット名 !help`（チャンネル）または `!help`（DM）を送ると、このうちの主要コマンドが返信されます。
> ソースの真実は `index.js` の `handleChannelMention` / `handleDM` 内の分岐です。コマンドを追加・変更したらこのファイルも更新してください。

凡例: `<...>` はユーザーが埋める値。`|` は同義のエイリアス（どれでも同じ動作）。

---

## 1. チャンネル（@メンション）コマンド

チャンネルでは必ず先頭に `@ボット名` を付けます（例: `@giipclaude tasklist`）。

### 1-1. 基本ワークフロー

| コマンド | 動作 |
| --- | --- |
| `@ボット名 <質問>` | その場で回答（曖昧・一般的な内容は質問として扱う） |
| `@ボット名 <作業依頼>` | Task 分析 → 確認待ち → `go` で実行 → GitHub 結果 URL を返信 |
| `@ボット名 タスク登録: <内容>` | 内容を強制的に Task として登録（質問と誤判定されるのを防ぐ） |

### 1-2. Task 管理

| コマンド | 動作 |
| --- | --- |
| `tasklist` | 待機中 Task 一覧 |
| `tasklist all` | 全 Task 一覧（完了・キャンセル含む） |
| `task7days`  （エイリアス: `task 7days` / `task7d` / `tasklist 7days`） | 直近 7 日間の全 Task（未処理・異常検知用） |
| `go` | 待機中 Task の一覧を表示 |
| `go <Task番号>` | 指定した Task を実行 |
| `go <Task番号>` + 改行後にコメント | 指定 Task を実行。**改行以降のテキストは「追加指示」として Task の .md に追記**してから実行（コメントは任意） |
| `cancel` | 待機中 Task の一覧を表示 |
| `cancel <Task番号>`  （エイリアス: `취소` / `キャンセル` / `中断` + 番号） | 指定した Task をキャンセル（スレッド不問でどこからでも可） |
| `taskmerge`  （エイリアス: `task merge` / `dedupe` / `중복 통합` / `머지`） | 未完了の重複タスクを検出（プレビューのみ、変更なし） |
| `taskmerge go`  （エイリアス: `taskmerge 실행` / `apply` / `확정` / `yes` / `はい`） | 重複タスクを統合（代表 1 件に集約し残りを取消） |
| `<14桁の番号>` | その Task 番号の状況を照会（ステータス・内容・進捗ログ） |

> **`go` の確認エイリアス**: Task 確認スレッド内では `go` の代わりに `start` / `ok` / `yes` / `예` / `응` / `시작` / `실행` / `진행` / `開始` / `はい` / `よし` / `実行` / `進める` も実行として扱われます。

> **rule — `go <番号>` の追加指示**: `go <Task番号>` の後ろ（同一メッセージ・改行以降でも可）に続けたテキストは、その Task 専用の「追加指示」として扱う。実行直前に `.agent/tasks/<ID>.md` へ `## 추가 지시 (Slack, …)` ブロックとして追記され、サブエージェントが必ず読む。**コメントは任意** — 付ければ反映し `📎 追加指示 … 反映しました` と返信、無ければ従来どおり素の `go` として実行する。判定正規式は末尾 `$` を張らず `\b` 止まり（`handlers.js` の `goWithId`）。

### 1-3. ワークフロー実行

プロジェクトの `.agent/workflows/` に置かれたワークフローを実行します（実行サブエージェント経路で走るので DB／スクリプトが権限に阻まれません）。

| コマンド | 動作 |
| --- | --- |
| `<プロジェクト名> wflist` | そのプロジェクトの `.agent/workflows` 一覧 |
| `<プロジェクト名> wflist <絞り込み語>` | 名前で絞り込み |
| `<プロジェクト名> wflist all` | 参考ドキュメントも表示 |
| `<プロジェクト> workflow <名>`  （エイリアス: `wf <名>` / `wfrun <名>` / `워크플로우 <名>`） | ワークフローを実行 |
| `<プロジェクト> <名> 실행` / `<プロジェクト> /<名>` / `<プロジェクト> <名>` | 同上（`<名> 실행` と `<名>` の形は実在名と完全一致した時のみ実行＝誤爆防止） |

例) `giipprj wf errorproc` = `giipprj errorproc 실행` = `giipprj /errorproc` = `giipprj workflow errorproc`

### 1-4. プロジェクト切り替え（プレフィックス）

`PROJECTS_ROOT` に複数プロジェクトがある場合、要求の先頭にフォルダ名を付けるとその作業ディレクトリに切り替わります。

```
@ボット名 myapp fix the login bug
```
→ この要求だけ `PROJECTS_ROOT/myapp` を作業ディレクトリにする

### 1-5. URL でスレッド参照（Method 2）

メッセージ内に Slack のパーマリンク（`https://<workspace>.slack.com/archives/<channel>/p<...>`）を貼ると、Bot がそのスレッドを読んで要約・比較・回答に使います。
※ Bot がそのチャンネルのメンバーで、`channels:history` / `groups:history` スコープが必要です。

### 1-6. 情報コマンド

| コマンド | 動作 |
| --- | --- |
| `!issues` | GitHub Issue 一覧 |
| `!issues refresh` | Issue を強制更新 |
| `!klayer <キーワード>` | K-Layer 知識検索 |
| `!help` | ヘルプ（主要コマンドを返信） |

### 1-7. giip 連携コマンド（`giip ...`）

giip サービスと連携するコマンド群です（チャンネル・DM 共通で動作。`giip-commands.js`）。

**アカウント連携**（`giip account`）

| コマンド | 動作 |
| --- | --- |
| `giip account set <login_id> <sk> [csn]` | このチャンネルの連携アカウントを設定（**SK を含むので DM 推奨**） |
| `giip account set-default <login_id> <sk> [csn]` | 既定（default）アカウントを設定 |
| `giip account show` | 現在の連携アカウント表示（SK は隠す） |

**イシュー**（`giip issue`）

| コマンド | 動作 |
| --- | --- |
| `giip issue list [status]` | イシュー一覧（連携アカウントの csn で絞り込み） |
| `giip issue get <isn>`  （エイリアス: `show`） | イシュー詳細 |
| `giip issue new "<title>"`  （エイリアス: `create`） | イシュー新規作成 |
| `giip issue done <isn>` | ステータスを DONE に変更 |
| `giip issue review <isn>` | ステータスを REVIEW に変更 |
| `giip issue progress <isn>`  （エイリアス: `start`） | ステータスを IN_PROGRESS に変更 |
| `giip issue comment <isn> <text>` | コメント追加 |

**プロジェクト → CSN マッピング**（`giip project`、エイリアス: `proj` / `csn`）

`<プロジェクト名> issue 登録 <内容>` がどの csn で登録されるかを管理します（`project-csn.json`、**Bot 再起動不要**）。giip アカウント設定とは独立。

| コマンド | 動作 |
| --- | --- |
| `giip project set <プロジェクト名> <csn>`  （エイリアス: `add`） | プロジェクト名 ↔ csn を登録 |
| `giip project list` | 登録済みマッピング一覧 |
| `giip project del <プロジェクト名>`  （エイリアス: `delete` / `rm` / `remove`） | マッピング削除 |

**チャンネル → 既定プロジェクト固定**（`giip channel`、エイリアス: `ch`）

「このチャンネルの（接頭辞なし）発話はすべて `<プロジェクト>` として処理」する固定マッピング（`channel-project.json`、**Bot 再起動不要**）。明示的なプロジェクト接頭辞は引き続き優先されます。

| コマンド | 動作 |
| --- | --- |
| `giip channel set <プロジェクト名> [チャンネルID]` | このチャンネル（または指定チャンネル）の既定プロジェクトを固定 |
| `giip channel list` | 固定マッピング一覧（現在のチャンネルに `← 현재 채널` 表示） |
| `giip channel del [チャンネルID]`  （エイリアス: `delete` / `rm` / `remove`） | 固定マッピング削除 |

**汎用 API**（`giip api`）

| コマンド | 動作 |
| --- | --- |
| `giip api <Verb> [jsondata]` | 任意の giip API を直接呼び出し |

---

## 2. DM（ダイレクトメッセージ）コマンド

DM では `@メンション` 不要。普通のメッセージは会話履歴付きの Q&A として応答します。

| コマンド | 動作 |
| --- | --- |
| `<普通のメッセージ>` | 会話履歴付きの Q&A |
| `!issues` | GitHub Issue 一覧 |
| `!issues refresh` | Issue を強制更新 |
| `!klayer <キーワード>` | K-Layer 知識検索 |
| `!reset` | 会話履歴をリセット |
| `!help` | DM コマンド一覧を返信 |
| `<14桁の番号>`  （`status <14桁>` も可） | その Task 番号の状況を照会 |

> **giip 連携コマンド**（`giip account` / `giip issue` / `giip project` / `giip channel` / `giip api`）は DM でも同じく使えます。詳細は「1-7. giip 連携コマンド」を参照。特に `giip account set`（SK を含む）は DM での実行を推奨します。

---

## 3. コマンドを追加したら

1. `index.js` の `handleChannelMention`（チャンネル）または `handleDM`（DM）に分岐を追加。
2. 該当する `!help` の応答文（チャンネル用は `cmd === '!help'` の配列、DM 用も同様）に 1 行追加。
3. **このファイル（`COMMANDS.md`）にも追記**して同期を保つ。
