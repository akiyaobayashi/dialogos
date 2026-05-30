# Dialogos - 賢者たちとの対話

## 起動方法

1. Node.js をインストールします。
2. このフォルダで依存関係を入れます。

```powershell
npm install
```

3. `.env.example` を `.env` にコピーして、OpenAI APIキーを設定します。

```env
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4.1-mini
PORT=5177
```

4. サーバーを起動します。

```powershell
npm start
```

5. ブラウザで開きます。

```text
http://127.0.0.1:5177/
```

## 注意

- APIキーはフロントエンドには置かず、必ず `.env` に設定してください。
- `.env` は配布ZIPには含めていません。
- `data/dialogos.sqlite` は実行時に自動生成されます。
- 人物画像は `assets/images/<id>/profile.webp` などへ差し替えてください。

## 初期コード

MVP用の解放コード:

```text
DIALOGOS-DEMO-100
```
