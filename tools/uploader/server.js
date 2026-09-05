"use strict";
/*
 * Direct upload receiver for large files (e.g. 771MB .zip -> .wfpbundle).
 * Zero-dependency Node HTTP server. Binds 0.0.0.0 so it works behind the
 * sandbox preview proxy. Uploads are stored OUTSIDE the git workspace
 * (default /tmp/wfp-upload) so they never bloat the repo or snapshots.
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";
const DIR = process.env.UPLOAD_DIR || "/tmp/wfp-upload";
const PARTS = path.join(DIR, "parts");
const CONVERT_DIR = path.join(DIR, "convert");
fs.mkdirSync(CONVERT_DIR, { recursive: true });
const convertJobs = new Map();

async function ensureFfmpeg() {
  const p = "/tmp/ffmpeg-bin/ffmpeg";
  if (fs.existsSync(p)) return p;
  fs.mkdirSync("/tmp/ffmpeg-bin", { recursive: true });
  await new Promise((resolve) => execFile("pip", ["download", "imageio-ffmpeg", "--no-deps", "-q", "-d", "/tmp/ffdl2"], { timeout: 180000 }, () => resolve()));
  const whl = (fs.readdirSync("/tmp/ffdl2").find((f) => f.endsWith(".whl"))) || "";
  if (!whl) throw new Error("ffmpeg wheel download failed");
  fs.rmSync("/tmp/ffwhl2", { recursive: true, force: true });
  await new Promise((resolve) => execFile("python3", ["-m", "zipfile", "-e", "/tmp/ffdl2/" + whl, "/tmp/ffwhl2"], { timeout: 60000 }, () => resolve()));
  const findBin = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, f.name);
      if (f.isDirectory()) { const r = findBin(fp); if (r) return r; }
      else if (f.name.startsWith("ffmpeg-") && !f.name.endsWith(".txt")) return fp;
    }
    return null;
  };
  const bin = findBin("/tmp/ffwhl2");
  if (!bin) throw new Error("ffmpeg binary not found in wheel");
  fs.copyFileSync(bin, p);
  fs.chmodSync(p, 0o755);
  return p;
}

/* 指定メディア名をbundleから取り出しH.264へ変換（結果はキャッシュ） */
async function getConverted(name) {
  const hex = crypto.createHash("md5").update(name).digest("hex");
  const out = path.join(CONVERT_DIR, hex + ".mp4");
  if (fs.existsSync(out)) return out;
  if (!convertJobs.has(name)) {
    convertJobs.set(name, (async () => {
      const ff = await ensureFfmpeg();
      const bundles = fs.readdirSync(DIR).filter((f) => f.endsWith(".zip"));
      if (!bundles.length) throw new Error("bundle zip not found on server");
      const bundle = path.join(DIR, bundles[0]);
      const src = path.join(CONVERT_DIR, "src_" + hex);
      await new Promise((resolve, reject) => {
        execFile("unzip", ["-p", bundle, "Medias/*/" + name], { maxBuffer: 300 * 1024 * 1024, encoding: "buffer", timeout: 120000 },
          (err, stdout) => {
            if (err || !stdout || !stdout.length) return reject(new Error("media not found: " + name));
            fs.writeFileSync(src, stdout);
            resolve();
          });
      });
      await new Promise((resolve, reject) => {
        execFile(ff, ["-hide_banner", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out],
          { timeout: 900000, maxBuffer: 1024 * 1024 },
          (e) => (e ? reject(new Error("transcode failed: " + e.message)) : resolve()));
      });
      try { fs.unlinkSync(src); } catch (e) {}
      return out;
    })().catch((e) => { convertJobs.delete(name); throw e; }));
  }
  return convertJobs.get(name);
}

function serveMp4(req, res, file, downloadName) {
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  const base = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=86400",
  };
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size) { res.writeHead(416, Object.assign({ "Content-Range": "bytes */" + size }, CORS)); res.end(); return; }
    end = Math.min(end, size - 1);
    res.writeHead(206, Object.assign({
      "Content-Length": end - start + 1,
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
    }, base, CORS));
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, Object.assign({ "Content-Length": size }, base, CORS));
    fs.createReadStream(file).pipe(res);
  }
}
const MAX_BODY = 32 * 1024 * 1024; // hard cap per chunk request

fs.mkdirSync(PARTS, { recursive: true });

const SESSION_FILE = path.join(DIR, "session.json");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function readSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch { return null; }
}
function writeSession(s) { fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2)); }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS));
  res.end(body);
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      total += c.length;
      if (total > cap) { done = true; reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

function expectedChunkSize(session, i) {
  if (i < 0 || i >= session.totalChunks) return -1;
  if (i < session.totalChunks - 1) return session.chunkSize;
  return session.size - session.chunkSize * (session.totalChunks - 1);
}

function resetAll() {
  for (const f of fs.readdirSync(PARTS)) fs.unlinkSync(path.join(PARTS, f));
  try { fs.unlinkSync(SESSION_FILE); } catch {}
  for (const f of fs.readdirSync(DIR)) {
    if (f === "parts") continue;
    try { fs.unlinkSync(path.join(DIR, f)); } catch {}
  }
}

function partPath(i) { return path.join(PARTS, "part_" + String(i).padStart(6, "0")); }

/* name -> .wfpbundle name: "X.wfpbundle.zip" (already a bundled zip) just
   strips ".zip"; plain "X.zip" becomes "X.wfpbundle". */
function bundleNameFor(name) {
  if (/\.wfpbundle\.zip$/i.test(name)) return name.replace(/\.zip$/i, "");
  if (/\.zip$/i.test(name)) return name.replace(/\.zip$/i, ".wfpbundle");
  return name + ".wfpbundle";
}

/* ---- assemble parts -> original name, then create .wfpbundle twin ---- */
async function assemble(session) {
  const original = path.join(DIR, session.name);
  const out = fs.createWriteStream(original, { flags: "w" });
  await new Promise((resolve, reject) => {
    out.on("error", reject);
    out.on("open", () => resolve());
  });
  for (let i = 0; i < session.totalChunks; i++) {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(partPath(i));
      rs.on("error", reject);
      rs.on("end", resolve);
      rs.pipe(out, { end: false });
    });
  }
  await new Promise((resolve, reject) => { out.end((e) => (e ? reject(e) : resolve())); });
  const stat = fs.statSync(original);
  if (stat.size !== session.size) throw new Error("size mismatch after assembly: " + stat.size + " != " + session.size);

  // .zip -> .wfpbundle (hard link so we don't double 771MB on disk; fall back to copy)
  const bundleName = bundleNameFor(session.name);
  const bundle = path.join(DIR, bundleName);
  try { fs.unlinkSync(bundle); } catch {}
  try { fs.linkSync(original, bundle); }
  catch { await fs.promises.copyFile(original, bundle); }
  return { original, bundle, bundleName, size: stat.size };
}

function verifyZip(file) {
  return new Promise((resolve) => {
    execFile("unzip", ["-t", file], { timeout: 180000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) resolve({ ok: false, detail: String(stdout || err.message).split("\n").slice(-3).join(" ").slice(0, 300) });
      else resolve({ ok: true });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "index.html"));
      res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS));
      res.end(html);
      return;
    }

    /* ---------------- render app ---------------- */
    const RENDER_SCRIPT = path.join(__dirname, "..", "render", "render.py");
    const RENDER_ROOT = path.join(DIR, "render");

    if (req.method === "GET" && p === "/convert") {
      const name = u.searchParams.get("name") || "";
      if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
        json(res, 400, { ok: false, error: "bad name" }); return;
      }
      try {
        const file = await getConverted(name);
        serveMp4(req, res, file);
      } catch (e) {
        json(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }

    if (req.method === "GET" && p === "/render") {
      const html = fs.readFileSync(path.join(__dirname, "render.html"));
      res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS));
      res.end(html);
      return;
    }

    if (req.method === "GET" && p === "/render/info") {
      const r = await new Promise((resolve) => {
        execFile("python3", [RENDER_SCRIPT, "--info"], { cwd: __dirname, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => resolve({ err, stdout }));
      });
      if (r.err) { json(res, 500, { ok: false, error: String(r.err.message) }); return; }
      try {
        const data = JSON.parse(r.stdout.trim().split("\n").pop());
        json(res, 200, { ok: true, project: data });
      } catch (e) { json(res, 500, { ok: false, error: "parse failed: " + r.stdout.slice(0, 200) }); }
      return;
    }

    function renderDir(q) {
      return path.join(RENDER_ROOT, (q.get("w") || "3840") + "x" + (q.get("h") || "2160") + "@" + (q.get("fps") || "120"));
    }

    if (req.method === "POST" && p === "/render/start") {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const w = parseInt(body.w, 10), h = parseInt(body.h, 10), fps = parseInt(body.fps, 10);
      if (![w, h, fps].every(Number.isFinite) || w < 16 || h < 16 || w > 7680 || h > 4320 || fps < 1 || fps > 240) {
        json(res, 400, { ok: false, error: "bad preset" }); return;
      }
      if (global.currentRender && global.currentRender.proc.exitCode === null) {
        json(res, 409, { ok: false, error: "render already running", preset: global.currentRender.preset }); return;
      }
      const outDir = path.join(RENDER_ROOT, w + "x" + h + "@" + fps);
      fs.mkdirSync(outDir, { recursive: true });
      // detached: own process group so the render survives turn boundaries
      const proc = spawn("python3", [RENDER_SCRIPT, DIR, outDir, String(w), String(h), String(fps)], {
        cwd: __dirname, detached: true, stdio: "ignore",
        env: Object.assign({}, process.env, { FFMPEG_PATH: process.env.FFMPEG_PATH || "/tmp/ffmpeg-bin/ffmpeg" }),
      });
      proc.unref();
      global.currentRender = { preset: w + "x" + h + "@" + fps, proc, outDir, startedAt: Date.now() };
      json(res, 200, { ok: true, preset: global.currentRender.preset });
      return;
    }

    if (req.method === "GET" && p === "/render/status") {
      const outDir = renderDir(u.searchParams);
      let progress = null;
      try { progress = JSON.parse(fs.readFileSync(path.join(outDir, "progress.json"), "utf8")); } catch {}
      let hasFile = false, size = 0;
      try { size = fs.statSync(path.join(outDir, "output.mp4")).size; hasFile = true; } catch {}
      const job = global.currentRender;
      const running = !!(job && job.proc.exitCode === null && job.outDir === outDir);
      let logTail = "";
      try { logTail = fs.readFileSync(path.join(outDir, "render.log"), "utf8").split("\n").slice(-4).join("\n").slice(-800); } catch {}
      json(res, 200, { ok: true, running, progress, hasFile, size, logTail });
      return;
    }

    if (req.method === "GET" && p === "/render/stream") {
      const outDir = renderDir(u.searchParams);
      const file = path.join(outDir, "output.mp4");
      if (!fs.existsSync(file)) { json(res, 404, { ok: false, error: "not rendered yet" }); return; }
      const size = fs.statSync(file).size;
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (start >= size) { res.writeHead(416, Object.assign({ "Content-Range": "bytes */" + size }, CORS)); res.end(); return; }
        end = Math.min(end, size - 1);
        res.writeHead(206, Object.assign({
          "Content-Type": "video/mp4",
          "Content-Length": end - start + 1,
          "Content-Range": "bytes " + start + "-" + end + "/" + size,
          "Accept-Ranges": "bytes",
          "Content-Disposition": "inline",
        }, CORS));
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, Object.assign({
          "Content-Type": "video/mp4",
          "Content-Length": size,
          "Accept-Ranges": "bytes",
          "Content-Disposition": "inline",
        }, CORS));
        fs.createReadStream(file).pipe(res);
      }
      return;
    }

    if (req.method === "GET" && p === "/render/file") {
      const outDir = renderDir(u.searchParams);
      const file = path.join(outDir, "output.mp4");
      if (!fs.existsSync(file)) { json(res, 404, { ok: false, error: "not rendered yet" }); return; }
      const s = readSession();
      const base = (s && s.name ? s.name.replace(/\.wfpbundle\.zip$/i, "").replace(/\.zip$/i, "") : "render") +
        "_" + (u.searchParams.get("w") || "3840") + "x" + (u.searchParams.get("h") || "2160") + "@" + (u.searchParams.get("fps") || "120") + ".mp4";
      const asciiFallback = base.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
      res.writeHead(200, Object.assign({
        "Content-Type": "video/mp4",
        "Content-Length": fs.statSync(file).size,
        "Content-Disposition": 'attachment; filename="' + asciiFallback + '"; filename*=UTF-8\'\'' + encodeURIComponent(base),
      }, CORS));
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (req.method === "GET" && p === "/status") {
      const s = readSession();
      if (!s) { json(res, 200, { session: null }); return; }
      const received = [];
      for (let i = 0; i < s.totalChunks; i++) {
        try { fs.statSync(partPath(i)); received.push(i); } catch {}
      }
      json(res, 200, { session: { name: s.name, size: s.size, chunkSize: s.chunkSize, totalChunks: s.totalChunks, received } });
      return;
    }

    if (req.method === "POST" && p === "/reset") { resetAll(); json(res, 200, { ok: true }); return; }

    if (req.method === "POST" && p === "/init") {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
      const name = String(body.name || "").replace(/[\/\\\0]/g, "_").slice(0, 200);
      const size = Number(body.size);
      const chunkSize = Number(body.chunkSize);
      const totalChunks = Number(body.totalChunks);
      if (!name || !Number.isFinite(size) || size <= 0 || !Number.isFinite(chunkSize) || chunkSize <= 0 || chunkSize > MAX_BODY || !Number.isFinite(totalChunks) || totalChunks <= 0 || totalChunks > 100000) {
        json(res, 400, { ok: false, error: "invalid init params" }); return;
      }
      const existing = readSession();
      if (existing && existing.name !== name && !body.force) {
        json(res, 409, { ok: false, conflict: true, existing: existing.name }); return;
      }
      if (existing && (existing.name !== name || existing.size !== size || existing.chunkSize !== chunkSize)) resetAll();
      if (!readSession()) writeSession({ name, size, chunkSize, totalChunks, startedAt: new Date().toISOString() });
      json(res, 200, { ok: true }); return;
    }

    let m;
    if (req.method === "POST" && (m = p.match(/^\/chunk\/(\d+)$/))) {
      const s = readSession();
      if (!s) { json(res, 409, { ok: false, error: "no session; POST /init first" }); return; }
      const i = parseInt(m[1], 10);
      const expected = expectedChunkSize(s, i);
      if (expected < 0) { json(res, 400, { ok: false, error: "bad chunk index" }); return; }
      const buf = await readBody(req, MAX_BODY);
      if (buf.length !== expected) { json(res, 400, { ok: false, error: "chunk size mismatch: got " + buf.length + " expected " + expected }); return; }
      const sha = u.searchParams.get("sha");
      if (sha) {
        const actual = crypto.createHash("sha256").update(buf).digest("hex");
        if (actual !== sha.toLowerCase()) { json(res, 422, { ok: false, error: "sha256 mismatch for chunk " + i }); return; }
      }
      fs.writeFileSync(partPath(i), buf);
      let received = 0;
      for (let k = 0; k < s.totalChunks; k++) { try { fs.statSync(partPath(k)); received++; } catch {} }
      json(res, 200, { ok: true, index: i, received, total: s.totalChunks });
      return;
    }

    if (req.method === "POST" && p === "/finish") {
      const s = readSession();
      if (!s) { json(res, 409, { ok: false, error: "no session" }); return; }
      const missing = [];
      for (let i = 0; i < s.totalChunks; i++) { try { fs.statSync(partPath(i)); } catch { missing.push(i); } }
      if (missing.length) { json(res, 409, { ok: false, error: "missing chunks", missing: missing.slice(0, 20), missingCount: missing.length }); return; }
      const result = await assemble(s);
      const verify = /\.zip$/i.test(s.name) ? await verifyZip(result.original) : null;
      json(res, 200, {
        ok: true,
        originalName: s.name,
        size: result.size,
        bundleName: result.bundleName,
        downloadUrl: "/download",
        zipCheck: verify,
      });
      return;
    }

    if (req.method === "GET" && p === "/download") {
      const s = readSession();
      const bundleName = s ? bundleNameFor(s.name) : null;
      const file = bundleName ? path.join(DIR, bundleName) : null;
      if (!file || !fs.existsSync(file)) { json(res, 404, { ok: false, error: "bundle not found" }); return; }
      const asciiFallback = bundleName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
      const encodedName = encodeURIComponent(bundleName);
      res.writeHead(200, Object.assign({
        "Content-Type": "application/octet-stream",
        "Content-Length": fs.statSync(file).size,
        "Content-Disposition":
          'attachment; filename="' + asciiFallback + '"; filename*=UTF-8\'\'' + encodedName,
      }, CORS));
      fs.createReadStream(file).pipe(res);
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log("uploader listening on http://" + HOST + ":" + PORT + " (storage: " + DIR + ")");
});
