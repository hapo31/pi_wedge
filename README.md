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

`npm run check`で型/Lint/Format/48テスト/ビルド。`npm run test:storage`で実S3確認。フロント開発は別ターミナルで`npm run dev:web`（同じAPIへproxy）。STORAGE_BACKEND=localはストレージ不要の開発用、偽スライス/偽印刷は本番へ導入しない。

## 本番

/var/lib/pi_wedgeを作成しSeaweedFSへbind mount。DATA_DIR=/var/lib/pi_wedge/appを設定、`.env`を600権限にする。`npm ci && npm run build`、`docker compose up -d`、`npm start`。アプリはOrca/FreeCADを利用するため初期構成はホスト上で起動する。systemd例はdeploy/、設定の絶対パスとサービスユーザーを実環境へ合わせる。nodeは24に固定。
Orca/FreeCAD導入と`npm run profiles:prepare`は[スライサー手順](docs/slicer.md)。プリンター設定・実機確認は[printer](docs/printer.md)。依存の導入後は外部通信不要。DBとSeaweedFSを停止して/var/lib/pi_wedgeをバックアップ。

## 実装・検証状況

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

`/api/*` はAI/管理用のBearer認証を維持。`/preview/{uuid}` とその配下の読取・印刷操作は信頼するLAN向けで、指定UUIDのスライス結果だけを扱う。ブラウザ印刷は同一OriginのPOSTと永続的なIdempotency-Keyが必要。
結果不明の印刷を自動再送しない。同じIdempotency-Keyで結果を参照し、実機確認後にresolve APIを使う。[API使用例](docs/api-design.md)を参照。

MCPクライアントには `http://サーバーのLAN-IP:3000/mcp` をStreamable HTTPとして登録し、`Authorization: Bearer <API_TOKEN>` を設定する。MCPは用途とAPI/プレビューの使い方をモデルに伝える案内専用で、実際のアップロード・スライスはAPI、確認はブラウザのプレビューで行う。[MCP接続手順](docs/mcp.md)を参照。

開発用UIは `npm run dev:web`。実ブラウザ検証はAPIサーバー起動後 `npx playwright install --with-deps chromium` と `npm run test:e2e`。ブラウザ試験は印刷APIをモックする。実スライス検証は `npm run test:slice -- model.stl model.step`（モデルと成果物を保存する）。同じDATA_DIRのサーバーを停止するか、検証専用DATA_DIRを指定して実行する。

設計: [concept](docs/concept.md)、[architecture](docs/architecture.md)、[API](docs/api-design.md)、[storage](docs/storage.md)、[preview](docs/preview.md)、[roadmap](docs/roadmap.md)。開発規約は[AGENTS.md](AGENTS.md)。

アプリのコードはMIT。ダウンロードするOrca本体/プロファイルなど第三者成果物はそれぞれのライセンスが適用される。
