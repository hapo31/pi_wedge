# A1 mini LAN通信

現行実装は以下のLAN用アダプターで、クラウド印刷は未実装。LAN Onlyを使わずHandyと併用する方式は[Issue #1](https://github.com/hapo31/pi_wedge/issues/1)、[接続方式の調査 #6](https://github.com/hapo31/pi_wedge/issues/6)、[Connect詳細調査 #7](https://github.com/hapo31/pi_wedge/issues/7)で扱う。

FTPS（implicit TLS :990）で.gcode.3mfを転送、MQTT TLS :8883 / device/{serial}/requestにproject_fileをpublish、device/{serial}/reportで応答を読む。ユーザーbblp、アクセスコードとIP/serialはenv、ログに出さない。basic-ftp/mqttはJavaScript実装でARM64追加バイナリ不要。

これは公式安定APIではない。[ha-bambulabの通信実装](https://github.com/greghesp/ha-bambulab/tree/main/custom_components/bambu_lab/pybambu)を互換性の参考とする。[Bambu公式方針](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/)はLAN Only / Developer Modeを説明。ファームウェアによって第三者コマンドが拒否され得る。導入先のA1 miniで許可方式・パス・ACKを確認する。

Printer.uploadとPrinter.startPrintは独立、PrinterServiceはUUIDのready成果物だけを許可。通常G-codeは初期の物理印刷対象にしない。.gcode.3mfのplate_1を使用。開始時FTPS転送して最新の存在を確認（過去の転送記録だけを信用しない）。SD/cacheのURLは検証項目。

PRINTER_ENABLED=falseが既定。enabled時host/serial/access codeが必須。`PRINTER_CA_FILE`にはBambu Studio公式の`resources/cert/printer.cer`など、BBL CAバンドルを指定する。プリンター証明書のCNが設定したserialと一致することも検証する。隔離LANで検証する場合のみPRINTER_INSECURE_TLS=trueを明示。タイムアウトと接続エラーは秘密を含まないエラーコードに変換。

AI/管理用の印刷APIはBearer + Idempotency-Key必須。LANのブラウザ印刷はトークン入力不要で、同一Origin・確認ダイアログ・Idempotency-Key必須。どちらも同じPrinterServiceを使用する。pendingをDBへ保存してから転送/送信、sequence_id対応のACKでaccepted。publish後のタイムアウト/切断はunknownにし自動再送しない。acceptedは造形完了ではない。同じキーの再呼出しは保存した結果、内容変更は409。1台の制御は直列/同時操作拒否。plate/bed leveling/AMS mappingをPrintOptionsに用意、未対応の多色スライスは保証しない。

## 実機検証（未実施なら未検証と表示）

印刷・停止の実行には、その時点の明示指示を受ける。

1. 型番/firmware/serial/IP、LAN Only/Developer Mode、SDカード、TLS証明書を記録。A1 miniのアクセスコードでFTPS一覧とMQTT接続を確認。
2. 20mm cubeをStudioで確認し、upload APIだけを実行。プリンター側にUUID.gcode.3mfが同じサイズで存在し、機構が動かないことを確認。
3. ベッドを空にして材料/プレートを確認し、明示的print APIを一度実行。ftp:///UUID.gcode.3mf、Metadata/plate_1.gcode、sequence_id ACK、実際の開始を記録。形式/パスが不一致ならアダプターのみ調整する。
4. 同一キー再送で2回目の開始がないこと、別内容409、通信断時unknown、再起動後も同一キーで再送しないことを確認。
5. bedLeveling、外部スプール/AMS各選択スロット、複数プレートの選択は、一度に1条件だけ変更して都度1回の明示印刷で確認する。指定した設定と実際の供給元・印刷された枚を記録する。mockの成功を実機の成功と記載しない。
6. 造形完了まで確認し、モデルの予定寸法と実測X/Y/Z、反り・層ずれ・ベッドへの接着の状態を記録する。受付ACK・RUNNING・造形完了・品質を別々に評価する。
7. Bambu Studioの版を記録し、複製した単一/複数プレートの成果物をGUIで読み込む。各枚の異なる形状・寸法・設定を確認し、別名で再編集保存して再読込する。元の成果物を変更せず、この読込確認ではプリンターへ転送しない。

結果不明の操作が残る場合は新しいキーの印刷も409で止める。実機画面・ベッドを確認した後のみ `POST /api/printer/operations/{operationId}/resolve` に `outcome`（accepted/failed）と `inspectionNote` を送信して解決する。このAPI自体は機器を動かさない。

## MQTT診断ログ

印刷操作中のMQTT要求・応答はJSONで標準出力へ記録する。`printer_mqtt_request` / `printer_mqtt_response` / `printer_mqtt_published` / `printer_mqtt_exchange_completed` / `printer_mqtt_exchange_failed` を操作UUID・要求sequence_id・時刻・経過時間で照合する。publishedはブローカーへの送信完了であり、プリンターの受付ACKではない。

応答ログは照合されなかったものも含め、command・sequence_id・result・reason・err_code・gcode_state・print_errorなどの許可フィールドに限定する。1回の交換で先頭32応答と照合できた応答を記録し、終了ログには応答総数を残す。文字列は256文字まで、受信は64KiBまで。接続資格情報・deviceトピック・全テレメトリ・任意のネストを記録せず、設定済みの秘密とURL認証情報を伏せる。

印刷ACKは同一sequence_idで照合する。commandがある場合はproject_fileに一致させ、省略されている場合はresultまたは数値err_codeを持つ応答だけを対象にする。resultは大文字小文字を区別せず、非ゼロerr_codeは拒否として扱う。単なる状態通知を受付ACKにはしない。

LANアクセスコードによる接続認証とコマンドの署名認証は別である。[通信ライブラリ作者のエラー表](https://github.com/Aptimex/bambu-mqtt-generator/blob/main/README.md)はerr_code `84033543`を署名不足として説明する。拒否時はLAN Only / Developer Modeと対象ファームウェアの許可方式を確認し、署名を回避する実装は行わない。実機試行・Developer Mode前後の結果は[検証記録 #10](https://github.com/hapo31/pi_wedge/issues/10#developer-mode有効後の受付成功と停止2026-10-14)を参照。

## 停止API

`POST /api/printer/stop`へBearer・Idempotency-Key(UUID)・JSON `{}`を送る。PrinterServiceが停止操作をSQLiteのstopOperationレコードへpendingで登録し、Printer.stopPrintを呼ぶ。アダプターはFTPS転送やidle判定をせず、購読後に固定のprint.stop / param空文字を一度publishする。開始と同じTLS・ACK照合・ログ・タイムアウト処理を使う。

停止操作はaction stop、状態pending/accepted/failed/unknown。acceptedは要求受付であり、終了動作や機構の停止完了は別途実機で確認する。キーを再使用しても送信せず、既存結果を返す。開始用キーの再利用は409。GET `/api/printer/operations/{operationId}`で照会し、unknownは実機を確認した管理者が既存resolve APIで解決する。停止操作のfailed解決は「停止要求が受付されなかった」、accepted解決は「停止が受付された」の確認を表す。

結果不明の開始が残っていても停止は要求できるが、通信中の同時操作は409。停止後も開始の不確定履歴は残す。結果不明の停止は新しいキーで再送せず、新規開始も止める。再起動時のpending停止はunknownへ復旧し、再送しない。停止REST API経由の実機キャンセルは未検証。実機の停止ACKは診断用の直接MQTTによるもので、[検証記録 #10](https://github.com/hapo31/pi_wedge/issues/10)で区別する。

## AMS Liteの状態と供給元

Printer.readStatusはMQTT pushallのみを送信し、AMS Lite 0番ユニットのスロット0〜3を正規化する。tray_exist_bitsから装填、tray_typeから材料、tray_colorからRGB色、tray_nowから使用中スロット/外部スプールを取得する。不明値はnull。readStatusの共有・5秒キャッシュはPrinterServiceに置き、印刷のAMS確認は新しい状態を要求する。公開APIは機器識別子・RFID・生テレメトリを返さない。

プレビューはスロット1〜4表記、API amsMappingは0〜3。同一の単色スライスに使う供給元だけを選び、スライス済み材料/温度・AMS登録情報は変更しない。空/不明スロット・既知のPLA以外の材料は開始前に拒否する。供給設定と操作キーはブラウザにも送信前から保存し、結果不明時に変更して新しい要求を作らない。AMS供給UIからの実印刷・品質・供給切替は未検証。実機読取と残る受入れ確認は[検証記録 #10](https://github.com/hapo31/pi_wedge/issues/10)へ記録する。
