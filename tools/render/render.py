#!/usr/bin/env python3
"""
Filmora .wfpbundle -> MP4 renderer (no Filmora needed).

Parses ProjectFolder/Medias/<timelineGUID>/timeline.wesproj inside the .wfp
project (itself zipped inside the .wfpbundle), then renders the edit with
ffmpeg:

  1. per-clip trimmed segments, scaled/padded to target resolution, fps-converted
  2. concat of segments (stream copy)
  3. audio mix: BGM + per-clip audio placed at timeline offsets
  4. mux

NOT replicated (Filmora-proprietary): effects/transitions/stickers/text
overlays (effectChainList, type=8 clips w/o media), per-clip volume curves.
"""
import json, os, re, sys, glob, zipfile, subprocess, shutil, time

TICK = 1e7  # Filmora uses 100ns ticks

def info(opts):
    """Print a JSON summary of the project in the newest bundle."""
    d = opts.get("dir", "/tmp/wfp-upload")
    bundle = find_bundle(d)
    z, pinfo, minfo, tl = parse_project(bundle)
    media_root = os.path.join(d, "media", "Medias")
    vcount = acount = ovcount = 0
    music = []
    names = set()
    for tr in tl["timelineInfos"][0]["trackInfos"]:
        for c in tr.get("clipList", []):
            guid = guid_of_clip(c, minfo)
            mp = None
            if guid:
                dd = os.path.join(media_root, guid)
                if not os.path.isdir(dd):
                    for n in z.namelist():
                        if n.startswith("Medias/"):
                            z.extract(n, os.path.join(d, "media"))
                files = [f for f in os.listdir(dd) if not f.endswith((".json", ".png"))] if os.path.isdir(dd) else []
                mp = os.path.join(dd, files[0]) if files else None
            if not mp:
                if c.get("type") == 8 or not c.get("filename"):
                    ovcount += 1
                continue
            if tr.get("trackType") == 1 and c.get("type") == 1 and mp.endswith((".mp4", ".mov", ".mkv", ".webm")):
                vcount += 1
                names.add(os.path.basename(mp))
            elif tr.get("trackType") == 2 and c.get("type") == 2:
                acount += 1
                music.append(os.path.basename(mp))
    fr = pinfo.get("project_timeline_framerate", [60, 1])
    res = pinfo.get("project_timeline_resolution", [1920, 1080])
    print(json.dumps({
        "bundle": os.path.basename(bundle),
        "project": pinfo.get("project_file_name"),
        "editor": "%s %s" % (pinfo.get("project_editor_name"), pinfo.get("project_editor_modify_version")),
        "timeline": {"w": res[0], "h": res[1], "fps": fr[0] / (fr[1] or 1)},
        "durationSec": pinfo.get("project_timeline_duration", 0) / TICK,
        "videoClips": vcount, "audioClips": acount,
        "effectOnlyClips": ovcount,
        "audioMedia": sorted(set(music))[:5],
    }, ensure_ascii=False))

def find_bundle(dir_):
    cands = [f for f in glob.glob(os.path.join(dir_, "*.zip")) if f.endswith(".zip")]
    if not cands:
        raise SystemExit("no bundle zip found in " + dir_)
    return max(cands, key=os.path.getmtime)

def find_ffmpeg():
    for p in [os.environ.get("FFMPEG_PATH"), "/tmp/ffmpeg-bin/ffmpeg"]:
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    raise SystemExit("ffmpeg not found (expected /tmp/ffmpeg-bin/ffmpeg)")

def parse_project(bundle_path):
    z = zipfile.ZipFile(bundle_path)
    wfp_name = [n for n in z.namelist() if n.endswith(".wfp")][0]
    z.extract(wfp_name, os.path.dirname(bundle_path) or ".")
    proj = zipfile.ZipFile(os.path.join(os.path.dirname(bundle_path) or ".", wfp_name))
    pinfo = json.loads(proj.read("ProjectFolder/project_info.json"))
    minfo = json.loads(proj.read("ProjectFolder/Medias/medias_info.json"))
    tl_name = "ProjectFolder/Medias/%s/timeline.wesproj" % pinfo["timeline_mediaId"]
    tl = json.loads(proj.read(tl_name))
    return z, pinfo, minfo, tl

def guid_of_clip(clip, minfo):
    """clip.filename -> media GUID via %DOCUMENT_DIR%/Medias/{GUID} or basename match."""
    fn = clip.get("filename", "")
    m = re.search(r"Medias/(\{[0-9A-Fa-f-]+\})", fn)
    if m:
        return m.group(1)
    base = os.path.basename(fn.replace("file:/", ""))
    for guid, info in minfo["media_items"].items():
        if info.get("name", "") and (info["name"] in base or base in info["name"] or
                                     info["name"] == os.path.splitext(base)[0]):
            return guid
    return None

def main():
    bundle = sys.argv[1]
    if bundle == "--info":
        info(json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})
        return
    if os.path.isdir(bundle):
        bundle = find_bundle(bundle)
    out_dir = sys.argv[2]
    width, height, fps = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    os.makedirs(out_dir, exist_ok=True)
    ff = find_ffmpeg()
    work = os.path.join(out_dir, "work")
    os.makedirs(work, exist_ok=True)
    progress_path = os.path.join(out_dir, "progress.json")
    log_path = os.path.join(out_dir, "render.log")

    def prog(state, frac, msg=""):
        with open(progress_path, "w") as f:
            json.dump({"state": state, "frac": round(frac, 4), "msg": msg, "ts": time.time()}, f)

    log = open(log_path, "a", buffering=1)
    def run(cmd, **kw):
        log.write("+ " + " ".join(cmd[:12]) + "...\n")
        r = subprocess.run(cmd, stdout=log, stderr=log, **kw)
        if r.returncode != 0:
            raise RuntimeError("command failed (%d): %s" % (r.returncode, " ".join(cmd[:8])))

    prog("parsing", 0.0, "解析中")
    z, pinfo, minfo, tl = parse_project(bundle)

    # extract media
    media_root = os.path.join(os.path.dirname(bundle), "media", "Medias")
    if not os.path.isdir(media_root):
        prog("parsing", 0.02, "素材抽出中")
        for n in z.namelist():
            if n.startswith("Medias/"):
                z.extract(n, os.path.join(os.path.dirname(bundle), "media"))

    def media_path(guid):
        d = os.path.join(media_root, guid)
        if not os.path.isdir(d):
            return None
        files = [f for f in os.listdir(d) if not f.endswith((".json", ".png"))]
        return os.path.join(d, files[0]) if files else None

    tracks = tl["timelineInfos"][0]["trackInfos"]
    vclips, astreams = [], []
    skipped = []
    for tr in tracks:
        for c in tr.get("clipList", []):
            guid = guid_of_clip(c, minfo)
            mp = media_path(guid) if guid else None
            entry = {
                "guid": guid, "path": mp,
                "in": c["inPoint"] / TICK, "out": c["outPoint"] / TICK,
                "tl": c["tlBegin"] / TICK, "tlend": c["tlEnd"] / TICK,
                "type": c.get("type"), "ttype": tr.get("trackType"),
            }
            if not mp:
                if c.get("type") in (1, 2):
                    skipped.append("no-media clip type=%s" % c.get("type"))
                continue
            if tr.get("trackType") == 1 and c.get("type") == 1 and mp.endswith((".mp4", ".mov", ".mkv", ".webm")):
                vclips.append(entry)
            elif tr.get("trackType") == 2 and c.get("type") == 2 and mp.endswith((".mp3", ".m4a", ".wav", ".aac", ".mp4")):
                astreams.append(entry)
    vclips.sort(key=lambda e: e["tl"])
    astreams.sort(key=lambda e: e["tl"])
    total_dur = max([e["tlend"] for e in vclips] + [e["tlend"] for e in astreams] + [0]) or 1.0
    log.write("video clips=%d audio streams=%d dur=%.2fs skipped=%s\n" % (len(vclips), len(astreams), total_dur, skipped))
    if not vclips:
        raise SystemExit("no video clips found")

    # 1) segments
    seg_list = os.path.join(work, "list.txt")
    with open(seg_list, "w") as lf:
        for i, e in enumerate(vclips):
            prog("render", 0.05 + 0.75 * i / len(vclips), "映像 %d/%d" % (i + 1, len(vclips)))
            seg = os.path.join(work, "seg%03d.mp4" % i)
            if not (os.path.isfile(seg) and os.path.getsize(seg) > 0):
                dur = e["out"] - e["in"]
                run([ff, "-hide_banner", "-y",
                     "-ss", "%.3f" % e["in"], "-t", "%.3f" % dur, "-i", e["path"],
                     "-map", "0:v:0", "-map", "0:a:0?",
                     "-vf", "scale=%d:%d:force_original_aspect_ratio=decrease:flags=lanczos,"
                            "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,fps=%d" % (width, height, width, height, fps),
                     "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
                     "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
                     "-t", "%.3f" % (e["tlend"] - e["tl"]), seg])
            lf.write("file '%s'\n" % seg)

    # 2) concat video
    prog("concat", 0.82, "映像連結中")
    video_mp4 = os.path.join(work, "video.mp4")
    run([ff, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", seg_list, "-c", "copy", video_mp4])

    # 3) audio mix
    prog("audio", 0.88, "音声ミックス中")
    cmd = [ff, "-hide_banner", "-y"]
    parts = []
    inputs = []
    for e in astreams:
        if e["path"].endswith((".mp4", ".mov", ".mkv", ".webm")):
            # skip media without an audio stream (intro recordings etc.)
            pr = subprocess.run([ff, "-hide_banner", "-i", e["path"]], capture_output=True, text=True)
            if "Audio:" not in pr.stderr:
                log.write("skip audio-less media: %s\n" % e["path"])
                continue
        inputs.append(e)
        cmd += ["-i", e["path"]]
    if not inputs:
        shutil.copy(video_mp4, os.path.join(out_dir, "output.mp4"))
        prog("done", 1.0, "完了（音声なし）")
        return
    fc = []
    for i, e in enumerate(inputs):
        delay_ms = int(round(e["tl"] * 1000))
        fc.append("[{i}:a]atrim=start={s}:end={t},asetpts=PTS-STARTPTS,adelay={d}|{d}[a{i}]".format(
            i=i, s="%.3f" % e["in"], t="%.3f" % e["out"], d=delay_ms))
    mix = "".join("[a%d]" % i for i in range(len(inputs)))
    fc.append(mix + "amix=inputs=%d:normalize=0:dropout_transition=0,alimiter=limit=0.95,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]" % len(inputs))
    audio_m4a = os.path.join(work, "audio.m4a")
    run(cmd + ["-filter_complex", ";".join(fc), "-map", "[aout]", "-c:a", "aac", "-b:a", "256k", "-t", "%.3f" % (total_dur + 0.5), audio_m4a])

    # 4) mux
    prog("mux", 0.97, "最終ファイル書き出し中")
    out_name = os.path.join(out_dir, "output.mp4")
    run([ff, "-hide_banner", "-y", "-i", video_mp4, "-i", audio_m4a,
         "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", "-shortest", out_name])
    prog("done", 1.0, "完了: %s (%.1f MB)" % (out_name, os.path.getsize(out_name) / 1e6))

if __name__ == "__main__":
    try:
        main()
    except Exception as ex:
        import traceback
        out_dir = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "--info" else "."
        try:
            os.makedirs(out_dir, exist_ok=True)
            with open(os.path.join(out_dir, "progress.json"), "w") as f:
                json.dump({"state": "error", "msg": str(ex), "ts": time.time()}, f)
        except Exception:
            pass
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
