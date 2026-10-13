# API設計

OpenAPI 3.1 `/openapi.json` が機械可読の正本。Swagger `/docs` はローカル配信（CDN不要）。すべての `/api/*` は `Authorization: Bearer <API_TOKEN>`。UUID形式、Zod strictによる未知キー拒否、サイズ上限、エラーJSON `{error:{code,message}}`。認証トークンはクエリに渡さない。

| Method / path                                      | 入力                                                          | 成功                           | 副作用                                                |
| -------------------------------------------------- | ------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| GET /health                                        | なし                                                          | 200 生存確認                   | なし、公開                                            |
| GET /api/ready                                     | Bearer                                                        | 200/503 DB/S3確認              | 読取のみ                                              |
| GET /api/profiles                                  | Bearer                                                        | 200 管理者設定プロファイル     | なし                                                  |
| POST /api/files                                    | multipart file(STL/STEP)                                      | 201 File UUID                  | モデル保存                                            |
| GET /api/files/{uuid}                              | UUID                                                          | 200 メタデータ                 | なし                                                  |
| GET /api/files/{uuid}/download                     | UUID                                                          | 200 binary                     | 読取のみ                                              |
| POST /api/slices                                   | JSON fileId/options または multipart file/options(JSON文字列) | 202 Job + Location             | 保存・キューのみ、印刷しない                          |
| GET /api/slices/{jobId}                            | UUID                                                          | 200 Job                        | なし                                                  |
| GET /api/files/{uuid}/gcode                        | UUID                                                          | 200 text/plain                 | G-code抽出のみ                                        |
| POST /api/printer/upload                           | JSON fileId                                                   | 200 転送結果                   | プリンターのストレージへ書込、機構を動かさない        |
| POST /api/printer/print                            | JSON fileId/options、Idempotency-Key(UUID)                    | 200 操作結果                   | 機器動作・加熱・造形開始                              |
| POST /api/printer/stop                             | JSON {}、Idempotency-Key(UUID)                                | 200 停止操作結果               | 現在の印刷をキャンセル、終了動作が続くことがある      |
| GET /api/printer/operations/{operationId}          | UUID                                                          | 200 操作の確定/不確定結果      | なし                                                  |
| POST /api/printer/operations/{operationId}/resolve | outcome + inspectionNote                                      | 200 更新結果                   | 実機を確認した管理者がunknownを解決、機器は動かさない |
| GET /preview/{uuid}                                | UUID                                                          | 200 React shell                | トークン入力なし、自動プレビュー                      |
| GET /preview/{uuid}/data                           | UUID                                                          | 200 統計・元モデル名・印刷可否 | readyスライスだけ、物理操作なし                       |
| GET /preview/{uuid}/gcode                          | UUID                                                          | 200 text/plain                 | 指定スライスのG-code抽出のみ                          |
| GET /preview/{uuid}/download                       | UUID                                                          | 200 binary                     | 指定スライスの保存済み本体だけ                        |
| POST /preview/{uuid}/print                         | UUID、Origin、Idempotency-Key、空の本体                       | 200 操作結果                   | 確認済みブラウザ操作、転送・加熱・造形開始            |
| POST /mcp                                          | MCP JSON-RPC、Bearer                                          | MCP初期化・用途案内            | 案内のみ。ファイル・API・プリンターへアクセスしない   |

ブラウザ用 `/preview/*` は信頼するLAN内でトークン入力なし。公開範囲は指定UUIDのreadyスライス結果のみ。印刷はOriginが要求URLのoriginと一致することを検証し、Originなし/不一致は403、本文付きは400（1KiB超は413）。ブラウザが自動送信するOriginとクライアント側で保持するIdempotency-Keyを使用する。CORSを許可せず、AI用API_TOKENをUI・URLへ渡さない。

`POST /mcp` は Streamable HTTP のJSON-RPC入口で、Bearer認証が必要。`pi_wedge_workflow` ツールがサービスの用途、`/docs`・`/openapi.json`、完了したスライスを開く `/preview/{resultFileId}` を案内するだけで、モデルのアップロード・スライス・印刷は実行しない。接続手順とツールの想定利用は [MCPガイド](mcp.md) を参照。

主なエラー: 400 schema/invalid_file、401 unauthorized、403 forbidden_origin、404 file/job/operation不存在、409 not_ready/wrong_kind/queue_full/idempotency_conflict/printer_busy、413 too_large、415 unsupported_format、422 invalid_gcode/archive、502 printer_error、503 dependency_unavailable、504 printer_outcome_unknown。詳細は各OpenAPI応答に記述。

ジョブ状態: queued→running→succeeded|failed。succeeded時だけresultFileIdが参照可能。エラーはcode/message、推定時間/材料は未取得時null。スライス結果本体は直接返さない。
印刷操作: pending→accepted|failed|unknown。MQTT ACKはコマンド受付で、造形完了ではない。Idempotency-Keyは恒久保存、同一内容なら以前の結果を返し、別内容は409。pending/unknownの再送はしない。結果不明時はプリンター画面で確認してから新しい操作を判断する。

停止APIはBearer・UUIDのIdempotency-Key・空のJSONオブジェクト`{}`を必須とし、本文の未知キーを拒否する。ファイルを転送せず、固定のprint.stopを送る。停止結果は`{id, action: "stop", state, createdAt, error}`。pending→accepted|failed|unknown、HTTP 200/502/504は開始と同じ。acceptedは停止要求の受付で、完全停止の確認ではない。GET operationsとPOST resolveは開始・停止双方の操作を返す。停止しても開始操作の受付履歴を書き換えない。

キーは開始・停止で共有する名前空間とし、同じキーを別の動作に使うと409。同じキーの再呼出しは保存した状態を返し、pending/unknownを再送しない。未解決の開始があっても、実行中の転送・MQTT交換がなければ明示的停止を受け付ける。未解決の停止があると新しい停止・開始キーを409で拒否し、実機確認後に既存resolveで解決する。プリンター操作は直列なので、他の通信処理中は停止もprinter_busyで拒否する。起動時のpending停止はunknownに復旧する。

ACKは同一sequence_idと結果で照合し、commandが省略された応答にも対応する。resultの大文字小文字を区別しない。MQTT診断ログは操作UUIDで追跡し、秘密を伏せた要求・照合対象外も含む応答・送信完了・交換の終了理由を記録する。開始のレスポンス形式を維持し、操作照会・解決には停止操作のレスポンス形式を追加する。
任意設定は許可リスト（wallLoops/topShellLayers/bottomShellLayers）に限定。ユーザー定義G-code・CLIパス・任意JSON設定は受け取らない。

## 使用例

停止要求のHTTP例（Bearerと新しいUUIDキーを指定する）:

```http
POST /api/printer/stop
Authorization: Bearer <API_TOKEN>
Idempotency-Key: 0198cdf0-b8f1-4de0-8d67-2d9e95ed019c
Content-Type: application/json

{}
```

受付成功の例:

```json
{
  "id": "0198cdf0-b8f1-4de0-8d67-2d9e95ed019c",
  "action": "stop",
  "state": "accepted",
  "createdAt": "2026-10-14T00:00:00.000Z",
  "error": null
}
```

トークンはHTTP Authorizationヘッダーに指定する。以下の環境変数はクライアント側で設定する。

```bash
export PI_WEDGE_URL=http://raspberrypi.local:3000
# TOKENには管理者が設定したトークン、MODEL_ID/FILE_ID/JOB_IDには各APIのUUIDを設定
curl -H "Authorization: Bearer $TOKEN" "$PI_WEDGE_URL/api/profiles"
curl -H "Authorization: Bearer $TOKEN" -F file=@model.stl "$PI_WEDGE_URL/api/files"
curl -H "Authorization: Bearer $TOKEN" -F file=@model.step -F 'options={"layerHeight":0.2,"infillDensity":15}' "$PI_WEDGE_URL/api/slices"
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data "{\"fileId\":\"$MODEL_ID\"}" "$PI_WEDGE_URL/api/slices"
curl -H "Authorization: Bearer $TOKEN" "$PI_WEDGE_URL/api/slices/$JOB_ID"
curl -H "Authorization: Bearer $TOKEN" "$PI_WEDGE_URL/api/files/$FILE_ID"
curl -H "Authorization: Bearer $TOKEN" "$PI_WEDGE_URL/api/files/$FILE_ID/download" -o artifact.gcode.3mf
curl -H "Authorization: Bearer $TOKEN" "$PI_WEDGE_URL/api/files/$FILE_ID/gcode" -o preview.gcode
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data "{\"fileId\":\"$FILE_ID\"}" "$PI_WEDGE_URL/api/printer/upload"
# 以下のみ加熱・機構動作を開始。ベッド/材料を確認し、操作UUIDをクライアントで保存してから実行。
curl -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $OPERATION_ID" -H 'Content-Type: application/json' --data "{\"fileId\":\"$FILE_ID\",\"options\":{\"bedLeveling\":true}}" "$PI_WEDGE_URL/api/printer/print"
curl -H "Authorization: Bearer $TOKEN" "$PI_WEDGE_URL/api/printer/operations/$OPERATION_ID"
```

ブラウザは `/preview/$FILE_ID` を開くだけで表示する。AIがこのURLをユーザーへ渡す。JSONレスポンスのUUIDは手元に保存し、ジョブがsucceededになるまでpollする。unknownは結果を確認するまで新しいキーで再試行しない。
