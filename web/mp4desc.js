/*
 * mp4desc.js — tiny MP4/ISOBMFF walker to extract per-track codec info
 * needed by WebCodecs: fourcc, codec string, and the raw description box
 * (av1C/avcC/hvcC/vpcC, header included). UMD; testable in Node.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.WfpMP4 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function u32(v, o) { return (v[o] << 24) | (v[o + 1] << 16) | (v[o + 2] << 8) | v[o + 3]; }
  function u16(v, o) { return (v[o] << 8) | v[o + 1]; }
  function u64(v, o) { return u32(v, o) * 4294967296 + u32(v, o + 4); }
  function type4(v, o) { return String.fromCharCode(v[o], v[o + 1], v[o + 2], v[o + 3]); }
  function hex2(n) { return n.toString(16).padStart(2, "0"); }

  /* iterates boxes in [start,end) calling cb(type, bodyStart, bodyEnd, headerLen) */
  function eachBox(v, start, end, cb) {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(v, o);
      const t = type4(v, o + 4);
      let headerLen = 8;
      if (size === 1) { size = u64(v, o + 8); headerLen = 16; }
      else if (size === 0) { size = end - o; }
      if (size < headerLen || o + size > end) break;
      if (cb(t, o + headerLen, o + size, headerLen, o) === false) return;
      o += size;
    }
  }

  function boxBytes(v, bodyStart, headerLen, bodyEnd) {
    return v.slice(bodyStart - headerLen, bodyEnd); // full box incl. header
  }

  function codecFromAv1C(d) {
    // d = full av1C box bytes
    const p = 8; // skip box header
    const b1 = d[p + 1], b2 = d[p + 2];
    const profile = b1 >> 5, level = b1 & 31;
    const tier = (b2 >> 7) & 1;
    const high = (b2 >> 6) & 1, twelve = (b2 >> 5) & 1;
    const bitdepth = high ? (twelve ? 12 : 10) : 8;
    const bd = bitdepth === 12 ? "12" : bitdepth === 10 ? "10" : "08";
    return "av01." + profile + "." + String(level).padStart(2, "0") + (tier ? "H" : "M") + "." + bd;
  }

  function codecFromAvcC(d) {
    const p = 8;
    // avcC: configurationVersion(1) profile_idc(1) compat(1) level_idc(1)
    return "avc1." + hex2(d[p + 1]) + hex2(d[p + 2]) + hex2(d[p + 3]);
  }

  const CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, stsd: 2 };

  function inspect(buf) {
    const v = new Uint8Array(buf);
    const tracks = [];
    let moovEnd = -1;

    eachBox(v, 0, v.length, (t, bs, be) => {
      if (t === "moov") {
        moovEnd = be;
        eachBox(v, bs, be, (t2, bs2, be2) => {
          if (t2 !== "trak") return;
          inspectTrak(v, bs2, be2, tracks);
        });
        return false;
      }
      return true;
    });
    if (!tracks.length) throw new Error("no tracks found (moov " + (moovEnd < 0 ? "missing" : "ok") + ")");
    return { tracks };
  }

  function inspectTrak(v, trakStart, trakEnd, out) {
    let timescale = 0, hdlrType = "", stsdStart = -1, stsdEnd = -1;
    eachBox(v, trakStart, trakEnd, (t, bs, be) => {
      if (t === "mdia") {
        eachBox(v, bs, be, (t2, bs2, be2) => {
          if (t2 === "mdhd") { timescale = u32(v, bs2 + 12); }
          else if (t2 === "hdlr") { hdlrType = type4(v, bs2 + 8); }
          else if (t2 === "minf") {
            eachBox(v, bs2, be2, (t3, bs3, be3) => {
              if (t3 === "stbl") {
                eachBox(v, bs3, be3, (t4, bs4, be4) => {
                  if (t4 === "stsd") { stsdStart = bs4; stsdEnd = be4; }
                });
              }
            });
          }
        });
      }
    });
    if (stsdStart < 0) return;
    // stsd: version/flags(4) + entry_count(4) + entries
    const n = u32(v, stsdStart + 4);
    let o = stsdStart + 8;
    const entries = [];
    eachBox(v, o, stsdEnd, (t, bs, be, hl) => {
      entries.push({ fourcc: t, bodyStart: bs, headerLen: hl, end: be });
      return entries.length < n;
    });
    const e = entries[0];
    if (!e) return;
    const track = {
      handler: hdlrType,
      timescale,
      fourcc: e.fourcc,
      width: 0, height: 0,
      codec: null,
      description: null,
    };
    // visual sample entry: 6 reserved + data_ref_index(2) + pre def(2)+reserved(2)+predef(2)+
    // width(2) height(2) ... all after the 8-byte entry header
    if (hdlrType === "vide") {
      track.width = u16(v, e.bodyStart + 24);
      track.height = u16(v, e.bodyStart + 26);
      // find description sub-box
      eachBox(v, e.bodyStart + 78, e.end, (t, bs, be, hl) => {
        if (t === "av1C") { track.description = boxBytes(v, bs, hl, be); track.codec = codecFromAv1C(track.description); }
        else if (t === "avcC") { track.description = boxBytes(v, bs, hl, be); track.codec = codecFromAvcC(track.description); }
        else if (t === "hvcC") { track.description = boxBytes(v, bs, hl, be); track.codec = "hvc1*" ; }
        else if (t === "vpcC") { track.description = boxBytes(v, bs, hl, be); track.codec = "vp09.00.10.08"; }
        return true;
      });
    }
    out.push(track);
  }

  return { inspect, eachBox };
});
