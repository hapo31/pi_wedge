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

`npm run check`で型/Lint/Format/テスト/ビルド。`npm run test:storage`で実S3確認。フロント開発は別ターミナルで`npm run dev:web`（同じAPIへproxy）。STORAGE_BACKEND=localはストレージ不要の開発用、偽スライス/偽印刷は本番へ導入しない。

## 本番

/var/lib/pi_wedgeを作成しSeaweedFSへbind mount。DATA_DIR=/var/lib/pi_wedge/appを設定、`.env`を600権限にする。`npm ci && npm run build`、`docker compose up -d`、`npm start`。アプリはOrca/FreeCADを利用するため初期構成はホスト上で起動する。systemd例はdeploy/、設定の絶対パスとサービスユーザーを実環境へ合わせる。nodeは24に固定。
Orca/FreeCAD導入と`npm run profiles:prepare`は[スライサー手順](docs/slicer.md)。プリンター設定・実機確認は[printer](docs/printer.md)。依存の導入後は外部通信不要。DBとSeaweedFSを停止して/var/lib/pi_wedgeをバックアップ。

## 状態

フェーズ0: 実装・検証済み（ARM64、実HTTP、SeaweedFS S3とコンテナ再作成後の永続化）。フェーズ1/2: 計画済み。実機互換性は未検証。
設計: [concept](docs/concept.md)、[architecture](docs/architecture.md)、[API](docs/api-design.md)、[storage](docs/storage.md)、[preview](docs/preview.md)、[roadmap](docs/roadmap.md)。開発規約は[AGENTS.md](AGENTS.md)。
