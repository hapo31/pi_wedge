# A1 mini LAN通信

FTPS（implicit TLS :990）で.gcode.3mfを転送、MQTT TLS :8883 / device/{serial}/requestにproject_fileをpublish、device/{serial}/reportで応答を読む。ユーザーbblp、アクセスコードとIP/serialはenv、ログに出さない。basic-ftp/mqttはJavaScript実装でARM64追加バイナリ不要。

これは公式安定APIではない。[ha-bambulabの通信実装](https://github.com/greghesp/ha-bambulab/tree/main/custom_components/bambu_lab/pybambu)を互換性の参考とする。[Bambu公式方針](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/)はLAN Only / Developer Modeを説明。ファームウェアによって第三者コマンドが拒否され得る。実際のA1 miniで許可方式・パス・ACKを確認するまで互換性は未検証。

Printer.uploadとPrinter.startPrintは独立、PrinterServiceはUUIDのready成果物だけを許可。通常G-codeは初期の物理印刷対象にしない。.gcode.3mfのplate_1を使用。開始時FTPS転送して最新の存在を確認（過去の転送記録だけを信用しない）。SD/cacheのURLは検証項目。

PRINTER_ENABLED=falseが既定。enabled時host/serial/access codeが必須。自己署名証明書はCAファイルで信頼設定。隔離LANで検証する場合のみPRINTER_INSECURE_TLS=trueを明示。タイムアウトと接続エラーは秘密を含まないエラーコードに変換。

印刷はBearer + Idempotency-Key必須。pendingをDBへ保存してから転送/送信、sequence_id対応のACKでaccepted。publish後のタイムアウト/切断はunknownにし自動再送しない。acceptedは造形完了ではない。同じキーの再呼出しは保存した結果、内容変更は409。1台の制御は直列/同時操作拒否。plate/bed leveling/AMS mappingをPrintOptionsに用意、未対応の多色スライスは保証しない。

## 実機検証（未実施なら未検証と表示）

1. 型番/firmware/serial/IP、LAN Only/Developer Mode、SDカード、TLS証明書を記録。A1 miniのアクセスコードでFTPS一覧とMQTT接続を確認。
2. 20mm cubeをStudioで確認し、upload APIだけを実行。プリンター側にUUID.gcode.3mfが同じサイズで存在し、機構が動かないことを確認。
3. ベッドを空にして材料/プレートを確認し、明示的print APIを一度実行。ftp:///UUID.gcode.3mf、Metadata/plate_1.gcode、sequence_id ACK、実際の開始を記録。形式/パスが不一致ならアダプターのみ調整する。
4. 同一キー再送で2回目の開始がないこと、別内容409、通信断時unknown、再起動後も同一キーで再送しないことを確認。
5. bedLeveling/AMS mappingは個別に確認。mockの成功を上記の成功と記載しない。

結果不明の操作が残る場合は新しいキーの印刷も409で止める。実機画面・ベッドを確認した後のみ `POST /api/printer/operations/{operationId}/resolve` に `outcome`（accepted/failed）と `inspectionNote` を送信して解決する。このAPI自体は機器を動かさない。
