# API設計

OpenAPI 3.1 `/openapi.json` が機械可読の正本。Swagger `/docs` はローカル配信（CDN不要）。すべての `/api/*` は `Authorization: Bearer <API_TOKEN>`。UUID形式、Zod strictによる未知キー拒否、サイズ上限、エラーJSON `{error:{code,message}}`。認証トークンはクエリに渡さない。

| Method / path                             | 入力                                                          | 成功                       | 副作用                                         |
| ----------------------------------------- | ------------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| GET /health                               | なし                                                          | 200 生存確認               | なし、公開                                     |
| GET /api/ready                            | Bearer                                                        | 200/503 DB/S3確認          | 読取のみ                                       |
| GET /api/profiles                         | Bearer                                                        | 200 管理者設定プロファイル | なし                                           |
| POST /api/files                           | multipart file(STL/STEP)                                      | 201 File UUID              | モデル保存                                     |
| GET /api/files/{uuid}                     | UUID                                                          | 200 メタデータ             | なし                                           |
| GET /api/files/{uuid}/download            | UUID                                                          | 200 binary                 | 読取のみ                                       |
| POST /api/slices                          | JSON fileId/options または multipart file/options(JSON文字列) | 202 Job + Location         | 保存・キューのみ、印刷しない                   |
| GET /api/slices/{jobId}                   | UUID                                                          | 200 Job                    | なし                                           |
| GET /api/files/{uuid}/gcode               | UUID                                                          | 200 text/plain             | G-code抽出のみ                                 |
| POST /api/printer/upload                  | JSON fileId                                                   | 200 転送結果               | プリンターのストレージへ書込、機構を動かさない |
| POST /api/printer/print                   | JSON fileId/options、Idempotency-Key(UUID)                    | 200 操作結果               | 機器動作・加熱・造形開始                       |
| GET /api/printer/operations/{operationId} | UUID                                                          | 200 操作の確定/不確定結果  | なし                                           |
| GET /preview/{uuid}                       | UUID                                                          | 200 React shell            | 認証後に取得、印刷は確認操作時のみ             |

主なエラー: 400 schema/invalid_file、401 unauthorized、404 file/job/operation不存在、409 not_ready/wrong_kind/queue_full/idempotency_conflict/printer_busy、413 too_large、415 unsupported_format、422 invalid_gcode/archive、502 printer_error、503 dependency_unavailable、504 printer_outcome_unknown。詳細は各OpenAPI応答に記述。

ジョブ状態: queued→running→succeeded|failed。succeeded時だけresultFileIdが参照可能。エラーはcode/message、推定時間/材料は未取得時null。スライス結果本体は直接返さない。
印刷操作: pending→accepted|failed|unknown。MQTT ACKはコマンド受付で、造形完了ではない。Idempotency-Keyは恒久保存、同一内容なら以前の結果を返し、別内容は409。pending/unknownの再送はしない。結果不明時はプリンター画面で確認してから新しい操作を判断する。
任意設定は許可リスト（wallLoops/topShellLayers/bottomShellLayers）に限定。ユーザー定義G-code・CLIパス・任意JSON設定は受け取らない。
