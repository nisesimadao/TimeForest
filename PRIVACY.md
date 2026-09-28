# プライバシーポリシー — TimeForest（Chrome 拡張）

最終更新: 2026-07-19

TimeForest は TimeTree の非公式クライアントです。
Chrome 拡張で扱う TimeTree のデータは、基本的に利用者の端末内で処理します。
作者が運営する収集用サーバーへ、予定や認証情報を送信する機能はありません。

## 収集・送信しないもの

- 作者は、利用状況、分析データ、トラッキング情報、広告識別子などを収集しません。
- TimeTree のパスワードは扱いません。ログインは TimeTree 自身のページで行います。

## 拡張が扱うデータ

| データ | 用途 | 保存・送信先 |
| --- | --- | --- |
| TimeTree のセッション Cookie（`_session_id`） | 認証付き API 呼び出し、アカウント切り替え | 端末内に保存し、`timetreeapp.com` へのリクエストで使用 |
| カレンダー / 予定 / メンバー等 | アジェンダ表示、エクスポート、通知判定 | `timetreeapp.com` から取得し、端末内で処理 |
| 設定、アカウント一覧、通知状態、予定キャッシュ | 機能状態の保持 | `chrome.storage.local` |
| 地図の表示範囲、検索語 | 地図表示と場所検索 | 地図機能を有効にした場合だけ OpenStreetMap / Nominatim へ送信 |

地図機能では、表示範囲や検索語を OpenStreetMap 系サービスへ送信します。
予定本文や TimeTree のセッション情報は地図サービスへ送信しません。

通常の通信先は `timetreeapp.com` です。
地図機能を利用する場合だけ、`host_permissions` に記載した OpenStreetMap 系ホストにもアクセスします。

Markdown / CSV / JSON / ICS のエクスポートはブラウザ内で生成し、ローカルファイルとして保存します。
作者のサーバーへアップロードしません。

## 権限の理由

| 権限 | 用途 |
| --- | --- |
| `cookies` | アカウント切り替えのため、Service Worker からセッション Cookie を読み書きする |
| `storage` | 設定、アカウント一覧、通知状態、予定キャッシュを保存する |
| `tabs` | TimeTree タブへの反映、再読み込み、通知クリック時の前面化 |
| `alarms` | リマインド判定を定期実行する |
| `notifications` | リマインドを OS 通知として表示する |
| `declarativeNetRequest` | 拡張自身の書き込みリクエストの Origin を `timetreeapp.com` に合わせる。対象は指定ドメインと XHR に限定 |
| `host_permissions` | TimeTree 本体と、地図機能で使う OpenStreetMap 系サービスへアクセスする |

## データの保存と削除

設定やキャッシュはブラウザプロファイル内に保存します。
拡張を削除すると、Chrome が管理する拡張データも削除されます。

保存したアカウントは、アカウントメニューから個別に削除できます。

## 連絡先

プライバシーに関する問い合わせや脆弱性の報告は、[SECURITY.md](SECURITY.md) の手順に従ってください。
