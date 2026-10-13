# スライサー・STEP

## 調査と選定（2026-10-13）

OrcaSlicer v2.4.2の[公式リリース](https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.4.2)にLinux Ubuntu2404 aarch64 AppImageとARM64 Flatpakが存在する。ARM64配布があることは確認済み、Pi OS上の起動・実スライスは別検証。AppImage展開後AppRunをORCA_BINに指定。GUI依存が初期化される可能性があるため必要時ORCA_XVFB=trueでxvfb-runを使用。管理者が配布物のチェックサム/出所を確認する。
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
