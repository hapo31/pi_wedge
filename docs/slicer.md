# スライサー・STEP

## 調査と選定（2026-10-13）

OrcaSlicer v2.4.2の[公式リリース](https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.4.2)にLinux Ubuntu2404 aarch64 AppImageとARM64 Flatpakが存在する。ARM64配布があることは確認済み、Debian13 ARM64の隔離環境でヘッドレス実スライスを確認済み。Pi OS上の性能は別検証。AppImage展開後AppRunをORCA_BINに指定。GUI依存が初期化される可能性があるため必要時ORCA_XVFB=trueでxvfb-runを使用。管理者が配布物のチェックサム/出所を確認する。
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

公式v2.4.2 AppImageはGLIBC>=2.38 / GLIBCXX_3.4.32を要求し、Debian12（glibc2.36）では動作しない。アプリのNode/S3はDebian12でも動作する。新規のホスト構築ではRaspberry Pi OS 64bitのDebian13系を選択し、下記CLI依存を導入する。Debian13 ARM64で検証済み。Pi OS固有の差異は実機で確認する。既存OSを保持する場合は同じModelConverter/Slicer契約で管理者の隔離ツール実行環境または互換ビルドを指定する。ホストのglibcを個別に置換しない。

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

本検証ではCLIにDISPLAY/Xvfb不要。--help、STL/STEP/インチ/2ソリッドを成功確認。Xvfbはディスプレイ初期化が必要な別ビルドのための任意設定。プロファイル由来のAGPLライセンスはmanifestの出所を確認。生成物を配布する場合は上流ライセンスに従う。

## Debian12を保持する隔離ツールモード

`docker build -f deploy/Dockerfile.tools -t pi-wedge-tools:0.1 .` を実行し、`.env`に `TOOLS_BACKEND=docker`、`TOOLS_IMAGE=pi-wedge-tools:0.1`、`ORCA_BIN=/opt/squashfs-root/AppRun`、`FREECAD_PYTHON=/usr/bin/python3`、`FREECAD_MODULE_PATH=/usr/lib/freecad-python3/lib` を設定する。プロファイルは同じ `npm run profiles:prepare` で準備する。アプリの実行ユーザーにはDocker操作権限が必要。DockerソケットをAPIへ公開しない。

DockerCommandRunnerがジョブ領域・プロファイル・固定の変換スクリプトだけをマウントし、ネットワーク無効・image pull無効で実行する（イメージは事前ビルド必須）。S3/プリンター/API資格情報をツールへ渡さない。CLI timeout後にコンテナを強制削除し、起動時はDATA_DIRラベルの残存コンテナを回収する。コンテナ回収に失敗した場合は依存復旧失敗として受付を止める。4GiB/3CPU/256PID上限はDockerに指定する。実ホストのcgroup対応を確認する（検証ホストはmemory limit非対応の警告を出したため、Pi上の上限動作は別検証）。

## プレートへの追加

`Slicer.slice`は任意の内部`ParentPlateInput`（ジョブ領域の親3MFパスと次の枚番号）を受け取れる。新しいSTL/変換済みSTEPを通常通り1枚だけOrcaでスライスした後、Orcaアダプター内から固定の`scripts/append-plate.py`を実行して結合する。Python標準ライブラリのみを使用し、native/dockerとも既存のCommandRunnerのタイムアウト・上限ログ・秘密を除いた環境を使う。Dockerでは固定スクリプトを読取専用でマウントする。

結合は[Orca v2.4.2の3MF実装](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/libslic3r/Format/bbs_3mf.cpp)と[プレート座標実装](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/GUI/PartPlate.cpp)に合わせ、既存G-code/md5は変更しない。モデルのオブジェクトIDと外部モデルパスを重複なく付け替え、model_settings/slice_info/filament_sequence/relationshipsを更新する。A1 miniの180mmベッド・1.2倍間隔・平方根切上げの列数でモデル配置を更新する。印刷用G-codeの座標は変えない。既存設定は保持し、新規枚は今回のスライス設定で生成済みのG-codeを使う。

ZIPを展開せずにコピーし、2000エントリ、番号100、XML/JSON各8MiB、展開後合計MAX_ARTIFACT_MBの8倍、圧縮後MAX_ARTIFACT_MBの上限を検証する。暗号化・重複名・不正パス・DTD/実体宣言を拒否。新しい集合参照はストレージ保存後にSQLiteで確定し、途中の成果物はジョブ領域と共に清掃する。

追加の実CLI試験は`npm run test:slice -- --append MODEL`。通常の1枚に続いて2枚追加し、同じプレートUUID、各結果UUID、選択G-code、元のG-code不変を検証する。専用DATA_DIRを使い、実ストレージへ保存するが印刷はしない。検証結果は[verification.md](verification.md)を参照。
