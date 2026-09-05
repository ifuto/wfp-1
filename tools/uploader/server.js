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
const { execFile } = require("child_process");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";
const DIR = process.env.UPLOAD_DIR || "/tmp/wfp-upload";
const PARTS = path.join(DIR, "parts");
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
