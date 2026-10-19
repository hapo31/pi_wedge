# 検証記録（2026-10-19）

## 実行環境と結果

ホスト: aarch64 / Debian12 / Node24.21.0。Pi 5そのものの性能測定ではない。

| 対象                   | 方法                                                                 | 結果                                                                            |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Hono/Swagger/OpenAPI   | 実HTTP、ローカルSwagger JS/CSS                                       | 成功                                                                            |
| SeaweedFS 4.48         | ARM64 Compose、/var/lib/pi_wedge→/data、S3書込→force-recreate→再読取 | データ一致                                                                      |
| S3Storage              | 実SeaweedFSでput/head/get/delete                                     | 成功                                                                            |
| API/サービス           | Vitest、CLI runnerは実子プロセス、プリンターはモック                 | 最終57テスト成功（停止API・冪等性・復旧・CLI/所有権/サービス/API/プレビュー）   |
| Orca2.4.2 + FreeCAD1.0 | ARM64 Debian13コンテナ、ネットワーク無効                             | 実ツールで成功                                                                  |
| STL20mm cube           | 非同期ジョブ→Orca→S3保存→UUID→preview text                           | succeeded、約71KBのgcode.3mf、約466KB G-code                                    |
| STEP20mm cube          | FreeCAD→STL→同じスライサー/保存経路                                  | succeeded、3.62g / 1213.85mm、総推定1356秒                                      |
| インチSTEP             | 0.7874015748inchをCONVERSION_BASED_UNITで宣言                        | 変換ログ19.9999999999962mm、スライス成功                                        |
| 2ソリッドSTEP          | 独立BREP2個、2個目のX位置30mm                                        | 2solids/24triangles、全幅50mm、スライス成功                                     |
| ブラウザ               | ARM64 Chromium156/Playwright1.64、実WebGL、API fixture               | レイヤー・travel・統計・回転/zoom・確認取消・1回送信・404・390px幅、2テスト成功 |
| A1 mini FTPS/MQTT      | モック・実FTPS転送とサイズ照合・印刷APIの実MQTT（2026-10-14）        | Developer Mode有効後に受付・RUNNING・停止確認。造形完了と品質は未検証           |

2026-10-13のブラウザ検証では印刷APIをfixtureで置換し、物理印刷を開始していない。2026-10-14の実機試行ではRESTからの印刷受付・RUNNING状態・明示的停止を確認したが、造形完了と品質は未検証。実スライスの.gcode.3mfは生成・ZIP/G-code構造を検証済み。

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

## MQTT診断と印刷APIによる実機試行（2026-10-14）

ユーザーが前回の操作`828ecc76-0ad7-4d5b-95ef-316911099e65`について「開始していない」と確認したため、管理APIのresolveでfailed / manually_resolvedへ更新した。その後、ユーザーの明示指示でMQTT診断ログ・command省略ACK・result大小文字・非ゼロerr_codeの拒否判定を実装した。秘密・全テレメトリをログへ出さず、文字列と応答数を制限する。モックで回帰検証し、実機結果とは区別する。

稼働していたnpm startのプロセスを正常終了し、ビルド済みコードをsystemdユーザーサービス`pi-wedge.service`として起動した。旧PID名前空間の所有者PID20がSQLiteに残って起動を妨げたため、旧サーバーの停止と、現在のPID20が無関係のカーネルスレッドであることを確認し、その所有者記録だけを除いた。サービスactive、GET /health 200を確認。OS再起動後の自動起動設定はこの一時ユニットには含まれない。

`POST /api/printer/print`へBearer認証・新しい永続Idempotency-Keyで一度だけ送信した。直接MQTTによる印刷開始や、自動再送は行っていない。

- 印刷操作UUID: `fcabcdab-87d7-4865-9b00-be8b43f81d19`
- ファイルUUID: `c4435680-29b2-459f-a9ad-44a8b45d2d95`（figure_tail_stand.stlのスライス、740,418bytes）
- オプション: plate 1、ベッドレベリングあり、AMSなし、flow/vibration/timelapseなし。前回と同じ。
- 実FTPS転送とリモートサイズ照合成功。その後MQTT TLS接続・report購読・pushall応答でIDLE / print_error 0を取得。
- 2026-10-14 00:16:50 JSTにproject_fileを送信。約13ms後に同じsequence_id `264944858`の応答を受信した。commandはproject_file、resultは省略、err_codeは`84033543`（`0x05024007`）。
- HTTP 502、操作はfailed / printer_rejectedで永続化。acceptedではなく、造形開始・完了は確認していない。

この実応答は、旧実装ではresultがないためunknownになる形式だった。前回の応答は記録されていないため、前回も同じエラーだったとは断定しない。今回のコードは非ゼロerr_codeを拒否と判定する。

[通信ライブラリ作者のエラー表](https://github.com/Aptimex/bambu-mqtt-generator/blob/main/README.md)では84033543は署名が必要な要求に署名がないことを示す。[Bambu公式方針](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/)はLAN OnlyのDeveloper Modeを第三者MQTT制御の選択肢として説明している。実機側のLAN Only / Developer Mode設定確認が次の手順。署名の回避実装は追加しない。

要求・応答の診断は`journalctl _SYSTEMD_USER_UNIT=pi-wedge.service -o cat`で操作UUIDを照合する。API試行結果とMQTTログの控えは`.data/printer-diagnostics/`（Git管理外）に保存。自動検証はnpm run check（型・Lint・Format・50テスト・サーバー/UIビルド）。サンドボックス内の既存CLI子プロセステスト2件の失敗は通常環境での実行で解消した。TLSの既存テスト期待値もserial照合関数を含む現行実装へ合わせた。ブラウザのコードとCLI処理は変更していない。

## Developer Mode有効後の受付成功と停止（2026-10-14）

ユーザーが実機のDeveloper Modeを有効にしたと通知した後、同じファイルとオプションを`POST /api/printer/print`へ新しいキーで一度送信した。要求・応答は`.data/printer-diagnostics/9b07689a-2272-4423-aa94-de1276ca1090.json`と同名の`.mqtt.log`へ保存した。

- 印刷操作UUID: `9b07689a-2272-4423-aa94-de1276ca1090`
- ファイルUUID: `c4435680-29b2-459f-a9ad-44a8b45d2d95`。前回と同じplate 1、ベッドレベリングあり、AMSなし。
- FTPS転送・サイズ照合・MQTTのIDLE取得成功。
- 00:21:51 JST、sequence_id `162559625`のproject_file要求に約20msでresult success / reason successのACKを取得。HTTP 200 / accepted、error nullで永続化。
- ユーザーの「成功したら停止」指示を受け、00:23:11 JSTに固定のprint.stopを一度送信。停止REST APIがないため、この停止だけは診断スクリプトから直接MQTTで実行した。
- 停止診断UUID: `944a8122-a8eb-4ece-bf15-a57e1f4f53e8`、sequence_id `155494418`。約13msでcommand stop / result successのACKを取得。
- 停止後のpushallと状態通知を読み取り、RUNNING（stg_cur 4、mc_percent 0、print_error `134201350`）の報告後、00:23:15 JSTにFAILED（print_error `50348044` / `0x0300400c`）へ遷移したことを確認。
- 停止要求・ACK・終了状態の記録は`.data/printer-diagnostics/944a8122-a8eb-4ece-bf15-a57e1f4f53e8.stop.json`へ保存。自動再送なし。

開始受付と停止後の終了状態は実機で確認した。造形完了・出力品質・各種エラー値の意味・AMS/ベッド設定の個別効果は未検証。印刷操作のacceptedは要求受付の履歴なので、後の停止によってfailedへ書き換えていない。停止APIを検証した結果ではない。Developer Mode有効前の署名拒否と有効後の受付成功を比較し、この試行の拒否原因がコマンド認証にあったことを確認できた。

## 停止REST APIの追加と適用（2026-10-14）

`POST /api/printer/stop`を追加し、稼働サーバーへ適用してpi-wedge.serviceを再起動した。Bearer・Idempotency-Key UUID・Content-Type application/json・厳密な空オブジェクト`{}`を要求する。HTTPハンドラーはPrinterServiceを呼び、MQTTはPrinter.stopPrintを実装するアダプターだけが操作する。停止のpending/accepted/failed/unknownをSQLiteのstopOperationレコードに保存し、開始とはキーの名前空間を共有する。既存のGET operations / POST resolveは両方の操作に対応する。既存の開始レコードと応答形式は維持した。

- `npm run check`: 型・Lint・Format・57テスト・サーバー/UIビルド成功。
- MQTTモック: 固定stopのみ送信、idle検査・転送・開始なし、異なるcommandのACKを除外、拒否とACK不達を区別。
- サービス: SQLiteを別接続で開き直して冪等性を確認、開始キーとの衝突、結果不明の開始からの停止、結果不明の停止の再送・新規開始禁止、同時要求拒否、pending復旧を確認。
- API: 認証・必須キー・未知キー・配列・欠落本文を拒否、受付・拒否・不明のレスポンスと共有ランタイムスキーマ/OpenAPI、照会・手動解決・重複送信防止を確認。
- 実HTTP: health / api/ready 200、OpenAPIにstopPrint・Bearer・必須Idempotency-Keyを確認。無認証POSTは401、未知キーのJSONとContent-Type省略は400。拒否される要求だけを送り、有効な停止コマンドは実機へ送信していない。
- 再起動後も以前の開始操作`9b07689a-2272-4423-aa94-de1276ca1090`はacceptedのまま照会でき、サービスはactive。

停止エンドポイント経由の実機キャンセルは未検証。前節の停止成功は診断用の直接MQTTによるもの。UI・CLI・S3は変更していない。

## AMS Lite状態表示と供給設定UI（2026-10-14）

計画は状態取得の抽象化、認証付き/UUID限定API、印刷ボタン上の状態と供給設定、確認内容と冪等性、Swagger案内、ソフトウェアと実機読取の検証の順で整理して実施した。

- `npm run check`: 型・Lint・Format・63テスト・サーバー/UIビルド成功。新規6件で実A1 mini形式のAMS正規化、MQTT読取のみ、アクセス制御、読取の共有、AMS mapping/空スロット/材料不一致の拒否、応答不達後のキーと設定保持を確認した。
- Playwright4件成功。4スロットの表示、空/PETGスロットの選択不可、選択したスロット2の材料/色を確認文とJSONへ反映、確認取消時0送信、確定時1送信、再読込で設定維持、404、unknown操作の無効化、更新後にAMS切断した場合の開始不可、390px幅の横はみ出しなしを確認。プリンター無効の一時DATA_DIRを使う127.0.0.1:3001で実行し、印刷APIはモック。
- 環境: `PLAYWRIGHT_BROWSERS_PATH=/tmp/pi-wedge-browsers` と既存の `/tmp/pi-wedge-copy-browser-deps/extracted/usr/lib/aarch64-linux-gnu` を使用。既存test-resultsの書込み権限を変更せず `--output=/tmp/pi-wedge-ams-e2e-20261014` に保存。
- 新しいBambuLanPrinter.readStatusを実機で確認。AMS Lite接続、スロット0にPLA/RGB `#F72323`、他の3スロットは空、tray_now 254（外部スプール使用）を取得。残量100はプリンター報告値として保持し、実測値とは扱わない。
- pending印刷/停止要求が0件と確認した後、user service `pi-wedge.service` を再起動して適用。readiness、認証付き`GET /api/printer/status`、保存済みモデルの`GET /preview/{uuid}/printer`がHTTP200、サービスactive、SwaggerにAI実行前の設定提示/ユーザー確認推奨があることを確認。開始APIの過去の結果と実行中ジョブを変更する操作は行っていない。
- 実稼働モデルをChromiumの390×844で表示。AMS表示、外部スプール選択、PLAスロット1の選択可/空スロット2の選択不可、JavaScriptエラー0、印刷要求0、横はみ出しなしを確認。画像は `/tmp/pi-wedge-ams-preview-live.png`。

AMS供給設定は今回の単色スライスで使う供給元/スロットの選択。AMS内の材料登録とスライス済み温度の変更は対象に含めない。AMSを選択した新規要求は送信前に装填と既知の材料を再確認する。新UIからAMS経由の実造形・供給切替・仕上がりの検証は未実施。

## 大きなプレビューの全体表示（2026-10-15）

対象UUID `e14cc9db-78ed-46c7-aa1c-017bd9220a0f`（shell_front.stl）のブラウザ用G-code APIは413 / `Preview exceeds 250,000 lines`を返していた。成果物を読取専用で取得し、展開後10,427,078bytes（9.94MiB）/473,996行/540レイヤーと確認。25万行とレイヤー内2万コマンドの閾値を限界値とする測定記録はなかった。総行数・レイヤー内コマンド数での拒否を削除し、解析/描画を分割、完了した解析コマンドと描画リソースを解放する実装へ変更した。展開容量32MiB・1行長・ZIP検証は維持。初期視点とviewportサイズ変更時に全体を収めるカメラ調整も追加した。

- `npm run check`: 型・Lint・Format・66テスト・サーバー/UIビルド成功。200万行を超える通常G-code/3MFを公開/認証付きAPIで末尾まで返すこと、入力を最大1,000行ずつ走査すること、デスクトップ/縦長画面で高いモデルの全頂点が画面内に収まることを確認。
- `npm run test:e2e`: ARM64 Chromium156で5件成功。288,000本の押出コマンドを持つ12層（各24,000コマンド）を末尾まで描画し、最後/最初のレイヤー切替と移動経路を確認。既存のAMS設定・確認・冪等性・404・結果不明の検証も成功。APIはfixtureで、印刷開始はモック。
- 対象実ファイルを一時DATA_DIR/localストレージの検証用API `127.0.0.1:3002` で表示。プリンターは無効。540層/108.00mmを約5.3秒で読み込み、270層/54.00mm・単層・移動経路の切替、390×844で横はみ出しなし、初期視点で全体が収まることを実Chromiumで確認。JavaScriptエラー0、印刷要求0。これは当該ブラウザ・モデルでの値であり、全端末/最大容量の性能保証ではない。
- APIで返したG-code全体のSHA-256は元の展開内容と一致（`3a1ade33e583da48fb965cb4dc1f59598d4b301cbc03ad3cde84d57d80ffe165`）。分割描画と元ライブラリの描画を別途比較し、直線/円弧を含む28,974座標が一致、15個のgeometryが一度ずつ解放され、描画済みコマンドが残らないことを確認した。
- 検証の画像/JSONは `/tmp/pi-wedge-large-preview-{desktop,mobile,layer270}.png` と `/tmp/pi-wedge-large-preview-result.json`。E2Eの結果は `/tmp/pi-wedge-large-preview-e2e-final/`。生成物はGit管理外。

稼働サービスへの反映結果は次節。実スマートフォン・32MiB最大入力・実造形の検証は行っていない。

## 全体表示変更の適用・再起動（2026-10-16）

ユーザーから適用と再起動の明示的な承認を受け、実行中/待機中のスライス・pending印刷/停止操作が0件と再確認した後、`systemctl --user restart pi-wedge.service`で反映した。サービスはactive/running、新PID `2057936`。`http://pi5s.local:3000/health`は200、配信OpenAPIには総行数制限を撤廃したG-code APIの記述を確認。

元のURL `http://pi5s.local:3000/preview/e14cc9db-78ed-46c7-aa1c-017bd9220a0f`をARM64 Chromium156で開き、全540層/108.00mmを約5.3秒で表示。270層/54.00mm・単層・移動経路の切替、390×844の横はみ出しなしを確認した。G-code取得は200、全10,427,078bytesのSHA-256は検証時の元ファイルと一致。3D表示エラー0、JavaScriptエラー0、印刷要求0。

稼働サーバーでは別途「AMSの状態を取得できません。接続を確認して更新してください。」の警告を確認した。今回確認したのは全体プレビューの動作で、プリンターへの接続・供給・実印刷の成功は確認していない。画像/結果JSONは `/tmp/pi-wedge-large-preview-live-{desktop,mobile,layer270}.png` と `/tmp/pi-wedge-large-preview-live-result.json`（Git管理外）。

## スライス履歴と名前（2026-10-19）

実装: `/history` と `/history/data` を信頼するLAN向けに認証なしで追加。readyのスライス結果だけを新しい順に24件ずつ返し、返却項目は結果UUID・名前・作成日時・形式・推定時間・フィラメント量に限定する。名前と元モデルファイル名の検索に対応。`POST /api/slices` のJSON・multipartに任意の `name` を追加し、ジョブと成果物に保存。既存・無名の結果は元モデル名を表示する。プレビューから履歴へ移動できる。

検証: `npm run check` は型・Lint・Format・70テスト・サーバー/UIビルド成功。履歴テストで名前の両入力形式、長さと制御文字の拒否、検索、ページ分割、モデルUUIDの除外、旧データの表示、OpenAPIの公開範囲を確認した。ローカル一時サーバー（localストレージ、プリンター無効）の `/history/data` はBearerなしで200・空配列を返した。`npm run test:e2e` は履歴画面、390px幅と既存プレビューを含むChromium6テスト成功。ブラウザテストのプリンター応答はモックで、実スライス・実印刷は行っていない。

稼働サービスへの反映: コードコミット `4f46837` を `origin/main` にプッシュし、`pi-wedge.service` を再起動。再起動前にqueued/runningジョブとpending/unknownの印刷・停止操作が0件であることを確認した。プリンターは再起動前後とも`PAUSE`を報告し、サーバーから停止・開始を送っていない。新PID `2437969` でactive/running、`/health`・認証付き`/api/ready`・`/history`・`/history/data`・既存結果の`/preview/{uuid}/data`が200。履歴は24件と次ページUUIDを返し、表示名と検索結果が一致した。稼働URLの実Chromiumでは24行表示、名前検索6行、390px幅の横はみ出しなし、ページエラー0を確認した。物理印刷の完了・品質は今回検証していない。
