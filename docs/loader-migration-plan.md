# loader単独の移行案（比較用、2026-10-22）

最初に作成したRouter単独の案。追加調査による現在の推奨方針は[TanStack Query併用の検討](query-migration-research.md)を参照。以下は比較用に保持する。実装・動作検証は未実施。

## 結論

今回は選択プレートのメタデータ取得と、履歴の検索・先頭ページ取得をTanStack Routerのloaderへ移す。G-code、プリンター状態、サムネイル、履歴の追加ページは現在の寿命・操作に合わせた取得を維持する。

調査元は[PR #4](https://github.com/hapo31/pi_wedge/pull/4)、`docs/preview.md`の「次段階のloader移行」、`web/src`全体の取得・ルーティング・印刷処理、対応するHTTP・サービス実装、既存のVitest・E2E。PR #4のコメント取得結果は0件だった。

現在の依存は`@tanstack/react-router` 1.170.45で、TanStack Queryは未導入。今回のloaderはRouterの機能を使用し、Queryの追加は行わない。Router自体がloaderの取得・キャッシュを管理でき、外部の取得ライブラリとの連携は別の選択肢である（[公式のData Loading](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading)、[External Data Loading](https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading)）。設定案は導入済みパッケージの型・実装でも確認した。

## 全体の移植候補

| 取得・処理                                 | 現在                               | 今回の方針と理由                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getPreviewData`                           | `PreviewScreen`のeffect            | **子ルートのloaderへ移す。** プレートUUIDとプレビューUUIDの組で取得する。集合一覧と選択枚の統計が同じ応答に入るため、親だけへ移すと統計の選択を誤る。API分割は不要。                                        |
| `getHistoryPage`の先頭ページ               | `History`のeffect                  | **`/history`のloaderへ移す。** 確定した検索語をURLの`q`に持たせ、検証後の値を`loaderDeps`にする。検索・直接アクセス・戻る/進むを同じ経路に揃える。                                                          |
| `getHistoryPage`の追加ページ               | 「さらに表示」のイベント           | イベント取得を維持。現在の一覧への追加を保つ。単純にcursorをloaderDepsへ入れるだけではページの置換になるため、移す場合は別途ページ蓄積の設計が必要。                                                        |
| `getPreviewText`                           | メタデータ取得後のeffect           | 今回はeffectに残す。loaderへの移植自体は可能だが、メタデータと一括で待つと、G-code失敗時や読込中の統計・ダウンロード表示が変わる。遅延データにする場合はPromiseの中断・失敗・保持期間も設計する必要がある。 |
| `getPrinterStatus`                         | メタデータ取得後と「更新」のeffect | effectに残す。AMS取得失敗はプレビュー表示を妨げず、明示的更新はAMSだけを取得する。子loaderの再実行にまとめるとメタデータやViewerまで更新する原因になる。                                                    |
| `getThumbnail`                             | 親配下の`PlateThumbnails`のeffect  | effectに残す。1枚ずつ取得し、親の寿命でblob URLを生成・破棄する。loaderで全枚を待つと選択枚の表示を遅らせる。                                                                                               |
| ダウンロード                               | クリック時のGET                    | 操作時の取得を維持。全体の3MFを事前にメモリへ保持する必要はない。                                                                                                                                           |
| 印刷POST・確認・冪等キー                   | `PrintController`とボタン操作      | 現在の責務を維持。loader・先読み・GET再試行には含めない。                                                                                                                                                   |
| Viewer解析・WebGL・画像URL・レイアウト計測 | DOMの寿命に合わせたeffect          | effectを維持。通信の開始をルートへ移しても、DOM・GPU資源や印刷状態の復元はコンポーネント側の責務。                                                                                                          |

## 選択プレート

- 現在の親子ルートと`remountDeps`を保ち、indexと`$previewId`に共通のメタデータloader処理を設定する。UUIDをZodで検証してから通信する。
- loaderは`getPreviewData(plateId, previewId, abortController.signal)`を呼び、応答を返す。親のReact stateや`PrintController`には触らない。
- `PreviewScreen`はloaderのメタデータを参照する。選択中の子が確定した後に親の一覧・プリンター設定表示へ反映する。古いルートの遅延応答が親へ混ざらない構造にする。
- G-code取得effectはloaderメタデータの確定後に開始し、独立したAbortControllerで子の離脱時に中断する。展開後32MiBのストリーム上限を維持し、RouterのloaderDataにはG-code文字列を入れない。
- プリンター状態はメタデータ確定後と明示的更新で取得する。印刷状態とAMS選択の復元はプレビューUUID単位で行い、Viewerの準備完了まで印刷を有効にしない。
- pending/error表示は子の領域内に置く。同じ集合内の切替では親の一覧DOM・サムネイルURL・横スクロール・サイドバーの確保高を維持する。メタデータ失敗とG-code失敗を分け、G-code失敗時は取得済み統計・ダウンロードを残す。
- 短縮・旧URLのHonoによる302と、正規URLへのSPA遷移を維持する。

## 履歴

- 入力途中の文字列はローカルstate、確定した検索語は`/history?q=...`に分ける。空検索は`q`を省略する。検索実行でURLを更新し、戻る/進むでは入力欄もURLへ同期する。
- `validateSearch`で`q`をZod検証する。既存APIと同じtrim・80文字上限・制御文字禁止を適用する。空文字は未指定へ正規化し、文字列以外や未知キーはエラーにする。
- `loaderDeps`は検証済み`q`だけとし、先頭ページを`getHistoryPage(q, null, signal)`で取得する。履歴のcursorは今回URLに持たせない。
- 先頭ページと追加ページを分けて保持し、検索変更・先頭ページの再取得時に追加分をリセットする。「さらに表示」では現在の検索語とcursorで取得し、追加失敗時は既存一覧を残す。
- 追加取得は条件変更・先頭ページ更新・離脱時に中断する。中断確認と検索世代の照合で、古いページが新しい検索結果へ追加されることを防ぐ。
- 再入場時は先頭ページを取得する。戻る操作では検索条件を復元し、追加ページ数の復元は今回の範囲に含めない。

## 取得・キャッシュ・エラー

- `defaultPreload: false`を維持し、新しいloaderでも自動・明示的な先読みを使用しない。
- 移行するルートは`staleTime: 0`、`gcTime: 0`を明示する。離脱済みデータをRouterの再利用キャッシュに残さず、プレート追加・プリンター設定変更・履歴の新規結果を再入場時に取得する。
- 再検証は導入済みRouterが対応する`loader: { handler, staleReloadMode: 'blocking' }`を使用する。古いメタデータで新しい画面の印刷操作を有効にしない。
- 対象ルートの`pendingMs: 0`、`pendingMinMs: 0`を明示する。既定の待ち時間に旧Viewer・印刷操作を残さず、既存の読み込み表示と同等に切り替える。親レイアウト保持はE2Eで確認する。
- 全GETで既存`fetchPreview`を使用する。503 `preview_busy`だけ最大30回再試行し、待機も中断する。Router側に再試行を追加しない。
- ルートエラーも既存`errorMessage`を使う。無効UUIDでは通信せず、子の取得エラーでは既存一覧を残す。自動再送や自動リロードを追加しない。
- メタデータの取得開始は移すが、サーバーの同時処理上限やストレージ処理は変更しない。ブラウザのキャンセルだけでサーバー内の全処理が即停止するとは扱わない。

## 実装順と検証

1. ルート入力検証・共通メタデータloader・子のpending/error表示を追加する。
2. `PreviewScreen`のメタデータ取得state/effectを置換し、G-code・AMS・印刷状態の寿命を維持する。
3. 履歴の検索をURLへ移し、先頭loaderと追加ページの状態・キャンセルを分ける。
4. 設計・README・roadmapを最終実装へ合わせ、検証結果を`docs/verification.md`へ追記する。

Vitestでは実Routerを使い、UUID・search検証、選択キー、切替と履歴検索の中断、503再試行中断、離脱後のキャッシュ不保持・再取得を確認する。G-code上限とPOST再試行禁止の既存テストを維持する。

E2Eでは既存の一覧DOM・画像URL・スクロール・通常スクロールバー・390px幅・連続切替・戻る/進む・302・印刷状態隔離の検証を継続する。追加でメタデータ失敗とG-code失敗、URL検索の直接アクセスと戻る、複数ページ追加と失敗・古い追加応答の排除、再入場での一覧更新を確認する。GET失敗後も一覧から別の枚へ移動でき、遅い旧応答で選択中の統計や印刷対象が変わらないことを確認する。

レビュー後の実装では`npm run check`と、APIサーバー起動後の`npm run test:e2e`を実施する。現在の作業ツリーには3MF修正・検証資料などの未コミット変更がある。これらを保持し、稼働中のdistを上書きしない隔離コピーでビルド・E2Eを行う。実機への転送・印刷や稼働サービスの更新は、この移行の検証には含めない。

## レビュー対象

判断してほしい点は、今回を「メタデータ＋履歴先頭loader」に絞り、G-code取得・AMS更新・サムネイル・追加ページを現在の寿命に残す範囲である。G-codeも今回移す場合は、メタデータを先に表示できる遅延取得と、ルート離脱後の保持・中断を含める計画へ変更する。
