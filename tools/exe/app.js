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
  return { src, entries, pinfo, mediaMap, parsed, rawTl: tl };
}

/* ============== WFP deep features: layers / filters / transitions ============== */
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
const VID_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|ts|3gp)$/i;

function fxParam(e, name) {
  const p = (e.paramList || []).find((x) => x.name === name);
  return p ? p.fxParam.unValue : null;
}

/* position/scale of a clip (Filmora transform effect; 0.5=center, 100=fit) */
function clipTransform(c) {
  for (const ch of c.effectChainList || []) {
    for (const e of ch.effectList || []) {
      if (e.id !== "video/effect/transform") continue;
      if (fxParam(e, "EnableTransform") === 0) return null;
      const px = fxParam(e, "Position_x"), py = fxParam(e, "Position_y");
      const sx = fxParam(e, "Scale_x"), sy = fxParam(e, "Scale_y");
      if ((px != null && Math.abs(px - 0.5) > 1e-4) || (py != null && Math.abs(py - 0.5) > 1e-4) ||
          (sx != null && Math.abs(sx - 100) > 1e-4) || (sy != null && Math.abs(sy - 100) > 1e-4)) {
        return { px: px == null ? 0.5 : px, py: py == null ? 0.5 : py, sx: sx == null ? 100 : sx, sy: sy == null ? 100 : sy };
      }
    }
  }
  return null;
}

/* the Filmora stock effect (GUID id) carried by a clip, if any */
function stockEffectOf(c) {
  for (const ch of c.effectChainList || []) {
    for (const e of ch.effectList || []) {
      if (/^(video|audio)\/effect\//.test(e.id)) continue;
      return e.display || e.id;
    }
  }
  return null;
}

/* Filmora filter name -> ffmpeg filter chain (visual approximation) */
function filmoraFilterChain(name, W, H) {
  const n = String(name);
  if (/fashion photography/i.test(n)) return ["eq=contrast=1.12:saturation=1.18", "colorbalance=rs=-0.05:bs=0.06:rh=0.04:bh=-0.05"];
  if (/retro/i.test(n)) return ["eq=contrast=1.06:saturation=0.85:gamma=0.98", "colorbalance=rm=0.03:gm=0.01:bm=-0.04", "vignette=PI/5", "noise=alls=8:allf=t"];
  if (/old\s*video/i.test(n)) return ["eq=saturation=0.55:contrast=1.10", "vignette=PI/4", "noise=alls=18:allf=t"];
  if (/extreme/i.test(n)) return ["eq=contrast=1.22:saturation=1.35", "vignette=PI/5"];
  if (/mild/i.test(n)) return ["eq=contrast=1.04:saturation=1.06"];
  if (/neon|neno/i.test(n)) return ["eq=saturation=1.45:contrast=1.10", "unsharp=5:5:1.2"];
  if (/chaos\s*2/i.test(n)) return ["rgbashift=rh=-5:bh=5", "eq=contrast=1.12:saturation=1.15", "noise=alls=12:allf=t"];
  if (/chaos\s*1/i.test(n)) return ["rgbashift=rh=-3:bh=3", "eq=contrast=1.08:saturation=1.10", "noise=alls=8:allf=t"];
  if (/cinema\s*21/i.test(n)) {
    const bar = Math.round((H - Math.round(W / 2.39)) / 2);
    return bar > 4 ? ["drawbox=x=0:y=0:w=" + W + ":h=" + bar + ":color=black:t=fill",
      "drawbox=x=0:y=" + (H - bar) + ":w=" + W + ":h=" + bar + ":color=black:t=fill"] : [];
  }
  if (/horror/i.test(n)) return ["eq=contrast=1.15:brightness=-0.03:saturation=0.85", "colorbalance=rm=0.05:bm=0.03", "vignette=PI/3", "noise=alls=14:allf=t"];
  if (/halloween/i.test(n)) return ["colorbalance=rm=0.06:bm=0.08", "eq=saturation=1.25:contrast=1.10", "noise=alls=10:allf=t"];
  if (/glitter|overlay/i.test(n)) return ["eq=saturation=1.15:contrast=1.06", "unsharp=5:5:0.8"];
  if (/up-?down|swing|bounce/i.test(n)) return ["eq=contrast=1.03:saturation=1.04"];
  return ["eq=contrast=1.05:saturation=1.08"];
}

function xfadeKind(name) {
  const n = String(name);
  if (/wipe.*right/i.test(n)) return "wiperight";
  if (/glitch\s*intro/i.test(n)) return "hblur";
  if (/glitch/i.test(n)) return "pixelize";
  if (/zoom/i.test(n)) return "zoomin";
  if (/roll/i.test(n)) return "slideleft";
  return "fade";
}

/* full timeline decode: base layer, image/video overlays, filter events, transitions */
function deepParse(tl, mediaByGuid) {
  const Z = globalThis.__ZIPLITE__;
  const T = 1e7;
  const info = tl.timelineInfos[0];
  const vTracks = info.trackInfos
    .filter((tr) => tr.trackType === 1)
    .sort((a, b) => (a.trackTag == null ? 0 : a.trackTag) - (b.trackTag == null ? 0 : b.trackTag));
  const mediaOf = (c) => { const g = Z.guidOf(c); return g ? mediaByGuid.get(g) : null; };
  const isMedia = (c) => c.type === 1 && (() => { const m = mediaOf(c); return !!m && (VID_EXT.test(m.name) || IMG_EXT.test(m.name)); })();
  let baseTag = null;
  for (const tr of vTracks) {
    if ((tr.clipList || []).some(isMedia)) { baseTag = tr.trackTag == null ? 0 : tr.trackTag; break; }
  }
  const base = [], overlays = [], filterEvents = [], transitions = [], audioFades = [];
  for (const tr of vTracks) {
    const tag = tr.trackTag == null ? 0 : tr.trackTag;
    for (const c of tr.clipList || []) {
      if (isMedia(c) && tag === baseTag) {
        base.push({ name: mediaOf(c).name, guid: Z.guidOf(c), in: c.inPoint / T, out: c.outPoint / T,
          tl0: c.tlBegin / T, tl1: c.tlEnd / T, transform: clipTransform(c), pt: c.postTransition || null });
        const de0 = stockEffectOf(c);
        if (de0) filterEvents.push({ tl0: c.tlBegin / T, tl1: c.tlEnd / T, tag: baseTag, name: de0 });
      } else if (isMedia(c)) {
        overlays.push({ name: mediaOf(c).name, guid: Z.guidOf(c), in: c.inPoint / T, out: c.outPoint / T,
          tl0: c.tlBegin / T, tl1: c.tlEnd / T, transform: clipTransform(c), tag });
        const de = stockEffectOf(c);
        if (de) filterEvents.push({ tl0: c.tlBegin / T, tl1: c.tlEnd / T, tag: tag + 0.5, name: de });
      } else if (c.type === 8) {
        const de = stockEffectOf(c);
        if (de) filterEvents.push({ tl0: c.tlBegin / T, tl1: c.tlEnd / T, tag, name: de });
      } else if (c.type === 1) {
        const de = stockEffectOf(c);
        if (de) filterEvents.push({ tl0: c.tlBegin / T, tl1: c.tlEnd / T, tag: baseTag == null ? tag : baseTag, name: de });
      }
    }
  }
  base.sort((a, b) => a.tl0 - b.tl0);
  for (const b of base) {
    const pt = b.pt;
    if (pt && pt.tlEnd > pt.tlBegin && !/audio fade/i.test(String(pt.display))) {
      transitions.push({ t0: pt.tlBegin / T, t1: pt.tlEnd / T, cut: (pt.tlBegin + pt.tlEnd) / (2 * T),
        kind: xfadeKind(pt.display), name: String(pt.display) });
    }
  }
  for (const tr of info.trackInfos) {
    if (tr.trackType !== 2) continue;
    for (const c of tr.clipList || []) {
      const pt = c.postTransition;
      if (pt && /audio fade/i.test(String(pt.display))) {
        audioFades.push({ t0: pt.tlBegin / T, t1: pt.tlEnd / T, cut: (pt.tlBegin + pt.tlEnd) / (2 * T) });
      }
    }
  }
  let dur = base.reduce((m, b) => Math.max(m, b.tl1), 0);
  for (const t of transitions) dur = Math.max(dur, t.t1);
  base.forEach((b) => { delete b.pt; });
  overlays.sort((a, b) => a.tl0 - b.tl0);
  filterEvents.sort((a, b) => a.tl0 - b.tl0);
  return {
    fps: info.frameRate.num / Math.max(1, info.frameRate.den),
    W: info.resolutionWidth, H: info.resolutionHeight, dur,
    base, overlays, filterEvents, transitions, audioFades,
  };
}

/* split timeline into atomic segments at every event edge */
function buildSegments(dp) {
  const eps = 1e-4;
  const edges = new Set([0, dp.dur]);
  for (const b of dp.base) { edges.add(b.tl0); edges.add(b.tl1); }
  for (const o of dp.overlays) { edges.add(o.tl0); edges.add(o.tl1); }
  for (const f of dp.filterEvents) { edges.add(f.tl0); edges.add(f.tl1); }
  for (const t of dp.transitions) { edges.add(t.t0); edges.add(t.t1); }
  const es = [...edges].filter((t) => t > -eps && t <= dp.dur + eps).sort((a, b) => a - b);
  const baseAt = (t) => dp.base.find((b) => b.tl0 <= t + eps && t < b.tl1 - eps) || null;
  const segs = [];
  for (let k = 0; k < es.length - 1; k++) {
    const a = es[k], b = es[k + 1];
    if (b - a < 0.02 || a >= dp.dur - eps) continue;
    const mid = (a + b) / 2;
    const clip = baseAt(mid);
    let trans = dp.transitions.find((t) => mid > t.t0 + eps && mid < t.t1 - eps) || null;
    if (trans) trans = Object.assign({}, trans, { end: trans.t1 >= dp.dur - 0.06 });
    segs.push({
      t0: a, t1: b, clip, trans,
      ov: dp.overlays.filter((o) => o.tl0 <= mid + eps && mid < o.tl1 - eps),
      fl: dp.filterEvents.filter((f) => f.tl0 <= mid + eps && mid < f.tl1 - eps).sort((x, y) => x.tag - y.tag),
      clipIndex: clip ? dp.base.indexOf(clip) : -1,
    });
  }
  return segs;
}

const dimsCache = new Map();
function probeDims(ff, file) {
  if (dimsCache.has(file)) return dimsCache.get(file);
  return new Promise((resolve) => {
    const p = spawn(ff, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    p.stderr.on("data", (d) => { tail += d.toString(); });
    p.on("error", () => resolve(null));
    p.on("close", () => {
      const m = tail.match(/,\s(\d{2,5})x(\d{2,5})[\s,\[]/);
      const r = m ? { w: +m[1], h: +m[2] } : null;
      dimsCache.set(file, r);
      resolve(r);
    });
  });
}

/* draw box layout: contain-fit into canvas, then scale %, then anchor at position */
function pipLayout(transform, dw0, dh0, W, H) {
  const fit = Math.min(W / dw0, H / dh0);
  const sx = transform ? transform.sx / 100 : 1, sy = transform ? transform.sy / 100 : 1;
  const dw = Math.max(2, Math.round(dw0 * fit * sx));
  const dh = Math.max(2, Math.round(dh0 * fit * sy));
  const px = transform ? transform.px : 0.5, py = transform ? transform.py : 0.5;
  return { dw, dh, x: Math.round(px * W - dw / 2), y: Math.round(py * H - dh / 2) };
}

/* build ffmpeg input list + filtergraph for one segment */
function buildSegPlan(s, gx) {
  const W = gx.W, H = gx.H, fps = gx.fps, files = gx.files, dp = gx.dp;
  const dur = s.t1 - s.t0;
  const scalePad = "scale=" + W + ":" + H + ":force_original_aspect_ratio=decrease:flags=lanczos,pad=" + W + ":" + H + ":(ow-iw)/2:(oh-ih)/2,setsar=1";
  const srcAt = (clip, t) => clip.in + Math.max(0, t - clip.tl0);
  const simple = !s.trans && !s.ov.length && !s.fl.length && !(s.clip && s.clip.transform);
  if (simple && s.clip) {
    const ss = srcAt(s.clip, s.t0);
    return {
      inputs: ["-ss", ss.toFixed(3), "-t", Math.max(0.1, srcAt(s.clip, s.t1) - ss).toFixed(3), "-i", files.get(s.clip.guid)],
      vf: scalePad + ",fps=" + fps, graph: null, map: null,
    };
  }
  const parts = [], inputs = [];
  let idxIn = 0;
  const addInput = (arr) => { const id = idxIn++; inputs.push(...arr); return id; };
  let cur;
  if (s.trans && !s.trans.end) {
    const tr = s.trans;
    const A = dp.base.find((b) => b.tl1 > tr.cut - 0.05 && b.tl0 < tr.cut) || s.clip;
    const B = dp.base.find((b) => b.tl0 < tr.cut + 0.05 && b.tl1 > tr.cut) || null;
    if (A && B && files.get(A.guid) && files.get(B.guid)) {
      const dA = Math.max(0.1, tr.cut - s.t0), dB = Math.max(0.1, s.t1 - tr.cut), D = dA + dB;
      const idA = addInput(["-ss", srcAt(A, s.t0).toFixed(3), "-t", dA.toFixed(3), "-i", files.get(A.guid)]);
      const idB = addInput(["-ss", srcAt(B, tr.cut).toFixed(3), "-t", dB.toFixed(3), "-i", files.get(B.guid)]);
      parts.push("[" + idA + ":v]" + scalePad + ",fps=" + fps + ",tpad=stop_mode=clone:stop_duration=" + dB.toFixed(3) + "[a0]");
      parts.push("[" + idB + ":v]" + scalePad + ",fps=" + fps + ",tpad=start_mode=clone:start_duration=" + dA.toFixed(3) + "[b0]");
      parts.push("[a0][b0]xfade=transition=" + tr.kind + ":duration=" + D.toFixed(3) + ":offset=0.0001[xf]");
      cur = "[xf]";
    } else { s.trans = Object.assign({}, s.trans, { end: true }); cur = null; }
  }
  if (!cur) {
    const c = s.clip;
    if (!c) { // gap -> black
      const idC = addInput(["-f", "lavfi", "-t", dur.toFixed(3), "-i", "color=black:s=" + W + "x" + H + ":r=" + fps]);
      parts.push("[" + idC + ":v]null[cv0]");
      cur = "[cv0]";
    } else {
      const ss0 = srcAt(c, s.t0);
      const idB0 = addInput(["-ss", ss0.toFixed(3), "-t", Math.max(0.1, srcAt(c, s.t1) - ss0).toFixed(3), "-i", files.get(c.guid)]);
      if (c.transform && gx.dims) {
        const dm = gx.dims.get(c.guid) || { w: 1920, h: 1080 };
        const L = pipLayout(c.transform, dm.w, dm.h, W, H);
        const idC = addInput(["-f", "lavfi", "-t", dur.toFixed(3), "-i", "color=black:s=" + W + "x" + H + ":r=" + fps]);
        parts.push("[" + idB0 + ":v]scale=" + L.dw + ":" + L.dh + ":flags=lanczos,setsar=1[bs]");
        parts.push("[" + idC + ":v][bs]overlay=" + L.x + ":" + L.y + "[cv0]");
        cur = "[cv0]";
      } else {
        parts.push("[" + idB0 + ":v]" + scalePad + "[cv0]");
        cur = "[cv0]";
      }
    }
  }
  let head = "";
  if (s.trans && s.trans.end) head = "fade=t=out:st=0:d=" + dur.toFixed(3) + ",";
  const steps = [];
  for (const o of s.ov) steps.push({ tag: o.tag, type: "ov", o });
  for (const f of s.fl) steps.push({ tag: f.tag, type: "fx", f });
  steps.sort((a, b) => a.tag - b.tag);
  let n = 0;
  for (const st of steps) {
    const nxt = "[c" + (++n) + "]";
    if (st.type === "ov") {
      const file = files.get(st.o.guid);
      const dm = (file && dimsCache.get(file)) || { w: 1920, h: 1080 };
      const L = pipLayout(st.o.transform, dm.w, dm.h, W, H);
      const id = addInput(["-loop", "1", "-framerate", String(fps), "-t", dur.toFixed(3), "-i", file]);
      parts.push("[" + id + ":v]scale=" + L.dw + ":" + L.dh + ":flags=lanczos,setsar=1[o" + n + "]");
      parts.push(cur + "[o" + n + "]overlay=" + L.x + ":" + L.y + nxt);
    } else {
      let chain;
      if (/heartbeat/i.test(st.f.name)) {
        // NOTE: d=1 zoompan is nondeterministic in some static builds (frame counter race); d=2 is stable.
        chain = "fps=" + fps + ",zoompan=z='1+0.045*abs(sin(2*PI*1.5*(in/" + fps + ")))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=2:s=" + W + "x" + H + ":fps=" + (fps * 2);
      } else {
        const fs2 = filmoraFilterChain(st.f.name, W, H);
        chain = fs2.length ? fs2.join(",") : "null";
      }
      parts.push(cur + chain + nxt);
    }
    cur = nxt;
  }
  parts.push(cur + head + "fps=" + fps + ",format=yuv420p[vout]");
  return { inputs, graph: parts.join(";"), map: "[vout]", vf: null };
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
  if (ctx.extraGuids) for (const g of ctx.extraGuids) guids.add(g);
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
  const { pinfo } = proj;
  const dp = deepParse(proj.rawTl, proj.mediaMap);
  if (limit) {
    const kept = dp.base.slice(0, limit);
    const endT = kept.length ? kept[kept.length - 1].tl1 : 0;
    dp.base = kept; dp.dur = endT;
    dp.overlays = dp.overlays.filter((o) => o.tl0 < endT - 0.01);
    dp.filterEvents = dp.filterEvents.filter((f) => f.tl0 < endT - 0.01);
    dp.transitions = dp.transitions.filter((t) => t.t0 < endT - 0.01);
    dp.audioFades = dp.audioFades.filter((f) => f.cut < endT);
  }
  appendLog("プロジェクト: " + pinfo.project_file_name + " / クリップ" + dp.base.length +
    " / レイヤー" + (dp.overlays.length + 1) + " / フィルター" + dp.filterEvents.length +
    " / トランジション" + dp.transitions.length + " / " + dp.dur.toFixed(1) + "s");
  if (!dp.base.length) throw new Error("映像クリップが見つかりません");

  const enc = await detectEncoder(ff);
  setStatus({ encoder: enc.label });

  const stamp = w + "x" + h + "@" + fps;
  const outDir = path.join(outRoot(), stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = {
    src: proj.src, entries: proj.entries, pinfo, parsed: proj.parsed, mediaMap: proj.mediaMap, outDir,
    extraGuids: new Set(dp.overlays.map((o) => o.guid)),
  };
  const logf = fs.openSync(path.join(outDir, "render.log"), "a");
  const logLn = (s2) => { fs.writeSync(logf, s2 + "\n"); appendLog(s2); };

  try {
    setStatus({ state: "extract", msg: "素材を展開中…", frac: 0.02 });
    const mediaMap = await extractMedia(ff, ctx);

    // probe image/base dims (needed for layered placement)
    const dims = new Map();
    for (const o of dp.overlays) {
      const f = mediaMap.get(o.guid);
      if (f && !dims.has(o.guid)) dims.set(o.guid, await probeDims(ff, f));
    }
    for (const b of dp.base) {
      if (b.transform && !dims.has(b.guid)) dims.set(b.guid, await probeDims(ff, mediaMap.get(b.guid)));
    }

    const segs = buildSegments(dp);
    logLn("セグメント: " + segs.length + "（レイヤー構成を含む全イベント境界で分割）");
    const gctx = { W: w, H: h, fps, files: mediaMap, dp, dims };

    setStatus({
      state: "render", msg: "映像レンダリング…", frac: 0.08,
      clips: dp.base.map((c, i) => ({ i, name: c.name, state: "pending", frac: 0 })),
    });
    const clipSegs = dp.base.map(() => []);
    segs.forEach((sg, i) => { if (sg.clipIndex >= 0) clipSegs[sg.clipIndex].push(i); });
    const clipLen = dp.base.map((b) => b.tl1 - b.tl0);
    const clipState = (i, patch) => { status.clips[i] = Object.assign({}, status.clips[i], patch); };
    const refreshClip = (ci) => {
      if (ci < 0) return;
      const list = clipSegs[ci];
      const f = list.reduce((a, i2) => a + (segs[i2].t1 - segs[i2].t0) * (segs[i2]._f || 0), 0) / Math.max(0.01, clipLen[ci]);
      clipState(ci, { frac: Math.min(1, f) });
    };

    const pool = enc.hw ? (enc.name === "h264_nvenc" ? 3 : 2) : 2;
    let encBroken = false; // HW encoder died mid-render -> fall back to CPU
    let idx = 0;
    const total = segs.reduce((a, x) => a + (x.t1 - x.t0), 0);
    const wall0 = Date.now();

    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= segs.length) return;
        const sg = segs[i];
        const seg = path.join(outDir, "seg" + String(i).padStart(3, "0") + ".mp4");
        const dur = sg.t1 - sg.t0;
        if (sg.clipIndex >= 0 && status.clips[sg.clipIndex]) clipState(sg.clipIndex, { state: "run" });
        const useEnc = (encBroken || !enc.hw) && enc.name !== "libx264"
          ? { name: "libx264", label: "CPU (libx264)", args: [], hw: false } : enc;
        if (!(fs.existsSync(seg) && fs.statSync(seg).size > 0)) {
          const plan = buildSegPlan(sg, gctx);
          for (const tryEnc of [useEnc, { name: "libx264", hw: false, label: "CPU (libx264)", args: [] }]) {
            const tmp = seg + ".tmp.mp4";
            const args = ["-hide_banner", "-y", ...plan.inputs];
            if (plan.graph) args.push("-filter_complex", plan.graph, "-map", plan.map);
            else args.push("-vf", plan.vf);
            let encA = encArgsFor(tryEnc, w, h, fps);
            if (plan.graph && /zoompan/.test(plan.graph)) {
              // BUG WORKAROUND: libx264 VBV (maxrate+bufsize together) makes zoompan's
              // frame counter stick (z frozen) in ffmpeg 7.0.x static builds -> drop VBV here.
              encA = encA.filter((x, k) => x !== "-maxrate" && x !== "-bufsize" && encA[k - 1] !== "-maxrate" && encA[k - 1] !== "-bufsize" ? true : false);
            }
            args.push("-an", ...encA, "-pix_fmt", "yuv420p", "-t", dur.toFixed(3), tmp);
            const r = await runFfmpeg(ff, args, (sec) => {
              sg._f = Math.min(1, sec / dur);
              refreshClip(sg.clipIndex);
              const doneNow = segs.reduce((a, x) => a + (x.t1 - x.t0) * (x._f || 0), 0);
              setStatus({
                frac: 0.08 + 0.72 * (doneNow / total),
                msg: "映像 " + Math.round(doneNow) + "s / " + Math.round(total) + "s（" + segs.length + "セグメント）",
                speedX: ((doneNow / Math.max(1, (Date.now() - wall0) / 1000)) / Math.max(1, pool)).toFixed(2) + "x",
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
        sg._f = 1;
        refreshClip(sg.clipIndex);
        if (sg.clipIndex >= 0 && clipSegs[sg.clipIndex].every((i2) => segs[i2]._f >= 1)) {
          clipState(sg.clipIndex, { state: "done", frac: 1 });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(pool, segs.length) }, worker));

    setStatus({ state: "concat", msg: "映像を連結中…", frac: 0.82 });
    const listFile = path.join(outDir, "list.txt");
    fs.writeFileSync(listFile, segs.map((_, i) => "file '" + path.join(outDir, "seg" + String(i).padStart(3, "0") + ".mp4") + "'").join("\n"));
    let r = await runFfmpeg(ff, ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", path.join(outDir, "video.mp4")]);
    if (r.code !== 0) throw new Error("連結失敗: " + r.tail.slice(-200));

    setStatus({ state: "audio", msg: "音声ミックス中…", frac: 0.88 });
    const safe = (pinfo.project_file_name || "output").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/[. ]+$/, "").slice(0, 60) || "output";
    const outFile = path.join(outRoot(), safe + "_" + stamp + ".mp4");
    const audioInputs = [];
    for (const c of proj.parsed.audioClips) {
      if (limit && c.tl >= dp.dur - 0.01) continue;
      const f = mediaMap.get(c.guid);
      if (!f) continue;
      if (/\.(mp4|mov|mkv|webm)$/i.test(f) && !(await hasAudio(ff, f))) continue;
      audioInputs.push({ c, f });
    }
    const fadeInOf = (c) => (dp.audioFades.find((fd) => Math.abs(fd.cut - c.tl) < 0.2) ? 1 : 0);
    const fadeOutOf = (c) => {
      for (const fd of dp.audioFades) {
        if (Math.abs(fd.cut - c.tlend) < 0.2) return { st: Math.max(0, fd.cut - 1 - c.tl), d: 1 };
      }
      for (const fd of dp.audioFades) {
        if (fd.t1 >= dp.dur - 0.06 && Math.abs(c.tlend - fd.t1) < 0.2) return { st: Math.max(0, fd.t0 - c.tl), d: Math.max(0.5, fd.t1 - fd.t0) };
      }
      return null;
    };
    if (audioInputs.length) {
      const args = ["-hide_banner", "-y"];
      const fc = [];
      audioInputs.forEach((ai, k) => {
        args.push("-i", ai.f);
        const delay = Math.round(Math.max(0, ai.c.tl) * 1000);
        let chain = "[" + k + ":a]atrim=start=" + ai.c.in.toFixed(3) + ":end=" + ai.c.out.toFixed(3) + ",asetpts=PTS-STARTPTS";
        if (fadeInOf(ai.c)) chain += ",afade=t=in:st=0:d=1";
        const fo = fadeOutOf(ai.c);
        if (fo) chain += ",afade=t=out:st=" + fo.st.toFixed(3) + ":d=" + fo.d.toFixed(3);
        chain += ",adelay=" + delay + "|" + delay + "[a" + k + "]";
        fc.push(chain);
      });
      fc.push(audioInputs.map((_, k) => "[a" + k + "]").join("") +
        "amix=inputs=" + audioInputs.length + ":normalize=0:dropout_transition=0,alimiter=limit=0.95," +
        "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]");
      const audioFile = path.join(outDir, "audio.m4a");
      r = await runFfmpeg(ff, args.concat(["-filter_complex", fc.join(";"), "-map", "[aout]", "-c:a", "aac", "-b:a", "256k",
        "-t", (dp.dur + 0.5).toFixed(3), audioFile]));
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
'<p class="sub" style="margin-top:18px">再現: カット編集＋音声ミックス＋<b>多レイヤー画像（位置・倍率）・フィルター・トランジション・フェード</b>。Filmora純正の素材動画を使う効果（オーバーレイ系）は色調・グレインで近似的に再現します。<br>GPU (NVIDIA/Intel内蔵/AMD) があれば自動でハードウェアエンコードを使用します。</p>' +
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
' if(j.ok){var f=j.project.feat;projInfo.innerHTML="プロジェクト: <b>"+esc(j.project.name)+"</b> ／ 長さ <b>"+j.project.dur.toFixed(1)+"s</b> ／ 映像クリップ <b>"+j.project.clips+"</b> ／ 音声 <b>"+j.project.audio+"</b>"+(f?" ／ レイヤー <b>"+f.layers+"</b>・フィルター <b>"+f.filters+"</b>・遷移 <b>"+f.trans+"</b> を再現":"");}}' +
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
          let feat = null;
          try {
            const d = deepParse(proj.rawTl, proj.mediaMap);
            feat = { layers: d.overlays.length + 1, filters: d.filterEvents.length, trans: d.transitions.length };
          } catch (e) {}
          const info = {
            ok: true, project: {
              name: proj.pinfo.project_file_name,
              dur: proj.parsed.duration,
              clips: proj.parsed.videoClips.length,
              audio: proj.parsed.audioClips.length,
              feat,
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
