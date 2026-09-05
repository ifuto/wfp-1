# .wfpbundle 復元検証記録 (2026-09-05)

`files/` にアップロードされた31分割パートから .wfpbundle を復元した際の検証結果。

## 元ファイル
- 名前: `タイトルなし-2026-09-04 22 50 25(copy).wfpbundle.zip`（アップロード時は percent-encode されたファイル名）
- サイズ: 771,038,851 bytes (735.1 MiB)
- 分割: 31 パート × 25,165,824 bytes (24 MiB) — `file-splitter.html` で生成

## 検証結果
| 項目 | 結果 |
|---|---|
| パート数 | 31/31 すべて受信 ✓ |
| 各パート SHA-256（manifest.json と照合） | 31/31 一致 ✓ |
| 結合後サイズ | 771,038,851 bytes 一致 ✓ |
| 結合全体 SHA-256 | `7d8457c04227de6f5f95bc57f6f6a6fbe9a2fb8533087b5f3d257aad88f158f1` |
| zip 整合性 (`unzip -t`) | **No errors detected** ✓ |
| 内容 | 29 エントリ（`Medias/*.mp4` 28本 + `.wfp` 1件） |

## 復元手順
```bash
cd files
cat *.bin > ../bundle.zip          # part001..part031 の順に連結
unzip -t ../bundle.zip             # 整合性確認
mv ../bundle.zip "タイトルなし-2026-09-04 22 50 25(copy).wfpbundle"
```

## 補足
- `.wfpbundle.zip` で終わる名前のファイルは「.wfpbundle を zip 化したもの」のため、
  `.zip` を剥がすだけで正しい `.wfpbundle` ファイル名になる（`.zip` → `.wfpbundle` 置換ではない）。
- 771MB は git の 100MB/ファイル制限を超えるため、結合済み .wfpbundle はリポジトリに入れず、
  `tools/uploader/server.js` の `/download` から配布する。
