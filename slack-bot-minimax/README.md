# Slack Bot — MiniMax 우선 버전

> `lowyworkenv/slack-bot`(2026-07-27 시점)을 그대로 복사한 변형본. MiniMax Token Plan(Anthropic
> Messages 호환 엔드포인트)을 1순위 실행 엔진으로 쓰고, 한도 소진 시에만 Claude 계정 풀로 폴백한다
> (`minimax-accounts.js` + `task-manager.js`/`claude-cli.js`의 폴백 로직 참조).
> `slack-bot`(기본, Claude 전용) 폴더와 나란히 두는 독립 배포본이다.

Claude CLI(또는 MiniMax Anthropic 호환 엔드포인트)를 호출해 태스크 분석·실행·Q&A를 채널에서 조작할 수 있다.

---

# SmartOrder Slack Bot (원본 설명)

Vegetrade SmartOrder プロジェクト用 Slack Bot。  
Claude CLI を呼び出してタスク分析・実行・Q&A をチャンネルから操作できる。

## 機能概要

| 機能 | 説明 |
|---|---|
| タスク管理 | `@bot 作業依頼` → 分析 → `go <ID>` で専用ブランチ作成→サブエージェント実行→PR 自動生成 |
| 質問応答 | `@bot 質問` → K-Layer + GitHub Issues を参照して即答 |
| DM 会話 | 会話履歴付き Q&A、`!issues` / `!klayer` コマンド |
| git 操作 | `@bot git push/pull` → 実行して結果を返信 |
| 全リポジトリ状況 | push 漏れ自動チェック・報告 |

---

## 前提条件

- Node.js 18 以上
- [Claude Code CLI](https://claude.ai/code) インストール済み・PATH 登録済み  
  （`claude --version` が通ること）
- Slack App 作成済み（Socket Mode 有効、Bot Token + App-Level Token 取得済み）  
  → **[Slack App セットアップ手順](SLACK_APP_SETUP.md)** を参照（初回のみ）

---

## セットアップ

### 1. 依存パッケージインストール

```bash
cd slack-bot
npm install
```

### 2. 環境変数設定

```bash
cp .env.example .env
```

`.env` を編集:

```env
SLACK_BOT_TOKEN=xoxb-...        # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...        # App-Level Token (Socket Mode 用)
GITHUB_TOKEN=ghp_...            # GitHub PAT (repo 権限)
GITHUB_REPO=LowyShin/smartorder-works
SLACK_CHANNEL_IDS=C0XXXXXXXXX  # 監視チャンネル ID (カンマ区切り)
```

> **チャンネル ID の確認方法**: Slack でチャンネルを右クリック → View channel details → 最下部に表示

### 3. Claude 구독 계정 라우팅（任意 / 複数アカウント時）

봇이 spawn하는 모든 `claude` 호출을 여러 **구독 계정**에 플랜 가중치대로 고르게 분산한다(Smooth Weighted Round-Robin). 사용량 한도에 걸린 계정은 자동으로 잠시 제외(쿨다운)되고, 회복되면 다시 투입된다.

- **설정 파일 없으면**: 현재 로그인된 계정 1개로 그대로 동작(추가 설정 불필요).
- **계정을 늘리려면**: 계정별로 별도 `CLAUDE_CONFIG_DIR`에 로그인해 두고, `claude-accounts.json`에 항목을 추가한다. 코드 변경·봇 재시작 불필요(파일 변경 시 자동 반영).

```bash
# 계정별 1회 로그인 (예: 계정 B)
CLAUDE_CONFIG_DIR="C:/claude-accounts/B" claude auth login --email <계정B이메일>
```

```jsonc
// slack-bot/claude-accounts.json  (git-ignored, claude-accounts.example.json 참고)
[
  { "name": "main",  "dir": "C:/claude-accounts/main", "weight": 1,  "email": "..." },
  { "name": "maxB",  "dir": "C:/claude-accounts/B",    "weight": 20, "email": "..." }
]
// weight: 플랜 비중 상대값 (Pro=1, Max5x=5, Max20x=20 식). 비율대로 요청 분산.
// dir   : 그 계정으로 로그인해 둔 CLAUDE_CONFIG_DIR 경로.
```

> **주의**: 순수 throughput 증량 목적의 구독 다중화는 Anthropic 소비자 약관 리스크가 있음. 파일에 계정 경로가 들어가므로 `claude-accounts.json`은 git 관리 대상이 아님(`.gitignore` 등록).

---

## 起動方法

### 通常起動（開発・テスト用）

```bash
cd slack-bot
node index.js
# または
npm start
```

### pm2 で管理（推奨）

```bash
# 初回登録
pm2 start index.js --name slack-bot --cwd C:\Users\lowyshin\Downloads\projects\smartorder-works\slack-bot

# プロセス保存（リカバリ用）
pm2 save

# 状態確認
pm2 list

# ログ確認
pm2 logs slack-bot

# 再起動
pm2 restart slack-bot

# 停止
pm2 stop slack-bot
```

> **現在の pm2 パス**: `C:\Users\lowyshin\AppData\Roaming\npm\pm2.cmd`  
> PATH に通っていない場合は `npm install -g pm2` でグローバルインストール済み

### PC 再起動後の自動起動（設定済み）

Windows Task Scheduler に `PM2-SlackBot-Resurrect` タスクが登録済み。  
`lowyshin` でログオン時に自動的に `pm2 resurrect` が実行される。

手動で再登録する場合（管理者 PowerShell で実行）:

```powershell
schtasks /Create /TN "PM2-SlackBot-Resurrect" ^
  /TR "cmd /c C:\Users\lowyshin\AppData\Roaming\npm\pm2.cmd resurrect" ^
  /SC ONLOGON /RU "lowyshin" /RL HIGHEST /F
```

---

## コマンド一覧

### チャンネル（@bot メンション）

| コマンド | 動作 |
|---|---|
| `@bot <作業依頼>` | Task 分析 → 確認 → `go <ID>` で実行 |
| `@bot <質問>` | K-Layer + Issues 参照して即答 |
| `<プロジェクト名> issue 등록 <内容>` | 内容をそのまま giip issue に登録。プロジェクトが `project-csn.json` に登録済みならその **CSN** で登録（例: `caci-mimity issue 등록 …` → CSN 70422）。未登録なら account 既定 CSN |
| `giip project set <프로젝트명> <csn>` | プロジェクト名 → CSN マッピングを追加/更新（`project-csn.json` に反映・**再起動不要**） |
| `giip project list` | 登録済みのプロジェクト → CSN マッピング一覧 |
| `giip project del <프로젝트명>` | マッピングを削除 |
| `giip channel set <프로젝트명> [채널ID]` | このチャンネルの既定プロジェクトを固定（`channel-project.json`・**再起動不要**）。接頭辞なしメッセージは全てこのプロジェクトで処理。채널ID 省略時は現在チャンネル |
| `giip channel list` | 채널 → 既定プロジェクト固定マッピング一覧 |
| `giip channel del [채널ID]` | 채널固定マッピングを削除 |
| `go <Task番号>` | 指定 Task を実行 |
| `go <Task番号>` + 改行後にコメント | 指定 Task を実行。**改行以降のテキストは「追加指示」として Task の .md に追記**してから実行する（コメントは任意 — あってもなくても可） |
| `go` | 待機中 Task 一覧を表示 |
| `cancel <Task番号>` | 指定 Task をキャンセル |
| `tasklist` | 待機中 Task 一覧 |
| `tasklist all` | 全 Task 一覧（完了・キャンセル含む） |
| `<14桁数字>` | Task ステータス確認 |
| `@bot git push` | smartorder-works を git push |
| `@bot git pull` | smartorder-works を git pull |
| `!issues` | GitHub Issue 一覧 |
| `!issues refresh` | Issue 強制更新 |
| `!klayer <キーワード>` | K-Layer 知識検索 |
| `!help` | ヘルプ表示 |

> **rule — プロジェクト別 CSN ルーティング**: `<プロジェクト名> issue 등록 <内容>` の CSN 対応は `slack-bot/project-csn.json` の `map` で管理する（コード変更不要）。編集は Slack から `giip project set <프로젝트명> <csn>` / `giip project list` / `giip project del <프로젝트명>` で行える（`config.js` の `setProjectCsn`/`listProjectCsn`/`deleteProjectCsn` が `map` だけ更新し `_comment` を保存、読み込みは毎回読み直すので**再起動不要**）。プロジェクト名が `PROJECTS_ROOT` 直下の同名フォルダなら作業フォルダ切替も兼ね、フォルダが無くても map にあれば名前だけで CSN ルーティングされる（その場合 workDir は lowyworkenv に安全フォールバック）。解決は `config.resolveProjectCsn(projectName || workDir)`。map に無ければ account 既定 CSN にフォールバック。
>
> **rule — チャンネル固定プロジェクトルーティング (task giip-724)**: 「このチャンネルの発話はすべて `<project>` として処理」を `slack-bot/channel-project.json` の `map`（`channelId → プロジェクト名`）で管理する。編集は Slack から `giip channel set <프로젝트명> [채널ID]` / `giip channel list` / `giip channel del [채널ID]`（`config.js` の `setChannelProject`/`listChannelProject`/`deleteChannelProject`、読み込みは毎回読み直すので**再起動不要**）。適用は `processMessage` で `config.applyChannelPin(channelId, parseProjectPrefix(text))`。**優先順位（設計判断）**: メッセージ先頭に実フォルダ / `project-csn.json` 登録名の**明示的プロジェクト接頭辞があればそれが勝つ**（Rule 32 の絶対規則を維持）。接頭辞が無いときだけチャンネルの既定プロジェクトが適用され、本来 `lowyworkenv` に潰れていた workDir/projectName（→ CSN）をそのプロジェクトで埋める。既定値: `C0B5TV2T43S → ecokaku-aidc`（CSN 70417）。⚠️ CSN ルーティングが実際に効くには bot ユーザ(uSn 29)がその CSN のメンバである必要がある（`giip project set` が自動付与）。
>
> **rule — `go <番号>` の追加指示 (D-2026-07-15)**: `go <Task番号>` の後ろ（同一メッセージ・改行以降でも可）に続けたテキストは、その Task 専用の「追加指示」として扱う。実行直前に Task の `.agent/tasks/<ID>.md` へ `## 추가 지시 (Slack, …)` ブロックとして追記され、サブエージェントが必ず読む。**コメントは任意** — 付ければ反映し `📎 追加指示 … 反映しました` と返信、無ければ従来どおり素の `go` として実行する。判定正規式は末尾 `$` を張らず `\b` 止まり（`handlers.js` の `goWithId`）。旧仕様（`$` 固定）ではコメントを付けると bare `go` に落ちて Task 一覧が出るバグがあった（PR #306 で修正）。

### DM

| コマンド | 動作 |
|---|---|
| `<質問>` | 会話履歴付き Q&A |
| `<14桁数字>` | Task ステータス確認 |
| `!issues` | GitHub Issue 一覧 |
| `!klayer <キーワード>` | K-Layer 知識検索 |
| `!reset` | 会話履歴リセット |
| `!help` | ヘルプ表示 |

---

## Task ワークフロー

```
1. @bot で作業依頼
       ↓
2. Claude が Task ファイル (.agent/tasks/{ID}.md) を分析・作成
       ↓
3. Slack に Task 内容と「go <ID>」を提示
       ↓
4. ユーザーが「go <ID>」を送信
       ↓
5. claude -p サブエージェントが作業実行
       ↓
6. 完了 → 専用ブランチ `bot/task-<ID>`(最新 origin/base 起点)へ commit・push
       → base(master/main) へ PR 自動生成 → PR URL を Slack に報告
```

> **ブランチ/PR 方針** (D-2026-07-09): `go <ID>` は每回 `git fetch origin <base>` 直後に
> `origin/<base>` を起点とした専用ブランチ `bot/task-<ID>` を作って作業する。作業ツリーは共有のため
> 1 タスクずつ直列実行され、完了後は元のブランチに復元される。サブエージェントは git を触らず、
> commit・push・PR は Bot(`task-manager.js`)が確定的に行う。常に最新 base 起点なので
> 「ブランチ作成時 merge conflict」は起きない。

---

## ファイル構成

```
slack-bot/
├── index.js              # メインエントリポイント
├── task-manager.js       # Task 作成・実行管理
├── claude-accounts.js    # 구독 계정 Weighted Round-Robin 라우터
├── claude-accounts.json  # 계정 라우팅 설정（git 管理外・任意）
├── claude-accounts.example.json # 계정 라우팅 설定テンプレート
├── k-layer.js            # K-Layer 知識検索
├── github-issues.js      # GitHub Issues キャッシュ
├── .env                  # 環境変数（git 管理外）
├── .env.example          # 環境変数テンプレート
├── .conversations.json   # DM 会話履歴（自動生成）
├── .task-state.json      # Task 実行状態（自動生成）
├── .bot-threads.json     # Bot 関与スレッド記録（自動生成）
├── register-startup.ps1  # Task Scheduler 登録スクリプト（管理者権限要）
└── package.json
```

---

## トラブルシューティング

**Bot が起動しない**
```bash
pm2 logs slack-bot --lines 50
```
よくある原因: `.env` の `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` が未設定、`claude` CLI が PATH にない

**PC 再起動後に Bot が起動しない**
```powershell
# Task Scheduler 確認
schtasks /Query /TN "PM2-SlackBot-Resurrect" /FO LIST

# 手動で resurrect
C:\Users\lowyshin\AppData\Roaming\npm\pm2.cmd resurrect
```

**重複起動**  
`index.js` 起動時に自動で同一プロセスを検出・終了する。手動で止める場合:
```bash
pm2 stop slack-bot
```
