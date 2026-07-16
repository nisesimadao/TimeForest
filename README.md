# TimeForest

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

TimeTree 非公式クライアント。3つの形で同じものを届ける。

| | 何 | どこで |
| --- | --- | --- |
| **[client/](client/)** | Electron デスクトップクライアント | Windows / macOS / Linux |
| **本リポジトリ直下** | Chrome 拡張 (MV3) | PC のブラウザ |
| **`dist/*.user.js`** | ユーザースクリプト | **スマホ**（iOS Safari / Firefox Android） |

ロジック（`src/lib/*`）は3つで共有していて、コピーは無い。CI がコピーの発生を
検出して落とす。

```sh
npm run check     # 構造チェック（依存ゼロ）
npm run build     # → dist/timeforest.user.js
npm run client    # デスクトップクライアントを起動
```

> **スマホのダークモードが目当てなら** → [スマホで使う](#スマホで使うユーザースクリプト)。
> TimeTree のモバイル**アプリ**にダークモードは無いが、モバイル**Web**にはある
> （隠れているだけ）。アプリを作り直さなくても届く。

## 拡張でできること

- **アジェンダ表示** — 任意期間を1本のリストで縦に読む。月グリッドを行き来しなくていい
- **ダークモード** — TimeTree 自身が持っている純正ダークテーマを有効化する（後述）
- **全文検索** — タイトル・場所・メモを全期間から即時検索
- **エクスポート** — Markdown（クリップボード）/ CSV / JSON / ICS
- **複数カレンダー横断** — 「家族」と「プライベート」を1つのリストにまとめて表示
- **ラベル絞り込み** — ラベル単位でオン・オフ

デスクトップクライアントはさらに、週の時間グリッド・月グリッド・コマンドパレット
（`Ctrl+K`）・予定の詳細ポップオーバー・方向を持ったトランジションを持つ。
詳細は [client/README.md](client/README.md)。

## インストール（PC / Chrome 拡張）

ビルド不要。

1. Chrome で `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をオン
3. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダを選択
4. TimeTree（`https://timetreeapp.com/calendars/...`）を開くと右下に ☰ ボタンが出る

ショートカット: `Alt+T` パネル開閉 / `Alt+D` テーマ切り替え

## スマホで使う（ユーザースクリプト）

**TimeTree のモバイルアプリにはダークモードがない。** でもモバイル Web は
レスポンシブで、しかも例の純正ダークテーマをそのまま持っている。つまり
アプリを作り直さなくても、モバイルブラウザ経由でダークモードが手に入る。

スマホには拡張を入れられないので、同じソースから1ファイルのユーザースクリプト
を吐く:

```
node build-userscript.js     # → dist/timeforest.user.js
```

`manifest.json` のファイル一覧をそのまま読むので、拡張版と中身がズレない。
`chrome.storage` は `localStorage` にシムされる。

- **iOS Safari** — [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)（無料）に読み込ませる
- **Android** — Firefox + Tampermonkey、または Kiwi Browser（Chrome 拡張がそのまま動く）

390px 幅で検証済み: パネルは全画面表示になり、ダークテーマ・アジェンダ・
エクスポートすべて動く。

ダークモードだけでよければ、ブックマークレット1行でも足りる:

```js
javascript:document.documentElement.setAttribute('data-theme','dark')
```

## ダークモードについて

**TimeTree は完成したダークテーマを既に出荷している。** `theme-*.css` の中に
`[data-theme=dark]:root` として、専用にデザインされたパレット一式（イベント
ラベル色のダーク版まで: `#2ecc87` → `#06a374`、`#e73b3b` → `#c5031a` …）が入って
いる。ただしアプリがこの属性を一度も設定しないので、常に
`:root, [data-theme=light]:root` が勝って日の目を見ていない。

この拡張がやっているのは `<html data-theme="dark">` を立てるだけ。`light` /
`dark` / `system`（`prefers-color-scheme` 追従）の3つとも TimeTree 側が
ネイティブに対応している。

初版では CSS の `filter: invert()` でページを反転させていたが、捨てた。
カレンダーではラベル色が意味そのものなのに、反転すると海の日が赤→サーモン
ピンク、七夕がピンク→グレーに化けて、色が嘘をつくため。純正テーマなら
デザイナーが1色ずつ決めた値なので全部正しい。

## 仕組み

TimeTree に公開 API はないので、Web アプリが叩いている内部 API に相乗りする。

```
GET /api/v1/calendars                      → カレンダー一覧（alias_code が URL のスラッグ）
GET /api/v1/calendar/{id}/events?since=0   → 全イベント（チャンク方式）
GET /api/v1/calendar/{id}/labels           → ラベル（色は 24bit 整数）
GET /api/v2/calendars/{id}/users           → メンバー
GET /api/v2/memorialdays?country_iso[]=JP  → 祝日・暦（七夕・海の日など）
```

必要なヘッダーは2つ。無いと `400 {"error":{"code":-401}}` が返る。

```
x-csrf-token: <meta name="csrf-token"> の値
x-timetreea:  web/2.1.0/ja
```

認証はユーザーの既存セッション Cookie に相乗りするだけで、**この拡張は認証情報を
一切読まない・保存しない・送信しない**。外部への通信もゼロ（`chrome.storage.local`
に保存するのはテーマ設定だけ）。

### データモデルの罠

実データ（2395件）を TimeTree 自身の月表示と突き合わせて判明したもの。
これを踏まないと表示がズレる:

| 罠 | 内容 |
| --- | --- |
| `deactivated_at != null` | 削除済み。除外する |
| `category: 2` | **カレンダーの予定ではなく「メモ(Keep)」**。`row_order` を持つ。グリッドには出ない |
| `type: 1` | 誕生日。`title` は空で返る。`author_id` → メンバー名で `🎂 ◯◯の誕生日` を組み立てる |
| 繰り返し | 親が `RRULE` + `EXDATE` を持ち、変更された回は EXDATE で穴を空けて `recurring_uuid` を持つ別イベントとして再登録される（「【休】そろばん教室」がこれ） |
| 終日の `end_at` | **含む**。7/1〜7/3 は3日間。iCal の `DTEND` は含まないので ICS 出力時に +1日する |
| 複数日 | 終日とは限らない。時刻付きが日をまたぐこともある（8/8 21:00 → 8/16 22:00） |
| 祝日 | events API に**入っていない**。`memorialdays` から別途取得してマージ |

RRULE は実際には `FREQ=DAILY|WEEKLY|YEARLY` + `BYDAY` / `UNTIL` / `INTERVAL` しか
使われていない（`COUNT` も `BYMONTHDAY` も皆無）。なので rrule.js は入れず、
`src/lib/recur.js` に小さな展開器を自前で持っている。

### 検証

`src/lib/recur.js` の展開結果を、TimeTree が実際に描画した月グリッドと突き合わせ
済み（2026年7月）。**104/107 が完全一致**し、残りの差分もすべて説明がつく:

- 七夕・海の日 → events API 由来ではない（memorialdays でマージして解決）
- 誕生日2件 → タイトル空で返る仕様（author_id から合成して解決）
- 西公民館に700円持参 → `category: 2` のメモ（除外して解決）

## 構成

```
manifest.json
build-userscript.js  拡張 → 1ファイルのユーザースクリプト（スマホ用）
src/
  bg.js            ツールバー・ショートカット
  content.js       起動と SPA 遷移への追従
  lib/              ← 3つのビルド全部で共有。DOM 非依存の純ロジック
    tz.js          タイムゾーン（終日は UTC、時刻付きは Asia/Tokyo）
    recur.js       RRULE / EXDATE 展開器
    api.js         内部 API クライアント（setTransport で通信層を差し替え可能）
    model.js       生イベント → 日付つき occurrence
    export.js      Markdown / CSV / JSON / ICS
  ui/dark.js       data-theme の切り替えと維持
  ui/panel.js      パネル本体
  ui/panel.css     スタイル（Apple HIG 準拠、根拠はファイル冒頭に明記）
client/            Electron デスクトップクライアント（src/lib をそのまま読む）
```

`lib/*` は `globalThis` に載せてあるので、拡張・ユーザースクリプト・Service Worker・
Electron のレンダラ、どこでも同じものが動く。環境ごとに違うのは通信手段だけなので、
そこは `api.setTransport()` で差し替える（拡張は直 fetch、Electron は CORS を
避けて IPC 経由）。

## 開発

```sh
npm run check     # 構造チェック
npm run smoke     # Electron クライアントをヘッドレス起動して健全性を確認
```

`scripts/check.js` は依存ゼロ。ユニットテストではなく、**実際に踏んだバグが
静かに戻ってくるのを防ぐ**ためのもの:

- manifest が存在しないファイルを指していないか
- `src/lib` のコピーが増えていないか（3ビルド共有の破綻）
- `client/main.js` に `net.fetch` が復活していないか（アカウント混線の原因になる）
- ICS の終日 `DTEND` が +1 日されているか（全複数日予定が1日短くなる）
- `model.js` がメモ（category 2）を除外しているか

CI（`.github/workflows/ci.yml`）は Node 20 / 24 でこれを走らせ、ユーザースクリプトの
ビルドが再現可能かを diff で確認し、Electron クライアントを xvfb 上で起動して
プリロードブリッジと共有ライブラリが解決することまで見る。

## これから

- **予定の作成・編集** — 未着手。書き込み系エンドポイントの調査が必要。
  クライアントは**アカウント切り替え**に対応済みなので、本番カレンダーに触れずに
  テスト用アカウントで開発できる
- **通知・リマインド** — 検証済み: Service Worker が単独で HTML シェルを fetch
  して csrf-token を抜けば、**TimeTree のタブを開いていなくても** API を叩ける。
  なので `chrome.alarms` + `chrome.notifications` でバックグラウンド通知が作れる。
  イベント側が持っている `alerts`（開始何分前か）をそのまま尊重できる
- **自動同期** — Google カレンダーへのミラーなど
- **常駐** — 拡張である以上 Chrome が起動している必要がある。Chrome の
  「Google Chrome を閉じた際にバックグラウンド アプリの処理を続行する」を
  有効にすれば、ウィンドウを閉じても動き続ける。完全な常駐が要るなら
  デスクトップクライアントを使う
- **パッケージ化** — electron-builder 未設定

## 既知の制限

- **内部 API に依存している。** TimeTree が仕様を変えれば壊れる。公式 API ではないし、
  自動化されたアクセスは TimeTree の利用規約上グレー。自分のアカウントの自分の
  データを個人的に読む用途を想定している
- RRULE 展開は固定オフセットのタイムゾーン（JST / UTC）で正確。DST のある
  タイムゾーンでは遷移をまたぐと1時間ずれ得る
- `x-timetreea` のクライアントバージョンはハードコード（`web/2.1.0/ja`）
- アイコン未設定（Chrome のデフォルト表示になる）
