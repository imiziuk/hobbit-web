// .d3dr log reader (browser + Node, ES module). Format: docs/D3DREC.md section 3; record layouts: ops.def.
//   const r = new LogReader(source); const header = await r.open();
//   for await (const rec of r.records()) { rec.op, rec.name, rec.iface, rec.self, rec.hr, rec.args }
// Sources: fromArrayBuffer(buf), fromBlob(file) (browser), or any {size, read(off, len) -> Promise<Uint8Array>}.
"use strict";
import {OPS, OP_HR, META_BASE} from "./ops.js";

/* ------------------------------------------------------------------ LZ4 block decoder */
export function lz4Decompress(src, rawLen){
  const dst = new Uint8Array(rawLen);
  let ip = 0, op = 0;
  const n = src.length;
  while (ip < n){
    const tok = src[ip++];
    let lit = tok >> 4;
    if (lit === 15){ let b; do { b = src[ip++]; lit += b; } while (b === 255); }
    dst.set(src.subarray(ip, ip + lit), op); ip += lit; op += lit;
    if (ip >= n) break;                       // last sequence: literals only
    const off = src[ip] | src[ip + 1] << 8; ip += 2;
    let ml = tok & 15;
    if (ml === 15){ let b; do { b = src[ip++]; ml += b; } while (b === 255); }
    ml += 4;
    let from = op - off;
    if (off <= 0 || from < 0) throw new Error("lz4: bad offset");
    if (off >= ml){ dst.copyWithin(op, from, from + ml); op += ml; }
    else for (let k = 0; k < ml; k++) dst[op++] = dst[from++];     // overlapping match
  }
  if (op !== rawLen) throw new Error(`lz4: decoded ${op} bytes, expected ${rawLen}`);
  return dst;
}

/* ------------------------------------------------------------------ sources */
export function fromArrayBuffer(buf){
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return {size: u8.length, read: async (off, len) => u8.subarray(off, Math.min(u8.length, off + len))};
}
export function fromBlob(blob){
  return {size: blob.size, read: async (off, len) => new Uint8Array(await blob.slice(off, off + len).arrayBuffer())};
}

const FILE_MAGIC = 0x52443344, CHUNK_MAGIC = 0x4B4E4843;
const td = new TextDecoder();

/* ------------------------------------------------------------------ record decoder */
class Cursor {
  constructor(u8, pos = 0){ this.d = u8; this.p = pos; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  u8(){ return this.d[this.p++]; }
  u(){ let v = 0, s = 0, b; do { b = this.d[this.p++]; v = s < 28 ? (v | (b & 127) << s) : v + (b & 127) * 2 ** s; s += 7; } while (b & 128); return v >>> 0; }
  i(){ const n = this.u(); return (n >>> 1) ^ -(n & 1); }
  d32(){ const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  f(){ const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  bytes(n){ const b = this.d.subarray(this.p, this.p + n); this.p += n; return b; }
}

export class LogReader {
  constructor(source, opts = {}){
    this.src = source;
    this.cacheLimit = opts.cacheBytes || (256 << 20);
    this.chunkIndex = new Map();    // seq -> {fileOff, comp, raw}
    this.cache = new Map();         // seq -> Uint8Array (decompressed), insertion order = LRU
    this.cacheBytes = 0;
    this.blobs = new Map();         // blobId -> {seq, off, len}
    this.mtx = new Array(4096); this.mtxNext = 0;   // matrix cache (ops.def field M)
    this.stats = {chunks: 0, rawBytes: 0, fileBytes: 0, records: 0, truncated: false, dupChunks: 0};
  }
  async open(){
    const h = await this.src.read(0, 12);
    const dv = new DataView(h.buffer, h.byteOffset, 12);
    if (h.length < 12 || dv.getUint32(0, true) !== FILE_MAGIC) throw new Error("not a .d3dr log");
    this.version = dv.getUint32(4, true);
    const jl = dv.getUint32(8, true);
    this.header = JSON.parse(td.decode(await this.src.read(12, jl)));
    this.dataStart = 12 + jl;
    return this.header;
  }
  async readChunkAt(off){
    const h = await this.src.read(off, 16);
    if (h.length < 16) return null;
    const dv = new DataView(h.buffer, h.byteOffset, 16);
    if (dv.getUint32(0, true) !== CHUNK_MAGIC) return null;
    const seq = dv.getUint32(4, true), raw = dv.getUint32(8, true), comp = dv.getUint32(12, true);
    const payLen = comp || raw, pay = await this.src.read(off + 16, payLen);
    if (pay.length < payLen) return null;
    const data = comp ? lz4Decompress(pay, raw) : pay.slice();
    return {seq, raw, comp, data, next: off + 16 + payLen};
  }
  remember(seq, data){
    if (this.cache.has(seq)) return;
    this.cache.set(seq, data); this.cacheBytes += data.length;
    for (const [k, v] of this.cache){ if (this.cacheBytes <= this.cacheLimit || k === seq) break; this.cache.delete(k); this.cacheBytes -= v.length; }
  }
  async chunkData(seq){
    let d = this.cache.get(seq);
    if (d){ this.cache.delete(seq); this.cache.set(seq, d); return d; }
    const ix = this.chunkIndex.get(seq); if (!ix) throw new Error("unknown chunk " + seq);
    const c = await this.readChunkAt(ix.fileOff);
    this.remember(seq, c.data); return c.data;
  }
  async blob(id){
    const b = this.blobs.get(id); if (!b) throw new Error("unknown blob " + id);
    const d = await this.chunkData(b.seq);
    return d.subarray(b.off, b.off + b.len);
  }
  async *chunks(){
    let off = this.dataStart, last = 0;
    while (off < this.src.size){
      const c = await this.readChunkAt(off);
      if (!c){ this.stats.truncated = off < this.src.size; break; }
      const fileOff = off; off = c.next;
      if (c.seq <= last){ this.stats.dupChunks++; continue; }     // emergency flush may repeat the last chunk
      last = c.seq;
      this.chunkIndex.set(c.seq, {fileOff, comp: c.comp, raw: c.raw});
      this.stats.chunks++; this.stats.rawBytes += c.raw; this.stats.fileBytes += 16 + (c.comp || c.raw);
      this.remember(c.seq, c.data);
      yield c;
    }
  }
  /** Decode one lock-data field ('X'). REF blobs are resolved here (async). */
  async data(cur, seq){
    const kind = cur.u8();
    if (kind === 0) return {kind: 0};
    if (kind === 1){ const id = cur.u(), len = cur.u(), off = cur.p; this.blobs.set(id, {seq, off, len}); return {kind, blobId: id, bytes: cur.bytes(len)}; }
    if (kind === 2){ const id = cur.u(); return {kind, blobId: id, bytes: await this.blob(id)}; }
    if (kind === 3){
      const n = cur.u(), spans = []; let pos = 0;
      for (let k = 0; k < n; k++){ pos += cur.u(); const len = cur.u(); spans.push({off: pos, bytes: cur.bytes(len)}); pos += len; }
      return {kind, spans};
    }
    throw new Error("bad data kind " + kind);
  }
  async *records(){
    for await (const c of this.chunks()){
      const cur = new Cursor(c.data);
      let hr = 0;
      while (cur.p < c.data.length){
        const at = cur.p, op = cur.u8();
        if (op === OP_HR){ hr = cur.d32() | 0; continue; }
        const def = OPS[op];
        if (!def) throw new Error(`bad op ${op} at chunk ${c.seq} +${at}`);
        const self = op < META_BASE ? cur.u() : 0, args = [];
        for (const t of def.sig){
          switch (t){
            case "u": case "o": args.push(cur.u()); break;
            case "i": args.push(cur.i()); break;
            case "d": args.push(cur.d32()); break;
            case "f": args.push(cur.f()); break;
            case "r": args.push(cur.u8() ? {left: cur.i(), top: cur.i(), right: cur.i(), bottom: cur.i()} : null); break;
            case "R": { const n = cur.u(); if (!n){ args.push(null); break; }
              const a = []; for (let k = 0; k < n - 1; k++) a.push({left: cur.i(), top: cur.i(), right: cur.i(), bottom: cur.i()}); args.push(a); break; }
            case "P": { const n = cur.u(); if (!n){ args.push(null); break; }
              const a = []; for (let k = 0; k < n - 1; k++) a.push({x: cur.i(), y: cur.i()}); args.push(a); break; }
            case "M": { const t = cur.u8();
              if (t === 1){ const m = new Float32Array(cur.bytes(64).slice().buffer); this.mtx[this.mtxNext++ & 4095] = m; args.push(m); }
              else if (t === 2) args.push(this.mtx[cur.u()].slice());
              else args.push(null);
              break; }
            case "B": { const n = cur.u(); args.push(n ? cur.bytes(n - 1) : null); break; }
            case "s": { const n = cur.u(); args.push(n ? td.decode(cur.bytes(n - 1)) : null); break; }
            case "X": args.push(await this.data(cur, c.seq)); break;
          }
        }
        this.stats.records++;
        yield {op, name: def.name, iface: def.iface, self, hr, args, seq: c.seq, at, size: cur.p - at};
        hr = 0;
      }
    }
  }
}

/* ------------------------------------------------------------------ struct helpers (d3d8types.h layouts) */
const f32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(o, true);
const u32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
export const S = {
  viewport: b => ({X: u32(b, 0), Y: u32(b, 4), Width: u32(b, 8), Height: u32(b, 12), MinZ: f32(b, 16), MaxZ: f32(b, 20)}),
  color: (b, o) => [f32(b, o), f32(b, o + 4), f32(b, o + 8), f32(b, o + 12)],
  material: b => ({Diffuse: S.color(b, 0), Ambient: S.color(b, 16), Specular: S.color(b, 32), Emissive: S.color(b, 48), Power: f32(b, 64)}),
  light: b => ({Type: u32(b, 0), Diffuse: S.color(b, 4), Specular: S.color(b, 20), Ambient: S.color(b, 36),
    Position: [f32(b, 52), f32(b, 56), f32(b, 60)], Direction: [f32(b, 64), f32(b, 68), f32(b, 72)], Range: f32(b, 76), Falloff: f32(b, 80),
    Attenuation0: f32(b, 84), Attenuation1: f32(b, 88), Attenuation2: f32(b, 92), Theta: f32(b, 96), Phi: f32(b, 100)}),
  pp: b => ({BackBufferWidth: u32(b, 0), BackBufferHeight: u32(b, 4), BackBufferFormat: u32(b, 8), BackBufferCount: u32(b, 12),
    MultiSampleType: u32(b, 16), SwapEffect: u32(b, 20), hDeviceWindow: u32(b, 24), Windowed: u32(b, 28),
    EnableAutoDepthStencil: u32(b, 32), AutoDepthStencilFormat: u32(b, 36), Flags: u32(b, 40),
    FullScreen_RefreshRateInHz: u32(b, 44), FullScreen_PresentationInterval: u32(b, 48)}),
  gamma: b => { const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), w = k => [...Array(256)].map((_, i) => dv.getUint16(k * 512 + i * 2, true));
    return {red: w(0), green: w(1), blue: w(2)}; },
};
