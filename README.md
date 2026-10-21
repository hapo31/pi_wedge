# pi_wedge

Raspberry Pi 5 8GBでSTL/STEPを非同期スライスし、SeaweedFSへ保存した成果物をUUIDで取得、ブラウザで3Dプレビューし、Bambu Lab A1 miniへLAN送信・印刷するTypeScriptサーバー。AIエージェント向けOpenAPI 3.1付き。運用はLAN内で完結。

必要: Raspberry Pi OS 64bit、Node.js 24.x、npm、Docker/Compose。実スライスはOrcaSlicer ARM64、STEPはFreeCAD Python、必要時Xvfb。対象プリンターA1 mini/0.4mm/PLA。ソフトウェア/firmware互換性の未検証項目は[roadmap](docs/roadmap.md)参照。

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

プレビューは展開後32MiB以内のG-code全体を扱い、総行数や1レイヤーのコマンド数では拒否しない。解析/描画を分割して進捗を表示する。大きいファイルの検証結果と端末の制約は[検証記録](docs/verification.md)を参照。

全体表示の検証: `npm run check`（66テスト・ビルド）と実Chromiumの5テストに成功。実ファイル473,996行/540レイヤーの表示・層切替・390px幅をプリンター無効の一時サーバーで確認した。2026-10-16にユーザー承認後、稼働サーバーへ反映・再起動し、元のLAN URLでの全体表示も確認済み。

`npm run check`で型/Lint/Format/66テスト/ビルド。`npm run test:storage`で実S3確認。フロント開発は別ターミナルで`npm run dev:web`（同じAPIへproxy）。STORAGE_BACKEND=localはストレージ不要の開発用、偽スライス/偽印刷は本番へ導入しない。

## 本番

/var/lib/pi_wedgeを作成しSeaweedFSへbind mount。DATA_DIR=/var/lib/pi_wedge/appを設定、`.env`を600権限にする。`npm ci && npm run build`、`docker compose up -d`、`npm start`。アプリはOrca/FreeCADを利用するため初期構成はホスト上で起動する。systemd例はdeploy/、設定の絶対パスとサービスユーザーを実環境へ合わせる。nodeは24に固定。
Orca/FreeCAD導入と`npm run profiles:prepare`は[スライサー手順](docs/slicer.md)。プリンター設定・実機確認は[printer](docs/printer.md)。依存の導入後は外部通信不要。DBとSeaweedFSを停止して/var/lib/pi_wedgeをバックアップ。

## 実装・検証状況

スライス履歴の実装: `/history` にreadyの結果を新しい順で24件ずつ表示し、名前・元ファイル名で検索してプレビューへ移動できる。任意の `name` をJSON・multipartのスライス要求で指定できる。既存結果は元モデル名を表示する。

スライス履歴の検証: `npm run check`（70テスト・ビルド）と `npm run test:e2e`（実Chromium6テスト）が成功。稼働サービスにも反映し、保存済み結果の一覧・検索・390px幅を実Chromiumで確認した。実機スライス・印刷は今回実行していない。詳細は[検証記録](docs/verification.md)。

| フェーズ | 実装 | 検証                                                                                       |
| -------- | ---- | ------------------------------------------------------------------------------------------ |
| 0        | 完了 | 実HTTP/Swagger/OpenAPI、SeaweedFS ARM64起動・再作成後の永続化                              |
| 1        | 完了 | UUID/ジョブ/エラー/FTPS・MQTTモック、実Orca+FreeCAD→S3保存（STL/STEP/インチ/複数ソリッド） |
| 2        | 完了 | 実WebGL/レイヤー/統計/確認付き印刷UI、デスクトップと390px幅、404/上限エラー                |

**A1 miniへの実FTPS転送・印刷要求受付・RUNNING状態・停止は確認済み、造形完了と品質は未検証**。2026-10-14の印刷API試行は署名不足で拒否されたが、実機のDeveloper Mode有効後に受付が成功した。プリンターは既定で無効。実機でのフェーズ1受入れ条件は[printer.md](docs/printer.md)の手順で確認する。Pi 5での最大入力の性能も未測定。ソフトウェアの自動テストとハードウェア受入れを区別した詳細は[検証記録](docs/verification.md)。

管理用の停止APIは`POST /api/printer/stop`（Bearer・Idempotency-Key UUID・JSON `{}`）。停止操作もSQLiteに保存し、同じキーでは再送しない。停止エンドポイントはモックで検証、実機の停止確認は診断用MQTTスクリプトによるもの。[API仕様と例](docs/api-design.md)を参照。

Orca2.4.2の公式ARM64版はglibc条件によりDebian12へ直接導入できない。新規のネイティブ構築はRaspberry Pi OSのDebian13系を選択する。Debian12では検証済みの `TOOLS_BACKEND=docker` を選べる。[依存導入手順](docs/slicer.md)に従う。アプリ本体はNode24があればDebian12でも動作する。

## 利用の流れ

AIにモデル作成を依頼→AIが認証済みAPIでSTL/STEPをスライス→完了したファイルのプレビューURLを受け取る→スマホでURLを開く→3D表示を確認して「印刷」。スマホではログインやAPIトークン入力は不要。印刷開始前に確認ダイアログを表示する。

`/api/*` はAI/管理用のBearer認証を維持。`/history` はreadyスライスの限定した一覧、`/preview/{uuid}` とその配下は指定UUIDのスライス結果を信頼するLANへ公開する。ブラウザ印刷は同一OriginのPOSTと永続的なIdempotency-Keyが必要。
結果不明の印刷を自動再送しない。同じIdempotency-Keyで結果を参照し、実機確認後にresolve APIを使う。[API使用例](docs/api-design.md)を参照。

MCPクライアントには `http://サーバーのLAN-IP:3000/mcp` をStreamable HTTPとして登録し、`Authorization: Bearer <API_TOKEN>` を設定する。MCPは用途とAPI/プレビューの使い方をモデルに伝える案内専用で、実際のアップロード・スライスはAPI、確認はブラウザのプレビューで行う。[MCP接続手順](docs/mcp.md)を参照。

開発用UIは `npm run dev:web`。実ブラウザ検証はAPIサーバー起動後 `npx playwright install --with-deps chromium` と `npm run test:e2e`。ブラウザ試験は印刷APIをモックする。実スライス検証は `npm run test:slice -- model.stl model.step`（モデルと成果物を保存する）。同じDATA_DIRのサーバーを停止するか、検証専用DATA_DIRを指定して実行する。

設計: [concept](docs/concept.md)、[architecture](docs/architecture.md)、[API](docs/api-design.md)、[storage](docs/storage.md)、[preview](docs/preview.md)、[roadmap](docs/roadmap.md)。開発規約は[AGENTS.md](AGENTS.md)。

アプリのコードはMIT。ダウンロードするOrca本体/プロファイルなど第三者成果物はそれぞれのライセンスが適用される。

## AMS Liteの供給設定

プレビューの印刷ボタン上でAMS接続状態・4スロットの装填/材料/色・使用中の供給元を確認し、外部スプールまたはAMSスロットを今回の印刷に選択できる。固定のGeneric PLAスライスに対応した単色設定で、温度やAMS側のフィラメント登録を書き換える操作ではない。AI用の取得はBearer付き`GET /api/printer/status`。Swaggerの開始APIには設定内容をユーザーへ提示して確認する推奨を記載。実装と検証の詳細は[検証記録](docs/verification.md)を参照。

複数プレートの実装: `/preview/{plateUUID}/{previewUUID}`で各枚を選び、下部サムネイル・統計・レイヤーを切り替える。プレートUUIDのみのURLは1枚目へリダイレクトする。履歴には枚数を表示し、プレビューのID欄で両UUIDを確認できる。従来の結果UUIDのURLも利用可能。

複数プレートの検証: 追加スライスと統合した`npm run check`（90テスト・ビルド）と実ChromiumのE2E7件が成功。両PRを各2回のサブエージェントレビュー後にマージし、2026-10-21に稼働サービスへ適用した。LANの既存URL・履歴・UUID表示・390px幅も確認済み。詳細は[検証記録](docs/verification.md)。複数枚の実機印刷は未検証。

追加スライスの実装: `POST /api/slices`のJSON・multipartに`parentId`として親プレビューの結果UUIDを渡すと、同じプレートUUIDの3MFへ別の枚を追加する。追加結果は新しいプレビューUUIDとなる。子を親として指定すると400となり、`error.parentId`にルートのUUIDを返す。親3MFのダウンロードは最新版、個別のAPIダウンロードと印刷は保存時点の成果物を使用する。[API仕様](docs/api-design.md#親プレビューへの追加スライス)を参照。

追加スライスの検証: `npm run test:slice -- --append MODEL`で実Orca/FreeCAD・S3保存と3枚までの追加を確認し、実HTTPから4枚目を追加してブラウザ表示を確認した。2026-10-21に稼働サービスへ適用済み。自動テスト・ブラウザ・3MF再読込の詳細は[検証記録](docs/verification.md)に記載。追加プレートの実機印刷は未検証。
