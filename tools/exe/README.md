# wfp-render.exe — Filmora編集データ → MP4 レンダラー（Windows）

インストール不要の単体exe。`.wfpbundle`（または中身のzip）を渡すと、
カット編集（トリミング・並び）と音声ミックス（BGM＋クリップ音声）を
ffmpegでレンダリングして MP4 を出力する。

## 使い方

1. `dist/wfp-render.exe` をダウンロード（GitHubの `dist/wfp-render.exe` の
   Downloadボタン/rawリンクから）。
2. `.wfpbundle` ファイルを **exeにドラッグ＆ドロップ**、またはコマンドプロンプトで:
   ```
   wfp-render.exe "タイトルなし-2026-09-04 22 50 25(copy).wfpbundle"
   ```
   既定は **4K(3840x2160) @ 120fps** 出力。
3. 初回実行時のみ ffmpeg（約90MB）を自動ダウンロードして
   `%LOCALAPPDATA%\wfp-render` にキャッシュする。
4. 出力は入力ファイルの横の `wfp-render-out/` に書き出される。
   中断してもセグメント単位で再開（同じ設定で再実行即可）。

## オプション
```
--res 1920x1080   解像度指定（既定 3840x2160）
--fps 60          fps指定（既定 120）
--out out.mp4     出力先
--crf 18          品質（小さいほど高画質、既定19）
--limit 5         テスト用：最初の5クリップだけ
--ffmpeg path     ffmpeg.exeを明示指定
-y                確認をスキップ
```

例: 1080p60で出力
```
wfp-render.exe project.wfpbundle --res 1920x1080 --fps 60
```

## 注意
- Filmora独自の**エフェクト・テキスト・ステッカー・トランジション・音量カーブ**
  は独自フォーマットのため再現されない（該当クリップはスキップ）。
- SmartScreen「WindowsによってPCが保護されました」が出た場合は
  「詳細情報」→「実行」。
- ビルド方法: `tools/exe/build.sh`（Bun のクロスコンパイル:
  `bun build --compile --target=bun-windows-x64`）

## 対象データ
Filmora 15系 `.wfp` を zip 化した `.wfpbundle`。`ProjectFolder/Medias/*/timeline.wesproj`
の `inPoint/outPoint/tlBegin/tlEnd`（100ns tick）を読み、映像は
`scale(lanczos)+pad+fps変換 → x264 veryfast crf19`、音声は
`atrim+adelay → amix(normalize=0) → alimiter` でミックス。
