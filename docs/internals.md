# 内部メモ — TimeTree 内部 API のリバースエンジニアリング

TimeForest は、TimeTree Web が利用する内部 API を使っています。
この文書は、書き込み処理や繰り返し予定へ変更を加える開発者向けに、実際の TimeTree Web の通信から確認したデータモデルとリクエスト形式を記録したものです。
高レベルの構成は [README](../README.md) を参照してください。

## 繰り返し予定の書き込み

TimeTree Web には「この回だけ編集」専用のエンドポイントはありません。
繰り返し予定の編集は、親イベントの `recurrences` を変更する操作と、必要に応じて親を参照する別イベントを作成する操作を組み合わせています。

以下は、テスト用アカウントで TimeTree Web の UI を操作し、実際の送信内容を確認した結果です。

| 操作 | リクエスト |
| --- | --- |
| この回だけ編集 | `POST /event` に `parent_id: <親uuid>` と `silent: true` を付けて子イベントを作成。続けて `PUT /event/{親}` で `recurrences: [RRULE, EXDATE:<対象回>]` と `silent: true` を送信 |
| これ以降を編集 | `POST /event` に `recurrences: [RRULE]` と `copy: true` を付けて分割点から新しい親を作成。続けて既存親へ `RRULE;UNTIL=<最後に残す回>` を設定 |
| すべてを編集 | `PUT /event/{親}` に変更分を送信 |
| この回だけ削除 | 親へ `RRULE` と対象回の `EXDATE` を設定 |
| これ以降を削除 | 親へ `RRULE;UNTIL=<最後に残す回>` を設定 |
| すべて削除 | `DELETE /event/{親}` |

実装上、特に次の点へ注意してください。

- **書き込み時の親子関係は `parent_id` を使います。**
  読み取りでは同じ関係が `recurring_uuid` として返りますが、`recurring_uuid` を作成・更新リクエストへ送っても親子関係は設定されません。
  `parent_id` を送ると、読み取り時には対応する `recurring_uuid` が返ります。
- **「この回だけ編集」では `silent: true` が使われます。**
  一つの UI 操作が子イベント作成と親イベント更新の 2 リクエストになるため、TimeTree Web は両方へ `silent: true` を付けています。
- **`UNTIL` は日付のみで、最後に残す occurrence の表示日を使います。**
  分割点の単純な前日や 1 周期前ではありません。
  EXDATE がある場合もあるため、`src/lib/recur.js` で実際の直前 occurrence を求めて設定します。

## データモデル

実データと TimeTree Web の月表示を比較して確認した主な条件です。

| 条件 | 扱い |
| --- | --- |
| `deactivated_at != null` | 削除済みイベントとして除外 |
| `category: 2` | カレンダーイベントではなく Keep のメモ。`row_order` を持ち、通常のグリッドには表示しない |
| `type: 1` | 誕生日。`title` が空の場合は `author_id` からメンバー名を取得して表示名を組み立てる |
| 繰り返し | 親が `RRULE` / `EXDATE` を持ち、変更された回は `recurring_uuid` を持つ別イベントとして返る |
| 終日の `end_at` | 終端日を含む。ICS の `DTEND` は終端を含まないため、出力時に 1 日加算する |
| 複数日 | 終日予定だけでなく、時刻付きイベントが日をまたぐ場合もある |
| 祝日 | events API ではなく `memorialdays` から取得してマージする |

確認した実データでは、RRULE は主に `FREQ=DAILY|WEEKLY|YEARLY` と `BYDAY` / `UNTIL` / `INTERVAL` の組み合わせでした。
このため、TimeForest は外部の rrule ライブラリではなく `src/lib/recur.js` に必要な範囲の展開処理を持ちます。

`COUNT` は確認した既存データには含まれていませんでしたが、書き込み API では保存できることを確認しています。
そのため展開器でも `COUNT` を処理します。

`COUNT` は表示中の期間ではなくシリーズ開始から数えます。
また RFC 5545 の扱いに合わせ、EXDATE で除外される回も先に COUNT の対象として数えた後で除外します。
`scripts/check.js` はこの挙動を実際の展開結果で検証します。

## 検証記録

`src/lib/recur.js` の展開結果は、テスト用アカウントの TimeTree Web が描画した月表示と比較しています。
2026 年 7 月の確認では、107 件中 104 件がそのまま一致し、残りも次のデータ種別として説明できました。

- 七夕・海の日：events API ではなく `memorialdays` 由来。
- 誕生日 2 件：`title` が空で、`author_id` から表示名を作る必要がある。
- 「西公民館に700円持参」：`category: 2` のメモで、カレンダーイベントとしては除外する。

この比較結果を基に、現在の `model.js` と `recur.js` の変換ルールを実装しています。
