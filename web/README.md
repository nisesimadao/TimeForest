# TimeForest — ホスト型 Web クライアント

この版は、デスクトップクライアントの `client/renderer/*` をブラウザで動かします。
拡張機能やデスクトップアプリをインストールせず、デプロイ先の URL から TimeTree を操作できます。

## バックエンドが必要な理由

別オリジンの Web ページから `timetreeapp.com` の API へ直接アクセスすると、ブラウザの CORS 制約を受けます。
そのため、同一オリジンの薄いバックエンドが `/api/tt/*` を `timetreeapp.com/api/*` へ中継します。

現在の認証付きリクエストでは、主に次の情報を使用します。

- `_session_id` Cookie
- TimeTree ページから取得した CSRF token
- `x-timetreea` header

## 認証

1. `timetreeapp.com` へ自分でログインします。
2. 開発者ツールの Application → Cookies から `_session_id` を確認します。
3. TimeForest の接続画面へ値を入力します。

入力した値は、この TimeForest デプロイの httpOnly Cookie に保存します。
サーバー側のデータベースやファイルには永続化せず、TimeTree への API リクエストを中継するときだけ読み取ります。
パスワードは TimeForest を通りません。

> 自己ホストまたは少人数で管理するデプロイを推奨します。
> 公開デプロイでは、保存しない構成であっても他人の TimeTree セッションがプロキシを通過します。
> Releases のモバイル向けユーザースクリプトは作者のデモ配信を既定の更新元としているため、常用する場合は自分のデプロイ先を設定してビルドしてください。

## ローカル実行

```bash
node web/build.js
node web/dev-server.js
```

`web/dev-server.js` は `http://localhost:8787` で待ち受け、`web/dist` の静的ファイルと次の API を提供します。

- `/api/connect`
- `/api/disconnect`
- `/api/whoami`
- `/api/tt/*`

実装は `web/proxy-core.js` と `web/cookie.js` を Vercel Functions と共有します。
ローカルサーバーは loopback interface のみに bind します。

## Vercel へのデプロイ

Vercel Dashboard の **Add New → Project** から、この GitHub リポジトリを import します。
CLI から `vercel deploy` を実行しても同じ構成を利用できます。

設定は次の通りです。

- **Root Directory**：リポジトリルート。
- **Framework Preset**：Other。
- **Build Command / Output Directory**：`vercel.json` の設定を使用します。

`web/build.js` は `src/lib`、`client/renderer`、`icons` を読み、自己完結した `web/dist` を生成します。
Vercel が公開するのは `web/dist` だけです。
`.local/` や開発用文書は `.vercelignore` でアップロード対象から外します。

`scripts/check.js` は、Web build に必要なファイルを `.vercelignore` が誤って除外していないことも検査します。

## 構成

### ビルド

`web/build.js` が次の内容を `web/dist` へ配置します。

- `index.html`
- `host-web.js`
- `src/lib/*` を元にした `lib/*`
- `client/renderer/*` を元にした `renderer/*`

これらのコピーは build output であり、Git には commit しません。

### API

- `api/tt.js`：`/api/tt/*` を受け、許可した TimeTree API path へ中継します。
- `api/connect.js` / `api/disconnect.js`：接続情報を httpOnly Cookie へ設定または削除します。
- `api/whoami.js`：現在接続しているアカウント情報を返します。
- `api/map/tile` / `api/map/search`：OpenStreetMap / Nominatim をサーバー側から取得します。

TimeTree proxy は `/api/v*` の JSON API だけを対象にし、固定した `timetreeapp.com` へ送信します。
リダイレクトは追跡せず、path traversal を拒否します。

## 複数アカウント

接続済みアカウントは httpOnly Cookie に保持します。
クライアントへ session token 自体は返しません。

アカウントの一覧、切り替え、削除は `api/accounts` 系 API から行います。
別タブでアカウントを切り替えた場合は BroadcastChannel を使い、他のタブを再読み込みします。

現在、アカウント削除の操作は renderer 側の仕様により 2 アカウント以上ある場合だけ表示します。
`api/disconnect` は実装済みですが、接続中のアカウントが 1 件だけの場合のサインアウト UI は未配線です。

## 検証

ローカル E2E では、次の経路を確認しています。

- 接続と TimeTree API の同期。
- 予定の作成、更新、削除。
- OpenStreetMap タイルと検索。
- 月 / 週 / アジェンダ表示、コマンドパレット、予定詳細。
- ページエラーが発生しないこと。

実行手順と検証スクリプトは、ルートの [README](../README.md) と [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。
