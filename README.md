# pi_wedge

Raspberry Pi 5 8GBでSTL/STEPを非同期スライスし、SeaweedFSへ保存した成果物をUUIDで取得、ブラウザで3Dプレビューし、Bambu Lab A1 miniへLAN送信・印刷するTypeScriptサーバー。AIエージェント向けOpenAPI 3.1付き。運用はLAN内で完結。

必要: Raspberry Pi OS 64bit、Node.js 24.x、npm、Docker/Compose。実スライスはOrcaSlicer ARM64、STEPはFreeCAD Python、必要時Xvfb。対象プリンターA1 mini/0.4mm/PLA。

## インストール・開発

```bash
npm ci
cp .env.example .env
# .envのAPI_TOKEN、S3_SECRET_KEYをランダム値へ変更
# 開発用にSEAWEED_DATA_DIR=./.data/seaweedfsを指定
mkdir -p .data/seaweedfs
docker compose up -d seaweedfs
npm run dev
```

既定は `HOST=0.0.0.0` / ポート3000でLANから接続できる。既存の `.env` が `HOST=127.0.0.1` の場合は `HOST=0.0.0.0` に変更してサーバーを再起動する。ローカル限定の運用は `HOST=127.0.0.1` を指定する。`/health`、[Swagger](http://localhost:3000/docs)、[OpenAPI JSON](http://localhost:3000/openapi.json)。SwaggerのAuthorizeへAPI_TOKENを入力。文書/UI資産はローカル配信。

同じLAN/Wi-Fiのスマホでは `http://サーバーのLAN-IP:3000/preview/{resultFileId}` を開くだけでプレビューが表示される。サーバーでAvahi等のmDNSが稼働している場合は `http://ホスト名.local:3000/preview/{resultFileId}` でも開ける（例: ホスト名 `raspberrypi` なら `raspberrypi.local`）。実際のIPは `hostname -I`、ホスト名は `hostname` で確認する。ファイアウォールを使う場合はLANからのTCP 3000を許可する。SeaweedFSのS3/管理ポートは引き続きホスト内で利用する。

過去のスライスは `http://サーバーのLAN-IP:3000/history` に新しい順で表示され、名前・元ファイル名で検索できる。名前を付ける場合は `POST /api/slices` のJSONまたはmultipartで任意の `name` を指定する。未指定や既存のスライスは元モデルのファイル名を表示する。履歴は信頼するLAN内で認証なしのため、LAN内の利用者に名前とプレビューURLが見える。

プレビューは展開後32MiB以内のG-code全体を扱い、解析/描画を分割して進捗を表示する。描画用データはブラウザ/GPUに残るため、端末によって表示できる容量は異なる。上限を超える成果物はダウンロードを利用する。

`npm run check`で型/Lint/Format/自動テスト/サーバー・UIビルド。`npm run test:storage`で実S3確認。フロント開発は別ターミナルで`npm run dev:web`（同じAPIへproxy）。`STORAGE_BACKEND=local`はストレージ不要の開発用。

## 本番

/var/lib/pi_wedgeを作成しSeaweedFSへbind mount。DATA_DIR=/var/lib/pi_wedge/appを設定、`.env`を600権限にする。`npm ci && npm run build`、`docker compose up -d`、`npm start`。アプリはOrca/FreeCADを利用するため初期構成はホスト上で起動する。systemd例はdeploy/、設定の絶対パスとサービスユーザーを実環境へ合わせる。nodeは24に固定。
Orca/FreeCAD導入と`npm run profiles:prepare`は[スライサー手順](docs/slicer.md)。プリンター設定・実機確認は[printer](docs/printer.md)。依存の導入後は外部通信不要。DBとSeaweedFSを停止して/var/lib/pi_wedgeをバックアップ。

Orca2.4.2の公式ARM64版はglibc条件によりDebian12へ直接導入できない。新規のネイティブ構築はRaspberry Pi OSのDebian13系を選択する。Debian12では `TOOLS_BACKEND=docker` を利用する。[依存導入手順](docs/slicer.md)を参照。アプリ本体はNode24があればDebian12でも動作する。

## 利用の流れ

AIにモデル作成を依頼→AIが認証済みAPIでSTL/STEPをスライス→完了したファイルのプレビューURLを受け取る→スマホでURLを開く→3D表示を確認して「印刷」。スマホではログインやAPIトークン入力は不要。印刷開始前に確認ダイアログを表示する。

`/api/*` はAI/管理用のBearer認証を維持。`/history` はreadyスライスの限定した一覧、`/preview/{uuid}` とその配下は指定UUIDのスライス結果を信頼するLANへ公開する。ブラウザ印刷は同一OriginのPOSTと永続的なIdempotency-Keyが必要。
結果不明の印刷を自動再送しない。同じIdempotency-Keyで結果を参照し、実機確認後にresolve APIを使う。[API使用例](docs/api-design.md)を参照。

MCPクライアントには `http://サーバーのLAN-IP:3000/mcp` をStreamable HTTPとして登録し、`Authorization: Bearer <API_TOKEN>` を設定する。MCPは用途とAPI/プレビューの使い方をモデルに伝える案内専用で、実際のアップロード・スライスはAPI、確認はブラウザのプレビューで行う。[MCP接続手順](docs/mcp.md)を参照。

開発用UIは `npm run dev:web`。実ブラウザ検証はAPIサーバー起動後 `npx playwright install --with-deps chromium` と `npm run test:e2e`。ブラウザ試験は印刷APIをモックする。実スライス検証は `npm run test:slice -- model.stl model.step`（モデルと成果物を保存する）。同じDATA_DIRのサーバーを停止するか、検証専用DATA_DIRを指定して実行する。

## プレートとAMS Lite

複数プレートは `/preview/{plateUUID}/{previewUUID}` で選択し、下部サムネイル・統計・レイヤーを切り替える。プレートUUIDのみのURLは1枚目へリダイレクトする。履歴には先頭プレートの1件だけを表示し、集合全体の枚数を添える。プレビューのID欄で両UUIDを確認できる。従来の結果UUIDのURLも利用可能。

`POST /api/slices`のJSON・multipartに`parentId`として親プレビューの結果UUIDを渡すと、同じプレートUUIDの3MFへ別の枚を追加する。子を親として指定すると400となり、`error.parentId`にルートのUUIDを返す。親3MFのダウンロードは最新版、個別のAPIダウンロードと印刷は保存時点の成果物を使用する。[API仕様](docs/api-design.md#親プレビューへの追加スライス)を参照。

プレビューでAMS Liteの接続状態・4スロットの装填/材料/色・使用中の供給元を確認し、外部スプールまたはAMSスロットを選択できる。固定のGeneric PLAスライスに対応した単色設定で、温度やAMS側のフィラメント登録は変更しない。AI用の取得はBearer付き`GET /api/printer/status`。

プレート一覧は切替中もDOM・画像・スクロール位置を保持する。メタデータ・G-code・AMS・履歴・サムネイルの取得はTanStack Query、ルーティングはTanStack Routerを使用する。[プレビュー設計](docs/preview.md)を参照。

## 印刷の制約

プリンターは既定で無効。現行のLANアダプターはFTPS/MQTTを使用し、ファームウェアとLAN Only / Developer Modeの設定に依存する。印刷の`accepted`は要求受付を表し、造形完了を表さない。[設定・実機確認手順](docs/printer.md)を参照。

管理用の停止APIは`POST /api/printer/stop`（Bearer・Idempotency-Key UUID・JSON `{}`）。停止操作もSQLiteに保存し、同じキーでは再送しない。[API仕様と例](docs/api-design.md)を参照。

造形完了・品質、停止REST API経由の実機キャンセル、AMS供給・複数プレートの実印刷、Pi 5の最大入力性能、実スマートフォンでの受入れは未検証。[検証記録・残る受入れ確認 #10](https://github.com/hapo31/pi_wedge/issues/10)で管理する。

クラウド印刷は未実装。Handy併用の印刷経路は[Issue #1](https://github.com/hapo31/pi_wedge/issues/1)、[接続方式の調査 #6](https://github.com/hapo31/pi_wedge/issues/6)、[Connect詳細調査 #7](https://github.com/hapo31/pi_wedge/issues/7)を参照。

## ドキュメント

[コンセプト](docs/concept.md)、[アーキテクチャ](docs/architecture.md)、[API](docs/api-design.md)、[ストレージ](docs/storage.md)、[スライサー](docs/slicer.md)、[プリンター](docs/printer.md)、[プレビュー](docs/preview.md)、[MCP](docs/mcp.md)。開発規約は[AGENTS.md](AGENTS.md)。

調査・計画・検証・反映の経過は[GitHub Issues](https://github.com/hapo31/pi_wedge/issues)で管理する。過去の[フェーズ・実装履歴 #11](https://github.com/hapo31/pi_wedge/issues/11)と[README・運用文書の記録 #12](https://github.com/hapo31/pi_wedge/issues/12)も参照できる。

アプリのコードはMIT。ダウンロードするOrca本体/プロファイルなど第三者成果物はそれぞれのライセンスが適用される。
