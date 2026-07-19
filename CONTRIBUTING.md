# Contributing / 開発ガイド

TimeForest への貢献ありがとうございます。**非公式**の TimeTree クライアントなので、
TimeTree の利用規約を尊重し、スクレイピングの乱用や過負荷になる変更は避けてください。

## 全体像 — 1つの共有ライブラリ、4つの形

`src/lib/*.js`（`tz` / `recur` / `api` / `model` / `export` / `map`）が中核です。
これらは `globalThis.TTX` に IIFE で載る**素の JS（ビルド不要・依存なし）**で、
4つの形すべてが**同じファイル**を読みます：

| 形 | 実行環境 | 入口 |
| --- | --- | --- |
| Chrome 拡張 | 本家 UI に注入 | `manifest.json` → `src/ui/*` + `src/content.js` + `src/bg.js` |
| デスクトップ | Electron | `client/`（main / preload / renderer） |
| ホスト型 Web | ブラウザ＋Vercel プロキシ | `web/` + `api/` |
| ユーザースクリプト | 本家上で同一オリジン | `build-userscript.js` / `build-app-userscript.js` |

**共有ライブラリの2枚目のコピーを作らないでください。** `scripts/check.js` が
ドリフトを検出して CI を落とします（コピー検出、4形態の lib リスト一致、
`CLIENT_TAG` 一致、libs が `window` ではなく `globalThis` を使うこと、等）。

## セットアップ

```bash
git clone https://github.com/nisesimadao/TimeForest
cd TimeForest
# ルートには依存がありません。デスクトップをビルド/起動するときだけ:
cd client && npm ci && cd ..
```

- 拡張: `chrome://extensions` で「パッケージ化されていない拡張機能を読み込む」→
  リポジトリのルートを選択。
- デスクトップ: `npm run client`（＝`electron .`）。
- Web（ローカル）: `node web/build.js && node web/dev-server.js`（`http://localhost:8787`）。
- ユーザースクリプト: `npm run build` / `npm run build:app` → `dist/` に出力。

## 変更を出す前に

```bash
npm run check     # 必須。CI が Node 20 と 24 で回します
```

`check.js` は静的検査＋ユーザースクリプトの再現ビルド＋各フォームの整合を見ます。
`verify:*` 系（`verify:api` / `verify:form` / `verify:recur` / `verify:cli` /
`verify:mcp` / `verify:ext` など）は**動作中のクライアントに CDP で繋ぐ E2E** です。
`npm run inspect`（`electron . --remote-debugging-port=9333`）で起動してから回します。

## 共有ライブラリを1つ増やすとき

`src/lib/foo.js` を足したら、**4か所すべて**に配線してください（`check.js` が全部
チェックします）:

1. `manifest.json` の `content_scripts[0].js`
2. `client/renderer/index.html` の `<script>`
3. `web/build.js` の `LIBS`
4. `build-app-userscript.js` の `LIBS`

## お願い

- **秘密情報をコミットしない。** ローカルの認証情報・Webhook は `.local/`（gitignore 済み）へ。
- **実在の個人データを入れない。** README や例は汎用値で。
- コミットメッセージは日本語で構いません。要点が分かるように。
- コードは周囲に合わせて（素の JS の IIFE、コメントは制約の説明に絞る）。
- セキュリティ上の問題は issue ではなく [SECURITY.md](SECURITY.md) の手順で。
