# WFP (Filmora) 編集データ形式 — 実プロジェクト解剖記録

対象: `タイトルなし-2026-09-04 22 50 25(copy).wfpbundle` (Filmora 15.6.4 / vbl 8.6.2.8)
生成: 2026-09-06、バンドル内 `.wfp` を展開して全キーを解析。

## 1. 容器構造（3層の入れ子）

```
.wfpbundle                  ← ZIP (STORED)
 ├─ Medias/{GUID}/素材ファイル     ← 動画/画像/音声の実体（バンドル直下）
 └─ <プロジェクト名>.wfp           ← これ自体が ZIP
      └─ ProjectFolder/
           ├─ project_info.json          ← プロジェクト設定
           ├─ Medias/{GUID}/media.json   ← 素材ごとのメタ
           ├─ Medias/{GUID}/thumbnail.png
           └─ Medias/{timeline_mediaId}/timeline.wesproj  ← ★編集データ本体 (JSON)
```

- 素材は「バンドル直下 `Medias/{GUID}/ファイル名`」と
  「`.wfp` 内 `ProjectFolder/Medias/{GUID}/ファイル名`」の2箇所に同名で存在。
  GUID で突き合わせる。
- タイムラインの GUID は `project_info.json` の `timeline_mediaId`。

## 2. 時刻の単位

**すべて 1e7 = 100ナノ秒単位の整数**（1秒 = 10,000,000）。
`tlBegin` / `tlEnd` = タイムライン上の配置、`inPoint` / `outPoint` = ソース内トリム。
例: `tlBegin=0, tlEnd=81333333` → 0〜8.133s。プロジェクト長 2173333331 → 217.33s。

## 3. timeline.wesproj の構文

```json
{ "resources": [素材の配列], "timelineInfos": [ { trackInfos: [トラック], ... } ] }
```

### resources[]
素材ごとのメタ。キーは **`sourceUuid`**（クリップの `sourceUuid` と突き合わせる）。
`filename` は `file:/C:/Users/...` の元パス（実体は GUID でMediasから取得）。
`vidStreamInfo[0].width/height` に画像サイズ等。

### timelineInfos[0]
`resolutionWidth/Height` (1920×1080), `frameRate:{num:60,den:1}`, `sampleRate`, `audioBusInfos`（マスター gain 0.0 = 無加工）。

### trackInfos[] — トラック
- `trackType`: **1=映像系 / 2=音声系**
- `trackTag`: レイヤー番号（**小さいほど下**）。映像と音声が同じ tag のペアで対応
- 実プロジェクト: tag2=メイン映像(24クリップ) / tag4・6・8・10=上レイヤー(効果・画像)。
  tag なし音声トラック1本 = BGM(mp3)

### clipList[] — クリップ
- `type`: **1=映像/画像, 2=音声, 8=効果クリップ（フィルター）**
- `tlBegin/tlEnd`: 配置位置、`inPoint/outPoint`: ソーストリム
- `speed.speedParam` (JSON文字列): `{keyframeSets:[{_time,_value}], Version:3}`
  → 全クリップ `_value:1.0` 固定 = 速度変更なし。`_value`≠1 で速度ランプ
- `pipBuf` (JSON文字列): 合成情報 `{BlendMode:0, Opacity:100, BlenderName:"video/blender/simple-pip"}`
- `backgroundFillBluredness`: 画像の背景ぼかし量
- `volumeKeyframe` / `audioDuckingframe`: 音声オートメーション（空なら無加工）
- `effectChainList`: 効果チェーン **3本固定**
  - `"Basic"`: crop-pan-zoom + transform（全クリップ）
  - `"Effect"`: ユーザー適用効果
  - `"Mask"`: complexmask

### effectChainList[].effectList[] — 効果
- `id`:
  - `video/effect/transform` — 位置/拡大/回転。paramList の
    `Position_x/y` (0..1, **0.5=中央**), `Scale_x/y` (%), `EnableTransform`
  - `video/effect/crop-pan-zoom` — クロップ（paramListなしなら無操作）
  - `video/effect/complexmask` — マスク（`complexmask_data` の `mask_count:0` = 空）
  - `audio/effect/clip_volume|fade|volume|ducking|equalizer|change_channel`
  - **GUID** (`F41825F4-...` 等) = Filmoraストック効果。`display` に人が読む名前
- type-8 クリップ（効果クリップ）: ソースはダミー(mp3)で、Effect チェーン内の
  GUID効果が本体。**そのトラックの下すべてに適用**される時間範囲 = tlBegin〜tlEnd

### postTransition — クリップ間トランジション
切り替わり点を挟む時間窤 `tlBegin〜tlEnd`（2.00s、中心がカット点）。
`display` = 名前。type-5。音声トラックでは `audio fade` として出現。
タイムライン末尾のトランジション = 黒フェード。

## 4. 実プロジェクトで使われた編集要素（全量）

| 要素 | 内容 |
|---|---|
| カット | 24クリップ連続 0〜217.33s、速度はすべて1.0 |
| 画像レイヤー | `S__13508654.jpg`(1206×663) 2.20-5.17s 位置(0.21,0.71) 30.6% / `S__13508655.jpg`(829×718) 3.13-6.05s 位置(0.81,0.39) 51.4% |
| ベースtransform | clip0 のみ Position_x=0.4875（24px左） |
| トランジション | 7本×2s: Simple Roll 11, Glitch, Glitch Intro 08, Warp Zoom 4/3, Fast Zoom, Fast Wipe Right（最後は黒フェード） |
| 音声フェード | 6本×2s（映像トランジションと同位置） |
| フィルター効果 | 25イベント（retro effect 9, Mild, Extreme, Fashion Photography 01, Chaos 1/2, Neno_Swing, OldVideo, Cinema 21_9, Up-Down 2, Horror Pack 01/03, Halloween Party Overlay 05, …）＋ clip直接効果: Glitter Overlay 06, HeartBeat(Speed=3) |
| マスク | 16箇所すべて空（mask_count=0） |
| 音声 | BGM mp3 0.72-214.36s + クリップ音声23本、音量/ダッキングすべてデフォルト |

## 5. 再現ポリシー（レンダラー実装）

| 分類 | 対応 |
|---|---|
| 完全再現 | カット/トリム、多レイヤー画像（位置・倍率・不透明度）、音声ミックス、音声フェード、末尾黒フェード、アス比フィット |
| 高精度近似 | トランジション→ffmpeg xfade 相当種別 (zoomin/slideleft/pixelize/hblur/wiperight)、色彩フィルター→eq/colorbalance/vignette/noise 系、Cinema 21_9→2.39:1黒帯、HeartBeat→zoompan脈動、OldVideo→ノイザス減彩 |
| 近似（素材なし） | Filmoraストックのオーバーレイ動画（Halloween/Glitter等）はバンドルにassetが無いため色彩・グレインで雰囲気のみ再現 |
