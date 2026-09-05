/*
 * ziplite.js — minimal ZIP reader over remote parts / local blobs,
 * plus Filmora timeline parsing. No dependencies.
 * Works in browsers and Node 18+ (DecompressionStream).
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.ZipLite = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------- sources (virtual concatenated file) ---------------- */

  class BlobSource {
    constructor(blobs) {
      this.blobs = blobs;
      this.offsets = [];
      let t = 0;
      for (const b of blobs) { this.offsets.push(t); t += b.size; }
      this.length = t;
    }
    async read(off, len) {
      if (off < 0 || len < 0 || off + len > this.length) throw new Error("read out of range");
      const end = off + len, parts = [];
      for (let i = 0; i < this.blobs.length; i++) {
        const s = this.offsets[i], e = s + this.blobs[i].size;
        if (e <= off || s >= end) continue;
        parts.push(this.blobs[i].slice(Math.max(off, s) - s, Math.min(end, e) - s));
      }
      return parts.length === 1 ? parts[0] : new Blob(parts);
    }
  }

  class HttpPartSource {
    /* names: array of URL-ready filenames under baseURL (pre-encoded if needed) */
    constructor(baseURL, names, sizes, onProgress) {
      this.baseURL = baseURL;
      this.names = names;
      this.sizes = sizes;
      this.onProgress = onProgress || null;
      this.bytesFetched = 0;
      this.cache = new Array(names.length).fill(null);
      this.offsets = [];
      let t = 0;
      for (const s of sizes) { this.offsets.push(t); t += s; }
      this.length = t;
    }
    async fetchRange(i, a, b) {
      if (this.cache[i]) return this.cache[i].slice(a, b);
      const url = this.baseURL + this.names[i];
      const r = await fetch(url, { headers: { Range: "bytes=" + a + "-" + (b - 1) } });
      if (r.status === 206) {
        const blob = await r.blob();
        this.bytesFetched += blob.size;
        if (this.onProgress) this.onProgress(this.bytesFetched);
        return blob;
      }
      if (r.status === 200) {
        // server ignored Range: cache whole part, slice the request out of it
        const full = await r.blob();
        this.cache[i] = full;
        this.bytesFetched += full.size;
        if (this.onProgress) this.onProgress(this.bytesFetched);
        return full.slice(a, b);
      }
      throw new Error("HTTP " + r.status + " for part " + i);
    }
    async read(off, len) {
      if (off < 0 || len < 0 || off + len > this.length) throw new Error("read out of range");
      const end = off + len, parts = [];
      for (let i = 0; i < this.names.length; i++) {
        const s = this.offsets[i], e = s + this.sizes[i];
        if (e <= off || s >= end) continue;
        parts.push(await this.fetchRange(i, Math.max(off, s) - s, Math.min(end, e) - s));
      }
      return parts.length === 1 ? parts[0] : new Blob(parts);
    }
  }

  /* ---------------- zip central directory ---------------- */

  async function openZip(source) {
    const tailLen = Math.min(source.length, 66000);
    const tail = new DataView(await (await source.read(source.length - tailLen, tailLen)).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("zip EOCD not found");
    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOff = tail.getUint32(eocd + 16, true);
    const cd = new Uint8Array(await (await source.read(cdOff, cdSize)).arrayBuffer());
    const dv = new DataView(cd.buffer);
    const td = new TextDecoder("utf-8");
    const entries = new Map();
    let p = 0;
    while (p + 46 <= cd.byteLength && entries.size < count) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad CDR signature at " + p);
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true);
      const el = dv.getUint16(p + 30, true);
      const cl = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = td.decode(cd.subarray(p + 46, p + 46 + nl));
      entries.set(name, { name, method, csize, usize, lho });
      p += 46 + nl + el + cl;
    }
    if (entries.size !== count) throw new Error("CDR count mismatch " + entries.size + " != " + count);
    return entries;
  }

  async function inflateRawBlob(raw) {
    // prefer zlib when running under Node/Bun (always available, fast)
    if (typeof require === "function") {
      try {
        const zlib = require("zlib");
        const buf = Buffer.from(await raw.arrayBuffer());
        return new Blob([zlib.inflateRawSync(buf)]);
      } catch (e) { /* fall through */ }
    }
    if (typeof DecompressionStream !== "undefined") {
      const ds = new DecompressionStream("deflate-raw");
      return await new Response(raw.stream().pipeThrough(ds)).blob();
    }
    throw new Error("no inflate implementation available");
  }

  async function extractEntry(source, entries, name) {
    const e = entries.get(name);
    if (!e) throw new Error("entry not found: " + name);
    const lh = new DataView(await (await source.read(e.lho, 30)).arrayBuffer());
    const nl = lh.getUint16(26, true);
    const el = lh.getUint16(28, true);
    const dataOff = e.lho + 30 + nl + el;
    const raw = await source.read(dataOff, e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateRawBlob(raw);
    throw new Error("unsupported zip method " + e.method + " for " + name);
  }

  /* ---------------- Filmora timeline ---------------- */

  const TICK = 1e7; // 100ns ticks per second
  const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;
  const AUDIO_EXT = /\.(mp3|m4a|wav|aac|flac|ogg)$/i;

  function guidOf(clip) {
    const fn = clip.filename || "";
    const m = fn.match(/Medias\/(\{[0-9A-Fa-f-]+\})/);
    return m ? m[1] : null;
  }

  /* mediaByGuid: Map guid -> {name, ext} from bundle/wfp entries */
  function parseTimeline(tl, mediaByGuid) {
    const videoClips = [], audioClips = [];
    const tracks = tl.timelineInfos[0].trackInfos;
    for (const tr of tracks) {
      for (const c of (tr.clipList || [])) {
        const guid = guidOf(c);
        const media = guid ? mediaByGuid.get(guid) : null;
        if (!media) continue;
        const entry = {
          guid, mediaName: media.name,
          in: c.inPoint / TICK, out: c.outPoint / TICK,
          tl: c.tlBegin / TICK, tlend: c.tlEnd / TICK,
          type: c.type, trackType: tr.trackType,
        };
        if (tr.trackType === 1 && c.type === 1 && VIDEO_EXT.test(media.name)) videoClips.push(entry);
        else if (tr.trackType === 2 && c.type === 2 && (AUDIO_EXT.test(media.name) || VIDEO_EXT.test(media.name))) audioClips.push(entry);
      }
    }
    videoClips.sort((a, b) => a.tl - b.tl);
    audioClips.sort((a, b) => a.tl - b.tl);
    const duration = Math.max(0,
      ...videoClips.map((e) => e.tlend), ...audioClips.map((e) => e.tlend));
    return { videoClips, audioClips, duration };
  }

  /* build guid -> media map from bundle ("Medias/{G}/x.mp4") and wfp
     ("ProjectFolder/Medias/{G}/x.mp4") entry names */
  function mediaMapFromEntries(names) {
    const m = new Map();
    for (const n of names) {
      const mm = n.match(/(?:^ProjectFolder\/)?Medias\/(\{[0-9A-Fa-f-]+\})\/([^\/]+)$/);
      if (!mm) continue;
      const file = mm[2];
      if (file.endsWith(".json") || file.endsWith(".png")) continue;
      if (!m.has(mm[1])) m.set(mm[1], { name: file, entry: n });
    }
    return m;
  }

  return { BlobSource, HttpPartSource, openZip, extractEntry, parseTimeline, mediaMapFromEntries, guidOf, TICK };
});
