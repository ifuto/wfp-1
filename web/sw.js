/*
 * sw.js — 仮想 MP4 ストリーミング Service Worker
 * /web/stream.mp4?dir=4k120|1080p60 へのリクエストを、
 * /video/<dir>/video.partNNN.bin の必要スライスに変換して返す。
 * Range対応・1リクエスト最大16MB・パートはCache APIで再利用。
 */
const M_CACHE = "wfp-manifest-v1";
const P_CACHE = "wfp-parts-v1";
const MAX_CHUNK = 16 * 1024 * 1024;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function basePath() {
  return new URL(self.registration.scope).pathname; // e.g. /wfp-1/web/
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname !== basePath() + "stream.mp4") return;
  event.respondWith(streamVideo(event.request, url));
});

async function getManifest(dir) {
  const c = await caches.open(M_CACHE);
  const key = "manifest:" + dir;
  let resp = await c.match(key);
  if (!resp) {
    resp = await fetch(basePath() + "../video/" + dir + "/manifest.json");
    try { await c.put(key, resp.clone()); } catch (e) {}
  }
  return resp.json();
}

async function partBuffer(dir, part) {
  const partURL = basePath() + "../video/" + dir + "/" + part.file;
  const c = await caches.open(P_CACHE);
  let resp = await c.match(partURL);
  if (!resp) {
    resp = await fetch(partURL);
    try { await c.put(partURL, resp.clone()); } catch (e) {}
  }
  return await resp.arrayBuffer();
}

async function streamVideo(request, url) {
  const dir = url.searchParams.get("dir") || "1080p60";
  const man = await getManifest(dir);
  const total = man.totalSize;
  const starts = [];
  let acc = 0;
  for (const p of man.parts) { starts.push(acc); acc += p.size; }

  const rangeH = request.headers.get("range");

  if (!rangeH) {
    // 全体ストリーム（ダウンロード用）: パートを順次流す
    const stream = new ReadableStream({
      async start(ctrl) {
        for (let i = 0; i < man.parts.length; i++) {
          const buf = await partBuffer(dir, man.parts[i]);
          ctrl.enqueue(new Uint8Array(buf));
        }
        ctrl.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
      },
    });
  }

  let start = 0, end = total - 1;
  const m = rangeH.match(/bytes=(\d*)-(\d*)/);
  if (m) {
    if (m[1]) start = parseInt(m[1], 10);
    if (m[2]) end = parseInt(m[2], 10);
    else end = total - 1;
    if (!m[1] && m[2]) { start = Math.max(0, total - parseInt(m[2], 10)); end = total - 1; }
  }
  if (start >= total) {
    return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + total } });
  }
  end = Math.min(end, total - 1, start + MAX_CHUNK - 1);

  const slices = [];
  for (let i = 0; i < man.parts.length; i++) {
    const ps = starts[i], pe = starts[i] + man.parts[i].size;
    const os = Math.max(start, ps), oe = Math.min(end + 1, pe);
    if (os >= oe) continue;
    const buf = await partBuffer(dir, man.parts[i]);
    slices.push(buf.slice(os - ps, oe - ps));
    if (oe >= end + 1) break;
  }

  let body;
  if (slices.length === 1) {
    body = slices[0];
  } else {
    const len = slices.reduce((a, s) => a + s.byteLength, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const s of slices) { out.set(new Uint8Array(s), o); o += s.byteLength; }
    body = out.buffer;
  }

  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Content-Range": "bytes " + start + "-" + end + "/" + total,
    },
  });
}
