# 実装計画（作業開始時に確定）

| フェーズ | 実装順・成果物                                                                                 | 完了を判定する検証                                                                      | 初期状態 |
| -------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- |
| 0        | 技術調査→設計8文書→Node24/Hono/Zod/OpenAPI→Compose→ヘルス/Swagger                              | 型/Lint/テスト/ビルド、実HTTP、ARM64 SeaweedFSで書込・コンテナ再作成・読取、Gitコミット | 作業中   |
| 1        | domain→SQLite→local/S3→ファイルサービス→コマンドrunner→FreeCAD→Orca→永続キュー→LAN printer→API | 契約/障害/復旧/入力/状態/MQTTモック/OpenAPIテスト、S3統合、実機試験は別記、Gitコミット  | 計画     |
| 2        | 安全なZIP抽出→preview API→React/gcode-preview→レイヤー/統計/確認付き印刷→UI検証                | G-code/ZIP不正・上限・UI型/ビルド・ブラウザ、Gitコミット                                | 計画     |

依存: フェーズ1は0の起動・ストレージ基盤に依存、2は1のUUID取得と明示的印刷APIに依存。フェーズ1だけでもSwagger/CLIから利用可能。

## 重大な不確定事項と判断

- Orca ARM64配布物はUbuntu 24.04向け。Pi OSのglibc/GTK互換、ヘッドレス初期化、処理時間/メモリは対象OS上で検証が必要。失敗時は同じSlicer契約で別ビルド/スライサーへ交換。
- A1 miniのLANプロトコルは公開された安定公式APIではない。FTPS990/MQTT8883を候補にし、LAN Only/Developer Modeと実ファームウェアで確認。署名を回避する実装は行わない。
- .gcode.3mfを標準印刷成果物とし、通常G-codeはプレビュー/ダウンロード用。ZIP内のplate_1.gcodeと実印刷可能性を別に検証。
- DBはNode24組込みSQLite。better-sqlite3よりARM64の追加ネイティブ依存を減らせる。SQLite APIは対象Node版に固定。多プロセス運用は初期スコープ外。
- SeaweedFSは4.48 mini + S3。master/volume/filerを別コンテナに分散しない。AWS SDKはLAN上のS3互換入口のみに接続。
- プレビューはgcode-preview（Three.jsベース）。全ファイルを無制限に扱わず32MiB/線数上限、分割処理。これを超えるファイルは保存/印刷可能だがプレビューは413。

## 完了時の記録

実装結果、実行コマンド、未検証項目はフェーズ完了時にこの文書とREADMEへ追記する。モック成功だけで実機完了としない。

## フェーズ0検証結果

2026-10-13 aarch64 / Node24.21.0 / SeaweedFS4.48。Hono実HTTP health/Swagger（ローカルJS資産）/OpenAPI3.1を取得。/var/lib/pi_wedge→/data bind mountでS3書込後、コンテナforce-recreateして同じUUIDを読取り・一致確認・削除。型/初期APIテスト/サーバーとUIビルド成功。

## フェーズ1ソフトウェア検証

UUID、staging復旧、永続SQLite、ストレージ障害、キュー/同時実行/再起動、STEP→Slicer契約、入力/サイズ/認証、JSON/multipart、OpenAPI、副作用分離、印刷冪等性、FTPS/MQTT TLS/ACK/timeoutを30自動テストで確認。CLI runnerは実子プロセス、Orca/FreeCADアダプターとプリンターはモック。SeaweedFSでS3アダプターput/head/get/delete、公式v2.4.2プロファイル継承解決を実行確認。実機を使用した転送/印刷は未検証。
