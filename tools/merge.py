#!/usr/bin/env python3
"""split.html で分割したパーツを結合して元ファイルを復元する。

使い方:
    python3 merge.py <パーツのあるディレクトリ> [-o 出力ファイル名] [--no-verify-zip]
    python3 merge.py part1 part2 ... [-o 出力ファイル名]

- <name>.manifest.json / manifest.json があれば、それに従って
  パーツの並び順・サイズ・SHA-256 を検証してから結合する。
- manifest が無ければファイル名の連番 (<name>.001, .002 …) から推定する。
- 出力名は manifest の output_name → -o → 元の名前 (.zip → .wfpbundle) の順で決まる。
- 出力が ZIP 形式なら最後に zipfile で整合性チェックする。

依存: Python 3.8+ の標準ライブラリのみ。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import zipfile
from pathlib import Path
from typing import Iterable, List, Optional

CHUNK = 8 * 1024 * 1024
RAW_PART_RE = re.compile(r"^(?P<stem>.+)\.(?P<num>\d{3,})$")
ZIP_PART_RE = re.compile(r"^(?P<stem>.+)\.part(?P<num>\d{3,})\.zip$", re.IGNORECASE)


class MergeError(Exception):
    pass


def fmt_bytes(n: int) -> str:
    v = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if v < 1000 or unit == "TB":
            return f"{v:.0f} {unit}" if unit == "B" else f"{v:.2f} {unit}"
        v /= 1000
    return f"{n} B"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def open_part_stream(path: Path, wrapped: bool, entry: Optional[str]):
    """パーツの中身を返すファイルオブジェクト（ZIP 包みなら展開ストリーム）。"""
    if not wrapped:
        return path.open("rb")
    zf = zipfile.ZipFile(path)
    names = zf.namelist()
    if not names:
        raise MergeError(f"{path.name}: ZIP が空です")
    if entry and entry in names:
        name = entry
    elif len(names) == 1:
        name = names[0]
    else:
        raise MergeError(f"{path.name}: ZIP 内のエントリを特定できません: {names}")
    return zf.open(name)


def sha256_of_part(path: Path, wrapped: bool, entry: Optional[str]) -> tuple[str, int]:
    h = hashlib.sha256()
    n = 0
    with open_part_stream(path, wrapped, entry) as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
            n += len(chunk)
    return h.hexdigest(), n


def find_manifest(paths: Iterable[Path]) -> Optional[Path]:
    cands = [p for p in paths if p.is_file() and p.name.lower().endswith("manifest.json")]
    if not cands:
        return None
    if len(cands) > 1:
        print(f"[warn] manifest が複数あります。最初のものを使います: {[c.name for c in cands]}", file=sys.stderr)
    return sorted(cands)[0]


def collect_inputs(args_inputs: List[str]) -> tuple[List[Path], Optional[Path]]:
    files: List[Path] = []
    manifest: Optional[Path] = None
    for s in args_inputs:
        p = Path(s)
        if p.is_dir():
            entries = sorted(x for x in p.iterdir() if x.is_file())
            m = find_manifest(entries)
            if m and not manifest:
                manifest = m
            files.extend(x for x in entries if x != m)
        elif p.is_file():
            if p.name.lower().endswith("manifest.json") and not manifest:
                manifest = p
            else:
                files.append(p)
        else:
            raise MergeError(f"見つかりません: {s}")
    return files, manifest


def infer_parts_without_manifest(files: List[Path]):
    """manifest 無し: ファイル名の連番から組み立てる。"""
    raw, wrapped = {}, {}
    for f in files:
        m = ZIP_PART_RE.match(f.name)
        if m:
            wrapped.setdefault(m.group("stem"), []).append((int(m.group("num")), f))
            continue
        m = RAW_PART_RE.match(f.name)
        if m:
            raw.setdefault(m.group("stem"), []).append((int(m.group("num")), f))
    groups = [(stem, lst, False) for stem, lst in raw.items()] + [(stem, lst, True) for stem, lst in wrapped.items()]
    if not groups:
        raise MergeError("パーツらしいファイルが見つかりません (<name>.001 … または <name>.part001.zip)")
    groups.sort(key=lambda g: -len(g[1]))
    stem, lst, is_wrapped = groups[0]
    if len(groups) > 1:
        print(f"[warn] 複数のパーツ群があります。最も多い群を使用: {stem} ({len(lst)} 個)", file=sys.stderr)
    lst.sort()
    nums = [n for n, _ in lst]
    expected = list(range(nums[0], nums[0] + len(nums)))
    if nums != expected:
        missing = sorted(set(range(nums[0], nums[-1] + 1)) - set(nums))
        raise MergeError(f"連番が飛んでいます。欠けているパーツ: {missing}")
    if nums[0] != 1:
        print(f"[warn] 連番が {nums[0]} から始まっています", file=sys.stderr)
    parts = [{"index": n, "name": f.name, "path": f, "entry": None, "size": None, "sha256": None} for n, f in lst]
    original_name = stem
    if is_wrapped:
        # zip 包みはファイル名から元の拡張子が落ちているので、中のエントリ名 (<orig>.001) から復元する
        try:
            with zipfile.ZipFile(lst[0][1]) as zf:
                entry = zf.namelist()[0]
            m = RAW_PART_RE.match(entry)
            if m:
                original_name = m.group("stem")
        except (zipfile.BadZipFile, IndexError):
            pass
    return {"original_name": original_name, "original_size": None, "output_name": None,
            "wrapped_in_zip": is_wrapped, "parts": parts}


def load_manifest(manifest_path: Path, files: List[Path]):
    with manifest_path.open("r", encoding="utf-8") as f:
        m = json.load(f)
    if not str(m.get("format", "")).startswith("split-manifest/"):
        print(f"[warn] 未知の manifest 形式: {m.get('format')!r}", file=sys.stderr)
    by_name = {f.name: f for f in files}
    parts = []
    missing = []
    for p in sorted(m["parts"], key=lambda x: x["index"]):
        path = by_name.get(p["name"])
        if path is None:
            missing.append(p["name"])
            continue
        parts.append({"index": p["index"], "name": p["name"], "path": path, "entry": p.get("entry"),
                      "size": p.get("size"), "sha256": p.get("sha256")})
    if missing:
        raise MergeError("manifest に載っているのに見つからないパーツ:\n  " + "\n  ".join(missing))
    idx = [p["index"] for p in parts]
    if idx != list(range(1, len(idx) + 1)):
        raise MergeError(f"manifest の index が 1..N の連番ではありません: {idx}")
    if m.get("part_count") not in (None, len(parts)):
        raise MergeError(f"manifest の part_count ({m.get('part_count')}) と実際のパーツ数 ({len(parts)}) が一致しません")
    extra = set(by_name) - {p["name"] for p in parts}
    if extra:
        print(f"[info] manifest に無いファイルは無視します: {sorted(extra)}", file=sys.stderr)
    return {"original_name": m.get("original_name"), "original_size": m.get("original_size"),
            "output_name": m.get("output_name"), "wrapped_in_zip": bool(m.get("wrapped_in_zip")), "parts": parts}


def decide_output_name(spec, cli_out: Optional[str]) -> str:
    if cli_out:
        return cli_out
    if spec.get("output_name"):
        return spec["output_name"]
    name = spec.get("original_name") or "merged.bin"
    if name.lower().endswith(".zip"):
        return name[:-4] + ".wfpbundle"
    return name


def merge(spec, out_path: Path, verify: bool = True) -> int:
    wrapped = spec["wrapped_in_zip"]
    parts = spec["parts"]
    total = 0
    problems = []

    if verify:
        print(f"[1/3] {len(parts)} パーツを検証中…")
        for p in parts:
            digest, n = sha256_of_part(p["path"], wrapped, p["entry"])
            p["actual_size"] = n
            if p["size"] is not None and n != p["size"]:
                problems.append(f"  {p['name']}: サイズ不一致 (expected {p['size']}, got {n})")
            if p["sha256"] and digest.lower() != p["sha256"].lower():
                problems.append(f"  {p['name']}: SHA-256 不一致\n      expected {p['sha256']}\n      got      {digest}")
            print(f"    #{p['index']:>3} {p['name']}  {fmt_bytes(n)}  {digest[:16]}…  {'NG' if problems and problems[-1].startswith('  ' + p['name']) else 'ok'}")
        if problems:
            raise MergeError("パーツの検証に失敗しました（該当パーツを再アップロードしてください）:\n" + "\n".join(problems))
    else:
        print("[1/3] 検証スキップ")

    print(f"[2/3] 結合中 → {out_path}")
    tmp = out_path.with_name(out_path.name + ".partial")
    h = hashlib.sha256()
    with tmp.open("wb") as out:
        for p in parts:
            with open_part_stream(p["path"], wrapped, p["entry"]) as src:
                for chunk in iter(lambda: src.read(CHUNK), b""):
                    out.write(chunk)
                    h.update(chunk)
                    total += len(chunk)
    if spec.get("original_size") is not None and total != spec["original_size"]:
        tmp.unlink(missing_ok=True)
        raise MergeError(f"結合後サイズ不一致: expected {spec['original_size']}, got {total}")
    os.replace(tmp, out_path)
    print(f"      {fmt_bytes(total)} ({total:,} bytes)  sha256={h.hexdigest()}")

    print("[3/3] 内容チェック")
    if zipfile.is_zipfile(out_path):
        try:
            with zipfile.ZipFile(out_path) as zf:
                bad = zf.testzip()
                n_entries = len(zf.infolist())
            if bad:
                raise MergeError(f"ZIP 内の破損エントリ: {bad}")
            print(f"      ZIP として正常 ({n_entries} エントリ)")
        except zipfile.BadZipFile as e:
            raise MergeError(f"ZIP として読めません: {e}")
    else:
        print("      (ZIP 形式ではないのでアーカイブ検査はスキップ)")
    return total


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="split.html で分割したパーツを結合する")
    ap.add_argument("inputs", nargs="+", help="パーツのあるディレクトリ、またはパーツファイル群")
    ap.add_argument("-o", "--output", help="出力ファイル名（既定: manifest の output_name → 元名の .zip を .wfpbundle に）")
    ap.add_argument("--outdir", help="出力先ディレクトリ（既定: 最初の入力ディレクトリ／カレント）")
    ap.add_argument("--no-verify", action="store_true", help="パーツの SHA-256 検証をスキップ")
    ap.add_argument("--force", action="store_true", help="出力先が存在しても上書き")
    args = ap.parse_args(argv)

    try:
        files, manifest = collect_inputs(args.inputs)
        if manifest:
            print(f"manifest: {manifest}")
            spec = load_manifest(manifest, files)
        else:
            print("manifest 無し: ファイル名から推定します")
            spec = infer_parts_without_manifest(files)
        out_name = decide_output_name(spec, args.output)
        if args.outdir:
            outdir = Path(args.outdir)
        elif Path(args.inputs[0]).is_dir():
            outdir = Path(args.inputs[0])
        else:
            outdir = Path.cwd()
        outdir.mkdir(parents=True, exist_ok=True)
        out_path = outdir / out_name
        if out_path.exists() and not args.force:
            raise MergeError(f"出力先が既に存在します: {out_path}（--force で上書き）")
        merge(spec, out_path, verify=not args.no_verify)
        print(f"\n完了: {out_path}")
        return 0
    except MergeError as e:
        print(f"\nエラー: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
