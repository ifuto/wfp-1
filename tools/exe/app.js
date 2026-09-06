#!/usr/bin/env node
/*
 * wfp-render GUI — Filmora .wfpbundle → MP4 renderer with a local web UI.
 *
 * Double-click the exe: it starts a local server, opens your browser,
 * and you drag & drop a .wfpbundle onto a clean white page. Rendering
 * runs in this process with real ffmpeg (GPU encoder autodetected),
 * streaming upload (memory-light random-access parsing), parallel
 * segment encoding, and live visual progress.
 *
 * Hidden CLI (for testing): wfp-render.exe --cli <bundle> [w h fps limit]
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync, execFile } = require("child_process");
const net = require("net");

/* ============================ utilities ============================ */
function human(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  return (n / 1e3).toFixed(0) + " KB";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appDir() {
  const base = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "wfp-render")
    : path.join(os.homedir(), ".cache", "wfp-render");
  fs.mkdirSync(base, { recursive: true });
  return base;
}
function uploadsDir() {
  const d = path.join(appDir(), "uploads");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function outRoot() {
  const vids = path.join(os.homedir(), "Videos");
  const d = fs.existsSync(vids) ? path.join(vids, "wfp-render") : path.join(appDir(), "output");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* job status (polled by the UI) */
let status = {
  state: "idle", msg: "待機中", frac: 0,
  encoder: null, clips: [], outName: null, outSize: 0,
  speedX: null, etaSec: null, logTail: "",
};
function setStatus(patch) {
  Object.assign(status, patch);
  status.ts = Date.now();
}
function appendLog(line) {
  const t = "[" + new Date().toTimeString().slice(0, 8) + "] " + line;
  console.log(t);
  const tail = (status.logTail + "\n" + t).split("\n");
  while (tail.length > 40) tail.shift();
  status.logTail = tail.join("\n").trim();
}

/* ============================ ffmpeg ============================ */
async function ensureFfmpeg() {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const cached = path.join(appDir(), "ffmpeg", exe);
  if (fs.existsSync(cached)) return cached;
  const which = spawnSync(exe, ["-version"], { captureOutput: true });
  if (which.status === 0) return exe;
  appendLog("ffmpeg未検出 — 自動ダウンロード中…");
  const urls = process.platform === "win32" ? [
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip",
  ] : [];
  if (urls.length) {
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        appendLog("ffmpeg " + human(buf.length) + " 受信 — 展開中…");
        const Z = globalThis.__ZIPLITE__;
        const src = new Z.BlobSource([new Blob([buf])]);
        const entries = await Z.openZip(src);
        const name = [...entries.keys()].find((n) => n.endsWith("/bin/" + exe) || n === "bin/" + exe);
        if (!name) throw new Error("archive lacks ffmpeg");
        const out = await Z.extractEntry(src, entries, name);
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        fs.writeFileSync(cached, Buffer.from(await out.arrayBuffer()));
        fs.chmodSync(cached, 0o755);
        const chk = spawnSync(cached, ["-version"], { captureOutput: true });
        if (chk.status === 0) { appendLog("ffmpeg OK: " + cached); return cached; }
      } catch (e) { appendLog("DL失敗: " + e.message); }
    }
  }
  throw new Error("ffmpegが見つかりません。https://ffmpeg.org からインストールするか path を PATH に追加してください");
}

/* GPU encoder autodetect: first that passes a tiny test encode wins */
async function detectEncoder(ff) {
  const cands = [
    { name: "h264_nvenc", label: "NVIDIA GPU (NVENC)", args: ["-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0"] },
    { name: "h264_qsv", label: "Intel GPU (QSV)", args: ["-preset", "veryfast", "-global_quality", "20"] },
    { name: "h264_amf", label: "AMD GPU (AMF)", args: ["-quality", "quality", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"] },
  ];
  for (const c of cands) {
    const r = await new Promise((resolve) => {
      const p = spawn(ff, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=128x72:d=0.2:r=30",
        "-c:v", c.name, ...c.args, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0 && !/error|failed|no capable|not support/i.test(err)));
    });
    if (r) { appendLog("エンコーダー: " + c.label + " (" + c.name + ")"); return { ...c, hw: true }; }
  }
  appendLog("エンコーダー: CPU (libx264 veryfast)");
  return { name: "libx264", label: "CPU (libx264)", args: ["-preset", "veryfast", "-crf", "19"], hw: false };
}

function encArgsFor(enc, w, h, fps) {
  const big = w * h > 1920 * 1080;
  const kbps = big ? (fps > 60 ? 90000 : 55000) : (w >= 1920 ? (fps > 60 ? 22000 : 14000) : 9000);
  if (enc.name === "libx264") return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-maxrate", String(kbps), "-bufsize", String(kbps * 2)];
  const extra = enc.name === "h264_nvenc"
    ? ["-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-maxrate", String(kbps), "-bufsize", String(kbps * 2)]
    : enc.name === "h264_qsv"
      ? ["-preset", "veryfast", "-global_quality", "20", "-maxrate", String(kbps)]
      : ["-quality", "quality", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"];
  return ["-c:v", enc.name, ...extra];
}

/* ============================ zip / project ============================ */
class FileSource {
  /* random-access file source for ziplite (memory-light) */
  constructor(filePath) {
    this.fd = fs.openSync(filePath, "r");
    this.length = fs.fstatSync(this.fd).size;
  }
  async read(off, len) {
    if (off < 0 || len < 0 || off + len > this.length) throw new Error("read out of range");
    const chunks = [];
    let got = 0;
    while (got < len) {
      const buf = Buffer.alloc(Math.min(8 * 1024 * 1024, len - got));
      const n = fs.readSync(this.fd, buf, 0, buf.length, off + got);
      if (n <= 0) break;
      chunks.push(buf.subarray(0, n));
      got += n;
    }
    return new Blob(chunks);
  }
  close() { try { fs.closeSync(this.fd); } catch (e) {} }
}

async function parseProject(bundlePath) {
  const Z = globalThis.__ZIPLITE__;
  const src = new FileSource(bundlePath);
  const entries = await Z.openZip(src);
  const wfpName = [...entries.keys()].find((n) => n.toLowerCase().endsWith(".wfp"));
  if (!wfpName) { src.close(); throw new Error(".wfp プロジェクトが見つかりません（Filmora の .wfpbundle を指定してください）"); }
  const wfpBlob = await Z.extractEntry(src, entries, wfpName);
  const wsrc = new Z.BlobSource([wfpBlob]);
  const wentries = await Z.openZip(wsrc);
  const td = new TextDecoder();
  const pinfo = JSON.parse(td.decode(await (await Z.extractEntry(wsrc, wentries, "ProjectFolder/project_info.json")).arrayBuffer()));
  const mediaMap = Z.mediaMapFromEntries([...entries.keys(), ...[...wentries.keys()].map((n) => n.replace(/^ProjectFolder\//, ""))]);
  const tl = JSON.parse(td.decode(await (await Z.extractEntry(wsrc, wentries, "ProjectFolder/Medias/" + pinfo.timeline_mediaId + "/timeline.wesproj")).arrayBuffer()));
  const parsed = Z.parseTimeline(tl, mediaMap);
  return { src, entries, pinfo, mediaMap, parsed };
}

/* ============================ render pipeline ============================ */
function runFfmpeg(ff, args, onTime) {
  return new Promise((resolve) => {
    const p = spawn(ff, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    p.stderr.on("data", (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      if (onTime) {
        const ms = s.match(/time=(\d+):(\d+):([\d.]+)/g);
        if (ms && ms.length) {
          const last = ms[ms.length - 1].split("=");
          const parts = last[1].split(":");
          onTime(+parts[0] * 3600 + +parts[1] * 60 + +parts[2]);
        }
      }
    });
    p.on("error", (e) => resolve({ code: 1, tail: String(e) }));
    p.on("close", (code) => resolve({ code, tail }));
  });
}

async function extractMedia(ff, ctx) {
  const Z = globalThis.__ZIPLITE__;
  const guids = new Set([...ctx.parsed.videoClips, ...ctx.parsed.audioClips].map((c) => c.guid));
  const map = new Map();
  let i = 0;
  const mediaDir = path.join(ctx.outDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const g of guids) {
    const m = ctx.mediaMap.get(g);
    if (!m) continue;
    const dest = path.join(mediaDir, g + "_" + m.name.replace(/[^\w.\-]+/g, "_"));
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      const blob = await Z.extractEntry(ctx.src, ctx.entries, m.entry);
      const w = fs.openSync(dest, "w");
      const ab = await blob.arrayBuffer();
      fs.writeSync(w, Buffer.from(ab));
      fs.closeSync(w);
    }
    map.set(g, dest);
    i++;
    setStatus({ msg: "素材展開 " + i + "/" + guids.size, frac: 0.02 + 0.06 * (i / guids.size) });
  }
  return map;
}

async function hasAudio(ff, file) {
  const r = await new Promise((res) => {
    execFile(ff, ["-hide_banner", "-i", file], { timeout: 30000, maxBuffer: 1024 * 1024 }, (e, so, se) => res(se || ""));
  });
  return /Audio:/.test(r);
}

async function renderJob(opt) {
  const { bundlePath, w, h, fps, ff, limit } = opt;
  const t0 = Date.now();
  setStatus({ state: "parsing", msg: "プロジェクト解析中…", frac: 0.01, clips: [], outName: null, outSize: 0 });
  const proj = await parseProject(bundlePath);
  const { pinfo, parsed } = proj;
  if (limit) parsed.videoClips = parsed.videoClips.slice(0, limit);
  appendLog("プロジェクト: " + pinfo.project_file_name + " / クリップ" + parsed.videoClips.length + " / " + parsed.duration.toFixed(1) + "s");

  const enc = await detectEncoder(ff);
  setStatus({ encoder: enc.label });

  const stamp = w + "x" + h + "@" + fps;
  const outDir = path.join(outRoot(), stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = { src: proj.src, entries: proj.entries, pinfo, parsed, mediaMap: proj.mediaMap, outDir };
  const logf = fs.openSync(path.join(outDir, "render.log"), "a");
  const logLn = (s) => { fs.writeSync(logf, s + "\n"); appendLog(s); };

  try {
    setStatus({ state: "extract", msg: "素材を展開中…", frac: 0.02 });
    const mediaMap = await extractMedia(ff, ctx);

    const clips = parsed.videoClips;
    setStatus({
      state: "render", msg: "映像レンダリング…", frac: 0.08,
      clips: clips.map((c, i) => ({ i, name: c.mediaName, state: "pending", frac: 0 })),
    });
    const clipState = (i, patch) => {
      status.clips[i] = Object.assign({}, status.clips[i], patch);
    };

    const pool = enc.hw ? 3 : 2;
    let encBroken = false; // HW encoder died mid-render -> fall back to CPU
    let idx = 0;
    const vf = "scale=" + w + ":" + h + ":force_original_aspect_ratio=decrease:flags=lanczos,pad=" + w + ":" + h + ":(ow-iw)/2:(oh-ih)/2,fps=" + fps;
    let encodedSec = 0, wall0 = Date.now();

    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= clips.length) return;
        const c = clips[i];
        const seg = path.join(outDir, "seg" + String(i).padStart(3, "0") + ".mp4");
        const dur = c.tlend - c.tl;
        clipState(i, { state: "run", frac: 0 });
        const useEnc = (encBroken || !enc.hw) && enc.name !== "libx264"
          ? { name: "libx264", label: "CPU (libx264)", args: [], hw: false } : enc;
        if (!(fs.existsSync(seg) && fs.statSync(seg).size > 0)) {
          for (const tryEnc of [useEnc, { name: "libx264", hw: false }]) {
            const tmp = seg + ".tmp.mp4";
            const r = await runFfmpeg(ff, [
              "-hide_banner", "-y",
              "-ss", c.in.toFixed(3), "-t", (c.out - c.in).toFixed(3), "-i", mediaMap.get(c.guid),
              "-map", "0:v:0", "-map", "0:a:0?",
              "-vf", vf, ...encArgsFor(tryEnc, w, h, fps),
              "-pix_fmt", "yuv420p",
              "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
              "-t", dur.toFixed(3), tmp,
            ], (sec) => {
              clipState(i, { frac: Math.min(1, sec / dur) });
              const done = status.clips.reduce((a, x) => a + (x.state === "done" ? 1 : x.frac), 0);
              setStatus({
                frac: 0.08 + 0.72 * (done / clips.length),
                msg: "映像 " + Math.round(done) + "/" + clips.length + " クリップ",
                speedX: (Date.now() - wall0) > 0 ? +((encodedSec + done) / ((Date.now() - wall0) / 1000) / Math.max(1, pool)).toFixed(2) : null,
              });
            });
            if (r.code === 0) {
              fs.renameSync(tmp, seg);
              if (tryEnc !== enc && tryEnc.name === "libx264" && enc.hw && !encBroken) {
                encBroken = true;
                logLn("⚠ " + enc.name + " が失敗 — 以降 CPU (libx264) に切替");
              }
              break;
            }
            try { fs.unlinkSync(tmp); } catch (e) {}
            logLn("セグメント" + (i + 1) + " 失敗(" + tryEnc.name + "): " + r.tail.split("\n").slice(-2).join(" "));
            if (tryEnc.name === "libx264") throw new Error("セグメント" + (i + 1) + " のエンコードに失敗");
          }
        }
        clipState(i, { state: "done", frac: 1 });
        setStatus({ msg: "映像 " + (i + 1) + "/" + clips.length + " クリップ完了" });
      }
    }
    await Promise.all(Array.from({ length: Math.min(pool, clips.length) }, worker));

    setStatus({ state: "concat", msg: "映像を連結中…", frac: 0.82 });
    const listFile = path.join(outDir, "list.txt");
    fs.writeFileSync(listFile, clips.map((_, i) => "file '" + path.join(outDir, "seg" + String(i).padStart(3, "0") + ".mp4") + "'").join("\n"));
    let r = await runFfmpeg(ff, ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", path.join(outDir, "video.mp4")]);
    if (r.code !== 0) throw new Error("連結失敗: " + r.tail.slice(-200));

    setStatus({ state: "audio", msg: "音声ミックス中…", frac: 0.88 });
    const safe = (pinfo.project_file_name || "output").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/[. ]+$/, "").slice(0, 60) || "output";
    const outFile = path.join(outRoot(), safe + "_" + stamp + ".mp4");
    const audioInputs = [];
    for (const c of parsed.audioClips) {
      const f = mediaMap.get(c.guid);
      if (!f) continue;
      if (/\.(mp4|mov|mkv|webm)$/i.test(f) && !(await hasAudio(ff, f))) continue;
      audioInputs.push({ c, f });
    }
    if (audioInputs.length) {
      const args = ["-hide_banner", "-y"];
      const fc = [];
      audioInputs.forEach((ai, k) => {
        args.push("-i", ai.f);
        const delay = Math.round(Math.max(0, ai.c.tl) * 1000);
        fc.push("[" + k + ":a]atrim=start=" + ai.c.in.toFixed(3) + ":end=" + ai.c.out.toFixed(3) +
          ",asetpts=PTS-STARTPTS,adelay=" + delay + "|" + delay + "[a" + k + "]");
      });
      fc.push(audioInputs.map((_, k) => "[a" + k + "]").join("") +
        "amix=inputs=" + audioInputs.length + ":normalize=0:dropout_transition=0,alimiter=limit=0.95," +
        "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]");
      const audioFile = path.join(outDir, "audio.m4a");
      r = await runFfmpeg(ff, args.concat(["-filter_complex", fc.join(";"), "-map", "[aout]", "-c:a", "aac", "-b:a", "256k",
        "-t", (parsed.duration + 0.5).toFixed(3), audioFile]));
      if (r.code !== 0) throw new Error("音声ミックス失敗: " + r.tail.slice(-200));
      setStatus({ state: "mux", msg: "最終書き出し中…", frac: 0.96 });
      r = await runFfmpeg(ff, ["-hide_banner", "-y", "-i", path.join(outDir, "video.mp4"), "-i", audioFile,
        "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", "-shortest", outFile]);
    } else {
      r = await runFfmpeg(ff, ["-hide_banner", "-y", "-i", path.join(outDir, "video.mp4"), "-c", "copy", "-movflags", "+faststart", outFile]);
    }
    if (r.code !== 0) throw new Error("書き出し失敗: " + r.tail.slice(-200));

    const min = (Date.now() - t0) / 60000;
    setStatus({
      state: "done", frac: 1, msg: "完了！ " + human(fs.statSync(outFile).size) + " / " + min.toFixed(1) + "分",
      outName: outFile, outSize: fs.statSync(outFile).size, etaSec: 0,
    });
    appendLog("✅ 完了: " + outFile + " (" + min.toFixed(1) + "分)");
  } catch (e) {
    setStatus({ state: "error", msg: String(e.message || e) });
    appendLog("❌ " + (e.message || e));
  } finally {
    try { fs.closeSync(logf); } catch (e) {}
    try { proj.src.close(); } catch (e) {}
  }
}

/* ============================ web UI ============================ */
const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>wfp render</title><style>' +
'*{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font-family:system-ui,-apple-system,"Segoe UI",Meiryo,sans-serif;line-height:1.7}' +
'.wrap{max-width:760px;margin:0 auto;padding:28px 18px 100px}h1{font-size:22px;margin:6px 0 2px}.sub{color:#666;font-size:13px;margin:0 0 22px}' +
'.card{border:1px solid #e5e5e5;border-radius:14px;padding:20px;margin-bottom:16px}' +
'#drop{border:2px dashed #bbb;border-radius:14px;padding:44px 16px;text-align:center;color:#888;cursor:pointer;transition:.15s}' +
'#drop.drag{border-color:#1a73e8;background:#f5f9ff}' +
'#drop.has{border-style:solid;border-color:#34a853;color:#111}' +
'#drop b{color:#111}button{background:#1a73e8;color:#fff;border:none;border-radius:10px;padding:14px 22px;font-size:15px;font-weight:600;cursor:pointer}' +
'button.green{background:#188038}button:disabled{opacity:.4;cursor:not-allowed}' +
'.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;align-items:center}' +
'select{font-size:15px;padding:10px;border:1px solid #ccc;border-radius:8px;background:#fff}' +
'.bar{height:12px;background:#f1f1f1;border-radius:8px;overflow:hidden;margin:14px 0 6px}.bar>div{height:100%;width:0;background:#1a73e8;transition:width .3s}' +
'.st{font-size:14px;color:#444}.st b{color:#111}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}' +
'.chip{font-size:11px;border-radius:6px;padding:3px 8px;border:1px solid #e0e0e0;color:#999;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.chip.run{border-color:#1a73e8;color:#1a73e8;background:#f5f9ff}.chip.done{border-color:#34a853;color:#188038;background:#f2faf4}' +
'.chip.err{border-color:#d93025;color:#d93025;background:#fdf3f2}' +
'video{width:100%;border-radius:12px;background:#000;margin-top:8px}' +
'details{margin-top:10px}pre{background:#fafafa;border:1px solid #eee;border-radius:8px;padding:10px;font-size:11px;max-height:160px;overflow:auto;white-space:pre-wrap;color:#555}' +
'.badge{display:inline-block;font-size:12px;border-radius:99px;padding:2px 10px;border:1px solid #e0e0e0;color:#555;margin-left:8px}' +
'.hidden{display:none}.err{color:#d93025}</style></head><body><div class="wrap">' +
'<h1>wfp render<span class="badge" id="encBadge">エンコーダー判定中…</span></h1>' +
'<p class="sub">Filmora の .wfpbundle をドラッグ＆ドロップするだけ。処理はすべてこのPC内で完結します。</p>' +
'<div class="card"><div id="drop"><span id="dropTxt"><b>ここに .wfpbundle をドロップ</b><br>またはクリックしてファイルを選択</span><input type="file" id="file" accept=".wfpbundle,.wfp,.zip" hidden></div>' +
'<div class="row"><label>解像度 <select id="res"><option value="3840x2160">4K</option><option value="1920x1080" selected>1080p</option><option value="1280x720">720p</option></select></label>' +
'<label>fps <select id="fps"><option value="120">120</option><option value="60" selected>60</option></select></label>' +
'<button id="go" class="green" disabled style="margin-left:auto">書き出し開始</button></div>' +
'<div class="st" id="projInfo" style="margin-top:10px"></div></div>' +
'<div class="card hidden" id="progCard"><div class="bar"><div id="bar"></div></div><div class="st" id="msg">準備中…</div>' +
'<div class="st" id="meta" style="margin-top:4px"></div><div class="chips" id="chips"></div>' +
'<details><summary>詳細ログ</summary><pre id="log"></pre></details></div>' +
'<div class="card hidden" id="doneCard"><h2 style="font-size:16px;margin:0 0 6px">✅ 完成</h2><div class="st" id="doneMsg"></div>' +
'<video id="player" controls playsinline preload="metadata"></video>' +
'<div class="row"><a id="dlA" href="#" style="text-decoration:none"><button class="green">⬇ 保存（ダウンロード）</button></a>' +
'<button id="openDir">📁 保存フォルダを開く</button></div></div>' +
'<p class="sub" style="margin-top:18px">再現: カット編集（トリミング・並び）＋音声ミックス（BGM＋クリップ音）。Filmora独自エフェクト・テキスト等は非対応。<br>GPU (NVIDIA/Intel/AMD) があれば自動でハードウェアエンコードを使用します。</p>' +
'</div><script>' +
'(function(){' +
'var drop=document.getElementById("drop"),file=document.getElementById("file"),dropTxt=document.getElementById("dropTxt");' +
'var go=document.getElementById("go"),res=document.getElementById("res"),fps=document.getElementById("fps");' +
'var projInfo=document.getElementById("projInfo"),progCard=document.getElementById("progCard");' +
'var bar=document.getElementById("bar"),msg=document.getElementById("msg"),metaEl=document.getElementById("meta"),chips=document.getElementById("chips"),logEl=document.getElementById("log");' +
'var doneCard=document.getElementById("doneCard"),player=document.getElementById("player"),doneMsg=document.getElementById("doneMsg"),dlA=document.getElementById("dlA");' +
'var uploaded=null,poll=null;' +
'drop.addEventListener("click",function(){file.click();});' +
'drop.addEventListener("dragover",function(e){e.preventDefault();drop.classList.add("drag");});' +
'drop.addEventListener("dragleave",function(){drop.classList.remove("drag");});' +
'drop.addEventListener("drop",function(e){e.preventDefault();drop.classList.remove("drag");if(e.dataTransfer.files.length)up(e.dataTransfer.files[0]);});' +
'file.addEventListener("change",function(){if(file.files.length)up(file.files[0]);file.value="";});' +
'function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;"})[c];});}' +
'function fmt(n){return n>=1048576?(n/1048576).toFixed(1)+" MB":(n/1024).toFixed(0)+" KB";}' +
'async function up(f){' +
' dropTxt.innerHTML="<b>"+esc(f.name)+"</b><br>"+fmt(f.size)+" をアップロード中…";' +
' var xhr=new XMLHttpRequest();xhr.open("POST","/api/upload?name="+encodeURIComponent(f.name));' +
' xhr.upload.onprogress=function(e){dropTxt.innerHTML="<b>"+esc(f.name)+"</b><br>アップロード "+Math.round(e.loaded/e.total*100)+"%";};' +
' xhr.onload=function(){try{var j=JSON.parse(xhr.responseText);if(j.ok){uploaded=j.path;dropTxt.innerHTML="<b>"+esc(f.name)+"</b><br>✅ 読み込み完了 — 設定して「書き出し開始」";drop.classList.add("has");go.disabled=false;loadProj(j.path);}else{dropTxt.textContent="❌ "+j.error;}}catch(e){dropTxt.textContent="❌ アップロード失敗";}};' +
' xhr.onerror=function(){dropTxt.textContent="❌ アップロード失敗";};' +
' xhr.send(f);}' +
'async function loadProj(p){var r=await fetch("/api/project?path="+encodeURIComponent(p));var j=await r.json();' +
' if(j.ok){projInfo.innerHTML="プロジェクト: <b>"+esc(j.project.name)+"</b> ／ 長さ <b>"+j.project.dur.toFixed(1)+"s</b> ／ 映像クリップ <b>"+j.project.clips+"</b> ／ 音声 <b>"+j.project.audio+"</b>";}}' +
'go.addEventListener("click",async function(){if(!uploaded)return;go.disabled=true;doneCard.classList.add("hidden");progCard.classList.remove("hidden");' +
' var parts=res.value.split("x");var body=JSON.stringify({path:uploaded,w:+parts[0],h:+parts[1],fps:+fps.value});' +
' var r=await fetch("/api/render",{method:"POST",headers:{"Content-Type":"application/json"},body:body});' +
' var j=await r.json();if(!j.ok&&j.error){msg.innerHTML="❌ "+esc(j.error);go.disabled=false;return;}startPoll();});' +
'function startPoll(){if(poll)clearInterval(poll);poll=setInterval(async function(){' +
' try{var j=await(await fetch("/api/status")).json();}catch(e){return;}' +
' bar.style.width=(j.frac*100).toFixed(1)+"%";' +
' msg.innerHTML=esc(j.msg||"");' +
' var m="";if(j.encoder)m+="エンコーダー: <b>"+esc(j.encoder)+"</b> ";if(j.etaSec>1)m+="残り約"+Math.ceil(j.etaSec/60)+"分";' +
' metaEl.innerHTML=m;' +
' if(j.clips&&j.clips.length){var h2="";for(var i=0;i<j.clips.length;i++){var c=j.clips[i];' +
' h2+="<span class=\\"chip "+c.state+"\\" title=\\""+esc(c.name)+"\\">"+(c.i+1)+(c.state==="done"?"✓":c.state==="run"?" ▶":"")+"</span>";}chips.innerHTML=h2;}' +
' logEl.textContent=j.logTail||"";' +
' document.getElementById("encBadge").textContent=j.encoder?("使用: "+j.encoder):"エンコーダー判定中…";' +
' if(j.state==="done"){clearInterval(poll);poll=null;doneCard.classList.remove("hidden");' +
' doneMsg.textContent=j.msg;player.src="/api/stream?nocache="+Date.now();dlA.href="/api/file";go.disabled=false;}' +
' if(j.state==="error"){clearInterval(poll);poll=null;msg.innerHTML="<span class=err>❌ "+esc(j.msg)+"</span>";go.disabled=false;}' +
'},700);}' +
'document.getElementById("openDir").addEventListener("click",function(){fetch("/api/open",{method:"POST"});});' +
'})();</script></body></html>';

/* ============================ server ============================ */
function serveMp4(req, res, file, download) {
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
  if (download) headers["Content-Disposition"] = 'attachment; filename="' + path.basename(file).replace(/[^\x20-\x7E]/g, "_") + '"; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(file));
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size) { res.writeHead(416, { "Content-Range": "bytes */" + size }); res.end(); return; }
    end = Math.min(end, size - 1);
    res.writeHead(206, Object.assign(headers, {
      "Content-Length": end - start + 1,
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
    }));
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, Object.assign(headers, { "Content-Length": size }));
    fs.createReadStream(file).pipe(res);
  }
}

function startServer(opts) {
  let jobRunning = false;
  let lastOut = null;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };

    if (p === "/" ) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (p === "/api/upload" && req.method === "POST") {
      const name = (u.searchParams.get("name") || "bundle.wfpbundle").replace(/[\/\\]/g, "_");
      const dest = path.join(uploadsDir(), Date.now() + "_" + name);
      const w = fs.createWriteStream(dest);
      req.on("data", (c) => w.write(c));
      req.on("end", () => w.end(() => json(200, { ok: true, path: dest, size: fs.statSync(dest).size })));
      req.on("error", () => json(500, { ok: false, error: "upload failed" }));
      return;
    }
    if (p === "/api/project") {
      (async () => {
        try {
          const proj = await parseProject(u.searchParams.get("path"));
          const info = {
            ok: true, project: {
              name: proj.pinfo.project_file_name,
              dur: proj.parsed.duration,
              clips: proj.parsed.videoClips.length,
              audio: proj.parsed.audioClips.length,
            },
          };
          proj.src.close();
          json(200, info);
        } catch (e) { json(500, { ok: false, error: String(e.message || e) }); }
      })();
      return;
    }
    if (p === "/api/render" && req.method === "POST") {
      (async () => {
        try {
          const body = JSON.parse(await new Promise((resolve) => {
            let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b));
          }));
          if (jobRunning && status.state !== "done" && status.state !== "error") { json(409, { ok: false, error: "レンダー中です" }); return; }
          const ff = await ensureFfmpeg();
          jobRunning = true;
          renderJob({ bundlePath: body.path, w: body.w, h: body.h, fps: body.fps, ff }).then(() => {
            jobRunning = false;
            lastOut = status.outName;
          });
          json(200, { ok: true });
        } catch (e) { json(500, { ok: false, error: String(e.message || e) }); }
      })();
      return;
    }
    if (p === "/api/status") { json(200, Object.assign({ ok: true }, status)); return; }
    if (p === "/api/stream" || p === "/api/file") {
      const f = status.outName || lastOut;
      if (!f || !fs.existsSync(f)) { json(404, { ok: false, error: "not rendered" }); return; }
      serveMp4(req, res, f, p === "/api/file");
      return;
    }
    if (p === "/api/open" && req.method === "POST") {
      const dir = status.outName ? path.dirname(status.outName) : outRoot();
      json(200, { ok: openLocal(dir) });
      return;
    }
    json(404, { ok: false, error: "not found" });
  });

  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const url = "http://127.0.0.1:" + port;
    appendLog("GUI起動: " + url);
    if (!opts.noOpen) openLocal(url);
    console.log("wfp-render GUI: " + url + "  (Ctrl+C で終了)");
  });
}

/* Open a path/URL with the OS default app; never throws (missing opener must not kill the server). */
function openLocal(target) {
  try {
    const cmds =
      process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] :
      process.platform === "darwin" ? ["open", [target]] :
      ["xdg-open", [target]];
    const child = spawn(cmds[0], cmds[1], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // swallow async ENOENT too
    child.unref();
    return true;
  } catch (e) { appendLog("open失敗: " + e.message); return false; }
}

/* ============================ main ============================ */
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--cli") {
    // headless test path: --cli <bundle> [w h fps limit]
    const bundle = args[1];
    const w = args[2] ? parseInt(args[2], 10) : 1280;
    const h = args[3] ? parseInt(args[3], 10) : 720;
    const fps = args[4] ? parseInt(args[4], 10) : 60;
    const limit = args[5] ? parseInt(args[5], 10) : 0;
    const ff = await ensureFfmpeg();
    console.log("[cli] ffmpeg:", ff);
    await new Promise((resolve) => {
      renderJob({ bundlePath: bundle, w, h, fps, ff, limit });
      const iv = setInterval(() => {
        console.log("[cli]", status.state, (status.frac * 100).toFixed(1) + "%", status.msg || "");
        if (status.state === "done" || status.state === "error") { clearInterval(iv); resolve(); }
      }, 1000);
    });
    process.exit(status.state === "done" ? 0 : 1);
  }
  const noOpen = args.includes("--no-open");
  startServer({ noOpen });
  // keep process alive
  setInterval(() => {}, 1 << 30);
}
main().catch((e) => { console.error(e); process.exit(1); });
