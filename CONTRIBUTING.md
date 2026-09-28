# Contributing / 開発ガイド

TimeForest への貢献を歓迎します。
TimeTree の非公式クライアントなので、TimeTree の利用規約を確認し、過剰なアクセスやサービスへ負荷をかける変更は避けてください。

## 全体構成

中核は `src/lib/*.js`（`tz` / `recur` / `api` / `model` / `export` / `map`）です。
これらは `globalThis.TTX` へ IIFE で公開する、ビルド不要・依存なしの JavaScript です。
次の 4 形態が同じファイルを読み込みます。

| 形態 | 実行環境 | 入口 |
| --- | --- | --- |
| Chrome 拡張 | TimeTree Web へ注入 | `manifest.json` → `src/ui/*` + `src/content.js` + `src/bg.js` |
| デスクトップ | Electron | `client/`（main / preload / renderer） |
| ホスト型 Web | ブラウザ + Vercel プロキシ | `web/` + `api/` |
| ユーザースクリプト | TimeTree Web 上の同一オリジン | `build-userscript.js` / `build-app-userscript.js` |

`src/lib` のコピーは作らないでください。
`scripts/check.js` が、コピーの増加、各形態の lib リスト、`CLIENT_TAG`、`globalThis` の利用などを検査し、構成がずれた場合は CI を失敗させます。

## セットアップ

```bash
git clone https://github.com/nisesimadao/TimeForest
cd TimeForest

# ルートには依存関係がありません。
# デスクトップ版をビルドまたは起動する場合だけ実行します。
cd client && npm ci && cd ..
```

- **Chrome 拡張**：`chrome://extensions` で「パッケージ化されていない拡張機能を読み込む」を選び、リポジトリのルートを指定します。
- **デスクトップ**：`npm run client` を実行します。
- **Web（ローカル）**：`node web/build.js && node web/dev-server.js` を実行し、`http://localhost:8787` を開きます。
- **ユーザースクリプト**：`npm run build` / `npm run build:app` を実行すると `dist/` へ出力します。

## 変更前の確認

```bash
npm run check
```

このチェックは必須です。
CI では Node 20 と Node 24 で実行します。

`check.js` は、静的な構成検査、ユーザースクリプトの再現ビルド、フォーム周辺の整合性を確認します。
`verify:*`（`verify:api` / `verify:form` / `verify:recur` / `verify:cli` / `verify:mcp` / `verify:ext` など）は、動作中の Electron クライアントへ CDP で接続する E2E 検証です。

先に次のコマンドでクライアントを起動します。

```bash
npm run inspect
```

これは `electron . --remote-debugging-port=9333` を実行します。

## 共有ライブラリを追加する場合

`src/lib/foo.js` を追加したら、次の 4 箇所へ同じファイルを登録してください。
`check.js` がすべての配線を確認します。

1. `manifest.json` の `content_scripts[0].js`
2. `client/renderer/index.html` の `<script>`
3. `web/build.js` の `LIBS`
4. `build-app-userscript.js` の `LIBS`

## 変更時の注意

- 認証情報、Webhook、その他の秘密情報をコミットしないでください。ローカル専用データは `.local/` に置きます。
- README やテスト例へ実在する個人データを入れないでください。
- コミットメッセージは日本語でも英語でも構いません。変更内容が分かる文にしてください。
- 既存の実装形式へ合わせてください。`src/lib` は IIFE を維持し、コメントは実装上の制約や理由を説明する場合に絞ります。
- セキュリティ上の問題は公開 Issue ではなく、[SECURITY.md](SECURITY.md) の手順で報告してください。
