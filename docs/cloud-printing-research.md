# LAN Onlyを使わない印刷の技術調査（2026-10-22）

調査対象は、A1 miniをBambu Cloudへ接続したままBambu Handyを使い、pi_wedgeのページから印刷を始められるか。公開資料とソースコード、既存の実機検証記録を確認した。今回はプリンター設定の変更、クラウドログイン、ファイル転送、印刷は行っていない。

同日の[Connect詳細調査](bambu-connect-research.md)では公式Wiki本文の取得に成功し、公開URL仕様・対応OS・3MF互換性・PC中継・スマホからの遠隔操作案を整理した。

## 結論

公式アプリへファイルを渡して印刷する経路はある。ただし、現在確認できた公開インターフェースでは、現行の認証制御を持つA1 miniに対し「Pi単体・スマホのページで最終確認・Handy併用」を満たす実装の成立は確認できない。接続先をクラウドMQTTへ変更するだけでは解決しない。

PC上のConnectでの最終確認を許容する場合は受け渡し連携を試作できる。PC画面をスマホから遠隔操作する構成も候補になるが、別PCは必要で未検証。Piと通常の印刷ページだけで完結することが必須なら、Bambu Labからクラウド接続を維持できる認可済み連携手段の提供を受けられるかが先決になる。旧ファームウェアを使う方法は条件付きの別案だが、今回の実機での可否は未確認。

## 現在の実装と実機の証拠

- `src/adapters/printer.ts` の `BambuLanPrinter` は、アクセスコードでFTPSへ保存し、ローカルMQTTへ未署名の `project_file` を送る。クラウド認証・コマンド署名は実装していない。
- `src/services/printer.ts` がSQLiteへの操作保存、冪等性、転送、開始、結果不明の再送防止を担当する。HTTP/UIと通信実装の分離は新しい経路でも利用できる。
- [2026-10-14の実機記録](verification.md#mqtt診断と印刷apiによる実機試行2026-10-14)ではFTPS/MQTT接続後、開始要求が `84033543` で拒否された。[Developer Mode有効後](verification.md#developer-mode有効後の受付成功と停止2026-10-14)には同じファイル・オプションで受付とRUNNINGを確認した。接続認証の成功と印刷権限の成立は別である。
- この記録だけでは、拒否時のLAN Only設定や現在の正確なファームウェア版、クラウド経由での実機挙動は確定できない。

## 方式の比較

| 方式                                | Handyとの併用                    | ページ内で開始まで完結       | Pi単体                          | 判断                                                       |
| ----------------------------------- | -------------------------------- | ---------------------------- | ------------------------------- | ---------------------------------------------------------- |
| 現在のFTPS + 未署名ローカルMQTT     | Developer Modeを使う構成では不可 | 現在の構成で可能             | 可能                            | 今回の目的を満たさない                                     |
| 非公式クラウドMQTT/API              | クラウド接続は維持できる         | 認証制御に対応できるか未確認 | 通信処理は実装可能              | 接続・状態取得の実例を印刷可能の証拠にできない             |
| Bambu Connectへの受け渡し           | クラウド接続を維持する構成が候補 | PCアプリで最終確認が必要     | Linux ARM64対応経路を確認できず | PC操作を許容する場合の試作候補                             |
| 公式の個別連携                      | 提供条件による                   | 提供APIによる                | 提供SDKの対応CPU/OSによる       | 要問い合わせ。利用できるという保証はない                   |
| Fleet Hub / ファーム向けローカルAPI | 不可                             | APIで実装可能                | 別途Hubが必要                   | Handy併用の条件に合わない                                  |
| 認証制御導入前のファームウェア      | 当時の構成では併用の余地あり     | 未署名制御を受け付ければ可能 | 可能                            | 対象版・ダウングレード可否・現行クラウドとの互換性を要確認 |

### クラウドMQTTへ変えるだけでは足りない理由

[Bambu公式の認証制御説明](https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/)では、印刷開始はLAN・クラウドの両方で認可対象であり、状態通知は別扱い。クラウドへのログイン成功やMQTT publish成功は印刷受付を意味しない。

実際に[ha-bambulabのクライアント](https://github.com/greghesp/ha-bambulab/blob/main/custom_components/bambu_lab/pybambu/bambu_client.py)はローカル接続とクラウド接続を切り替え、後者ではアカウントの資格情報を使う。[クラウド認証実装](https://github.com/greghesp/ha-bambulab/blob/main/custom_components/bambu_lab/pybambu/bambu_cloud.py)にはメールコード・二要素認証・Cloudflare等への処理もある。これはクラウド接続の実装例であり、当プロジェクトの実機に対する署名付き印刷開始を証明するものではない。

採用するなら、ファイルの転送先と取得方法、認可された開始要求、ACKとジョブ識別子、停止、トークン期限と再認証まで確認が必要。MQTTホストとパスワードの置換だけで着手する根拠は得られなかった。モデルがクラウドへ送られる方式なら、現在の「LAN内で完結」という運用条件も変わる。

### Bambu ConnectとPCの中継

[公式の第三者連携方針](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/)はBambu Connectと個別の連携窓口を案内している。[実装例](https://github.com/stevecad/steve-bambu-connector/blob/main/lib/bambuconnect.js)ではPCへ成果物を保存し、`bambu-connect://import-file` にPC上の絶対パス・名前・プロトコル版を渡してアプリを開く。[同プロジェクトの説明](https://github.com/stevecad/steve-bambu-connector#three-ways-to-print)もアプリでの確認が必要としている。

この仕組みを使う構成案は「ブラウザの明示操作 → Piに受け渡し要求を保存 → 認証済みPCエージェントがUUIDの成果物を取得・保存 → Connectを開く → PC上で印刷確認」。受け渡し時にはPCの稼働・ログインセッションが必要となり、Piとスマホの2台だけでは完結しない。PCの画面をスマホから操作する案は[詳細調査](bambu-connect-research.md#スマホのブラウザで最終確認する案)を参照。最初は既存のダウンロードから手動でConnectへ渡せば、エージェントを実装する前に成果物の互換性を確認できる。

URLスキームは、開いた端末のアプリを起動する。スマホのリンクへPiの `/tmp/...` を指定してもPCやPi上のConnectへファイルは渡らない。通常のブラウザにはPCの保存先を決めてネイティブアプリへ渡す汎用機能がないため、中継プログラムまたは手動操作が必要になる。

初回取得に失敗した[公式Wiki](https://wiki.bambulab.com/en/software/bambu-connect)は追調査で取得できた。配布欄はWindows x64とmacOS向けの2.5.0-beta.15でLinuxは開発中。URL仕様は `path`・`name`・`version=1.0.0` であり、印刷先・供給元・選択プレートや受付結果通知の指定は掲載されていない。アプリ起動・ファイル受け渡しを現在の `accepted`（プリンター受付済み）として扱ってはいけない。公開実装とのエンコード方法の差異も[詳細調査](bambu-connect-research.md#urlで指定できる範囲)に記録した。

[Bambu Studioの公式CLI説明](https://github.com/bambulab/BambuStudio/wiki/Command-Line-Usage)も確認したが、掲載されているのはスライス・エクスポート等で、クラウド印刷開始用のコマンドは確認できない。GUI自動操作はログイン状態・ダイアログ・更新で挙動が変わり、開始結果の確定も難しいため、常設サーバーの印刷アダプターとして採用する根拠にはしない。

### Fleet Hubは今回の解決策になるか

2026-05-20版の[Fleet Hub公式HTTP API](https://portal.bblmw.com/fleet-hub/wb76oog4i8k/files/Bambu%20Fleet%20Hub%20HTTP%20API%20EN%20v1.0.0.pdf)には印刷開始・停止がある。しかし[公式Technical White Paper](https://portal.bblmw.com/fleet-hub/wb76oog4i8k/files/Fleet%20Hub%20Technical%20White%20Paper%20EN%20v1.0.pdf#page=2)は、管理対象のプリンターがLAN専用となりHandyやクラウドサービスからアクセスできないと明記している。APIがあっても今回の併用条件を満たさない。

## 次の判断と検証

1. ページだけで完結させる場合は、公式窓口 `devpartner@bambulab.com` に、A1 mini・クラウド接続維持・Handy併用・Linux ARM64・ヘッドレスの条件を提示し、認可された開始/停止APIと成果物転送手段の提供可否を確認する。公開されている連携募集は、この条件での利用承認を意味しない。今回問い合わせは送信していない。
2. PCで最終確認してよい場合は、LAN OnlyをOFFにした実機でHandyの接続とConnectのクラウド接続を確認し、既存の `.gcode.3mf` を手動で読み込む。単一/追加プレート、AMS Lite、材料・プレート設定の互換性を確認してから、中継を試作する。
3. 旧ファームウェア案を選ぶ場合は、実機の現在版、公式に戻せる版、必要なAMS機能とクラウド互換性を先に確認する。今回公式リリース履歴の本文を取得できなかったため、未確認の版番号を推奨しない。
4. どの経路も、最終的な印刷開始試験はベッドと供給元を確認した明示操作で一度だけ実施し、同一キー再要求・タイムアウト・再起動・停止を検証する。成功が不明な要求は再送しない。過去のDeveloper Modeでの成功をクラウド経由の検証済みとは扱わない。

実装する場合もブラウザへクラウドトークン・アクセスコードを渡さず、同一OriginのPOST、確認、SQLiteへの操作永続化、UUIDによる成果物取得を維持する。PC中継を含む処理では、受け渡し中とプリンター受付済みを別状態にし、再接続時の二重起動を防ぐ。APIや状態を変更する段階でOpenAPIと `docs/api-design.md` を更新する。
