# TanStack Query併用の検討記録（2026-10-22）

ユーザーレビュー後に本案の実装を進めた。採用バージョンは5.104.5。メタデータはloader、履歴先頭は追加ページと同じhookで開始する構成を採用した。以下は実装前の判断記録で、最終仕様は[プレビュー設計](preview.md#loaderとtanstack-query)、検証状況は[検証記録](verification.md)を参照。

## 結論

TanStack Queryを使えば、現在の取得用useEffectは4か所とも置き換えられる。前案でeffectに残したG-code・AMS・サムネイルも対象にでき、履歴の追加ページもQueryへ統合できる。今回はRouterとQueryを併用する方針を推奨する。

RouterはURL・入力検証・遷移と初期データの取得調整を担当し、Queryはサーバーデータ・取得状態・エラー・キャンセル・ページ蓄積を管理する。取得結果を再びローカルstateへコピーするeffectは増やさず、Queryの値を直接参照する。

以下はコードと公式仕様から検討した時点の設計案である。当時導入済みだったのはRouter 1.170.45で、Queryは未導入だった。

## 置換対象

| 現在の処理                                                | Queryへの置換                                                                                         | 削除できる手動管理                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PreviewScreen`のメタデータ＋G-code取得effect             | メタデータと本文を別のqueryに分ける。本文はメタデータ取得成功後に`enabled`で開始する                  | 取得用effect、取得結果のコピー、loading/error、AbortControllerの手動管理              |
| `PreviewScreen`のAMS取得effect                            | 独立した`useQuery`。プリンター設定ありの場合だけ有効にし、「更新」は`refetch()`を呼ぶ                 | 取得用effect、refreshカウンター、statusLoading/statusErrorの手動管理                  |
| `History`の先頭ページ取得effectと追加取得イベント内の通信 | `useInfiniteQuery`。検索語をキーにし、次のcursorを`getNextPageParam`、追加操作を`fetchNextPage`にする | 取得用effect、items/cursor/loading/errorの手動管理、request refと追加ページの手動結合 |
| `PlateThumbnails`の逐次取得effect                         | 各枚をqueryにし、共通の同時数1の取得キューを通す                                                      | 取得ループと通信のAbortController管理。画像URLの生成・破棄effectは残す                |

依存した取得は`enabled`で表せる（[Dependent Queries](https://tanstack.com/query/latest/docs/framework/react/guides/dependent-queries)）。追加読込では`data.pages`にページを保持でき、既存APIの`nextCursor`をそのまま使える（[Infinite Queries](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries)）。

## 前案の懸念をどう解消するか

- **G-code失敗時も統計を残す:** メタデータとG-codeを別queryにする。本文の取得中・失敗でもメタデータを表示でき、ダウンロードも利用できる。両方を一つのloaderで待つ必要はない。
- **AMSだけを更新する:** AMSの`refetch`だけを呼ぶ。メタデータ再取得やViewer再生成に結びつけない。更新に失敗した際はQueryに残る旧snapshotを有効な供給情報として扱わず、現行の取得失敗表示を維持する。
- **履歴の追加分を保持する:** 同じ検索キーの`pages`を表示し、検索変更で別queryに切り替える。追加読込中は`isFetching`で重複要求を止め、追加失敗では取得済みページを残す。cursorはURLや通常queryのキーに含めず`pageParam`として扱う。
- **サムネイルを1枚ずつ取得する:** Queryだけでは同時数1にならない。queryFnに渡すsignalを取得キューの待機にも渡し、中断済みの待機要求を送らない。1枚の失敗でも後続の取得を続ける。単純な並列`useQueries`への置換だけでは不十分。
- **一覧と画像を保持する:** 親子ルートと既存の再マウント単位を維持し、サムネイルのqueryKeyを集合UUIDとプレビューUUIDに固定する。同じ集合の選択変更で取得し直さない。

## キー・寿命・キャンセル

| データ     | queryKeyの構成案                       | 取得・保持方針                                                                                                                |
| ---------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| メタデータ | `preview-data / plateId / previewId`   | 子loaderで現在値を取得してから表示。Queryをデータの保存先にする                                                               |
| G-code     | `preview-text / plateId / previewId`   | 選択中の子の`useQuery`だけが購読。`staleTime: Infinity`、`gcTime: 0`。先読み・永続化・前の枚を表示するplaceholderを使用しない |
| AMS        | `printer-status / plateId / previewId` | endpointは集合単位だが、キーに選択枚も含めて進入時の再取得を分離する。`staleTime: 0`、`gcTime: 0`。明示的更新はこのqueryだけ  |
| 履歴       | `history / validatedQ`                 | 先頭も追加分も同じinfinite query。`gcTime: 0`で離脱・検索変更後に非購読となった検索結果を破棄する                             |
| サムネイル | `thumbnail / plateId / previewId`      | 親に残る各枚のコンポーネントが購読。`staleTime: Infinity`、`gcTime: 0`。BlobはQuery、object URLはコンポーネントが所有する     |

`gcTime: 0`は非購読時にキャッシュの破棄対象にする設定で、JavaScriptヒープの即時解放を保証するものではない。G-codeは取得上限32MiBを維持し、Viewerの解析・GPU資源の解放も現在どおり行う。サーバー側のメモリ上限・処理中断は、ブラウザのQueryとは別に維持する。

各queryFnはQueryから受け取るsignalを既存の`getPreviewData`・`getPreviewText`・`getPrinterStatus`・`getHistoryPage`・`getThumbnail`へ渡す。signalを実際の通信・ストリーム・待機へ渡すことが中断の条件であり、導入だけで中断されるとは扱わない（[Query Cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)）。G-codeなどの中断を要する取得では通常の`useQuery`を使う。`useSuspenseQuery`にはキャンセルの制約がある（[公式リファレンス](https://tanstack.com/query/latest/docs/framework/react/reference/useSuspenseQuery)）。現在のViewer用コード分割のSuspenseとは別の話である。

## loaderとの分担

取得用effectをなくすだけならloaderは必須ではなく、全対象をQueryのhooksから開始する構成でもよい。元の移植目的に合わせる場合、loaderはメタデータなど初期表示に必要な小さいデータだけをQueryClient経由で取得し、G-code・AMS・サムネイルは表示側の通常queryに任せる。QueryClientはアプリ内で単一インスタンスを共有する（[External Data Loading](https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading)）。

loader連携では次の点を実装・検証の条件にする。

- RouterのloaderDataにはG-codeやBlobを入れない。初期取得の調整に留め、画面はQueryの値を購読する。
- メタデータは再進入時に最新取得の完了を待つ。キャッシュがあればそのまま返すだけの処理では、集合の追加や設定変更の反映を保証できない。
- loaderから画面の購読開始までの短い区間は購読者がいない。メタデータに一律`gcTime: 0`を適用すると購読前に破棄される可能性があるため、小さいメタデータには引渡し用の保持期間を設ける。暫定案は30秒で、鮮度とは分けて扱う。
- loaderで取得済みのメタデータを画面のマウント直後に二重取得しないよう、loaderの取得条件とhookの`refetchOnMount`を揃える。
- loaderによる命令的な取得と、hookが最後の購読を解除したときの中断は同一ではない。遷移中止をloader側のsignalから連携し、そのルートだけが必要としている未共有取得を中断する。同じキーの別の利用者まで一律に`cancelQueries`で止めない。
- 履歴の初期取得もloaderで待つ場合は、通常queryとinfinite queryを二重に持たず同じinfinite queryの先頭ページを取得する。購読開始までの保持・二重取得・中断を同様に検証する。
- API呼出しの詳細は、追加時に固定するQueryのバージョンの型で確認する。公式最新リファレンスには旧来の命令的取得APIの非推奨化も載っており、過去のサンプルをそのまま使わない。

## 既定設定から変える点

Queryは既定でエラー再試行やフォーカス・再接続時の再取得を行うため、このアプリでは明示的に設定する（[Important Defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)）。

- `retry: false`。既存`fetchPreview`の503 `preview_busy`に対する最大30回の再試行だけを使い、再試行回数を二重化しない。
- `refetchOnWindowFocus: false`、`refetchOnReconnect: false`、ポーリングなし。進入時または個別の更新操作で取得する。
- LAN用GETでは`networkMode: 'always'`を使う案とする。Queryのオンライン判定による一時停止を介さず、LANへの通信結果で判定する（[Network Mode](https://tanstack.com/query/latest/docs/framework/react/guides/network-mode)）。
- 全対象でローカルストレージへのQuery永続化を使用しない。現在の印刷操作の永続冪等キーとは別に扱う。

## 残すeffectと印刷操作

object URLの生成・破棄、ViewerのWebGL・解析処理、ResizeObserver、タイトル、親への表示状態の同期、印刷状態・AMS選択の復元は通信開始のeffectと分離する。これらまでQueryに移してeffectをゼロにすることは目標にしない。object URLをqueryFn内で作ると、購読・破棄との対応を失いやすいため避ける。

ダウンロードはクリック時のGETを維持する。印刷は既存`PrintController`の確認・永続キー・結果不明の扱いを保持し、今回`useMutation`への置換を含めない。印刷は読取queryやloaderから実行しない。

## 実装後に必要な確認

既存の`npm run check`とAPIサーバー起動後の`npm run test:e2e`に加え、QueryClientを使って中断・キャッシュ破棄・取得回数を確認する。特に、本文の遅延や失敗でも統計が残ること、AMS更新がViewerに影響しないこと、検索変更後の追加ページ混入がないこと、サムネイルの通信が同時数1であること、連続切替後に旧G-codeをキャッシュへ保持しないことを確認する。

loader採用時は購読への引渡し、進入時の鮮度、二重取得なし、遷移中止、同じキーへの素早い戻りで新しい要求まで中断しないことを検証する。一覧DOM・画像URL・スクロール保持と印刷状態の隔離も既存E2Eで継続して確認する。
