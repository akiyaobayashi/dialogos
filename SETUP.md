# Dialogos v2 — セットアップガイド

## 必要なもの
- Node.js v18+
- Anthropic API キー（または OpenAI API キー）
- Stripe アカウント（課金機能を使う場合）

---

## クイックスタート（AI だけ動かす）

```bash
# 1. 依存インストール
npm install

# 2. 環境変数ファイルを作成
cp .env.example .env

# 3. .env を編集して API キーを設定
#    ANTHROPIC_API_KEY=sk-ant-api03-xxxx
#    （または OPENAI_API_KEY=sk-xxxx）

# 4. サーバー起動
npm start
# → http://localhost:5177 で開く
```

---

## Stripe 課金機能を有効にする

### 1. Stripe アカウント準備

1. https://stripe.com にアクセスしアカウント作成
2. ダッシュボード → 開発者 → API キー
   - `STRIPE_SECRET_KEY` = Secret key (sk_test_xxxx)
   - `STRIPE_PUBLISHABLE_KEY` = Publishable key (pk_test_xxxx)

### 2. Webhook 設定

ローカル開発には [Stripe CLI](https://stripe.com/docs/stripe-cli) を使います：

```bash
# Stripe CLI をインストール
stripe login

# ローカル webhook 転送
stripe listen --forward-to localhost:5177/api/stripe/webhook
# → 表示された webhook signing secret を STRIPE_WEBHOOK_SECRET に設定
```

本番環境：Stripe ダッシュボード → 開発者 → Webhooks → エンドポイント追加
- URL: `https://your-domain.com/api/stripe/webhook`
- イベント: `checkout.session.completed`

### 3. .env 最終設定

```env
PORT=5177
ANTHROPIC_API_KEY=sk-ant-api03-xxxx
ANTHROPIC_MODEL=claude-sonnet-4-6
STRIPE_SECRET_KEY=sk_test_xxxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxx
APP_URL=http://localhost:5177
```

---

## クレジット料金体系

| パッケージ | 金額 | クレジット | 単価 |
|-----------|------|-----------|------|
| ライト     | ¥500  | 50 CR     | ¥10/CR |
| スタンダード | ¥1,000 | 120 CR | ¥8.3/CR |
| プレミアム  | ¥3,000 | 450 CR | ¥6.7/CR |

- 無料体験：10往復（新規ユーザー全員）
- 1 AI返答 = 1 クレジット消費

---

## デモ用コード（Stripe 不要）

Stripe なしでテストしたい場合はコード認証を使えます：

- `DIALOGOS-DEMO-100` → 100 CR 付与
- `DIALOGOS-TEST-100` → 100 CR 付与

アプリの「対話を続ける ＋」→「コードをお持ちの方」から入力。

---

## ファイル構成

```
dialogos/
├── server.js               ← Express + Anthropic + Stripe
├── index.html              ← SPA シェル
├── css/style.css           ← スタイル
├── js/
│   ├── app.js              ← ルーター・チャット・購入 UI
│   ├── services/
│   │   └── apiService.js   ← API クライアント
│   └── data/
│       ├── philosophers.js ← 14 賢者データ
│       ├── prompts.js      ← 各人格システムプロンプト
│       └── personalityFilters.js ← 人格フィルタ
├── assets/images/          ← 賢者の画像（portrait.webp）
├── data/dialogos.sqlite    ← SQLite DB（自動作成）
└── .env                    ← 環境変数（要作成）
```

---

## 賢者の画像を追加する

各賢者用に `assets/images/{id}/profile.webp` を配置すると表示されます。

```
assets/images/
├── socrates/profile.webp
├── plato/profile.webp
├── nietzsche/profile.webp
├── buddha/profile.webp
...（14 賢者分）
```

画像がなくても、象徴的な SVG モチーフと文字でフォールバック表示されます。

---

## 本番デプロイ（例：Railway）

```bash
# railway.app でプロジェクト作成後
railway init
railway up

# 環境変数は Railway ダッシュボードで設定
# APP_URL を本番 URL に変更することを忘れずに
```
