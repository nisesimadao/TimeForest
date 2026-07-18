# TimeForest — ブラウザ版（ホスト型 3P クライアント）

デスクトップクライアントの UI（`client/renderer/*`）を**そのままブラウザで**動かす。
拡張を入れず、URL を開くだけで別 UI から TimeTree を操作できる。

## なぜバックエンドが要るか

ブラウザの別オリジンのページから `timetreeapp.com` の API は **CORS で叩けない**
（TimeTree は他オリジンに `Access-Control-Allow-Origin` を返さない）。サーバーには
その制約が無い（CORS はブラウザの規則）ので、同一オリジンの薄いプロキシが
`/api/tt/*` を `timetreeapp.com/*` にサーバー側で中継する。実測（`scripts/` の
proxy-spike）で、必要なのは **`_session_id` クッキー + スクレイプした csrf-token +
`x-timetreea`** の3つだけ。

## 認証（トークンはサーバーに残さない）

`timetreeapp.com` に自分でログイン → 開発者ツール → Application → Cookies →
`_session_id` の値をコピーし、接続画面に貼る。値は **この端末のブラウザの httpOnly
クッキー**（このオリジン側）に入り、リクエストごとに関数が読んで TimeTree へ転送し、
それ以外どこにも保存しない。パスワードはこのアプリを一切通らない。

> 自己ホスト・単一利用者を前提にしている。公開マルチテナントにすると他人の
> セッションを預かることになるので、そのまま公開しないこと。

## ローカルで動かす

```sh
node web/dev-server.js        # http://localhost:8787
```

依存ゼロ（Node 組み込みのみ）。`web/dev-server.js` は Vercel と同じ経路を出す
—静的配信 + `/api/connect|disconnect|whoami` + `/api/tt/*`（`web/proxy-core.js` を
Vercel 関数と共有）。

## Vercel にデプロイ

```sh
vercel deploy
```

- 静的配信：`web/index.html`（`/` に rewrite）、`/src/lib/*`・`/client/renderer/*`
  を**コピーせず**そのまま配信（拡張・デスクトップと同じソース）。
- サーバーレス関数：`api/tt/[...path].js`（プロキシ）、`api/connect.js`、
  `api/disconnect.js`、`api/whoami.js`。いずれも `web/proxy-core.js` +
  `web/cookie.js` を共有。
- `.vercelignore` が `.local/` などをアップロード対象から外す。

## いまの状態

- 実測済み（`scripts/verify-web.js`, ローカル 9/0）：接続 → プロキシ経由の実同期
  → デスクトップ UI がブラウザで描画（サイドバー・アジェンダ・実データ）、
  コンソールエラー無し。
- 未対応：地図（当面 off）、複数アカウント切り替え（接続中の1つのみ）。次段階。
