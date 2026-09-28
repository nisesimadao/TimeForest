<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.png">
  <img alt="TimeForest — TimeTree 非公式クライアント" src="docs/banner-light.png" width="100%">
</picture>

[![CI](https://github.com/nisesimadao/TimeForest/actions/workflows/ci.yml/badge.svg)](https://github.com/nisesimadao/TimeForest/actions/workflows/ci.yml)
&nbsp;![dependencies 0](docs/badge-deps.svg)
&nbsp;![build step none](docs/badge-build.svg)
&nbsp;![node 20 · 24](docs/badge-node.svg)
&nbsp;![Electron 43](docs/badge-electron.svg)
&nbsp;![extension MV3](docs/badge-mv3.svg)

TimeForest は、TimeTree の Web 版を拡張する非公式クライアントです。
同じ TimeTree アカウントと予定データを使いながら、アジェンダ表示、地図ピン、エクスポート、複数アカウント切り替え、PC 通知、CLI / MCP 連携などを追加します。

利用には自分の TimeTree アカウントが必要です。
モック用アカウントや独自のカレンダーサービスは提供していません。

> **非公式プロジェクト**：TimeForest は TimeTree Inc. と提携、出資、承認の関係にありません。
> 「TimeTree」は権利者の商標です。
> 本プロジェクトは公式 API ではなく、TimeTree Web が利用する内部 API を、自分のアカウントのデータへアクセスする目的で使用します。

## 提供形態

TimeForest は `src/lib/*` の共通ロジックを、次の 4 形態から利用します。

| 形態 | 内容 | 対象 |
| --- | --- | --- |
| リポジトリ直下 | Chrome 拡張（Manifest V3） | PC ブラウザ |
| [`client/`](client/) | Electron デスクトップクライアント | Windows / macOS / Linux |
| `dist/*.user.js` | ユーザースクリプト | iOS Safari / Firefox Android を含むブラウザ |
| [`web/`](web/) | サーバーへデプロイするホスト型 Web クライアント | Web ブラウザ |

共有ライブラリのコピーが増えないよう、CI で構成を検査しています。

## 画面

### デスクトップのアジェンダ

空き日を省略し、複数日にまたがる予定を一つの帯として表示します。

![アジェンダ表示](docs/shots/agenda-dark.png)

月表示では、連続する予定を日ごとのチップへ分割せず、一つの帯として描画します。

![月表示](docs/shots/month-dark.png)

### 地図ピン

TimeTree のイベントが持つ緯度・経度を利用し、OpenStreetMap 上で場所を選択できます。
デスクトップクライアントと Chrome 拡張の両方から利用できます。

![地図ピッカー](docs/shots/mappicker-light.png)

### Chrome 拡張

独自の全画面 UI を重ねるのではなく、TimeTree Web の既存 UI に機能を追加します。
「マンスリー / ウィークリー」切り替えには「アジェンダ」を追加し、ツールバーにはエクスポート、テーマ、アカウント、通知の操作を追加します。

![本家のトグルにアジェンダ](docs/shots/ext-agenda-dark.png)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/shots/ext-toolbar-dark.png">
  <img alt="TimeTree ツールバーに追加した操作" src="docs/shots/ext-toolbar-light.png" width="100%">
</picture>

予定フォームには地図選択を追加します。

![本家フォームに地図ピッカー](docs/shots/ext-picker.png)

### ホスト型 Web クライアント

拡張機能やデスクトップアプリをインストールせず、デプロイした URL からデスクトップ版と同じレンダラーを利用できます。

![ブラウザ版](docs/shots/web-client.png)

ブラウザの CORS 制約を避けるため、同一オリジンの薄いバックエンドが TimeTree API を中継します。
認証情報は httpOnly Cookie に保持し、サーバーの永続ストレージには保存しません。
詳しくは [`web/README.md`](web/README.md) を参照してください。

## 主な機能

### Chrome 拡張

- **アジェンダ表示**：今日以降の予定を一つのリストで表示します。
  予定の詳細から、TimeTree Web の編集 UI を開けます。
- **テーマ切り替え**：TimeTree 自身が持つ light / dark / system テーマを切り替えます。
- **エクスポート**：Markdown / CSV / JSON / ICS 形式で予定を書き出します。
- **地図ピン**：予定フォームから緯度・経度を設定します。
- **アカウント切り替え**：端末内に保存した複数の `_session_id` を切り替えます。
- **PC 通知**：Chrome が動作している間、リマインドをデスクトップ通知として表示できます。既定では無効です。

### デスクトップクライアント

Chrome 拡張の機能に加え、次の機能を持ちます。

- 週の時間グリッドと月グリッド。
- コマンドパレット（`Ctrl+K`）。
- 予定の作成、編集、削除。
- 繰り返し予定の作成と、「この回だけ / これ以降 / すべて」を指定した編集・削除。
- リマインド通知とトレイ常駐。
- 参加者、ラベル、チェックリスト、URL、場所、メモ。
- コメントと変更履歴の表示・投稿。

画像添付は TimeTree の有料機能に依存するため、無料アカウント向けには実装していません。
デスクトップ版の詳細は [`client/README.md`](client/README.md) を参照してください。

## TimeTree Web との差分

### 週の開始曜日

TimeTree Web は月曜始まりで固定されています。
TimeForest では日曜始まりと月曜始まりを選択できます。
既定値は TimeTree Web に合わせて月曜です。

### 月グリッドの行数

月ごとに必要な 5 行または 6 行だけを表示します。
固定 6 行にしないことで、5 行で収まる月は各セルへより多くの高さを割り当てます。

### 場所の座標

TimeTree のイベントには `location_lat` / `location_lon` がありますが、Web 版の場所欄はテキスト入力のみです。
TimeForest はこの座標を読み書きし、地図から場所を指定できるようにします。

地図機能は既定で無効です。
有効にした場合だけ OpenStreetMap のタイルと検索 API へアクセスし、予定本文は送信しません。

## CLI

`tf` コマンドは、動作中のデスクトップクライアントへ RPC で問い合わせます。
デスクトップクライアントが起動していない場合は自動で起動します。

最初にクライアント依存関係をインストールしてください。

```sh
cd client
npm install
cd ..
npm link
```

例：

```sh
tf ls today
tf ls week --cal 仕事
tf find 歯医者
tf show 7110a578
tf say 7110a578 "14時でいい？"
tf add 歯医者 --at "7/21 10:00" --for 1h --where 駅前歯科 --alert 30m
tf edit 7110a578 --at "7/21 10:30"
tf rm 7110a578
tf use you@example.com
```

日付には `today`、`明日`、`week`、`nextweek`、`month`、`7/21`、`2026-07-21`、`+7d`、`-3d` などを指定できます。
イベント ID は一覧に表示される先頭 8 文字でも参照できます。
曖昧な場合は候補を表示し、自動で一件を選択しません。

RPC には Windows の名前付きパイプ、macOS / Linux では `userData` 配下の Unix socket を使用します。
TCP ポートは開きません。

## MCP

MCP サーバーも CLI と同じ RPC を利用します。

```sh
claude mcp add timeforest -- node /path/to/TimeForest/client/mcp.js
```

主なツール：

| Tool | 内容 |
| --- | --- |
| `list_events` | 指定期間の予定を取得 |
| `search_events` | 日付が不明な予定を検索 |
| `get_event` | 一件の詳細を取得 |
| `get_comments` | コメントと変更履歴を取得 |
| `add_comment` | コメントを投稿 |
| `create_event` | 予定を作成 |
| `update_event` | 予定を更新 |
| `delete_event` | 予定を削除 |
| `list_calendars` / `list_accounts` / `switch_account` | カレンダーとアカウントを操作 |

> **書き込み操作について**：共有カレンダーへの変更は他のメンバーへ通知される場合があります。
> 書き込み系ツールには MCP の write / destructive hint を設定し、削除では繰り返し予定の範囲も明示的に確認できるようにしています。

MCP SDK への依存は持たず、stdio 上の JSON-RPC に必要な処理だけを実装しています。
stdout はプロトコル専用とし、診断情報は stderr へ出力します。

## インストール：Chrome 拡張

ビルドは不要です。

1. Chrome で `chrome://extensions` を開きます。
2. 「デベロッパーモード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」から、このリポジトリのルートを選択します。
4. `https://timetreeapp.com/calendars/...` を開きます。

`Alt+T` でアジェンダ、`Alt+D` でテーマを切り替えられます。

ビルド済みの拡張 ZIP、デスクトップアプリ、ユーザースクリプトは [Releases](https://github.com/nisesimadao/TimeForest/releases/latest) から取得できます。

## スマートフォン：ユーザースクリプト

通常版は、TimeTree のモバイル Web へアジェンダ、テーマ、エクスポートなどを追加します。

```sh
node build-userscript.js
# → dist/timeforest.user.js
```

`manifest.json` の読み込み対象を基準にビルドするため、Chrome 拡張と同じソースを利用します。

- **iOS Safari**：[Userscripts](https://apps.apple.com/app/userscripts/id1463298887)
- **Android**：Firefox + Tampermonkey、または Kiwi Browser

ダークテーマだけを切り替える場合は、TimeTree Web が持つ `data-theme` を設定するだけでも利用できます。

```js
javascript:document.documentElement.setAttribute('data-theme','dark')
```

### デスクトップ UI を使うユーザースクリプト

`timeforest-app.user.js` は TimeTree の `/calendars` 上へデスクトップ版レンダラーをマウントします。
同一オリジンで動作するため、TimeTree Web にログイン済みであれば、そのセッションを利用します。

```sh
node build-app-userscript.js
# → dist/timeforest-app.user.js
```

Releases のプリビルド版は、既定の更新元として作者のデモ配信を参照します。
常用する場合は `TF_WEB_ORIGIN` を自分のデプロイ先へ設定してビルドし、更新元と API 中継先を自分で管理することを推奨します。
詳しくは [`web/README.md`](web/README.md) と [`PRIVACY.md`](PRIVACY.md) を参照してください。

## ダークモード

TimeTree Web の CSS には `[data-theme=dark]:root` 用の配色が含まれています。
TimeForest は `<html data-theme="dark">` を設定し、TimeTree 側の light / dark / system テーマを利用します。

初期実装で使用していた `filter: invert()` は使用していません。
カレンダーのラベル色そのものが変わり、予定の意味と表示色の対応を壊すためです。

## 内部 API と認証

TimeForest は TimeTree Web が使用する内部 API を呼び出します。
代表的な読み取りエンドポイントは次の通りです。

```text
GET /api/v1/calendars
GET /api/v1/calendar/{id}/events?since=0
GET /api/v1/calendar/{id}/labels
GET /api/v2/calendars/{id}/users
GET /api/v2/memorialdays?country_iso[]=JP
```

書き込みでは次のエンドポイントを使用します。

```text
POST   /api/v1/calendar/{id}/event
PUT    /api/v1/calendar/{id}/event/{uuid}
DELETE /api/v1/calendar/{id}/event/{uuid}
```

必要なリクエストヘッダー：

```text
x-csrf-token: <meta name="csrf-token"> の値
x-timetreea:  web/2.1.0/ja
```

通常のアジェンダ、エクスポート、地図、テーマ機能は Cookie の値を直接読みません。
ブラウザまたは Electron のセッションが TimeTree へのリクエストへ Cookie を付与します。

アカウント切り替えだけは例外で、各アカウントの `_session_id` を `chrome.storage.local` に保存し、`timetreeapp.com` の Cookie へ差し替えます。
保存先と差し替え先はいずれもローカル端末上です。

内部 API の詳細と繰り返し予定のデータモデルは [`docs/internals.md`](docs/internals.md) にまとめています。

## 構成

```text
manifest.json
build-userscript.js
build-app-userscript.js
src/
  bg.js
  content.js
  inject-main.js
  lib/             # 各ビルドで共有する DOM 非依存ロジック
    tz.js
    recur.js
    api.js
    model.js
    export.js
    map.js
  ui/
client/             # Electron デスクトップクライアント
web/                # ホスト型 Web クライアント
api/                # Vercel サーバーレス関数
```

`src/lib/*` は拡張、ユーザースクリプト、Service Worker、Electron、Web クライアントから共有します。
環境ごとの差は `api.setTransport()` で通信層を切り替えます。

## 開発と検証

基本チェック：

```sh
npm run check
npm run smoke
```

`scripts/check.js` は、主に次の回帰を検出します。

- manifest が存在しないファイルを参照していないこと。
- `src/lib` のコピーが増えていないこと。
- Electron の通信経路が意図しない実装へ戻っていないこと。
- ICS の終日予定で `DTEND` が正しく翌日になっていること。
- メモ種別の扱いと RRULE `COUNT` の展開が正しいこと。

実 API と実 UI を使う検証も用意しています。

```sh
cd client && npm run inspect
npm i playwright-core
npm run verify:form
npm run verify:recur
npm run verify:notify
npm run verify:comment
```

これらの検証はモックではなく TimeTree の実データを読み戻して確認します。
共有カレンダーを誤って変更しないよう、書き込み検証は指定したテスト用カレンダー以外では中断します。

CI は Node 20 / 24 で構造チェックとユーザースクリプトの再現性を確認し、Electron クライアントも xvfb 上で起動します。

## パッケージ化

```sh
npm run icons
npm run dist
npm run dist:dir
```

Electron のパッケージはリポジトリルートを基準にします。
`client/renderer/*` が `src/lib/*` を直接共有する構成を維持するためです。
配布対象は許可リストで制限し、必要な共有ファイルが含まれるかを `scripts/check.js` で検証します。

現在の配布物はコード署名していません。
Windows SmartScreen や macOS Gatekeeper が初回起動時に警告する場合があります。

macOS では Finder から対象アプリを右クリックして **開く** を選ぶ方法を使用してください。
OS のセキュリティ機能を恒久的に無効にする手順は推奨しません。

## リリース

`v0.2.0` のようなタグを push すると、`.github/workflows/release.yml` が次を GitHub Release へ追加します。

- `timeforest.user.js`
- `timeforest-app.user.js`
- `timeforest-extension.zip`
- Windows / macOS / Linux 向けデスクトップアプリ
- `SHA256SUMS.txt`

チェックサムは配布ファイルの破損や差し替えの検出に利用できます。
ただし、リポジトリと Release の両方が侵害された場合まで保証するものではありません。

```sh
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows PowerShell
(Get-FileHash .\TimeForest-0.1.0-x64.exe -Algorithm SHA256).Hash
```

## 今後の方針

- **画像添付**：無料アカウントでは TimeTree 側がプレミアム機能として拒否するため、実装しません。
- **外部カレンダーへの常時同期**：OAuth、配信、運用コストが大きいため、現時点では ICS / CSV / JSON / Markdown のエクスポートを提供します。
- **常駐**：Chrome 拡張は Chrome が動作している間だけ機能します。完全な常駐が必要な場合はデスクトップクライアントを使用してください。

## 既知の制限

- TimeTree の内部 API に依存するため、TimeTree 側の変更で動作しなくなる可能性があります。
- RRULE のタイムゾーン処理は JST / UTC の固定オフセットを主対象としており、DST の遷移をまたぐ場合は一時間ずれる可能性があります。
- `x-timetreea` のクライアントバージョンは `web/2.1.0/ja` に固定しています。
- `INTERVAL` と `COUNT` はフォームから編集できません。値自体は保持します。
- 画像添付には対応しません。
- デスクトップ通知は TimeForest が起動している間だけ動作します。サーバープッシュではありません。

## ライセンス

コードは [MIT License](LICENSE) で公開しています。
TimeTree の利用については、TimeTree 側の利用規約と適用されるルールを確認してください。

## 貢献とセキュリティ

- 開発手順と共有ライブラリの規約は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。
- 脆弱性は公開 Issue ではなく [SECURITY.md](SECURITY.md) の手順で報告してください。
- データとセッションの扱いは [PRIVACY.md](PRIVACY.md) を参照してください。
