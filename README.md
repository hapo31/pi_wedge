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

既定は127.0.0.1:3000。LANへ公開する場合HOST=0.0.0.0とファイアウォールを設定。`/health`、[Swagger](http://localhost:3000/docs)、[OpenAPI JSON](http://localhost:3000/openapi.json)。SwaggerのAuthorizeへAPI_TOKENを入力。文書/UI資産はローカル配信。

`npm run check`で型/Lint/Format/43テスト/ビルド。`npm run test:storage`で実S3確認。フロント開発は別ターミナルで`npm run dev:web`（同じAPIへproxy）。STORAGE_BACKEND=localはストレージ不要の開発用、偽スライス/偽印刷は本番へ導入しない。

## 本番

/var/lib/pi_wedgeを作成しSeaweedFSへbind mount。DATA_DIR=/var/lib/pi_wedge/appを設定、`.env`を600権限にする。`npm ci && npm run build`、`docker compose up -d`、`npm start`。アプリはOrca/FreeCADを利用するため初期構成はホスト上で起動する。systemd例はdeploy/、設定の絶対パスとサービスユーザーを実環境へ合わせる。nodeは24に固定。
Orca/FreeCAD導入と`npm run profiles:prepare`は[スライサー手順](docs/slicer.md)。プリンター設定・実機確認は[printer](docs/printer.md)。依存の導入後は外部通信不要。DBとSeaweedFSを停止して/var/lib/pi_wedgeをバックアップ。

## 実装・検証状況

| フェーズ | 実装 | 検証                                                                                       |
| -------- | ---- | ------------------------------------------------------------------------------------------ |
| 0        | 完了 | 実HTTP/Swagger/OpenAPI、SeaweedFS ARM64起動・再作成後の永続化                              |
| 1        | 完了 | UUID/ジョブ/エラー/FTPS・MQTTモック、実Orca+FreeCAD→S3保存（STL/STEP/インチ/複数ソリッド） |
| 2        | 完了 | 実WebGL/レイヤー/統計/確認付き印刷UI、デスクトップと390px幅、404/上限エラー                |

**A1 miniへの実転送・実印刷は未検証**。プリンターは既定で無効。実機でのフェーズ1受入れ条件は[printer.md](docs/printer.md)の手順で確認する。Pi 5での最大入力の性能も未測定。ソフトウェアの自動テストとハードウェア受入れを区別した詳細は[検証記録](docs/verification.md)。

Orca2.4.2の公式ARM64版はglibc条件によりDebian12へ直接導入できない。新規のネイティブ構築はRaspberry Pi OSのDebian13系を選択する。Debian12では検証済みの `TOOLS_BACKEND=docker` を選べる。[依存導入手順](docs/slicer.md)に従う。アプリ本体はNode24があればDebian12でも動作する。

## 利用の流れ

Swaggerで認証→`POST /api/slices`にSTL/STEPと設定を投入→ジョブUUIDをpoll→succeededのresultFileIdを取得→`/preview/{resultFileId}`で確認。印刷はプレビューの確認ダイアログまたは明示的なprint APIから開始する。
結果不明の印刷を自動再送しない。同じIdempotency-Keyで結果を参照し、実機確認後にresolve APIを使う。[API使用例](docs/api-design.md)を参照。

開発用UIは `npm run dev:web`。実ブラウザ検証はAPIサーバー起動後 `npx playwright install --with-deps chromium` と `npm run test:e2e`。ブラウザ試験は印刷APIをモックする。実スライス検証は `npm run test:slice -- model.stl model.step`（モデルと成果物を保存する）。同じDATA_DIRのサーバーを停止するか、検証専用DATA_DIRを指定して実行する。

設計: [concept](docs/concept.md)、[architecture](docs/architecture.md)、[API](docs/api-design.md)、[storage](docs/storage.md)、[preview](docs/preview.md)、[roadmap](docs/roadmap.md)。開発規約は[AGENTS.md](AGENTS.md)。

アプリのコードはMIT。ダウンロードするOrca本体/プロファイルなど第三者成果物はそれぞれのライセンスが適用される。
