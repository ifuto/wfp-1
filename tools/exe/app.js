#!/usr/bin/env node
/*
 * wfp-render — Filmora .wfpbundle -> MP4 renderer (single exe, no install).
 *
 * Usage:
 *   wfp-render.exe <bundle.wfpbundle|.zip|parts-dir> [--res WxH] [--fps N]
 *                  [--out FILE] [--crf N] [--limit N] [--ffmpeg PATH] [-y]
 *
 * Defaults: 3840x2160 @ 120fps, x264 veryfast crf19, output next to input.
 * ffmpeg.exe is auto-downloaded (gyan.dev essentials) on first run and
 * cached in %LOCALAPPDATA%/wfp-render (or ~/.cache/wfp-render).
 *
 * NOTE: replicates cut editing (trims/order) + audio mix (BGM + clip
 * audio). Filmora-proprietary effects/text/stickers are skipped.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");

/* ---------- tiny arg parser ---------- */
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-y" || a === "--yes") o.yes = true;
    else if (a === "--res") o.res = argv[++i];
    else if (a === "--fps") o.fps = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--crf") o.crf = argv[++i];
    else if (a === "--limit") o.limit = argv[++i];
    else if (a === "--ffmpeg") o.ffmpeg = argv[++i];
    else if (a === "-h" || a === "--help") o.help = true;
    else o._.push(a);
  }
  return o;
}

function human(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  return (n / 1e3).toFixed(0) + " KB";
}
function die(msg) { console.error("\n[error] " + msg); process.exit(1); }
function pauseOnWindows() {
  if (process.platform === "win32") {
    try { spawnSync("cmd.exe", ["/c", "pause"], { stdio: "inherit", shell: false }); } catch (e) {}
  }
}
const USAGE = `wfp-render — Filmora .wfpbundle → MP4 renderer (4K120 / 1080p)

使い方:
  wfp-render.exe <編集データ.wfpbundle または .zip>  [オプション]

オプション:
  --res WxH     出力解像度 (既定: 3840x2160 … 4K。1920x1080 も可)
  --fps N       出力フレームレート (既定: 120)
  --out FILE    出力ファイル名
  --crf N       品質 (既定: 19, 小さいほど高品質)
  --limit N     テスト用: 最初のNクリップだけレンダー
  --ffmpeg P    ffmpeg.exe のパス (無い場合は自動ダウンロード)
  -y            確認をスキップ

例:
  wfp-render.exe "タイトルなし.wfpbundle"
  wfp-render.exe project.zip --res 1920x1080 --fps 60
`;

/* ---------- ffmpeg acquisition ---------- */
function ffCacheDir() {
  const base = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "wfp-render")
    : path.join(os.homedir(), ".cache", "wfp-render");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function findFfmpeg(opt) {
  if (opt.ffmpeg) { if (fs.existsSync(opt.ffmpeg)) return opt.ffmpeg; die("--ffmpeg が見つかりません: " + opt.ffmpeg); }
  if (process.env.WFP_FFMPEG && fs.existsSync(process.env.WFP_FFMPEG)) return process.env.WFP_FFMPEG;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const cached = path.join(ffCacheDir(), "ffmpeg", exe);
  if (fs.existsSync(cached)) return cached;
  const which = spawnSync(exe, ["-version"], { captureOutput: true });
  if (which.status === 0) return exe;
  return null;
}

async function downloadFfmpeg() {
  const dir = ffCacheDir();
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const cached = path.join(dir, "ffmpeg", exe);
  if (fs.existsSync(cached)) return cached;
  const urls = [
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip",
  ];
  fs.mkdirSync(path.join(dir, "ffmpeg"), { recursive: true });
  for (const url of urls) {
    process.stdout.write("[ffmpeg] ダウンロード中: " + url + "\n");
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const total = +(res.headers.get("content-length") || 0);
      const buf = Buffer.from(await res.arrayBuffer());
      process.stdout.write("[ffmpeg] " + human(buf.length) + " 受信、解凍中…\n");
      const Z = globalThis.__ZIPLITE__;
      const src = new Z.BlobSource([new Blob([buf])]);
      const entries = await Z.openZip(src);
      const ffEntry = [...entries.keys()].find((n) => n.endsWith("/bin/" + exe) || n === "bin/" + exe || n.endsWith("/" + exe));
      if (!ffEntry) throw new Error("ffmpeg not inside archive");
      const out = await Z.extractEntry(src, entries, ffEntry);
      fs.writeFileSync(cached, Buffer.from(await out.arrayBuffer()));
      const chk = spawnSync(cached, ["-version"], { captureOutput: true });
      if (chk.status !== 0) throw new Error("downloaded ffmpeg broken");
      console.log("[ffmpeg] OK: " + cached);
      return cached;
    } catch (e) { console.log("[ffmpeg] 失敗: " + e.message); }
  }
  die("ffmpegの自動ダウンロードに失敗しました。--ffmpeg で直接指定してください。");
}

/* ---------- pipeline ---------- */
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || opt._.length === 0) { console.log(USAGE); pauseOnWindows(); process.exit(opt.help ? 0 : 1); }

  const input = opt._[0];
  if (!fs.existsSync(input)) die("ファイルが見つかりません: " + input);

  let width = 3840, height = 2160, fps = 120;
  if (opt.res) { const m = opt.res.match(/^(\d+)\s*[x×]\s*(\d+)$/i); if (!m) die("--res の書式: 3840x2160"); width = +m[1]; height = +m[2]; }
  if (opt.fps) { fps = parseInt(opt.fps, 10); if (!(fps > 0 && fps <= 240)) die("--fps が変です"); }
  const crf = opt.crf ? parseInt(opt.crf, 10) : 19;
  const limit = opt.limit ? parseInt(opt.limit, 10) : 0;

  let ff = findFfmpeg(opt);
  if (!ff) ff = await downloadFfmpeg();
  console.log("[ffmpeg] " + ff);

  /* ---- load bundle ---- */
  const Z = globalThis.__ZIPLITE__;
  const st = fs.statSync(input);
  console.log("[load] " + path.basename(input) + " (" + human(st.size) + ")");
  const chunks = [];
  const fh = fs.openSync(input, "r");
  const CH = 64 * 1024 * 1024;
  for (let off = 0; off < st.size; off += CH) {
    const len = Math.min(CH, st.size - off);
    const b = Buffer.alloc(len);
    fs.readSync(fh, b, 0, len, off);
    chunks.push(b);
    process.stdout.write("\r[load] 読み込み " + Math.min(100, Math.round((off + len) / st.size * 100)) + "%");
  }
  fs.closeSync(fh);
  process.stdout.write("\n");
  const src = new Z.BlobSource(chunks.map((c) => new Blob([c])));
  const entries = await Z.openZip(src);
  console.log("[zip] bundle entries: " + entries.size);

  const wfpName = [...entries.keys()].find((n) => n.toLowerCase().endsWith(".wfp"));
  if (!wfpName) die(".wfp プロジェクトが bundle 内に見つかりません（Filmoraの .wfpbundle を指定してください）");
  const wfpBlob = await Z.extractEntry(src, entries, wfpName);
  const wsrc = new Z.BlobSource([wfpBlob]);
  const wentries = await Z.openZip(wsrc);
  console.log("[zip] project entries: " + wentries.size);

  const td = new TextDecoder();
  const pinfo = JSON.parse(td.decode(await (await Z.extractEntry(wsrc, wentries, "ProjectFolder/project_info.json")).arrayBuffer()));
  const mediaMap = Z.mediaMapFromEntries([...entries.keys(), ...[...wentries.keys()].map((n) => n.replace(/^ProjectFolder\//, ""))]);
  const tlName = "ProjectFolder/Medias/" + pinfo.timeline_mediaId + "/timeline.wesproj";
  const tl = JSON.parse(td.decode(await (await Z.extractEntry(wsrc, wentries, tlName)).arrayBuffer()));
  const parsed = Z.parseTimeline(tl, mediaMap);
  const dur = parsed.duration;
  console.log("[proj] " + pinfo.project_file_name);
  console.log("[proj] タイムライン " + pinfo.project_timeline_resolution.join("x") + "@" + (pinfo.project_timeline_framerate[0] / pinfo.project_timeline_framerate[1]) + " / " + (dur / 60).toFixed(1) + "分");
  console.log("[proj] 映像クリップ " + parsed.videoClips.length + " / 音声 " + parsed.audioClips.length + " → 出力 " + width + "x" + height + "@" + fps);
  if (parsed.videoClips.length === 0) die("映像クリップがありません");

  if (!opt.yes) {
    process.stdout.write("開始しますか? [Enter=開始 / Ctrl+C=中止] ");
    spawnSync(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/c", "pause>nul"] : ["-c", "read dummy"], { stdio: ["inherit", "ignore", "ignore"] });
  }

  /* ---- workspace ---- */
  const baseName = path.basename(input).replace(/\.(wfpbundle|zip)$/i, "");
  const outDir = path.join(path.dirname(path.resolve(input)), "wfp-render-out", width + "x" + height + "@" + fps + (limit ? "-test" : ""));
  fs.mkdirSync(outDir, { recursive: true });
  const mediaDir = path.join(path.dirname(path.resolve(input)), "wfp-render-out", "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const logPath = path.join(outDir, "render.log");
  const log = fs.openSync(logPath, "a");

  function run(args, label) {
    const r = spawnSync(ff, args, { stdio: ["ignore", "ignore", log] }); // log = fd number
    if (r.status !== 0) {
      const tail = fs.readFileSync(logPath, "utf8").split("\n").slice(-15).join("\n");
      die((label || "ffmpeg") + " が失敗しました (exit " + r.status + ")。ログ: " + logPath + "\n" + tail);
    }
  }

  /* ---- extract media ---- */
  const needGuids = new Set([...parsed.videoClips, ...parsed.audioClips].map((c) => c.guid));
  const guidFile = new Map();
  let mi = 0;
  for (const g of needGuids) {
    const m = mediaMap.get(g);
    if (!m) continue;
    const dest = path.join(mediaDir, g + "_" + m.name);
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      const blob = await Z.extractEntry(src, entries, m.entry);
      const w = fs.openSync(dest, "w");
      const ab = await blob.arrayBuffer();
      fs.writeSync(w, Buffer.from(ab));
      fs.closeSync(w);
    }
    guidFile.set(g, dest);
    process.stdout.write("\r[media] " + (++mi) + "/" + needGuids.size);
  }
  process.stdout.write("\n");

  /* ---- segments ---- */
  const clips = limit ? parsed.videoClips.slice(0, limit) : parsed.videoClips;
  const list = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const seg = path.join(outDir, "seg" + String(i).padStart(3, "0") + ".mp4");
    list.push(seg);
    if (fs.existsSync(seg) && fs.statSync(seg).size > 0) continue;
    const media = guidFile.get(c.guid);
    const durSeg = c.out - c.in;
    process.stdout.write("\r[video] クリップ " + (i + 1) + "/" + clips.length + " (" + durSeg.toFixed(1) + "s)");
    run(["-hide_banner", "-y",
      "-ss", c.in.toFixed(3), "-t", durSeg.toFixed(3), "-i", media,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease:flags=lanczos,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,fps=" + fps,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
      "-t", (c.tlend - c.tl).toFixed(3), seg], "segment " + (i + 1));
  }
  process.stdout.write("\n[video] 連結中…\n");
  const listFile = path.join(outDir, "list.txt");
  fs.writeFileSync(listFile, list.map((s) => "file '" + s.replace(/'/g, "'\\''") + "'").join("\n"));
  const videoMp4 = path.join(outDir, "video.mp4");
  run(["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", videoMp4], "concat");

  /* ---- audio ---- */
  console.log("[audio] ミックス中…");
  let audioInputs = [];
  for (const c of (limit ? parsed.audioClips.filter((a) => a.tl < clips[clips.length - 1].tlend) : parsed.audioClips)) {
    const f = guidFile.get(c.guid);
    if (!f) continue;
    if (/\.(mp4|mov|mkv|webm)$/i.test(f)) {
      const pr = spawnSync(ff, ["-hide_banner", "-i", f], { captureOutput: true });
      if (!/Audio:/.test(pr.stderr.toString())) continue;
    }
    audioInputs.push({ c, f });
  }
  const outFile = opt.out || path.join(outDir, "..", "..", baseName + "_" + width + "x" + height + "@" + fps + ".mp4");
  if (audioInputs.length === 0) {
    fs.copyFileSync(videoMp4, outFile);
  } else {
    const args = ["-hide_banner", "-y"];
    const fc = [];
    audioInputs.forEach((ai, idx) => {
      args.push("-i", ai.f);
      const delay = Math.round(ai.c.tl * 1000);
      fc.push("[" + idx + ":a]atrim=start=" + ai.c.in.toFixed(3) + ":end=" + ai.c.out.toFixed(3) +
        ",asetpts=PTS-STARTPTS,adelay=" + delay + "|" + delay + "[a" + idx + "]");
    });
    fc.push(audioInputs.map((_, idx) => "[a" + idx + "]").join("") +
      "amix=inputs=" + audioInputs.length + ":normalize=0:dropout_transition=0,alimiter=limit=0.95," +
      "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]");
    const audioFile = path.join(outDir, "audio.m4a");
    const outDur = limit ? clips[clips.length - 1].tlend : dur;
    run(args.concat(["-filter_complex", fc.join(";"), "-map", "[aout]", "-c:a", "aac", "-b:a", "256k",
      "-t", (outDur + 0.5).toFixed(3), audioFile]), "audio mix");
    console.log("[mux] 最終ファイル書き出し中…");
    run(["-hide_banner", "-y", "-i", videoMp4, "-i", audioFile, "-map", "0:v:0", "-map", "1:a:0",
      "-c", "copy", "-movflags", "+faststart", "-shortest", outFile], "mux");
  }
  console.log("\n✅ 完了: " + outFile + " (" + human(fs.statSync(outFile).size) + ")");
  pauseOnWindows();
}

main().catch((e) => { console.error("\n[error] " + (e && e.stack || e)); pauseOnWindows(); process.exit(1); });
