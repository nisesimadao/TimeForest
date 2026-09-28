# セキュリティポリシー

TimeForest は TimeTree の非公式サードパーティクライアントです。
この文書は TimeForest のコードに関する脆弱性の報告方法を説明します。
TimeTree 本体の問題は、TimeTree の公式窓口へ報告してください。

## 報告方法

脆弱性を見つけた場合は公開 Issue を作成せず、GitHub の非公開報告を利用してください。

1. リポジトリの **Security** タブを開きます。
2. **Report a vulnerability** を選択します。
3. 再現手順、影響範囲、可能であれば PoC を添えてください。

個人プロジェクトのため SLA は設定していません。
セッションや Cookie の扱いに関係する問題は優先して確認します。

## セキュリティモデル

TimeForest はパスワードを受け取りません。
ログインは TimeTree 自身のログインページで行い、各クライアントは TimeTree が発行したセッションを利用します。

### Chrome 拡張

セッションはブラウザの `_session_id` Cookie を利用します。
Cookie を直接扱うのは Service Worker だけで、コンテンツスクリプトへ値を渡しません。

書き込み API は Service Worker を経由します。
`declarativeNetRequest` は、拡張自身の対象リクエストについて Origin を `timetreeapp.com` に合わせる目的で使用し、対象ドメインと XHR に限定しています。

### デスクトップ（Electron）

アカウントごとに独立した Electron partition を使用し、Cookie を分離します。
認証付き API リクエストは main process から行います。

renderer が利用する preload bridge（`window.host`）は、TimeTree の `/api/*` に必要な JSON 操作へ範囲を限定しています。
任意 URL の取得、shell 実行、任意ファイルアクセス用の API は公開していません。

### ホスト型 Web クライアント

TimeTree の session token はサーバーの永続ストレージへ保存しません。
呼び出し元の httpOnly Cookie からリクエストごとに読み取り、TimeTree へ転送します。

backend proxy は許可した `/api/v*/` の JSON API を固定ホスト `timetreeapp.com` へ中継します。
redirect は追跡しません。

### ユーザースクリプト

`timetreeapp.com` 上の同一オリジンで動作し、TimeTree Web の既存セッションを使用します。
この形態では TimeForest の外部 proxy へ session token を渡しません。

## 対象範囲

**対象**：このリポジトリの Chrome 拡張、デスクトップクライアント、Web クライアント、ユーザースクリプト、backend proxy。

**対象外**：TimeTree 本体、OpenStreetMap、Nominatim などの外部サービス。

## 配布物

現在のデスクトップ配布物はコード署名していません。
Windows または macOS が初回起動時に警告を表示する場合があります。

各 Release には配布ファイルの SHA-256 checksum を含め、ダウンロード後の破損や差し替えを確認できるようにしています。
