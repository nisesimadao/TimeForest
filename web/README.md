# TimeForest — ブラウザ版（ホスト型 3P クライアント）

デスクトップクライアントの UI（`client/renderer/*`）を**そのままブラウザで**動かす。
拡張を入れず、URL を開くだけで別 UI から TimeTree を操作できる。

## なぜバックエンドが要るか

ブラウザの別オリジンのページから `timetreeapp.com` の API は **CORS で叩けない**
（TimeTree は他オリジンに `Access-Control-Allow-Origin` を返さない）。サーバーには
その制約が無い（CORS はブラウザの規則）ので、同一オリジンの薄いプロキシが
`/api/tt/*` を `timetreeapp.com/api/*` にサーバー側で中継する。ローカルのスパイクで
実測した必要要素は **`_session_id` クッキー + スクレイプした csrf-token +
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
node web/build.js            # web/dist を組み立てる（自己完結の配信物）
node web/dev-server.js       # http://localhost:8787（web/dist だけを配信）
```

依存ゼロ（Node 組み込みのみ）。`web/dev-server.js` は Vercel と同じ物を出す
—`web/dist` の静的配信 + `/api/connect|disconnect|whoami` + `/api/tt/*`
（`web/proxy-core.js`・`web/cookie.js` を Vercel 関数と共有）。ループバックのみに
bind。

## Vercel にデプロイ

```sh
vercel deploy
```

- ビルド：`web/build.js` が `web/dist` に自己完結の配信物を組む（`index.html`・
  `host-web.js`・`lib/*`＝src/lib のコピー・`renderer/*`＝client/renderer のコピー）。
  `outputDirectory` は `web/dist` なので、**配信されるのは web/dist だけ**。リポジトリの
  他ファイル（`.local/`・ソース）はどのパスでも取得できない。コピーは commit されず
  デプロイ時に生成されるので「lib のコピーを持たない」規則も保たれる。
- サーバーレス関数：`api/tt/[...path].js`（`/api/v*` のみ中継・リダイレクト非追従）、
  `api/connect.js`・`api/disconnect.js`（同一オリジンの JSON POST のみ）、
  `api/whoami.js`。いずれも `web/proxy-core.js` + `web/cookie.js` を共有。
- `.vercelignore` が `.local/`・`HANDOFF.md` などをアップロードからも外す。

## いまの状態

- ローカル E2E で 9/0：接続 → プロキシ経由の実同期 → デスクトップ UI がブラウザで
  描画（サイドバー・アジェンダ・実データ）、コンソールエラー無し。
- 未対応：地図（当面 off）、複数アカウント切り替え（接続中の1つのみ）。次段階。
