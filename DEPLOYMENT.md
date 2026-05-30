# Dialogos 本番接続手順

このフォルダは Vercel + Supabase + Stripe + OpenAI で動く構成です。

## 1. SupabaseでSQLを実行する

1. Supabaseを開く
2. 対象プロジェクトを選ぶ
3. 左メニューの SQL Editor を開く
4. New query を押す
5. `supabase/schema.sql` の中身をすべて貼り付ける
6. Run を押す

実行するファイル:

```
supabase/schema.sql
```

## 2. RLS確認

SQL Editorで以下を実行してください。

```sql
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('users','conversations','messages','memories','unlocked_characters','purchases','usage_events')
order by tablename;
```

全行の `rowsecurity` が `true` ならOKです。

DialogosはブラウザからSupabaseを直接触りません。Vercel APIだけが `SUPABASE_SERVICE_ROLE_KEY` でDBを触ります。そのため、公開ポリシーは作らない方が安全です。

## 3. Supabaseから取得する値

Supabase Dashboard -> Project Settings -> API で取得します。

- Project URL -> `SUPABASE_URL`
- service_role key -> `SUPABASE_SERVICE_ROLE_KEY`

`anon public` key は今回Vercelに登録しません。

## 4. Vercel環境変数

Vercel Dashboard -> 対象Project -> Settings -> Environment Variables に登録します。

```
OPENAI_API_KEY=sk-proj_xxxx
OPENAI_MODEL=gpt-4.1-mini
OPENAI_MAX_OUTPUT_TOKENS=620
OPENAI_TEMPERATURE=0.9

SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY

STRIPE_SECRET_KEY=sk_live_xxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxx

APP_URL=https://your-dialogos-domain.vercel.app

FREE_COUNT=10
RATE_LIMIT_PER_MINUTE=10
MAX_RECENT_MESSAGES=20
MAX_FREE_RECENT_MESSAGES=8
```

## 5. Stripe Webhook

Stripe Dashboard -> Developers -> Webhooks -> Add endpoint を押します。

Endpoint URL:

```
https://your-dialogos-domain.vercel.app/api/stripe/webhook
```

送るイベント:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

作成後に表示される signing secret を、Vercelの `STRIPE_WEBHOOK_SECRET` に入れます。

## 6. Stripe Price ID

コードには反映済みです。

- 記憶の書 680円: `price_1Tc42DR4lgjy27fJkehRTmqu` ではなく `price_1Tc42DR4lgjy27fJW85jwg3v`
- 灯火 150 / 500円: `price_1Tc44SR4lgjy27fJdXiFNQP7`
- 灯火 400 / 1000円: `price_1Tc45TR4lgjy27fJrWhyAqk4`
- 灯火 1000 / 2000円: `price_1Tc45vR4lgjy27fJkehRTmqu`

## 7. 動作確認

デプロイ後、ブラウザで以下を開きます。

```
https://your-dialogos-domain.vercel.app/api/health
```

期待値:

```json
{"ok":true,"db":true,"stripe":true,"ai":"openai"}
```

## 8. 注意

- `.env` やAPIキーをGitHubへ上げないこと。
- `SUPABASE_SERVICE_ROLE_KEY` は秘匿。ブラウザに出さないこと。
- 決済反映は Stripe Webhook 成功後。
- AI返信成功後だけ、無料回数または灯火を1つ消費。
