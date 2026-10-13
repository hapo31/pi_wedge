# 検証記録（2026-10-13）

## 実行環境と結果

ホスト: aarch64 / Debian12 / Node24.21.0。Pi 5そのものの性能測定ではない。

| 対象                   | 方法                                                                 | 結果                                                                            |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Hono/Swagger/OpenAPI   | 実HTTP、ローカルSwagger JS/CSS                                       | 成功                                                                            |
| SeaweedFS 4.48         | ARM64 Compose、/var/lib/pi_wedge→/data、S3書込→force-recreate→再読取 | データ一致                                                                      |
| S3Storage              | 実SeaweedFSでput/head/get/delete                                     | 成功                                                                            |
| API/サービス           | Vitest、CLI runnerは実子プロセス、プリンターはモック                 | 最終39テスト成功（CLI/所有権/サービス/API/プレビュー）                          |
| Orca2.4.2 + FreeCAD1.0 | ARM64 Debian13コンテナ、ネットワーク無効                             | 実ツールで成功                                                                  |
| STL20mm cube           | 非同期ジョブ→Orca→S3保存→UUID→preview text                           | succeeded、約71KBのgcode.3mf、約466KB G-code                                    |
| STEP20mm cube          | FreeCAD→STL→同じスライサー/保存経路                                  | succeeded、3.62g / 1213.85mm、総推定1356秒                                      |
| インチSTEP             | 0.7874015748inchをCONVERSION_BASED_UNITで宣言                        | 変換ログ19.9999999999962mm、スライス成功                                        |
| 2ソリッドSTEP          | 独立BREP2個、2個目のX位置30mm                                        | 2solids/24triangles、全幅50mm、スライス成功                                     |
| ブラウザ               | ARM64 Chromium156/Playwright1.64、実WebGL、API fixture               | レイヤー・travel・統計・回転/zoom・確認取消・1回送信・404・390px幅、2テスト成功 |
| A1 mini FTPS/MQTT      | モックのみ                                                           | 実機未検証                                                                      |

ブラウザの印刷APIはfixtureで置換した。物理印刷は一度も開始していない。実スライスの.gcode.3mfは生成・ZIP/G-code構造を検証したが、A1 miniで印刷可能なことを確認した結果ではない。

## 実ツールで判明した修正

- Orca --export-3mfにはファイル名を渡す。絶対パスは--outputdirと二重連結される。
- Orca2.4の設定コメントは10KB超。コメント行64KiB、実コマンド4KiBを上限にした。
- Orca2.4の時間は`total estimated time`から取得。旧形式のestimated printing timeも対応。
- FreeCAD PythonではPartより前にFreeCADをimportしてCADカーネルを初期化する。
- 成果物メタデータには統計のみをコピーし、ローカル一時パスを保存/公開しない。

## 未検証項目

A1 miniの実firmware、LAN Only/Developer Mode、証明書、FTPS保存パス、MQTT project_file/sequence ACK、AMS lite、ベッドオプション、実印刷。手順はprinter.md。
Pi 5 8GBでの最大モデル・高精度STEPのRSS/時間/温度、長期運用/電源断、SD容量枯渇、全種類のSTEP assembly。Slicer異常/ZIP上限は自動テスト済みだが、最大入力の性能保証ではない。

## 再実行

`npm run check`。SeaweedFS稼働時`npm run test:storage`。実ツール設定後`npm run test:slice -- path/to/model.stl path/to/model.step`。既定DB/ストレージへテストモデル・結果が保存されるため、検証専用DATA_DIR/S3_BUCKETで実行する。
ブラウザ: サーバーを起動して`npx playwright install --with-deps chromium`、`npm run test:e2e`。画像は.data/preview-desktop.png / .data/preview-mobile.png（Git外）。
検証用ARM64ツールイメージは `docker build -f deploy/Dockerfile.tools -t pi-wedge-tools:0.1 .`。これはホスト互換性を切り分ける補助環境で、アプリの既定実行方法はホストのCLIである。元ファイル/設定/一時ディレクトリだけをバインドして検証し、秘密をコンテナへ渡さない。
