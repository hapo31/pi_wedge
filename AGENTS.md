# pi_wedge 開発規約

## 目的・構造

Raspberry Pi 5 8GB / ARM64 のLAN内でA1 mini用モデルをスライスし、UUIDで保存・プレビュー・明示的に印刷する。
`src/domain` は型・インターフェース、`src/adapters` は外部実装、`src/services` はユースケース、`src/app.ts` はHTTP、`web` はReact、`docs` は設計・検証記録。

## 制約

- HTTPハンドラーでCLI、S3、FTPS、MQTTを直接操作しない。Slicer / ModelConverter / ObjectStorage / Printerのインターフェース経由。
- SQLiteにメタデータ・ジョブ・印刷操作を永続化。ファイル本体はストレージ経由。UUIDをオブジェクトキーに使用し、クライアントのパスは受け取らない。
- 初期実装は単一サーバープロセス。Piのメモリを守るため同時スライス数は1。キューに上限。
- 印刷開始を他のAPIから暗黙的に呼ばない。認証・永続的冪等キーを必須にする。結果不明のMQTT操作を自動再送しない。
- MCPは未実装。サービス層をHTTPから独立させ将来の入口を追加可能にする。
- ARM64にないバイナリを必須依存にしない。実機依存の結果をモック結果と混同しない。

## コーディング・API

TypeScript strict / noUncheckedIndexedAccess、ESM、2スペース、Prettier。外部入力はZodで検証。UUID、形式、サイズ、数値範囲、未知キーを検証。CLIはspawn(shell:false)と固定の引数配列、タイムアウト、上限付きログ、一時領域のfinally清掃を使用。秘密をログ・例外・URLに出さない。
OpenAPI 3.1は実行時スキーマと共有し、operationId、例、エラー、非同期状態、物理副作用を記述。変更時は整合性テスト・docs/api-design.mdを更新。

## ストレージ・スライサー

書込み前にstagingメタデータを作成し、保存成功後readyへ。失敗はfailed。クラッシュ時のstagingは再照合。ストレージ変更は両アダプターの契約テストで確認。Orca固有の引数、出力、プロファイルはアダプター内。APIから任意CLI引数やユーザーG-code設定を受け取らない。プロファイルは管理者が固定バージョンから準備し、継承を解決する。

## テスト・フェーズ

Vitestで抽象化、UUID、入力、キュー状態、再起動、ストレージ障害、重複印刷防止、MQTT通信モック、OpenAPI整合性を確認。大規模プレビューは上限・分割処理を確認。実機を動かすテストは既定テストから外す。
フェーズ0: サーバー/Swagger/OpenAPIとSeaweedFS再作成後の永続化。
フェーズ1: フェイクCLI/モックで非同期→保存→UUID→転送→印刷を検証、実機の手順はdocs参照。
フェーズ2: UIビルド、G-code抽出制限、レイヤー/印刷操作、ブラウザ確認。
各フェーズは論理的コミット。README・roadmapに実装と検証の状態を別々に記録。

## 変更後チェック

`npm run check`（型、Lint、Format、Vitest、サーバー/UIビルド）。S3変更時は `npm run test:storage` とComposeコンテナ再作成後の読取。ハードウェア検証はdocs/slicer.md・docs/printer.mdに記録。生成ファイル、.env、秘密、データをコミットしない。
