# プレビュー

React + TypeScript、Three.jsベースの[gcode-preview](https://github.com/xyz-tools/gcode-preview)を採用。テキストG-codeを解析・描画するので.gcode.3mfはサーバーのyauzlアダプターでMetadata/plate_1.gcodeを抽出。複数プレートは初期スコープ外。ZIPをディスクへ展開せず、エントリ数・compressed/uncompressed size・実読取byteを制限。暗号化、不正構造、期待パス不存在は422。

`/preview/{uuid}`: 大きな3D viewport、右側ファイル名/UUID/推定時間/材料/接続状態、下部レイヤースライダー。180×180×180mm build volume、回転/ズーム/pan、単一レイヤー/積層表示、travel toggle。印刷は別の目立つボタン→ネイティブ確認ダイアログ→API、実行中disable、恒久冪等キー使用。unknownは成功と表示しない。

APIトークンは画面で入力、Reactメモリだけに保持しURL/localStorageへ保存しない。Swaggerの認証と独立。401/404/422/413を日本語で表示。

負荷対策: サーバーMAX_PREVIEW_MB既定32、browser response上限、250,000行/コメント64KiB・コマンド4KiB上限、ストリームを小batchに分割しevent loopへyield、キャンセルとdispose。描画用geometryは最終的にメインスレッドに残るため無制限規模を保証しない。上限超過はdownloadを案内。モバイルでは統計を下へ配置。

確認: raw/container同じツールパス、無効ファイル/ZIP bomb拒否、レイヤースライダー反映、build volume、統計null表示、確認キャンセルで送信なし、二重クリック1送信、失敗・unknown表示。WebGL実ブラウザ検証と型/ビルドを別々に記録。

実装はparserへ1,000行ずつ投入、ライブラリのrenderAnimated(1)で1レイヤーずつ構築する。レイヤー変更は既存geometryの可視性変更だけで再解析/再生成しない。単一レイヤーが20,000コマンド超なら表示を停止してdownloadを案内。feature/速度による色分けは未実装、押出/移動の色とtravel切替を実装。

Orca/Prusa系のCHANGE_LAYER/LAYER_CHANGEがある場合、開始前のパージ押出をプレビュー入力から除去し、起動時の移動/押出モードを保持する。実成果物の100レイヤー20mm cubeで層表示を検証。コメントのない通常G-codeはライブラリのZ/押出による層推定を利用する。
