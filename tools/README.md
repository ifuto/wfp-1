# tools/ — 大きいファイルの分割・結合

アップロード上限（25MB など）を超えるファイルを、ブラウザだけで分割して送るためのツール。

| ファイル | 役割 |
|---|---|
| `split.html` | 送る側。ブラウザで開いてファイルをドロップすると、指定サイズ（既定 20MB）のパーツと `manifest.json` を書き出す。外部通信なし。 |
| `merge.py` | 受け取る側。パーツを SHA-256 で検証してから結合し、ZIP として開けるかもチェックする。標準ライブラリのみ。 |

## 送る側（split.html）

1. `split.html` をブラウザで開く（ダブルクリックでOK。Chrome / Edge 推奨）
2. ファイルをドロップ → パーツサイズを確認 → **分割する**
3. **フォルダを選んで一括保存** で空フォルダを選ぶと、全パーツ + `<name>.manifest.json` が書き出される
   - Firefox / Safari は **全部ダウンロード**（複数ダウンロードの許可を求められたら許可）
4. 書き出されたファイルを全部アップロード

例: 771MB の `project.zip` → 20MB × 39 パーツ（`project.zip.001` … `project.zip.039`）+ `project.zip.manifest.json`

アップロード先が `.001` のような拡張子を弾く場合は「各パーツを ZIP で包む」を選ぶと `project.part001.zip` … になる（無圧縮なのでサイズはほぼ同じ）。

## 受け取る側（merge.py）

```sh
python3 tools/merge.py <パーツを置いたディレクトリ>
# 出力名は manifest の output_name（.zip → .wfpbundle に自動変換）
# 明示するなら: python3 tools/merge.py parts/ -o project.wfpbundle
```

manifest が無くても連番ファイル名から結合できる（その場合ハッシュ検証はスキップ）。

手動で結合するなら:

```sh
cat "project.zip".[0-9]* > project.wfpbundle            # macOS / Linux
copy /b project.zip.001+project.zip.002+... project.wfpbundle   # Windows
```
