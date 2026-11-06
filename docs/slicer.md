# スライサー・STEP

## 対象ツールとCLI

OrcaSlicer v2.4.2の[公式リリース](https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.4.2)にあるLinux Ubuntu2404 aarch64 AppImageを使用する。展開後AppRunをORCA_BINに指定。GUI依存が初期化される可能性があるため必要時ORCA_XVFB=trueでxvfb-runを使用。管理者が配布物のチェックサム/出所を確認する。
[CLI公式仕様](https://github.com/OrcaSlicer/OrcaSlicer/wiki/cli_misc)では--load-settingsは機械/工程JSONのセミコロン区切り、--load-filamentsは材料JSON。[CLIアクション](https://www.orcaslicer.com/wiki/cli/cli_actions)に--sliceと--export-3mfがある。[v2.4.2実装](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/OrcaSlicer.cpp)を参照し、--slice 1 --outputdir DIR --export-3mf result.gcode.3mf MODELで単一プレートを出力する。成果物にはMetadata/plate_1.gcodeが必要。拡張子だけで印刷可能とみなさない。

`Slicer.slice(ModelFile, SliceOptions):Promise<SliceResult>` は入力ローカルパス、出力パス/形式/統計を返す。OrcaAdapterの内側でプロフィール、spawn、ログ、出力検証を実行。1ジョブ1一時ディレクトリ、上限付きstdout/stderr、プロセスグループkillのタイムアウト、finally清掃。APIは任意CLI引数を渡さない。

## デフォルトプロファイル

a1-mini-0.4 + generic-pla、0.20mm/15%/support=false、Textured PEI。`npm run profiles:prepare` は固定v2.4.2のBBL公式JSONから継承を再帰解決して管理者ローカルprofiles/generatedに保存。生成物はGit外、出所とhashをmanifest保存。完全な継承解決が必要で、子JSONだけを--load-settingsへ渡さない。導入時のみネット接続、運用中はローカル。未準備ならジョブは明確にfailed（偽のスライスで成功させない）。PLA/ノズル/プレートは実機と一致させる。代替はOrca GUIから完全なpresetを書き出して配置する。

## STEP変換

FreeCADのPythonモジュール（Open CASCADE）を独立ModelConverterで使用。[MeshPart API](https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/MeshPart/App/AppMeshPartPy.cpp)のmeshFromShape、LinearDeflection=0.1mm/AngularDeflection=0.5radを既定、APIで範囲制限して指定。FreeCADのSTEP importerで単位をmmへ正規化し、複数ソリッドの配置を保持したcompoundをメッシュ化。invalid/null/solidsなし、造形範囲を超える寸法、過多triangleを失敗にする。STL自体の単位はmmと明示。BREP→メッシュ変換は回復不能エラーをジョブへ保存。

## 実環境での試験

1. Pi OS/Orca/FreeCAD版、glibc、RAMを記録、AppRun --help（必要時Xvfb）を確認。
2. プロファイル準備、20mm cube STLをAPIへ投入、queued→running→succeeded、ZIP内plate_1.gcode、統計を確認。
3. mm STEP/inch STEP/2-solid STEPでSTL寸法20mm、配置保持、shapeエラーを確認。
4. G-codeをOrca/Bambu Studioで再読込しA1 mini/0.4/PLA/180mmプレートを確認。180mm超モデルが拒否されることを確認。
5. 最大サイズでRSS/所要時間、タイムアウト後プロセス消失、一時領域清掃を確認。実機印刷はprinter.mdの別手順。
   期待結果を満たすまで実スライス検証済みと表示しない。

## 導入先OSと具体的手順

公式v2.4.2 AppImageはGLIBC>=2.38 / GLIBCXX_3.4.32を要求し、Debian12（glibc2.36）では動作しない。アプリのNode/S3はDebian12でも動作する。新規のホスト構築ではRaspberry Pi OS 64bitのDebian13系を選択し、下記CLI依存を導入する。Pi OS固有の差異は実機で確認する。既存OSを保持する場合は同じModelConverter/Slicer契約で管理者の隔離ツール実行環境または互換ビルドを指定する。ホストのglibcを個別に置換しない。

```bash
sudo apt-get update
sudo apt-get install libopengl0 libglu1-mesa libgtk-3-0t64 libwebkit2gtk-4.1-0 libmspack0 libsecret-1-0 freecad-python3 xvfb xauth
# 作業用ディレクトリ内で取得・検証・展開
curl -fL -o orca.AppImage https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v2.4.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V2.4.2.AppImage
printf '%s\n' 'e1a07275a25f176626c55a5df39e91bc4476d8c28ee4a3192ff758e29dd5c3ba  orca.AppImage' | sha256sum -c -
chmod +x orca.AppImage
./orca.AppImage --appimage-extract
# 展開したsquashfs-rootを/opt/orcaslicerへ管理者が配置し、ORCA_BIN=/opt/orcaslicer/AppRun
# FREECAD_MODULE_PATH=/usr/lib/freecad-python3/lib
npm run profiles:prepare
```

Xvfbはディスプレイ初期化が必要なビルドのための任意設定。プロファイル由来のAGPLライセンスはmanifestの出所を確認。生成物を配布する場合は上流ライセンスに従う。

## Debian12を保持する隔離ツールモード

`docker build -f deploy/Dockerfile.tools -t pi-wedge-tools:0.1 .` を実行し、`.env`に `TOOLS_BACKEND=docker`、`TOOLS_IMAGE=pi-wedge-tools:0.1`、`ORCA_BIN=/opt/squashfs-root/AppRun`、`FREECAD_PYTHON=/usr/bin/python3`、`FREECAD_MODULE_PATH=/usr/lib/freecad-python3/lib` を設定する。プロファイルは同じ `npm run profiles:prepare` で準備する。アプリの実行ユーザーにはDocker操作権限が必要。DockerソケットをAPIへ公開しない。

DockerCommandRunnerがジョブ領域・プロファイル・固定の変換スクリプトだけをマウントし、ネットワーク無効・image pull無効で実行する（イメージは事前ビルド必須）。S3/プリンター/API資格情報をツールへ渡さない。CLI timeout後にコンテナを強制削除し、起動時はDATA_DIRラベルの残存コンテナを回収する。コンテナ回収に失敗した場合は依存復旧失敗として受付を止める。4GiB/3CPU/256PID上限はDockerに指定する。導入先ホストでcgroupと実際の上限動作を確認する。

## 実行中の作業領域上限（任意設定）

既定の `DATA_DIR/tmp` は通常のディスク領域で、成果物のサイズ検査とタイムアウトだけでは中間ファイルの合計容量を制限しない。容量を制限する場合は、管理者がアプリ専用の[tmpfs](https://docs.kernel.org/filesystems/tmpfs.html)を用意し、`TOOLS_WORKSPACE_DIR` にそのマウントポイントの絶対パス、`TOOLS_WORKSPACE_MAX_MB` に許容する最大容量（既定1024MiB、範囲1〜4096MiB）を設定する。ディレクトリ未設定なら従来の動作になる。アプリがmountやsudoを実行することはない。

例として、サービスを停止した状態で `/var/lib/pi_wedge-work` を作成し、`/etc/fstab` に次を設定する。`<UID>` と `<GID>` は `id -u pi_wedge` / `id -g pi_wedge` の数値へ置き換える。

```fstab
tmpfs /var/lib/pi_wedge-work tmpfs rw,nosuid,nodev,size=1G,nr_inodes=65536,uid=<UID>,gid=<GID>,mode=0700 0 0
```

`sudo mount /var/lib/pi_wedge-work` 後に `findmnt /var/lib/pi_wedge-work` と `df -B1 /var/lib/pi_wedge-work` でtmpfsと総容量を確認し、`.env` に以下を設定する。パスは `DATA_DIR` / `PROFILE_DIR` と親子関係を持たない専用マウントにする。

```dotenv
TOOLS_WORKSPACE_DIR=/var/lib/pi_wedge-work
TOOLS_WORKSPACE_MAX_MB=1024
```

同梱systemdサービスではdrop-inの `[Unit]` に `RequiresMountsFor=/var/lib/pi_wedge-work`、`[Service]` に `ReadWritePaths=/var/lib/pi_wedge-work` を追加し、daemon-reload後に起動する。root所有の通常ディレクトリを同じパスへ残しておけば、未マウント時にサービスユーザーがそこへ書き込むことも防げる。

起動時にtmpfsの種別・総容量・独立したマウントポイント・パスの分離を検査し、失敗した場合はデータAPIを無効にする。ジョブ作成とCLI実行の直前、清掃・復旧時も再検査し、マウントの消失や置換を検出した場合は通常ディスクへ切り替えず失敗にする。起動中に管理者がマウントを変更しないこと。実行中の強制アンマウントとの競合までをアプリで保証するものではない。復旧時はマウント直下のアプリ所有サブディレクトリだけを清掃し、マウントや他のファイルは残す。

native/dockerとも入力・変換・スライス・結合の作業領域をこのtmpfs上へ作り、HOME、TMPDIR、TMP、TEMP、XDG_CACHE_HOME、XDG_CONFIG_HOMEもその中へ設定する。FreeCADはHOMEを参照しないため、[公式のFREECAD_USER_HOME](https://github.com/FreeCAD/FreeCAD/blob/1.0.0/src/App/Application.cpp)も同じ領域へ指定する。FreeCADのデータと一時ファイルもこの指定先に作られる。容量上限はカーネルが書込み時に適用し、超過時はENOSPCなどでコマンド/ジョブが失敗する。出力サイズ検査・タイムアウト・finally清掃も維持する。

この設定のDocker実行では、追加でrootファイルシステムをread-onlyにし、ホストと同じUID/GIDで実行する。プロファイルと固定スクリプトはread-onlyのまま、`/tmp` も同じ作業tmpfsへbindする。daemon側のログは `--log-driver none` で保存せず、アプリがattach経由のstdout/stderrを既存のバイト上限で取得する。Dockerの `/dev/shm` などの別領域はこの合計に含まず、各領域に別の容量上限がある。コンテナのメモリ上限にはホストのmemory cgroup対応と有効化が必要であり、非対応ならDockerが指定を無視するため導入時に実効性を確認する（[Docker実行オプション](https://docs.docker.com/engine/containers/run/)）。nativeはプロセスのファイルアクセスを隔離しないため、環境設定を無視して他のパスへ書くツールの動作までは制限しない。

tmpfsはRAMと、設定されていればswapを使う。Pi 8GBではツール本体・Node・OS・他サービスの使用量を含めて容量を決める。作業領域が満杯になる前のメモリ不足を防ぐ保証ではない。実Orca/FreeCADの必要容量や制限モードでの互換性は導入先で小さいSTL/STEPと追加プレートを使って確認し、結果は[Issue #20](https://github.com/hapo31/pi_wedge/issues/20)へ記録する。

## プレートへの追加

`Slicer.slice`は任意の内部`ParentPlateInput`（ジョブ領域の親3MFパスと次の枚番号）を受け取れる。新しいSTL/変換済みSTEPを通常通り1枚だけOrcaでスライスした後、Orcaアダプター内から固定の`scripts/append-plate.py`を実行して結合する。Python標準ライブラリのみを使用し、native/dockerとも既存のCommandRunnerのタイムアウト・上限ログ・秘密を除いた環境を使う。Dockerでは固定スクリプトを読取専用でマウントする。

結合は[Orca v2.4.2の3MF実装](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/libslic3r/Format/bbs_3mf.cpp)と[プレート座標実装](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/GUI/PartPlate.cpp)に合わせ、既存G-code/md5は変更しない。モデルのオブジェクトIDと外部モデルパスを重複なく付け替え、model_settings/slice_info/filament_sequence/relationshipsを更新する。A1 miniの180mmベッド・1.2倍間隔・平方根切上げの列数でモデル配置を更新する。印刷用G-codeの座標は変えない。既存設定は保持し、新規枚は今回のスライス設定で生成済みのG-codeを使う。

Bambu Studio/Orcaの共有形状キャッシュは外部モデルのパスを含めず数値IDだけをキーにする。そのため、親を含む全外部`.model`の形状IDをコンテナ全体で一意に振り直し、componentのobjectid/UUID、形状UUID、model_settingsのpart IDとmesh_sharedを同時に更新する。以前の結合処理で作った親も追加時に補正する。形状XMLはストリームで走査し、オブジェクトの開始タグだけを書き換える。頂点・三角形のバイト列は保持し、8MiBを超える形状もメモリへ一括展開しない。

保存済みのサーバー生成3MFは、`python3 scripts/append-plate.py --repair INPUT OUTPUT MAX_BYTES`で別ファイルへ修復できる。出力先は新規ファイルに限り、元のファイル・G-code/md5・モデル配置・スライス設定は変更しない。ストレージへの反映はこのスクリプトの対象外。反映時は元の成果物とSQLiteをバックアップし、staging→保存・照合→readyの順序とサイズメタデータの更新が必要。

ZIPを展開せずにコピーし、2000エントリ、番号100、XML/JSON各8MiB、展開後合計MAX_ARTIFACT_MBの8倍、圧縮後MAX_ARTIFACT_MBの上限を検証する。暗号化・重複名・不正パス・DTD/実体宣言を拒否。新しい集合参照はストレージ保存後にSQLiteで確定し、途中の成果物はジョブ領域と共に清掃する。

追加の実CLI試験は`npm run test:slice -- --append MODEL`。通常の1枚に続いて2枚追加し、同じプレートUUID、各結果UUID、選択G-code、元のG-code不変を検証する。専用DATA_DIRを使い、実ストレージへ保存するが印刷はしない。

実ツールの実行結果・環境差・未検証項目は[検証記録 #10](https://github.com/hapo31/pi_wedge/issues/10)、過去の調査・導入時の記録は[Issue #12](https://github.com/hapo31/pi_wedge/issues/12)を参照。追加の検証結果もIssueへ記録する。
