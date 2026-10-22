# API設計

OpenAPI 3.1 `/openapi.json` が機械可読の正本。Swagger `/docs` はローカル配信（CDN不要）。すべての `/api/*` は `Authorization: Bearer <API_TOKEN>`。UUID形式、Zod strictによる未知キー拒否、サイズ上限、エラーJSON `{error:{code,message}}`。認証トークンはクエリに渡さない。

| Method / path                                      | 入力                                                                                          | 成功                           | 副作用                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| GET /health                                        | なし                                                                                          | 200 生存確認                   | なし、公開                                            |
| GET /api/ready                                     | Bearer                                                                                        | 200/503 DB/S3確認              | 読取のみ                                              |
| GET /api/profiles                                  | Bearer                                                                                        | 200 管理者設定プロファイル     | なし                                                  |
| POST /api/files                                    | multipart file(STL/STEP)                                                                      | 201 File UUID                  | モデル保存                                            |
| GET /api/files/{uuid}                              | UUID                                                                                          | 200 メタデータ                 | なし                                                  |
| GET /api/files/{uuid}/download                     | UUID                                                                                          | 200 binary                     | 読取のみ                                              |
| POST /api/slices                                   | JSON fileId/name?/parentId?/options または multipart file/name?/parentId?/options(JSON文字列) | 202 Job + Location             | 保存・キューのみ、印刷しない                          |
| GET /api/slices/{jobId}                            | UUID                                                                                          | 200 Job                        | なし                                                  |
| GET /history                                       | なし                                                                                          | 200 履歴画面                   | 認証なし、物理操作なし                                |
| GET /history/data                                  | q?（名前検索）、cursor?（結果UUID）                                                           | 200 最新24件・次ページUUID     | readyスライスの限定情報のみ、物理操作なし             |
| GET /api/files/{uuid}/gcode                        | UUID                                                                                          | 200 text/plain                 | G-code抽出のみ                                        |
| GET /api/printer/status                            | Bearer                                                                                        | 200 プリンター/AMS Lite状態    | MQTT読取のみ、5秒以内のキャッシュ                     |
| POST /api/printer/upload                           | JSON fileId                                                                                   | 200 転送結果                   | プリンターのストレージへ書込、機構を動かさない        |
| POST /api/printer/print                            | JSON fileId/options、Idempotency-Key(UUID)                                                    | 200 操作結果                   | 機器動作・加熱・造形開始                              |
| POST /api/printer/stop                             | JSON {}、Idempotency-Key(UUID)                                                                | 200 停止操作結果               | 現在の印刷をキャンセル、終了動作が続くことがある      |
| GET /api/printer/operations/{operationId}          | UUID                                                                                          | 200 操作の確定/不確定結果      | なし                                                  |
| POST /api/printer/operations/{operationId}/resolve | outcome + inspectionNote                                                                      | 200 更新結果                   | 実機を確認した管理者がunknownを解決、機器は動かさない |
| GET /preview/{uuid}                                | UUID                                                                                          | 200 React shell                | トークン入力なし、自動プレビュー                      |
| GET /preview/{uuid}/data                           | UUID                                                                                          | 200 統計・元モデル名・印刷可否 | readyスライスだけ、物理操作なし                       |
| GET /preview/{uuid}/gcode                          | UUID                                                                                          | 200 text/plain                 | 指定スライスのG-code抽出のみ                          |
| GET /preview/{uuid}/download                       | UUID                                                                                          | 200 binary                     | 指定スライスの保存済み本体だけ                        |
| GET /preview/{uuid}/printer                        | readyスライスUUID                                                                             | 200 プリンター/AMS Lite状態    | MQTT読取のみ、識別子や生テレメトリを返さない          |
| POST /preview/{uuid}/print                         | UUID、Origin、Idempotency-Key、空またはAMS設定JSON                                            | 200 操作結果                   | 確認済みブラウザ操作、転送・加熱・造形開始            |
| POST /mcp                                          | MCP JSON-RPC、Bearer                                                                          | MCP初期化・用途案内            | 案内のみ。ファイル・API・プリンターへアクセスしない   |

ブラウザ用 `/history`・`/history/data`・`/preview/*` は信頼するLAN内でトークン入力なし。履歴はreadyのスライス結果UUID、表示名、作成日時、形式、推定時間、フィラメント量だけを新しい順に24件ずつ返す。任意の`q`は表示名と元モデルのファイル名を検索する。`cursor`には同じ検索条件で取得した前ページ最後の結果UUIDを指定する。モデル本体、スライス設定、API_TOKEN、プリンター情報は履歴に出さない。プレビューは指定UUIDのreadyスライス結果と限定されたプリンター/AMS状態だけを公開する。印刷はOriginが要求URLのoriginと一致することを検証し、Originなし/不一致は403。本文は空、またはContent-Type application/jsonの`{useAms, amsMapping?}`のみ。未知キー・不正な形式は400、1KiB超は413。ブラウザが自動送信するOriginとクライアント側で保持するIdempotency-Keyを使用する。CORSを許可せず、AI用API_TOKENをUI・URLへ渡さない。

`POST /api/slices` の任意の `name` はJSON・multipartの両方で受け付ける。前後空白を除いた1～80文字で、制御文字は拒否する。ジョブと完成した成果物に保存し、履歴・プレビューに表示する。省略時や既存データは元モデルのファイル名を表示する。名前の指定は印刷・スライス設定を変更しない。

`GET /api/files/{uuid}/gcode` と `GET /preview/{uuid}/gcode` は通常G-code、またはコンテナ内の選択した`Metadata/plate_N.gcode`全体を返す。総行数での拒否や途中切り捨てはない。展開後の容量が`MAX_PREVIEW_MB`（既定32MiB、設定範囲1〜32）を超えると413。1行のコメント64KiB・コマンド4KiBやZIP構造の違反は422。元の成果物のダウンロードにはプレビュー容量上限を適用しない。

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
curl -H "Authorization: Bearer $TOKEN" -F file=@model.step -F 'name=収納ケースのふた' "$PI_WEDGE_URL/api/slices"
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
過去のスライスはLAN内のブラウザで `/history` を開く。一覧からプレビューへ移動できる。ブラウザの検索条件は`/history?q=...`へ保存し、戻る/進むでも復元する。追加ページのcursorは画面内のQueryが管理し、URLには含めない。RESTの`/history/data?q=...&cursor=...`と公開範囲は変更しない。

## AMS供給設定

`GET /api/printer/status` はBearer必須。`GET /preview/{uuid}/printer`はreadyスライスUUIDに限定したLANブラウザ用。MQTT pushallから`observedAt`、`gcodeState`、`amsConnected`、`currentSlot`、`externalSpoolActive`、最大4スロットの材料/色/装填/使用中/残量を返す。unknownはnull、残量はプリンターの報告値。機器識別子・RFID・生データは返さない。読取をまとめ、成功値を最大5秒キャッシュする。接続不可は502で古い成功値に置き換えない。

ブラウザの設定例は`{"useAms":true,"amsMapping":[0]}`（画面のスロット1）。外部スプールは`{"useAms":false}`または従来の空本文。AMS Lite単色スライスの0〜3だけを許可し、useAmsとmappingの対応を検証する。設定でスライス済み温度・材料やAMS側の登録情報は書き換えない。新しい開始要求はアップロード前にAMS状態を再取得し、装填が確認できないスロットと既知のPLA以外の材料を拒否する。同一キーの再照会は状態取得や機器送信を行わない。

Swaggerの開始API説明は、AIエージェントがモデル、フィラメント設定、AMS使用/スロット/材料/色、ベッドレベリング等をユーザーへ示し確認することを推奨する。ブラウザも選択内容を確認ダイアログに表示する。送信前にキーと供給設定をlocalStorageへ保存し、応答不達・ページ再読込でも元の要求を維持する。確定したfailed後の明示的再試行だけ新しいキーを生成する。

## 複数プレートのプレビュー

`/preview/{plateUUID}/{previewUUID}`が選択状態を表す正規URL。`GET /preview/{plateUUID}`は1枚目へ302でリダイレクトする。旧結果UUIDも同じ入口で解決する。UUID割当はSQLiteに永続化される。

`GET /preview/{uuid}/data`は`plateId`、`previewId`、`plate`（1〜100）、`plates: [{id, plate}]`、選択枚の統計、限定ファイル情報、表示名、印刷設定有無を返す。data/gcode/thumbnailおよびPOST printは任意の`previewId`クエリで枚を選ぶ（省略時は先頭）。所属しないUUIDは404、形式/未知クエリキーは400。`GET /preview/{uuid}/thumbnail`は容量制限付きG-codeの上面図SVGで、最大4096描線。1000行ごとに処理を譲り、要求の中断を確認する。抽出からSVG生成完了までプレビューの同時処理数2に数え、超過は503 `preview_busy`。ブラウザはGETのこのエラーだけを最大30回（待機合計28.75秒）再取得し、プレート切替時に待機も中断する。POSTやその他のエラーを自動再送しない。読取でプリンターは操作しない。

`GET /api/files/{uuid}/gcode?plate=N`はBearer認証を維持し、1〜100の番号を指定できる。番号省略時は最初に存在する枚、通常G-codeは1枚のみ。印刷APIの`options.plate`も1〜100を受け付け、転送前に実在を検証する。ブラウザ印刷本文は従来通りAMS設定のみで、選択プレビューをサーバーが保存済みファイルと番号へ解決する。印刷冪等キーの永続性と不明結果の再送禁止を維持する。

履歴はSQLiteだけを読み、ストレージ本体を取得しない。初回プレビューでIDを割り当て済みの項目には結果UUIDに加え`plateId`、`previewId`、`plateCount`を返す。未初期化の項目は結果UUIDだけを返し、画面は従来の`/preview/{resultUUID}`へリンクする。本体の欠落やストレージ障害があっても、履歴にある他の結果を表示できる。公開範囲は名前・日時・形式・統計・UUID・枚数のみ。元モデル、スライス設定、認証トークンは返さない。

## 親プレビューへの追加スライス

`POST /api/slices`のJSON・multipart両方で任意の`parentId`（プレビュー用の結果UUID）を指定する。ジョブIDやプレート集合UUIDではなく、親を持たないルートのプレビューUUIDを使用する。指定がなければ従来の単一プレートを作成する。

```json
{
  "fileId": "0198cdf0-b8f1-4de0-8d67-2d9e95ed019c",
  "parentId": "97662892-0469-4a22-b5d1-b3ae7d935817",
  "name": "追加パーツ",
  "options": { "layerHeight": 0.16 }
}
```

新しいモデルだけをスライスし、親の最新の3MFへ別の枚として追加する。親のG-codeは再スライス・書換えせず、モデル・設定参照・plate_N.gcode/json/md5・slice_info・関連パスを結合する。プレートUUIDは変えず、追加分は新しい結果/プレビューUUIDとなる。ジョブと結果メタデータに`parentId`を保存し、成功した追加ジョブは`plateId`と追加枚番号`plate`も返す。結果メタデータにも`plate`を保存する。`/preview/{plateId}/{resultFileId}`で追加枚を直接開ける。`/preview/{plateId}`は引き続き1枚目へ302。

親のプレビューからダウンロードする3MFは追加済みの最新版になる。`GET /api/files/{resultFileId}/download`は各ジョブ完了時点の不変のスナップショット。認証付き印刷APIで`options.plate`を省略すると、結果メタデータの`plate`を使用する（番号のない既存結果は1枚目）。明示された番号を優先し、解決後の番号を印刷操作へ保存して冪等性を比較する。各プレビューの印刷はそのUUIDに対応する不変のスナップショットと枚番号を使用し、後続の追加で既存の印刷要求が変わらない。スライスから転送・印刷は実行しない。

指定UUIDに親がある場合は400 BadRequest。multipartでもファイル保存・ジョブ作成前に拒否し、次の形式でルートを返す。

```json
{
  "error": {
    "code": "parent_slice_required",
    "message": "Use the root preview UUID as parentId",
    "parentId": "97662892-0469-4a22-b5d1-b3ae7d935817"
  }
}
```

不正なUUIDは400、不存在は404、未準備・元モデル/通常G-codeなど不適切な形式は409。最大番号100の集合への追加は409 `plate_limit`。複数要求は同時スライス数1のキューで直列処理し、実行時点の最新3MFに追加する。保存成功後に集合の参照・新プレビュー・ジョブ成功をSQLiteの同一トランザクションで確定する。ツール/ストレージ/DB障害では親と既存プレビューを維持する。再起動時はqueuedを再開し、runningはfailedへ復旧して未確定成果物を削除する。
