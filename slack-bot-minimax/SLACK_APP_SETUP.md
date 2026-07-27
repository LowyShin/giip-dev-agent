# Slack App セットアップガイド — SmartOrder Slack Bot

このボットは **Socket Mode** で動作します。
Polling 方式の `codex-bot` とは別の Slack App を用意してください。

---

## 1. Slack App を作成する

1. [https://api.slack.com/apps](https://api.slack.com/apps) を開く
2. **Create New App** → **From scratch** を選択
3. App Name（例: `SmartOrder Bot`）と対象 Workspace を入力して **Create App**

---

## 2. Bot Token Scopes を追加する

**OAuth & Permissions** → **Scopes** → **Bot Token Scopes** に以下を追加:

| Scope | 用途 |
|---|---|
| `chat:write` | メッセージ送信 |
| `app_mentions:read` | `@ボット名` メンション受信 |
| `channels:history` | パブリックチャンネルのメッセージ読み取り |
| `channels:read` | チャンネル情報取得 |
| `groups:history` | プライベートチャンネルのメッセージ読み取り |
| `groups:read` | プライベートチャンネル情報取得 |
| `im:history` | DM メッセージ読み取り |
| `im:read` | DM 情報取得 |
| `im:write` | DM 送信 |
| `users:read` | ユーザー表示名の取得（スレッド要約で「誰が何を言ったか」を実名表示） |

> **`users:read` について**: このスコープが無くてもスレッド本文の読み取り・要約は正常に動作する。
> 無い場合はスレッド要約の話者名が Slack ユーザー ID（例: `UM8P5UALQ`）で表示され、
> 追加すると実名（表示名）で表示される。`conversations.replies` でスレッド全体を取得後、
> `users.info` で各発言者名を解決するために使う。

> **スコープを追加・変更した後は必ず Reinstall が必要** (後述 §5 参照)

---

## 3. Socket Mode を有効にする

1. 左メニュー **Socket Mode** → **Enable Socket Mode** をオン
2. **App-Level Token** を生成する画面が開く:
   - Token Name: 任意（例: `socket-mode-token`）
   - Scope: `connections:write` にチェック
   - **Generate** ボタン → `xapp-` で始まるトークンが表示される → コピーして保存

---

## 4. Event Subscriptions を有効にする

**Event Subscriptions** → **Enable Events** をオン

**Subscribe to bot events** に以下を追加:

| Event | 用途 |
|---|---|
| `app_mention` | チャンネルでの @メンション受信 |
| `message.im` | DM メッセージ受信 |
| `message.channels` | パブリックチャンネルのスレッド返信受信 |
| `message.groups` | プライベートチャンネルのスレッド返信受信 |

> Socket Mode では Request URL 不要。URL 欄は空のままで OK。

---

## 5. Workspace にインストールする

**OAuth & Permissions** → **Install to Workspace** → **Allow**

インストール後に **Bot User OAuth Token**（`xoxb-` から始まる）が表示される → コピー

---

## 6. チャンネルにボットを招待する

監視したいチャンネルで:
```
/invite @SmartOrder Bot
```

チャンネル ID の確認方法:
- Slack でチャンネルを右クリック → **View channel details** → 最下部に `C0XXXXXXXXX` 形式で表示

---

## 7. .env に設定する

```bash
cp slack-bot/.env.example slack-bot/.env
```

```env
SLACK_BOT_TOKEN=xoxb-...          # §5 で取得した Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...          # §3 で取得した App-Level Token
GITHUB_TOKEN=ghp_...              # GitHub PAT（repo 権限）
GITHUB_REPO=LowyShin/smartorder-works
SLACK_CHANNEL_IDS=C0XXXXXXXXX,C0YYYYYYYYY  # §6 で確認したチャンネル ID（カンマ区切り）
POLL_INTERVAL_MS=60000
```

設定後:
```bash
cd slack-bot
pm2 restart slack-bot
pm2 logs slack-bot  # "[Bot] Socket Mode 接続完了" が出れば OK
```

---

## トラブルシューティング

**`missing_scope` エラー**  
→ §2 のスコープ追加 → §5 の Reinstall を必ず実施

**`invalid_auth` / `token_revoked`**  
→ トークンを再取得。Bot Token と App-Level Token を混同していないか確認

**DM が届かない**  
→ `im:history` と `im:read` スコープを追加して Reinstall  
→ Event Subscriptions に `message.im` が含まれているか確認

**チャンネルメンションに反応しない**  
→ ボットをチャンネルに招待済みか確認（`/invite @ボット名`）  
→ `SLACK_CHANNEL_IDS` にそのチャンネル ID が含まれているか確認
