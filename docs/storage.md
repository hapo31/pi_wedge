# 永続化

SeaweedFS 4.48 `weed mini` をCompose単一コンテナで使用。公式[mini手順](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini)に基づきS3バケットを作成。アプリはAWS SDK S3のPut/Get/Head/DeleteをObjectStorage契約に閉じ込める。endpointはLAN/loopback、forcePathStyle=true。管理ポートはホストへ公開しない。S3は127.0.0.1:8333のみ、認証必須。

ホスト既定 `/var/lib/pi_wedge` → `/data` bind mount。開発は `.env` の `SEAWEED_DATA_DIR=./.data/seaweedfs`。DBは別途 `DATA_DIR`（本番 `/var/lib/pi_wedge/app`）。設定・DB・Seaweedディレクトリを停止して一緒にバックアップ。単一ノードなのでバックアップ必須、冗長化は初期範囲外。

File: id UUID、name、format(stl/step/gcode/gcode.3mf)、size、createdAt、sourceModelId、sliceOptions、state(staging/ready/failed)、error、estimatedSeconds、filamentGrams、filamentMillimeters。オブジェクトキーはUUIDのみ。Job/PrintOperationもUUIDで管理。元モデル参照はAPIで確認してから生成。

書込み順: DB staging→object put→DB ready。失敗はfailedにして未完成objectを削除。クラッシュ後stagingはHeadとsizeを照合しreadyへ修復、なければ削除しfailed。readyの消失は取得時dependency_unavailable（欠落を黙って成功にしない）。生成結果UUIDはジョブ実行前に割当て保存し、running中断時の孤立成果物をfailedとして除去。読取/ダウンロードはstream、サイズを確認。
SQLite WAL + busy_timeout + schema user_version。DBはJSON payloadを使用し、ID/レコード種別で索引。状態遷移はサービス層で制御。削除APIは初期スコープ外、管理者は停止・バックアップ後に整合性を確認して清掃。

検証: `npm run test:storage` write→read→delete。`--keep`でUUIDを残し、Compose stop/rm/up後`--read UUID`で同じ値が得られることを確認。証跡はroadmapに記録。
