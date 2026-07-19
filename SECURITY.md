# セキュリティポリシー

TimeForest は TimeTree の**非公式**サードパーティクライアントです。ここは
TimeForest（このリポジトリのコード）の脆弱性についての窓口であり、TimeTree
本体のセキュリティ窓口ではありません。TimeTree 本体の問題は TimeTree に直接
報告してください。

## 報告方法

脆弱性を見つけたら、**公開 issue を立てず**、GitHub の非公開報告を使ってください：

1. リポジトリの **Security** タブ →「**Report a vulnerability**」
2. 再現手順・影響範囲・可能なら PoC を添えてください

数日以内に一次応答し、修正の可否と方針を返します。個人プロジェクトなので
SLA は保証できませんが、セッションやクッキーの扱いに関わる問題は最優先で見ます。

## セキュリティモデル（何を守っているか）

TimeForest はパスワードを一切受け取りません。ログインは常に TimeTree 自身の
ログインページで行われ、各形態は TimeTree が発行したセッションだけを扱います。

- **Chrome 拡張** — セッションはブラウザのクッキー（`_session_id`）。クッキーに
  触れるのは Service Worker だけで、コンテンツスクリプトには渡しません。書き込み
  API は Service Worker 経由で、`declarativeNetRequest` で自身のリクエストの Origin
  を timetreeapp.com に書き換えます（対象ドメイン＋xhr に限定）。権限は最小限
  （`storage`/`tabs`/`cookies`/`alarms`/`notifications`/`declarativeNetRequest`）で、
  すべて実際に使用しています。
- **デスクトップ（Electron）** — アカウントごとに独立したパーティション
  （Chromium のクッキー壷、userData 下で DPAPI 暗号化）。認証付き fetch は main
  プロセスでのみ行い、レンダラは preload の狭いブリッジ（`window.host`）越しに
  `/api/*` の JSON しか要求できません。任意 URL・シェル・ファイルには触れません。
- **ホスト型 Web クライアント** — セッショントークンはサーバに保存しません。
  呼び出し元自身の httpOnly クッキーに乗り、リクエスト毎に読んで転送し、忘れます。
  バックエンドプロキシは `/api/v*/` の JSON のみを固定ホスト timetreeapp.com へ
  中継し、リダイレクトは追いません（認証済み HTML の反射を防ぐ）。
- **ユーザースクリプト** — timetreeapp.com 上で同一オリジンに動くため、ページ
  自身のログインに乗るだけです。プロキシもトークン受け渡しもありません。

## 対象範囲

- **対象**: このリポジトリのコード（拡張 / デスクトップ / web / ユーザースクリプト /
  バックエンドプロキシ）。
- **対象外**: TimeTree 本体、および OpenStreetMap / Nominatim（地図タイル・検索）。

## 配布物について

デスクトップのビルドは**未署名**です。Windows / macOS は初回起動時に警告を
出します（README 参照）。改ざん検知のため、各リリースには成果物の SHA256 を
併記しています。
