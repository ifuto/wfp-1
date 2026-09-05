# wfp-1 — Filmora .wfpbundle ツールセット

771MBのFilmora編集データ（`.wfpbundle`）を分割アップロードし、
結合・検証（`files/VERIFY.md`）して、**4K120fps / 1080p のMP4に書き出す**ツール一式。

## 🌐 Web版（インストール不要・ブラウザ内で完結）

**https://ifuto.github.io/wfp-1/web/**

- `.wfpbundle` をアップロードするだけで完結（リポジトリ非依存・送信ゼロ）
- WebCodecs でデコード（AV1/H.264）→ H.264エンコード → WebAudioミックス → MP4化
  （ffmpeg.wasm不使用・32MBダウンロード不要）
- 720p60 / 1080p60 / 1080p120 / 4K120（GPUエンコード）
- デスクトップChrome / Edge 推奨

## 🖥️ exe版（4K120対応・速い・推奨）

[`dist/wfp-render.exe`](https://github.com/ifuto/wfp-1/raw/arena/01a07073-wfp-1/dist/wfp-render.exe)
（Windows x64・単体・インストール不要。初回のみffmpegを自動DL）

```
wfp-render.exe "編集データ.wfpbundle"                # 4K 120fps で書き出し
wfp-render.exe "編集データ.wfpbundle" --res 1920x1080 --fps 60
```

詳細: [tools/exe/README.md](tools/exe/README.md)

## 対応範囲（共通）
カット編集（トリミング・並び順）と音声ミックス（BGM＋クリップ音声）を再現。
Filmora独自のエフェクト・テキスト・ステッカー・トランジション・音量カーブは
独自フォーマットのため非対応。

## リポジトリ構成
- `files/` — 分割アップロードされた31パート＋manifest.json（検証記録: VERIFY.md）
- `web/` — GitHub Pages Web版（ziplite.js / ffmpeg.wasm vendor 同梱）
- `tools/exe/` — exe版ソース＋ビルドスクリプト（Bunクロスコンパイル）
- `tools/uploader/` — サンドボックス内アップロード受付サーバー（チャット制限回避用）
- `tools/render/` — サンドボックス内レンダラー（サーバー側ffmpeg）
- `file-splitter.html` — ブラウザ内ファイル分割ツール（iOS対応）
