# 検証記録（2026-10-13）

## 実行環境と結果

ホスト: aarch64 / Debian12 / Node24.21.0。Pi 5そのものの性能測定ではない。

| 対象                   | 方法                                                                 | 結果                                                                            |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Hono/Swagger/OpenAPI   | 実HTTP、ローカルSwagger JS/CSS                                       | 成功                                                                            |
| SeaweedFS 4.48         | ARM64 Compose、/var/lib/pi_wedge→/data、S3書込→force-recreate→再読取 | データ一致                                                                      |
| S3Storage              | 実SeaweedFSでput/head/get/delete                                     | 成功                                                                            |
| API/サービス           | Vitest、CLI runnerは実子プロセス、プリンターはモック                 | 最終43テスト成功（CLI/所有権/サービス/API/プレビュー）                          |
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
ブラウザ: サーバーを起動して`npx playwright install --with-deps chromium`、`npm run test:e2e`。画像はPlaywrightのテスト別出力先にpreview-desktop.png / preview-mobile.pngとして保存する（既定はtest-results/、Git外）。
検証用ARM64ツールイメージは `docker build -f deploy/Dockerfile.tools -t pi-wedge-tools:0.1 .`。これはホスト互換性を切り分ける補助環境で、アプリの既定実行方法はホストのCLIである。元ファイル/設定/一時ディレクトリだけをバインドして検証し、秘密をコンテナへ渡さない。

追加検証: Debian12標準サーバーにTOOLS_BACKEND=dockerを設定し、POST /api/slicesのmultipartからSTL/STEPを受信して実ツール処理、S3保存、GET job/file/gcodeまで通した。コンテナtimeout/ラベル回収/回収失敗は自動テスト。環境テンプレートの既定はnative、ローカル.envはこの検証環境に合わせdockerを選択した。

## 添付モデルのスライス（2026-10-13）

`measuring_cup_10ml.step`（約1.6MB）を標準サーバーの `POST /api/slices` にmultipartで送信した。A1 mini 0.4mm / Generic PLA / 積層0.2mm / インフィル15% / サポートなし、メッシュ設定は既定値。実FreeCAD1.0→Orca2.4.2→SeaweedFS保存まで約3.4秒でsucceededとなった。

- ジョブUUID: `e3311bfd-be10-4c13-9cbc-b7d9e1a777e3`
- 元モデルUUID: `8f0de80d-dd91-42b1-9ee9-72e4b509904b`
- 結果UUID: `20f9f399-ba9e-493d-9800-70ec2d64264f`
- gcode.3mf: 468,548bytes、ZIP整合性正常、`Metadata/plate_1.gcode` を抽出できた。
- G-code: 1,800,698bytes / 74,273行 / 141レイヤー / 高さ28.20mm。
- 推定時間: 28分59秒（モデル造形22分54秒、準備を含む総時間）。材料5.72g / 1,918.74mm。
- 実ChromiumでUUIDから取得・3D表示、レイヤー70（高さ14.00mm）への切替、単一レイヤーと移動経路表示を確認。JavaScriptエラーなし。プリンターは無効、印刷ボタンは無効、プリンターAPI呼出し0回。

生成物・検証JSON・スクリーンショットは `.data/measuring-cup-test/`（Git管理外）に保存した。実機への転送・印刷、容量精度や水密性は検証していない。

## LANからのプレビュー接続（2026-10-13）

HTTPの既定とローカル `.env` を `HOST=0.0.0.0` に変更し、標準サーバーを正常終了・再起動した。`ss` で `0.0.0.0:3000` の待ち受けを確認。SeaweedFSは `127.0.0.1:8333` のまま。ホストのAvahiは稼働済みで、`pi5s.local` がLAN IPv4 `192.168.11.62` に解決された。

`http://pi5s.local:3000` と `http://192.168.11.62:3000` の両方でhealth・計量カップのプレビューページ・認証済みメタデータ/G-code取得が200、未認証のメタデータ取得が401となった。LAN IP経由の実Chromium（390×844、タッチ端末エミュレーション）で141層の3D表示、70層への切替、横にはみ出さないことを確認。JavaScriptエラーとプリンターAPI呼出しは0回。スクリーンショットと結果JSONは `.data/measuring-cup-test/preview-mobile-lan.png` / `lan-mobile.json` に保存。

`npm run check` は型・Lint・Format・43テスト・サーバー/UIビルドに成功。LAN IPをbaseURLとしたPlaywrightの既存2テストも成功（印刷APIはモック）。実スマートフォンや別の物理端末からの接続は未検証。同じLANの端末ではmDNS URLを利用でき、名前解決が使えない端末はLAN IPで接続する。

## AIから受け取ったURLを直接開くUI（2026-10-13）

ユーザーの用途に合わせ、LANの `/preview/{uuid}` をトークン入力なしで自動表示する構成へ変更した。元モデル名を表示し、トークンフォーム・APIリンク・UUIDの目立つ表示を削除。ブラウザ用のdata/gcode/downloadは指定UUIDのreadyスライスのみ公開し、`/api/*` のBearer認証は維持する。ブラウザ印刷は同一Origin・空のPOST・永続Idempotency-Keyを検証し、既存PrinterServiceを共用する。Originなし/不一致、本文付き、無効UUID/キー、未設定プリンターを拒否する。

- `npm run check`: 型・Lint・Format・全47テスト・サーバー/UIビルド成功。
- 実ChromiumのPlaywright2テスト: 入力なしの自動表示、レイヤー操作、確認取消時0送信、確認後1送信、404と印刷無効表示が成功。印刷要求はモック。
- 保存済み計量カップをLAN IPから390×844の実Chromiumで開き、141層の自動表示と70層への切替が成功。パスワード入力0、Authorizationヘッダー0、AI用API呼出し0、プリンターAPI呼出し0、JavaScriptエラー0、横はみ出しなし。
- 「印刷ファイルを保存」のダウンロード名は `measuring_cup_10ml.gcode.3mf`、ダウンロード内容のSHA-256が元成果物と一致。
- mDNS名 `pi5s.local` からdataを認証なしで取得成功。スクリーンショットと詳細JSONは `.data/measuring-cup-test/preview-simple-mobile.png` / `simple-mobile.json`（Git管理外）。

検証サーバーは会話の実行セッションから独立したsystemdユーザーサービス `pi-wedge.service` で稼働している（Restart=on-failure、既存ユーザーのLinger=yes）。ビルド後は `systemctl --user restart pi-wedge.service`、状態は `systemctl --user status pi-wedge.service` で確認。この検証用ユニットはsystemd-runによる一時ユニットで、OS再起動後の自動起動は本番用unitを設置して設定する。
実スマートフォンと実プリンターでの検証は未実施。プリンター設定は無効のままで、物理印刷は開始していない。

## ユーザー向け文言の見直し（2026-10-13）

開発規約の文言方針に沿い、画面の用途説明・重複した補足・操作ID・フッターを削除した。操作を「印刷」「ダウンロード」「結果を確認」に短縮し、確認ダイアログはベッド・材料・プレートの確認に絞った。プリンターの設定有無と実際の接続状態を区別し、受付済みと結果不明は別の状態として表示する。印刷失敗時の内部英語メッセージを原因・対処の日本語に置き換えた。

- `npm run check`: 型・Lint・Format・48テスト・サーバー/UIビルド成功。制限環境では既存CLI子プロセステスト2件が失敗したが、制限外での同じチェックは成功した。
- `npm run test:e2e`: ARM64 Chromiumで3テスト成功。レイヤー・統計・確認取消時0送信・確認後1送信・受付済み・404・結果不明時の操作無効・390px幅を確認した。デスクトップとモバイルの画像も確認した。
- サーバーは専用一時DATA_DIR・localストレージ・プリンター無効で127.0.0.1:3100に起動した。印刷APIはfixtureで置換し、物理印刷は開始していない。
- 導入済みブラウザは `/tmp/pi-wedge-browsers` を指定。不足ライブラリを `/tmp/pi-wedge-copy-browser-deps` に展開し、LD_LIBRARY_PATHで参照した。OSへのライブラリ導入はしていない。既存test-resultsの所有権による書込み失敗を避け、`--output=/tmp/pi-wedge-copy-playwright-results` で結果・画像を保存した。
