# プレビュー

React + TypeScript、Three.jsベースの[gcode-preview](https://github.com/xyz-tools/gcode-preview)を採用。テキストG-codeを解析・描画するので.gcode.3mfはサーバーのyauzlアダプターでMetadata/plate_1.gcodeを抽出。複数プレートは初期スコープ外。ZIPをディスクへ展開せず、エントリ数・compressed/uncompressed size・実読取byteを制限。暗号化、不正構造、期待パス不存在は422。

`/preview/{uuid}`: 大きな3D viewport、右側ファイル名/UUID/推定時間/材料/接続状態、下部レイヤースライダー。180×180×180mm build volume、回転/ズーム/pan、単一レイヤー/積層表示、travel toggle。印刷は別の目立つボタン→ネイティブ確認ダイアログ→API、実行中disable、恒久冪等キー使用。unknownは成功と表示しない。

AIから受け取った `/preview/{uuid}` を開くだけで、元モデル名・統計・3Dツールパスを自動表示する。トークン入力、APIリンク、UUIDの目立つ表示を省き、スマホで確認して印刷開始する用途に絞る。UIにAPI_TOKENを埋め込まず、データは専用の `/preview/{uuid}/data`・`gcode`・`download` から取得。元モデル本体や一覧は公開しない。403/404/422/413を日本語で表示。

「印刷を開始」は確認後に空のPOSTを `/preview/{uuid}/print` へ送信。同一OriginとIdempotency-Keyをサーバーで検証し、認証済みAI APIと同じPrinterServiceを使用する。Originがない/一致しない要求は403、CORSは許可しない。これは信頼するLANでの運用を前提とする。

スマホからは同じLANの `http://ホスト名.local:3000/preview/{uuid}`（mDNS稼働時）または `http://LAN-IP:3000/preview/{uuid}` を使う。APIサーバーの既定待ち受けは `HOST=0.0.0.0`。APIのURLは相対パスなのでアクセスしたホスト名/IPのままデータを取得できる。Viteの開発サーバーを起動せず、ビルド済みUIをAPIサーバーから配信する構成で利用可能。

負荷対策: サーバーMAX_PREVIEW_MB既定32、browser response上限、250,000行/コメント64KiB・コマンド4KiB上限、ストリームを小batchに分割しevent loopへyield、キャンセルとdispose。描画用geometryは最終的にメインスレッドに残るため無制限規模を保証しない。上限超過はdownloadを案内。モバイルでは統計を下へ配置。

確認: raw/container同じツールパス、無効ファイル/ZIP bomb拒否、レイヤースライダー反映、build volume、統計null表示、確認キャンセルで送信なし、二重クリック1送信、失敗・unknown表示。WebGL実ブラウザ検証と型/ビルドを別々に記録。

実装はparserへ1,000行ずつ投入、ライブラリのrenderAnimated(1)で1レイヤーずつ構築する。レイヤー変更は既存geometryの可視性変更だけで再解析/再生成しない。単一レイヤーが20,000コマンド超なら表示を停止してdownloadを案内。feature/速度による色分けは未実装、押出/移動の色とtravel切替を実装。

Orca/Prusa系のCHANGE_LAYER/LAYER_CHANGEがある場合、開始前のパージ押出をプレビュー入力から除去し、起動時の移動/押出モードを保持する。実成果物の100レイヤー20mm cubeで層表示を検証。コメントのない通常G-codeはライブラリのZ/押出による層推定を利用する。
