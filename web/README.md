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

> 自己ホスト・単一利用者が基本。トークンはリクエストごとに読んで転送し保存しないが、
> 自分のデプロイを不特定多数に開放すると（一時的にせよ）他人のセッションを通すことに
> なるので、常用は各自のデプロイで。作者は動作確認用の公開デモ
> `time-forest-five.vercel.app` を1つ動かしていて、プリビルドのモバイル版
> ユーザースクリプトの自動更新元も兼ねる（[ルート README](../README.md) 参照）。

## ローカルで動かす

```sh
node web/build.js            # web/dist を組み立てる（自己完結の配信物）
node web/dev-server.js       # http://localhost:8787（web/dist だけを配信）
```

依存ゼロ（Node 組み込みのみ）。`web/dev-server.js` は Vercel と同じ物を出す
—`web/dist` の静的配信 + `/api/connect|disconnect|whoami` + `/api/tt/*`
（`web/proxy-core.js`・`web/cookie.js` を Vercel 関数と共有）。ループバックのみに
bind。

## Vercel にデプロイ（GitHub 連携）

このリポジトリを push した状態で、Vercel ダッシュボードの **Add New → Project** から
この GitHub リポジトリを Import するだけ。CLI（`vercel deploy`）でも同じ。

- **Root Directory**：リポジトリ直下（デフォルトのまま）。`vercel.json` / `api/` /
  `web/` がそこにあるので、サブディレクトリの指定は不要。
- **Framework Preset**：Other（`vercel.json` で `framework: null` 指定済み）。
- **Build Command / Output Directory**：`vercel.json` が指定済み
  （`node web/build.js` → `web/dist`）。触らなくてよい。

リポジトリ直下には拡張・デスクトップ・スクリプトも同居しているが、**配信されるのは
`web/dist` だけ**（`outputDirectory`）で、アップロードからは `.vercelignore` が
`.local/`・`docs/` などを外す。`web/build.js` は Vercel 上で `src/lib`・
`client/renderer`・`icons/` を読むので、それらは `.vercelignore` に入れない
（`scripts/check.js` が build 入力の除外を検査するので、デプロイ時にビルドが
「ファイルが無い」で落ちない）。

デプロイ後、初回アクセスは接続画面が出る。`timetreeapp.com` の `_session_id` を
貼れば繋がる。

構成の詳細：

- ビルド：`web/build.js` が `web/dist` に自己完結の配信物を組む（`index.html`・
  `host-web.js`・`lib/*`＝src/lib のコピー・`renderer/*`＝client/renderer のコピー）。
  `outputDirectory` は `web/dist` なので、**配信されるのは web/dist だけ**。リポジトリの
  他ファイル（`.local/`・ソース）はどのパスでも取得できない。コピーは commit されず
  デプロイ時に生成されるので「lib のコピーを持たない」規則も保たれる。
- サーバーレス関数：`api/tt.js`（`vercel.json` の rewrite で `/api/tt/*` を受ける。
  `/api/v*` のみ中継・リダイレクト非追従・`..` トラバーサル拒否）、
  `api/connect.js`・`api/disconnect.js`（同一オリジンの JSON POST のみ）、
  `api/whoami.js`。いずれも `web/proxy-core.js` + `web/cookie.js` を共有。
- `.vercelignore` が `.local/`（認証情報）やセッションメモ等をアップロードからも外す。

## いまの状態

- ローカル E2E：接続 → プロキシ経由の実同期 → デスクトップ UI がブラウザで描画
  （9/0）、書き込み（作成・更新・削除、4/0）、地図（タイル・検索、5/0）、フル UI
  （月/週/アジェンダ・コマンドパレット・予定詳細、pageerror ゼロ、6/0）。
- 地図：`api/map/tile`・`api/map/search` がサーバー側で OSM/Nominatim を UA 付きで
  取得（タイルは data: URI 化）。ページは同一オリジンしか触らず CSP は閉じたまま。
- 複数アカウント：`tt_accounts`（httpOnly, `[{id,name,token}]`）に接続済みアカウントを
  持ち、`tt_session` を差し替えて切替（`api/accounts` の list/switch/forget）。トークンは
  クライアントに返さない。別アカウントで接続すると自動で追加。アクティブなアカウントを
  削除すると残りにフォールバック（無ければサインアウト）。別タブでの切替は
  BroadcastChannel で他タブを reload。UI はデスクトップのアカウントメニューがそのまま動く。
- 既知の制約：アカウント削除の × はアカウントが2つ以上の時だけ出る（renderer 共有仕様）。
  接続中が1つだけの状態からのサインアウト UI は未配線（`api/disconnect` は用意済み）。
  実切替（A→B）の E2E は捨てアカが単一のため機構検証（`scripts/verify-api.js`）で担保。
