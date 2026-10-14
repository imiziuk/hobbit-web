// D3D8 fixed-function -> WebGL2 (prototype for the Meridian.exe web port).
// Implements the subset of IDirect3DDevice8 that Meridian.exe calls (see docs/WEB_PORT_D3D8.md, section 1),
// as plain JS methods with the D3D8 names. The COM/wasm bridge (com.js) maps vtable calls onto these.
// Conventions (D3D8 -> GL), all handled here:
//  * matrices are D3D row-vector, row-major; uploaded raw they ARE the GL column-major transposes, so the
//    shader does uProj * (uView * (uWorld * v)) unchanged;
//  * clip z: D3D 0..w, GL -w..w  ->  gl_Position.z = 2z - w;  NDC y is "up" in both, so windings and culling
//    match; only viewport/scissor rects and readbacks flip (D3D origin top-left);
//  * D3D8 pixel centres sit on integer coordinates: every vertex is shifted by +0.5 px (x) / -0.5 px (y) in NDC;
//  * D3DCOLOR is BGRA in memory -> attribute read as UNSIGNED_BYTE normalized and swizzled .bgra in the shader;
//  * the back buffer is an FBO; Present() blits it to the canvas through the gamma ramp (SetGammaRamp).
"use strict";

/* ------------------------------------------------------------------ constants (d3d8types.h) */
export const RS = {ZENABLE: 7, FILLMODE: 8, SHADEMODE: 9, ZWRITEENABLE: 14, ALPHATESTENABLE: 15, LASTPIXEL: 16, SRCBLEND: 19,
  DESTBLEND: 20, CULLMODE: 22, ZFUNC: 23, ALPHAREF: 24, ALPHAFUNC: 25, DITHERENABLE: 26, ALPHABLENDENABLE: 27, FOGENABLE: 28,
  SPECULARENABLE: 29, FOGCOLOR: 34, FOGTABLEMODE: 35, FOGSTART: 36, FOGEND: 37, FOGDENSITY: 38, ZBIAS: 47, RANGEFOGENABLE: 48,
  STENCILENABLE: 52, STENCILFAIL: 53, STENCILZFAIL: 54, STENCILPASS: 55, STENCILFUNC: 56, STENCILREF: 57, STENCILMASK: 58,
  STENCILWRITEMASK: 59, TEXTUREFACTOR: 60, CLIPPING: 136, LIGHTING: 137, AMBIENT: 139, FOGVERTEXMODE: 140, COLORVERTEX: 141,
  LOCALVIEWER: 142, NORMALIZENORMALS: 143, DIFFUSEMATERIALSOURCE: 145, SPECULARMATERIALSOURCE: 146, AMBIENTMATERIALSOURCE: 147,
  EMISSIVEMATERIALSOURCE: 148, VERTEXBLEND: 151, SOFTWAREVERTEXPROCESSING: 153, COLORWRITEENABLE: 168, BLENDOP: 171};
export const TSS = {COLOROP: 1, COLORARG1: 2, COLORARG2: 3, ALPHAOP: 4, ALPHAARG1: 5, ALPHAARG2: 6, TEXCOORDINDEX: 11,
  ADDRESSU: 13, ADDRESSV: 14, BORDERCOLOR: 15, MAGFILTER: 16, MINFILTER: 17, MIPFILTER: 18, MIPMAPLODBIAS: 19, MAXMIPLEVEL: 20,
  MAXANISOTROPY: 21, TEXTURETRANSFORMFLAGS: 24, ADDRESSW: 25, COLORARG0: 26, ALPHAARG0: 27, RESULTARG: 28};
export const TOP = {DISABLE: 1, SELECTARG1: 2, SELECTARG2: 3, MODULATE: 4, MODULATE2X: 5, MODULATE4X: 6, ADD: 7, ADDSIGNED: 8,
  ADDSIGNED2X: 9, SUBTRACT: 10, ADDSMOOTH: 11, BLENDDIFFUSEALPHA: 12, BLENDTEXTUREALPHA: 13, BLENDFACTORALPHA: 14,
  BLENDTEXTUREALPHAPM: 15, BLENDCURRENTALPHA: 16, PREMODULATE: 17, MODULATEALPHA_ADDCOLOR: 18, MODULATECOLOR_ADDALPHA: 19,
  MODULATEINVALPHA_ADDCOLOR: 20, MODULATEINVCOLOR_ADDALPHA: 21, BUMPENVMAP: 22, BUMPENVMAPLUMINANCE: 23, DOTPRODUCT3: 24,
  MULTIPLYADD: 25, LERP: 26};
export const TA = {DIFFUSE: 0, CURRENT: 1, TEXTURE: 2, TFACTOR: 3, SPECULAR: 4, TEMP: 5, COMPLEMENT: 0x10, ALPHAREPLICATE: 0x20};
export const FMT = {R8G8B8: 20, A8R8G8B8: 21, X8R8G8B8: 22, R5G6B5: 23, X1R5G5B5: 24, A1R5G5B5: 25, A4R4G4B4: 26, A8: 28,
  X4R4G4B4: 30, L8: 50, A8L8: 51, D16: 80, D24S8: 75, INDEX16: 101, INDEX32: 102,
  DXT1: 0x31545844, DXT2: 0x32545844, DXT3: 0x33545844, DXT4: 0x34545844, DXT5: 0x35545844};
export const FVF = {XYZ: 0x002, XYZRHW: 0x004, POSITION_MASK: 0x00e, NORMAL: 0x010, PSIZE: 0x020, DIFFUSE: 0x040, SPECULAR: 0x080,
  TEXCOUNT_MASK: 0xf00, TEXCOUNT_SHIFT: 8};
export const PT = {POINTLIST: 1, LINELIST: 2, LINESTRIP: 3, TRIANGLELIST: 4, TRIANGLESTRIP: 5, TRIANGLEFAN: 6};
export const TS = {VIEW: 2, PROJECTION: 3, TEXTURE0: 16, WORLD: 256};
export const LOCK = {READONLY: 0x10, NOSYSLOCK: 0x800, NOOVERWRITE: 0x1000, DISCARD: 0x2000};
export const CLEAR = {TARGET: 1, ZBUFFER: 2, STENCIL: 4};
export const TCI = {PASSTHRU: 0, CAMERASPACENORMAL: 0x10000, CAMERASPACEPOSITION: 0x20000, CAMERASPACEREFLECTIONVECTOR: 0x30000};
export const LIGHT = {POINT: 1, SPOT: 2, DIRECTIONAL: 3};
export const HR = {OK: 0, INVALIDCALL: 0x8876086c | 0, NOTAVAILABLE: 0x8876086a | 0, DEVICELOST: 0x88760868 | 0};

/* ------------------------------------------------------------------ small helpers */
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export const asFloat = bits => (u32[0] = bits >>> 0, f32[0]);
export const asBits = f => (f32[0] = f, u32[0]);
export const color4 = c => [((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255, (c >>> 24) / 255];
const IDENT = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const isDXT = f => f === FMT.DXT1 || f === FMT.DXT2 || f === FMT.DXT3 || f === FMT.DXT4 || f === FMT.DXT5;

/** Vertex layout of an FVF code: byte offsets of every element and the stride. */
export function decodeFVF(fvf){
  const L = {fvf, rhw: false, pos: 0, posSize: 3, weights: 0, normal: -1, psize: -1, diffuse: -1, specular: -1, tex: []};
  let o = 0;
  switch (fvf & FVF.POSITION_MASK){
    case 0x002: o = 12; break;
    case 0x004: L.rhw = true; L.posSize = 4; o = 16; break;
    case 0x006: case 0x008: case 0x00a: case 0x00c: case 0x00e:     // XYZB1..B5 (weights are skipped: VERTEXBLEND unused)
      L.weights = ((fvf & FVF.POSITION_MASK) - 4) / 2; o = 12 + 4 * L.weights; break;
    default: o = 0;
  }
  if (fvf & FVF.NORMAL){ L.normal = o; o += 12; }
  if (fvf & FVF.PSIZE){ L.psize = o; o += 4; }
  if (fvf & FVF.DIFFUSE){ L.diffuse = o; o += 4; }
  if (fvf & FVF.SPECULAR){ L.specular = o; o += 4; }
  const n = (fvf & FVF.TEXCOUNT_MASK) >> FVF.TEXCOUNT_SHIFT;
  for (let i = 0; i < n; i++){
    const size = [2, 3, 4, 1][(fvf >>> (16 + 2 * i)) & 3];
    L.tex.push({off: o, size}); o += 4 * size;
  }
  L.stride = o;
  return L;
}

/** Bytes per pixel (or per 4x4 block for DXT) and the pitch of one surface level, as D3D8 reports it. */
export function formatInfo(fmt){
  switch (fmt){
    case FMT.DXT1: return {block: 8};
    case FMT.DXT2: case FMT.DXT3: case FMT.DXT4: case FMT.DXT5: return {block: 16};
    case FMT.A8R8G8B8: case FMT.X8R8G8B8: return {bpp: 4};
    case FMT.R8G8B8: return {bpp: 3};
    case FMT.R5G6B5: case FMT.X1R5G5B5: case FMT.A1R5G5B5: case FMT.A4R4G4B4: case FMT.X4R4G4B4: case FMT.A8L8: return {bpp: 2};
    case FMT.A8: case FMT.L8: return {bpp: 1};
    default: return null;
  }
}
export function levelLayout(fmt, w, h){
  const fi = formatInfo(fmt);
  if (fi.block){ const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2); return {pitch: bw * fi.block, rows: bh, size: bw * bh * fi.block}; }
  return {pitch: w * fi.bpp, rows: h, size: w * h * fi.bpp};
}

/* ------------------------------------------------------------------ DXT decode (fallback when S3TC is missing) */
function rgb565(c){ return [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0]; }
export function decodeDXT(fmt, src, w, h){
  const out = new Uint8Array(w * h * 4), bs = fmt === FMT.DXT1 ? 8 : 16, bw = Math.max(1, (w + 3) >> 2);
  for (let by = 0; by < Math.max(1, (h + 3) >> 2); by++) for (let bx = 0; bx < bw; bx++){
    const b = (by * bw + bx) * bs, cb = b + (bs - 8);
    const c0 = src[cb] | src[cb + 1] << 8, c1 = src[cb + 2] | src[cb + 3] << 8;
    const p0 = rgb565(c0), p1 = rgb565(c1), pal = [p0.concat(255), p1.concat(255)];
    if (fmt !== FMT.DXT1 || c0 > c1){
      pal.push([0, 1, 2].map(i => (2 * p0[i] + p1[i]) / 3 | 0).concat(255), [0, 1, 2].map(i => (p0[i] + 2 * p1[i]) / 3 | 0).concat(255));
    } else pal.push([0, 1, 2].map(i => (p0[i] + p1[i]) >> 1).concat(255), [0, 0, 0, 0]);
    let alphas = null;
    if (fmt === FMT.DXT5 || fmt === FMT.DXT4){
      const a0 = src[b], a1 = src[b + 1]; alphas = [a0, a1];
      if (a0 > a1) for (let i = 1; i < 7; i++) alphas.push(((7 - i) * a0 + i * a1) / 7 | 0);
      else { for (let i = 1; i < 5; i++) alphas.push(((5 - i) * a0 + i * a1) / 5 | 0); alphas.push(0, 255); }
    }
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++){
      const x = bx * 4 + px, y = by * 4 + py; if (x >= w || y >= h) continue;
      const i = py * 4 + px, ci = (src[cb + 4 + py] >> (2 * px)) & 3, o = (y * w + x) * 4, c = pal[ci];
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
      if (fmt === FMT.DXT3 || fmt === FMT.DXT2) out[o + 3] = ((src[b + (i >> 1)] >> (4 * (i & 1))) & 15) * 17;
      else if (alphas){
        const bit = 3 * i, lo = b + 2 + (bit >> 3), v = (src[lo] | (src[lo + 1] || 0) << 8) >> (bit & 7);
        out[o + 3] = alphas[v & 7];
      }
    }
  }
  return out;
}

/** Any uncompressed D3D format -> RGBA8 (row-major, top row first: same orientation as D3D memory). */
export function toRGBA8(fmt, src, w, h, pitch){
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
    const o = (y * w + x) * 4; let r, g, b, a = 255;
    switch (fmt){
      case FMT.A8R8G8B8: case FMT.X8R8G8B8: { const s = y * pitch + x * 4; b = src[s]; g = src[s + 1]; r = src[s + 2]; if (fmt === FMT.A8R8G8B8) a = src[s + 3]; break; }
      case FMT.R8G8B8: { const s = y * pitch + x * 3; b = src[s]; g = src[s + 1]; r = src[s + 2]; break; }
      case FMT.R5G6B5: { const s = y * pitch + x * 2, c = src[s] | src[s + 1] << 8; [r, g, b] = rgb565(c); break; }
      case FMT.X1R5G5B5: case FMT.A1R5G5B5: { const s = y * pitch + x * 2, c = src[s] | src[s + 1] << 8;
        r = ((c >> 10) & 31) * 255 / 31 | 0; g = ((c >> 5) & 31) * 255 / 31 | 0; b = (c & 31) * 255 / 31 | 0; if (fmt === FMT.A1R5G5B5) a = c & 0x8000 ? 255 : 0; break; }
      case FMT.A4R4G4B4: case FMT.X4R4G4B4: { const s = y * pitch + x * 2, c = src[s] | src[s + 1] << 8;
        r = ((c >> 8) & 15) * 17; g = ((c >> 4) & 15) * 17; b = (c & 15) * 17; if (fmt === FMT.A4R4G4B4) a = (c >> 12) * 17; break; }
      case FMT.A8: { r = g = b = 0; a = src[y * pitch + x]; break; }
      case FMT.L8: { r = g = b = src[y * pitch + x]; break; }
      case FMT.A8L8: { const s = y * pitch + x * 2; r = g = b = src[s]; a = src[s + 1]; break; }
      default: r = 255; g = 0; b = 255;
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
  return out;
}
/** RGBA8 -> D3D format (used by CopyRects / D3DXLoadSurface* HLE). */
export function fromRGBA8(fmt, rgba, w, h, dst, pitch){
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
    const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
    switch (fmt){
      case FMT.A8R8G8B8: case FMT.X8R8G8B8: { const s = y * pitch + x * 4; dst[s] = b; dst[s + 1] = g; dst[s + 2] = r; dst[s + 3] = fmt === FMT.A8R8G8B8 ? a : 255; break; }
      case FMT.R5G6B5: { const s = y * pitch + x * 2, c = (r >> 3) << 11 | (g >> 2) << 5 | b >> 3; dst[s] = c & 255; dst[s + 1] = c >> 8; break; }
      case FMT.A1R5G5B5: case FMT.X1R5G5B5: { const s = y * pitch + x * 2, c = (a >= 128 || fmt === FMT.X1R5G5B5 ? 0x8000 : 0) | (r >> 3) << 10 | (g >> 3) << 5 | b >> 3; dst[s] = c & 255; dst[s + 1] = c >> 8; break; }
      case FMT.A4R4G4B4: { const s = y * pitch + x * 2, c = (a >> 4) << 12 | (r >> 4) << 8 | (g >> 4) << 4 | b >> 4; dst[s] = c & 255; dst[s + 1] = c >> 8; break; }
      case FMT.A8: dst[y * pitch + x] = a; break;
      default: throw new Error("fromRGBA8: format " + fmt);
    }
  }
}

/* ------------------------------------------------------------------ resources */
let nextId = 1;
class Resource { constructor(dev){ this.dev = dev; this.refs = 1; this.id = nextId++; } AddRef(){ return ++this.refs; }
  Release(){ const r = --this.refs; if (r === 0) this.destroy(); return r; } destroy(){} }

/** System-memory backing store. In the wasm build `alloc` returns a view into wasm memory (ptr = its address),
 *  so Lock can hand the game a real pointer; standalone it is a plain ArrayBuffer (ptr = 0). */
function defaultAlloc(size){ return {ptr: 0, u8: new Uint8Array(size), free(){}}; }

export class Texture extends Resource {
  constructor(dev, w, h, levels, usage, fmt, pool){
    super(dev);
    if (!formatInfo(fmt)) throw new Error("unsupported texture format " + fmt);
    if (!levels){ levels = 1; for (let s = Math.max(w, h); s > 1; s >>= 1) levels++; }
    Object.assign(this, {w, h, levels, usage, fmt, pool, lod: 0});
    this.lv = [];
    for (let l = 0; l < levels; l++){
      const lw = Math.max(1, w >> l), lh = Math.max(1, h >> l), lay = levelLayout(fmt, lw, lh);
      this.lv.push({w: lw, h: lh, ...lay, mem: dev.alloc(lay.size), dirty: true});
    }
    const gl = dev.gl;
    this.tex = gl.createTexture();
    this.alphaOnly = fmt === FMT.A8;
  }
  GetLevelCount(){ return this.levels; }
  GetLevelDesc(l){ const v = this.lv[l]; return {Format: this.fmt, Type: 3, Usage: this.usage, Pool: this.pool, Size: v.size, Width: v.w, Height: v.h}; }
  GetSurfaceLevel(l){ this.AddRef(); return new Surface(this.dev, this, l); }
  /** returns {pitch, ptr, bytes}: bytes = view starting at the locked rect's first byte. */
  LockRect(l, rect, flags){
    const v = this.lv[l]; if (!v) return null;
    let off = 0;
    if (rect){ const fi = formatInfo(this.fmt); off = fi.block ? (rect.top >> 2) * v.pitch + (rect.left >> 2) * fi.block : rect.top * v.pitch + rect.left * fi.bpp; }
    v.locked = !(flags & LOCK.READONLY);
    return {pitch: v.pitch, ptr: v.mem.ptr + off, bytes: v.mem.u8.subarray(off)};
  }
  UnlockRect(l){ const v = this.lv[l]; if (v && v.locked){ v.dirty = true; v.locked = false; this.dev.dirtyTex.add(this); } return HR.OK; }
  /** Upload dirty levels to GL (called lazily at draw time). */
  upload(){
    const gl = this.dev.gl, s3tc = this.dev.s3tc;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let l = 0; l < this.levels; l++){
      const v = this.lv[l]; if (!v.dirty) continue; v.dirty = false;
      const src = v.mem.u8.subarray(0, v.size);
      // WebGL S3TC rule: level 0 must be a multiple of 4; deeper levels may also be 1 or 2 wide/high
      const dimsOK = (d => d % 4 === 0 || (l > 0 && d < 4))(v.w) && (d => d % 4 === 0 || (l > 0 && d < 4))(v.h);
      if (isDXT(this.fmt) && s3tc && dimsOK && !this.forceCPU){
        const ifmt = {[FMT.DXT1]: s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT, [FMT.DXT2]: s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT, [FMT.DXT3]: s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT,
          [FMT.DXT4]: s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT, [FMT.DXT5]: s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT}[this.fmt];
        gl.compressedTexImage2D(gl.TEXTURE_2D, l, ifmt, v.w, v.h, 0, src);
      } else if (isDXT(this.fmt)){
        gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA8, v.w, v.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, decodeDXT(this.fmt, src, v.w, v.h));
      } else if (this.fmt === FMT.A8){
        // legacy unsized ALPHA samples as (0,0,0,a): exactly D3D's A8 rule
        const tight = new Uint8Array(v.w * v.h); for (let y = 0; y < v.h; y++) tight.set(src.subarray(y * v.pitch, y * v.pitch + v.w), y * v.w);
        gl.texImage2D(gl.TEXTURE_2D, l, gl.ALPHA, v.w, v.h, 0, gl.ALPHA, gl.UNSIGNED_BYTE, tight);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA8, v.w, v.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, toRGBA8(this.fmt, src, v.w, v.h, v.pitch));
      }
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, this.levels - 1);
  }
  destroy(){ this.dev.gl.deleteTexture(this.tex); this.lv.forEach(v => v.mem.free()); this.dev.dirtyTex.delete(this); }
}

export class Surface extends Resource {
  /** tex = owning Texture (level l) or null for the back buffer */
  constructor(dev, tex, l){ super(dev); this.tex = tex; this.level = l; }
  GetDesc(){ if (!this.tex) return {Format: this.dev.backFormat, Width: this.dev.width, Height: this.dev.height}; const d = this.tex.GetLevelDesc(this.level); d.Type = 1; return d; }
  LockRect(rect, flags){ return this.tex ? this.tex.LockRect(this.level, rect, flags) : null; }
  UnlockRect(){ return this.tex ? this.tex.UnlockRect(this.level) : HR.OK; }
  destroy(){ if (this.tex) this.tex.Release(); }
}

export class Buffer extends Resource {
  /** kind: "vb" | "ib" */
  constructor(dev, kind, length, usage, fmtOrFvf, pool){
    super(dev);
    Object.assign(this, {kind, length, usage, pool, fvf: kind === "vb" ? fmtOrFvf : 0, ifmt: kind === "ib" ? fmtOrFvf : 0});
    this.mem = dev.alloc(length);
    const gl = dev.gl; this.buf = gl.createBuffer();
    this.target = kind === "vb" ? gl.ARRAY_BUFFER : gl.ELEMENT_ARRAY_BUFFER;
    gl.bindBuffer(this.target, this.buf); gl.bufferData(this.target, length, (usage & 0x200) ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    if (this.target === gl.ELEMENT_ARRAY_BUFFER) gl.bindBuffer(this.target, null);
    this.dirtyLo = Infinity; this.dirtyHi = 0;
  }
  GetDesc(){ return {Format: this.kind === "vb" ? 0 : this.ifmt, Type: this.kind === "vb" ? 6 : 7, Usage: this.usage, Pool: this.pool, Size: this.length, FVF: this.fvf}; }
  /** Lock(offset, size, flags) -> {ptr, bytes}. size 0 = whole buffer. DISCARD/NOOVERWRITE need nothing special:
   *  GL uploads are ordered with the draws, and the CPU copy is the source of truth. */
  Lock(offset, size, flags){
    if (!size) size = this.length - offset;
    if (!(flags & LOCK.READONLY)){ this.dirtyLo = Math.min(this.dirtyLo, offset); this.dirtyHi = Math.max(this.dirtyHi, offset + size); }
    return {ptr: this.mem.ptr + offset, bytes: this.mem.u8.subarray(offset, offset + size)};
  }
  Unlock(){ this.flush(); return HR.OK; }
  flush(){
    if (this.dirtyHi <= this.dirtyLo) return;
    const gl = this.dev.gl;
    if (this.kind === "ib") gl.bindVertexArray(null);
    gl.bindBuffer(this.target, this.buf);
    gl.bufferSubData(this.target, this.dirtyLo, this.mem.u8, this.dirtyLo, this.dirtyHi - this.dirtyLo);
    this.dirtyLo = Infinity; this.dirtyHi = 0;
  }
  destroy(){ this.dev.gl.deleteBuffer(this.buf); this.mem.free(); }
}

/* ------------------------------------------------------------------ fixed-function shader generator */
const RS_KEY = [RS.LIGHTING, RS.FOGENABLE, RS.FOGTABLEMODE, RS.FOGVERTEXMODE, RS.SPECULARENABLE, RS.ALPHATESTENABLE, RS.ALPHAFUNC,
  RS.COLORVERTEX, RS.DIFFUSEMATERIALSOURCE, RS.SPECULARMATERIALSOURCE, RS.AMBIENTMATERIALSOURCE, RS.EMISSIVEMATERIALSOURCE, RS.LOCALVIEWER];

/** Everything that changes the generated GLSL, as a compact string (program cache key). */
export function shaderKey(dev, L){
  const rs = dev.rs, parts = [L.fvf.toString(16)];
  for (const s of RS_KEY) parts.push(rs[s]);
  const lit = rs[RS.LIGHTING] && !L.rhw;
  if (lit) parts.push("L" + dev.activeLights().map(l => l.Type).join(""));
  for (let s = 0; s < 8; s++){
    const t = dev.tss[s]; if (t[TSS.COLOROP] === TOP.DISABLE) break;
    parts.push(`s${s}:${t[TSS.COLOROP]},${t[TSS.COLORARG0]},${t[TSS.COLORARG1]},${t[TSS.COLORARG2]},${t[TSS.ALPHAOP]},${t[TSS.ALPHAARG0]},${t[TSS.ALPHAARG1]},${t[TSS.ALPHAARG2]},${t[TSS.RESULTARG]},${t[TSS.TEXCOORDINDEX]},${t[TSS.TEXTURETRANSFORMFLAGS]},${dev.textures[s] ? 1 : 0}`);
  }
  return parts.join("|");
}

function argExpr(a, stage, alpha){
  let base;
  switch (a & 0xf){
    case TA.DIFFUSE: base = "vDif"; break; case TA.CURRENT: base = stage === 0 ? "vDif" : "cur"; break;
    case TA.TEXTURE: base = `t${stage}`; break; case TA.TFACTOR: base = "uTF"; break; case TA.SPECULAR: base = "vSpe"; break;
    case TA.TEMP: base = "tmp"; break; default: base = "vec4(1.0)";
  }
  if (a & TA.ALPHAREPLICATE) base = `${base}.aaaa`;
  if (a & TA.COMPLEMENT) base = `(vec4(1.0)-${base})`;
  return alpha ? `${base}.a` : `${base}.rgb`;
}
/** GLSL for one combiner op; `c` selects colour (vec3) vs alpha (float) form. */
function opExpr(op, a0, a1, a2, s, c){
  const T = c ? "vec3" : "float", one = `${T}(1.0)`, half = `${T}(0.5)`;
  switch (op){
    case TOP.SELECTARG1: return a1; case TOP.SELECTARG2: return a2;
    case TOP.MODULATE: return `${a1}*${a2}`; case TOP.MODULATE2X: return `2.0*${a1}*${a2}`; case TOP.MODULATE4X: return `4.0*${a1}*${a2}`;
    case TOP.ADD: return `${a1}+${a2}`; case TOP.ADDSIGNED: return `${a1}+${a2}-${half}`; case TOP.ADDSIGNED2X: return `2.0*(${a1}+${a2}-${half})`;
    case TOP.SUBTRACT: return `${a1}-${a2}`; case TOP.ADDSMOOTH: return `${a1}+${a2}*(${one}-${a1})`;
    case TOP.BLENDDIFFUSEALPHA: return `mix(${a2},${a1},vDif.a)`; case TOP.BLENDTEXTUREALPHA: return `mix(${a2},${a1},t${s}.a)`;
    case TOP.BLENDFACTORALPHA: return `mix(${a2},${a1},uTF.a)`; case TOP.BLENDCURRENTALPHA: return `mix(${a2},${a1},${s ? "cur" : "vDif"}.a)`;
    case TOP.BLENDTEXTUREALPHAPM: return `${a1}+${a2}*(1.0-t${s}.a)`;
    case TOP.PREMODULATE: return a1;                                  // [I] needs next stage's texture; not used by the game
    case TOP.MODULATEALPHA_ADDCOLOR: return c ? `${a1}+${a1.replace(/\.rgb$/, ".a")}*${a2}` : a1;
    case TOP.MODULATECOLOR_ADDALPHA: return c ? `${a1}*${a2}+${a1.replace(/\.rgb$/, ".a")}` : a1;
    case TOP.MODULATEINVALPHA_ADDCOLOR: return c ? `(1.0-${a1.replace(/\.rgb$/, ".a")})*${a2}+${a1}` : a1;
    case TOP.MODULATEINVCOLOR_ADDALPHA: return c ? `(vec3(1.0)-${a1})*${a2}+${a1.replace(/\.rgb$/, ".a")}` : a1;
    case TOP.DOTPRODUCT3: return c ? `vec3(clamp(4.0*dot(${a1}-vec3(0.5),${a2}-vec3(0.5)),0.0,1.0))` : "dp3";
    case TOP.MULTIPLYADD: return `${a0}+${a1}*${a2}`;
    case TOP.LERP: return `mix(${a2},${a1},${a0})`;
    default: return a1;                                               // BUMPENVMAP*: unsupported, pass arg1
  }
}

export function genShaders(dev, L){
  const rs = dev.rs, lit = rs[RS.LIGHTING] && !L.rhw, lights = lit ? dev.activeLights() : [];
  const fogOn = !!rs[RS.FOGENABLE], fogTable = rs[RS.FOGTABLEMODE], fogVert = rs[RS.FOGVERTEXMODE];
  const stages = [];
  for (let s = 0; s < 8; s++){ const t = dev.tss[s]; if (t[TSS.COLOROP] === TOP.DISABLE) break; stages.push(t); }
  const needN = lit || stages.some(t => (t[TSS.TEXCOORDINDEX] & 0xffff0000) === TCI.CAMERASPACENORMAL || (t[TSS.TEXCOORDINDEX] & 0xffff0000) === TCI.CAMERASPACEREFLECTIONVECTOR);
  let vs = `#version 300 es
precision highp float;
layout(location=0) in vec4 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec4 aDif;
layout(location=3) in vec4 aSpe;
${L.tex.map((t, i) => `layout(location=${4 + i}) in vec4 aT${i};`).join("\n")}
uniform mat4 uWorld, uView, uProj, uTexM[8];
uniform vec4 uVp;      // viewport x, y, w, h (pixels)
uniform vec2 uDepth;   // viewport MinZ, MaxZ
uniform vec4 uMatD, uMatA, uMatS, uMatE; uniform float uMatP; uniform vec4 uAmb;
uniform vec4 uLD[8], uLS[8], uLA[8], uLP[8], uLDir[8], uLAtt[8], uLSpot[8];
uniform vec4 uFog;     // start, end, density, -
out vec4 vDif, vSpe; out float vFog;
${stages.map((t, s) => `out vec4 vT${s};`).join("\n")}
void main(){
  vec4 dif = ${L.diffuse >= 0 ? "aDif.bgra" : "vec4(1.0)"};
  vec4 spe = ${L.specular >= 0 ? "aSpe.bgra" : "vec4(0.0)"};
  vec4 eye = vec4(0.0); vec3 N = vec3(0.0,0.0,1.0);
`;
  if (L.rhw){
    vs += `  float w = aPos.w > 0.0 ? 1.0 / aPos.w : 1.0;
  vec2 ndc = vec2((aPos.x - uVp.x) / uVp.z * 2.0 - 1.0, 1.0 - (aPos.y - uVp.y) / uVp.w * 2.0);
  float nz = uDepth.y > uDepth.x ? (aPos.z - uDepth.x) / (uDepth.y - uDepth.x) * 2.0 - 1.0 : aPos.z * 2.0 - 1.0;
  gl_Position = vec4(ndc, nz, 1.0) * w;
  eye = vec4(0.0, 0.0, w, 1.0);
`;
  } else {
    vs += `  eye = uView * (uWorld * vec4(aPos.xyz, 1.0));
  gl_Position = uProj * eye;
  gl_Position.z = 2.0 * gl_Position.z - gl_Position.w;
`;
    if (needN) vs += `  N = ${L.normal >= 0 ? "normalize(transpose(inverse(mat3(uView * uWorld))) * aNrm)" : "vec3(0.0)"};\n`;
  }
  vs += `  gl_Position.xy += vec2(1.0 / uVp.z, -1.0 / uVp.w) * gl_Position.w;   // D3D8 pixel centres\n`;
  if (lit){
    const src = (st, dflt) => {                // material colour source (COLORVERTEX + *MATERIALSOURCE)
      const v = rs[st];
      if (rs[RS.COLORVERTEX] && v === 1 && L.diffuse >= 0) return "dif";
      if (rs[RS.COLORVERTEX] && v === 2 && L.specular >= 0) return "spe";
      return dflt;
    };
    const Md = src(RS.DIFFUSEMATERIALSOURCE, "uMatD"), Ma = src(RS.AMBIENTMATERIALSOURCE, "uMatA"),
      Ms = src(RS.SPECULARMATERIALSOURCE, "uMatS"), Me = src(RS.EMISSIVEMATERIALSOURCE, "uMatE");
    vs += `  vec3 Ld = vec3(0.0), La = vec3(0.0), Ls = vec3(0.0); vec3 V = ${rs[RS.LOCALVIEWER] ? "normalize(-eye.xyz)" : "vec3(0.0,0.0,-1.0)"};\n`;
    lights.forEach((l, i) => {
      vs += `  { vec3 Lv; float att = 1.0, spot = 1.0;\n`;
      if (l.Type === LIGHT.DIRECTIONAL) vs += `    Lv = normalize(-uLDir[${i}].xyz);\n`;
      else {
        vs += `    vec3 d = uLP[${i}].xyz - eye.xyz; float dist = length(d); Lv = d / max(dist, 1e-6);
    att = dist > uLAtt[${i}].w ? 0.0 : 1.0 / max(uLAtt[${i}].x + uLAtt[${i}].y * dist + uLAtt[${i}].z * dist * dist, 1e-6);\n`;
        if (l.Type === LIGHT.SPOT) vs += `    float rho = dot(normalize(-uLDir[${i}].xyz), Lv);
    spot = rho > uLSpot[${i}].x ? 1.0 : (rho <= uLSpot[${i}].y ? 0.0 : pow(max((rho - uLSpot[${i}].y) / max(uLSpot[${i}].x - uLSpot[${i}].y, 1e-6), 0.0), uLSpot[${i}].z));\n`;
      }
      vs += `    float k = att * spot, nl = max(dot(N, Lv), 0.0);
    La += uLA[${i}].rgb * k; Ld += uLD[${i}].rgb * nl * k;
    ${rs[RS.SPECULARENABLE] ? `if (nl > 0.0) Ls += uLS[${i}].rgb * pow(max(dot(N, normalize(Lv + V)), 0.0), uMatP) * k;` : ""} }\n`;
    });
    vs += `  vec4 md = ${Md};
  dif = vec4(clamp(${Me}.rgb + ${Ma}.rgb * (uAmb.rgb + La) + md.rgb * Ld, 0.0, 1.0), md.a);
  spe = vec4(clamp(${Ms}.rgb * Ls, 0.0, 1.0), spe.a);\n`;
  }
  vs += `  vDif = dif; vSpe = spe;\n`;
  // fog factor input: eye depth for table fog, computed factor for vertex fog, specular alpha otherwise
  if (fogOn){
    if (fogTable) vs += `  vFog = abs(eye.z);\n`;
    else if (fogVert && !L.rhw) vs += `  { float d = abs(eye.z); vFog = ${fogExpr(fogVert, "d")}; }\n`;
    else vs += `  vFog = spe.a;\n`;
  } else vs += `  vFog = 1.0;\n`;
  // texture coordinates per stage: TEXCOORDINDEX (set + generation mode), then the texture transform
  stages.forEach((t, s) => {
    const tci = t[TSS.TEXCOORDINDEX], gen = tci & 0xffff0000, set = tci & 0xffff, ttf = t[TSS.TEXTURETRANSFORMFLAGS];
    let v;
    if (gen === TCI.CAMERASPACENORMAL) v = "vec4(N, 1.0)";
    else if (gen === TCI.CAMERASPACEPOSITION) v = "vec4(eye.xyz, 1.0)";
    else if (gen === TCI.CAMERASPACEREFLECTIONVECTOR) v = "vec4(reflect(normalize(eye.xyz), N), 1.0)";
    else if (L.tex[set]){ const n = L.tex[set].size; v = ["", `vec4(aT${set}.x, 1.0, 0.0, 0.0)`, `vec4(aT${set}.xy, 1.0, 0.0)`, `vec4(aT${set}.xyz, 1.0)`, `aT${set}`][n]; }
    else v = "vec4(0.0, 0.0, 1.0, 0.0)";
    if ((ttf & 0xff) !== 0) v = `(uTexM[${s}] * ${v})`;
    vs += `  vT${s} = ${v};\n`;
  });
  vs += "}\n";

  let fs = `#version 300 es
precision highp float;
in vec4 vDif, vSpe; in float vFog;
${stages.map((t, s) => `in vec4 vT${s}; uniform sampler2D uS${s};`).join("\n")}
uniform vec4 uTF, uFogC, uFog; uniform float uARef;
out vec4 oCol;
void main(){
  vec4 cur = vDif, tmp = vec4(0.0); float dp3;
`;
  stages.forEach((t, s) => {
    const ttf = t[TSS.TEXTURETRANSFORMFLAGS], proj = (ttf & 256) !== 0, cnt = ttf & 0xff;
    const uv = proj ? `vT${s}.xy / vT${s}.${"xyzw"[Math.max(1, cnt) - 1]}` : `vT${s}.xy`;
    fs += `  vec4 t${s} = ${dev.textures[s] ? `texture(uS${s}, ${uv})` : "vec4(1.0)"};\n`;
    const cop = t[TSS.COLOROP], aop = t[TSS.ALPHAOP];
    const ca = [0, 1, 2].map(i => argExpr(t[[TSS.COLORARG0, TSS.COLORARG1, TSS.COLORARG2][i]], s, false));
    const aa = [0, 1, 2].map(i => argExpr(t[[TSS.ALPHAARG0, TSS.ALPHAARG1, TSS.ALPHAARG2][i]], s, true));
    const dst = (t[TSS.RESULTARG] & 0xf) === TA.TEMP ? "tmp" : "cur";
    if (cop === TOP.DOTPRODUCT3) fs += `  dp3 = clamp(4.0*dot(${ca[1]}-vec3(0.5),${ca[2]}-vec3(0.5)),0.0,1.0);\n`;
    fs += `  { vec3 rc = clamp(${opExpr(cop, ...ca, s, true)}, 0.0, 1.0);\n`;
    // ALPHAOP DISABLE with colour enabled: alpha passes through from the previous stage (diffuse on stage 0)
    const al = aop === TOP.DISABLE ? `${s ? "cur" : "vDif"}.a` : (cop === TOP.DOTPRODUCT3 ? "dp3" : opExpr(aop, ...aa, s, false));
    fs += `    float ra = clamp(${al}, 0.0, 1.0); ${dst} = vec4(rc, ra); }\n`;
  });
  if (rs[RS.SPECULARENABLE]) fs += `  cur.rgb = clamp(cur.rgb + vSpe.rgb, 0.0, 1.0);\n`;
  if (fogOn){
    if (fogTable) fs += `  float f = ${fogExpr(fogTable, "vFog")};\n`; else fs += `  float f = clamp(vFog, 0.0, 1.0);\n`;
    fs += `  cur.rgb = mix(uFogC.rgb, cur.rgb, f);\n`;
  }
  if (rs[RS.ALPHATESTENABLE]){
    const cmp = ["false", "false", "a < r", "a == r", "a <= r", "a > r", "a != r", "a >= r", "true"][rs[RS.ALPHAFUNC]] || "true";
    fs += `  { float a = floor(cur.a * 255.0 + 0.5), r = uARef; if (!(${cmp})) discard; }\n`;
  }
  fs += `  oCol = cur;\n}\n`;
  return {vs, fs, stages: stages.length, lights};
}
function fogExpr(mode, d){
  if (mode === 1) return `clamp(exp(-${d} * uFog.z), 0.0, 1.0)`;
  if (mode === 2) return `clamp(exp(-(${d} * uFog.z) * (${d} * uFog.z)), 0.0, 1.0)`;
  return `clamp((uFog.y - ${d}) / max(uFog.y - uFog.x, 1e-6), 0.0, 1.0)`;
}

/* ------------------------------------------------------------------ the device */
const GLBLEND = gl => [0, gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA,
  gl.ONE_MINUS_DST_ALPHA, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA_SATURATE];
const GLSTENCILOP = gl => [0, gl.KEEP, gl.ZERO, gl.REPLACE, gl.INCR, gl.DECR, gl.INVERT, gl.INCR_WRAP, gl.DECR_WRAP];

function rsDefaults(){
  const r = new Uint32Array(256);
  const set = (k, v) => r[k] = v >>> 0;
  set(RS.ZENABLE, 1); set(RS.FILLMODE, 3); set(RS.SHADEMODE, 2); set(RS.ZWRITEENABLE, 1); set(RS.LASTPIXEL, 1);
  set(RS.SRCBLEND, 2); set(RS.DESTBLEND, 1); set(RS.CULLMODE, 3); set(RS.ZFUNC, 4); set(RS.ALPHAFUNC, 8); set(RS.FOGEND, asBits(1));
  set(RS.FOGDENSITY, asBits(1)); set(RS.STENCILFAIL, 1); set(RS.STENCILZFAIL, 1); set(RS.STENCILPASS, 1); set(RS.STENCILFUNC, 8);
  set(RS.STENCILMASK, -1); set(RS.STENCILWRITEMASK, -1); set(RS.TEXTUREFACTOR, -1); set(RS.CLIPPING, 1); set(RS.LIGHTING, 1);
  set(RS.COLORVERTEX, 1); set(RS.LOCALVIEWER, 1); set(RS.DIFFUSEMATERIALSOURCE, 1); set(RS.SPECULARMATERIALSOURCE, 2);
  set(RS.COLORWRITEENABLE, 15); set(RS.BLENDOP, 1);
  return r;
}
function tssDefaults(s){
  const t = new Uint32Array(32);
  t[TSS.COLOROP] = s ? TOP.DISABLE : TOP.MODULATE; t[TSS.COLORARG1] = TA.TEXTURE; t[TSS.COLORARG2] = TA.CURRENT;
  t[TSS.ALPHAOP] = s ? TOP.DISABLE : TOP.SELECTARG1; t[TSS.ALPHAARG1] = TA.TEXTURE; t[TSS.ALPHAARG2] = TA.CURRENT;
  t[TSS.TEXCOORDINDEX] = s; t[TSS.ADDRESSU] = t[TSS.ADDRESSV] = t[TSS.ADDRESSW] = 1; t[TSS.MAGFILTER] = t[TSS.MINFILTER] = 1;
  t[TSS.MAXANISOTROPY] = 1; t[TSS.COLORARG0] = t[TSS.ALPHAARG0] = TA.CURRENT; t[TSS.RESULTARG] = TA.CURRENT;
  return t;
}

export class Device {
  /** opts: {width, height, alloc(size) -> {ptr, u8, free}, backFormat} */
  constructor(gl, opts = {}){
    this.gl = gl;
    this.width = opts.width || gl.canvas.width; this.height = opts.height || gl.canvas.height;
    this.alloc = opts.alloc || defaultAlloc;
    this.backFormat = opts.backFormat || FMT.X8R8G8B8;
    this.s3tc = opts.noS3TC ? null : gl.getExtension("WEBGL_compressed_texture_s3tc");
    this.aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    this.rs = rsDefaults(); this.tss = [...Array(8)].map((_, s) => tssDefaults(s));
    this.textures = new Array(8).fill(null);
    this.xf = new Map([[TS.WORLD, IDENT()], [TS.VIEW, IDENT()], [TS.PROJECTION, IDENT()]]);
    for (let i = 0; i < 8; i++) this.xf.set(TS.TEXTURE0 + i, IDENT());
    this.vp = {X: 0, Y: 0, Width: this.width, Height: this.height, MinZ: 0, MaxZ: 1};
    this.mat = {Diffuse: [1, 1, 1, 1], Ambient: [0, 0, 0, 0], Specular: [0, 0, 0, 0], Emissive: [0, 0, 0, 0], Power: 0};
    this.lights = new Map(); this.lightOn = new Set();
    this.fvf = 0; this.stream = {vb: null, stride: 0}; this.indices = {ib: null, base: 0};
    this.dirtyTex = new Set(); this.programs = new Map(); this.samplers = new Map();
    this.blocks = new Map(); this.recording = null; this.nextBlock = 1;
    this.gamma = null; this.inScene = false; this.stats = {draws: 0, programs: 0, prims: 0};
    this.initGL();
  }
  initGL(){
    const gl = this.gl, W = this.width, H = this.height;
    // back buffer = FBO (colour RGBA8 + depth24/stencil8), shown by Present()
    this.fbo = gl.createFramebuffer(); this.color = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.color);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.depth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    this.vao = gl.createVertexArray(); this.upBuf = gl.createBuffer(); this.upIdx = gl.createBuffer();
    // present pass (gamma LUT)
    const vs = `#version 300 es
out vec2 uv; void main(){ vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1); uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
    const fs = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D uC, uG; uniform int uUseG; out vec4 o;
void main(){ vec4 c = texture(uC, uv); if (uUseG == 1) c.rgb = vec3(texture(uG, vec2(c.r, 0.5)).r, texture(uG, vec2(c.g, 0.5)).g, texture(uG, vec2(c.b, 0.5)).b); o = vec4(c.rgb, 1.0); }`;
    this.presentProg = this.link(vs, fs);
    this.gammaTex = gl.createTexture();
  }
  link(vs, fs){
    const gl = this.gl, p = gl.createProgram();
    for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]){
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + "\n" + src);
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  /* -------------------------------------------------- state setters (recorded inside Begin/EndStateBlock) */
  rec(fn, args){ if (this.recording){ this.recording.push([fn, args]); return true; } return false; }
  SetRenderState(s, v){ if (this.rec("SetRenderState", [s, v])) return HR.OK; this.rs[s] = v >>> 0; return HR.OK; }
  GetRenderState(s){ return this.rs[s]; }
  SetTextureStageState(st, s, v){ if (this.rec("SetTextureStageState", [st, s, v])) return HR.OK; if (st < 8) this.tss[st][s] = v >>> 0; return HR.OK; }
  GetTextureStageState(st, s){ return this.tss[st][s]; }
  SetTexture(st, tex){
    if (this.rec("SetTexture", [st, tex])) return HR.OK;
    if (tex) tex.AddRef(); if (this.textures[st]) this.textures[st].Release(); this.textures[st] = tex || null; return HR.OK;
  }
  /** m: Float32Array(16) in D3D memory order */
  SetTransform(t, m){ if (this.rec("SetTransform", [t, Float32Array.from(m)])) return HR.OK; this.xf.set(t, Float32Array.from(m)); return HR.OK; }
  GetTransform(t){ return Float32Array.from(this.xf.get(t) || IDENT()); }
  MultiplyTransform(t, m){ const a = this.xf.get(t) || IDENT(), o = new Float32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++){ let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * m[k * 4 + c]; o[r * 4 + c] = s; }
    return this.SetTransform(t, o); }
  SetViewport(vp){ if (this.rec("SetViewport", [{...vp}])) return HR.OK; this.vp = {...vp}; return HR.OK; }
  GetViewport(){ return {...this.vp}; }
  SetMaterial(m){ if (this.rec("SetMaterial", [m])) return HR.OK; this.mat = JSON.parse(JSON.stringify(m)); return HR.OK; }
  /** l: D3DLIGHT8 as {Type, Diffuse, Specular, Ambient, Position, Direction, Range, Falloff, Attenuation0..2, Theta, Phi} */
  SetLight(i, l){ if (this.rec("SetLight", [i, l])) return HR.OK; this.lights.set(i, JSON.parse(JSON.stringify(l))); return HR.OK; }
  LightEnable(i, on){ if (this.rec("LightEnable", [i, on])) return HR.OK;
    if (!this.lights.has(i)) this.lights.set(i, {Type: LIGHT.DIRECTIONAL, Diffuse: [1, 1, 1, 0], Specular: [0, 0, 0, 0], Ambient: [0, 0, 0, 0], Position: [0, 0, 0], Direction: [0, 0, 1], Range: 0, Falloff: 0, Attenuation0: 0, Attenuation1: 0, Attenuation2: 0, Theta: 0, Phi: 0});
    if (on) this.lightOn.add(i); else this.lightOn.delete(i); return HR.OK; }
  activeLights(){ return [...this.lightOn].sort((a, b) => a - b).slice(0, 8).map(i => this.lights.get(i)); }
  SetVertexShader(fvf){ if (this.rec("SetVertexShader", [fvf])) return HR.OK; this.fvf = fvf; return HR.OK; }
  SetStreamSource(n, vb, stride){ if (this.rec("SetStreamSource", [n, vb, stride])) return HR.OK; if (n === 0) this.stream = {vb, stride}; return HR.OK; }
  SetIndices(ib, base){ if (this.rec("SetIndices", [ib, base])) return HR.OK; this.indices = {ib, base: base | 0}; return HR.OK; }

  /* state blocks: recorded calls are NOT applied while recording (Wine/D3D behaviour); Apply replays them */
  BeginStateBlock(){ this.recording = []; return HR.OK; }
  EndStateBlock(){ const h = this.nextBlock++; this.blocks.set(h, this.recording || []); this.recording = null; return h; }
  ApplyStateBlock(h){ const b = this.blocks.get(h); if (!b) return HR.INVALIDCALL; for (const [fn, a] of b) this[fn](...a); return HR.OK; }
  CaptureStateBlock(){ return HR.OK; }   // not called by the game
  DeleteStateBlock(h){ this.blocks.delete(h); return HR.OK; }

  /* -------------------------------------------------- resources */
  CreateTexture(w, h, levels, usage, fmt, pool){ return new Texture(this, w, h, levels, usage, fmt, pool); }
  CreateVertexBuffer(len, usage, fvf, pool){ return new Buffer(this, "vb", len, usage, fvf, pool); }
  CreateIndexBuffer(len, usage, fmt, pool){ return new Buffer(this, "ib", len, usage, fmt, pool); }
  GetRenderTarget(){ return new Surface(this, null, 0); }
  GetBackBuffer(){ return new Surface(this, null, 0); }
  /** CopyRects(src back buffer, rects|null, dst texture surface, points|null): screenshot / thumbnail path. */
  CopyRects(src, rects, dst, pts){
    const gl = this.gl, r = (rects && rects[0]) || {left: 0, top: 0, right: this.width, bottom: this.height};
    const w = r.right - r.left, h = r.bottom - r.top, px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(r.left, this.height - r.bottom, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const flip = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) flip.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    const p = (pts && pts[0]) || {x: 0, y: 0}, lk = dst.LockRect({left: p.x, top: p.y, right: p.x + w, bottom: p.y + h}, 0);
    fromRGBA8(dst.GetDesc().Format, flip, w, h, lk.bytes, lk.pitch); dst.UnlockRect();
    return HR.OK;
  }
  /* -------------------------------------------------- misc device calls the game makes */
  TestCooperativeLevel(){ return this.gl.isContextLost() ? HR.DEVICELOST : HR.OK; }
  GetAvailableTextureMem(){ return 256 << 20; }
  ResourceManagerDiscardBytes(){ return HR.OK; }
  ShowCursor(b){ this.gl.canvas.style.cursor = b ? "" : "none"; return 0; }
  ValidateDevice(){ return {hr: HR.OK, passes: 1}; }
  Reset(pp){ return HR.OK; }
  /** ramp: {red, green, blue}: 256 x uint16 each */
  SetGammaRamp(flags, ramp){
    const gl = this.gl, lut = new Uint8Array(256 * 4);
    let ident = true;
    for (let i = 0; i < 256; i++){ lut[i * 4] = ramp.red[i] >> 8; lut[i * 4 + 1] = ramp.green[i] >> 8; lut[i * 4 + 2] = ramp.blue[i] >> 8; lut[i * 4 + 3] = 255;
      if (lut[i * 4] !== i || lut[i * 4 + 1] !== i || lut[i * 4 + 2] !== i) ident = false; }
    gl.bindTexture(gl.TEXTURE_2D, this.gammaTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    this.gamma = ident ? null : ramp; return HR.OK;
  }
  GetGammaRamp(){ const r = [...Array(256)].map((_, i) => i * 257); return this.gamma || {red: r, green: r, blue: r}; }

  /* -------------------------------------------------- frame */
  BeginScene(){ this.inScene = true; return HR.OK; }
  EndScene(){ this.inScene = false; return HR.OK; }
  /** Clear(count, rects, flags, color, z, stencil): clears the viewport (or rects inside it) like D3D8. */
  Clear(count, rects, flags, color, z, stencil){
    const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const list = count && rects ? rects : [{left: this.vp.X, top: this.vp.Y, right: this.vp.X + this.vp.Width, bottom: this.vp.Y + this.vp.Height}];
    gl.enable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true); gl.depthMask(true); gl.stencilMask(0xff);
    const c = color4(color); gl.clearColor(c[0], c[1], c[2], this.backFormat === FMT.X8R8G8B8 ? 1 : c[3]);
    gl.clearDepth(z); gl.clearStencil(stencil);
    let bits = 0; if (flags & CLEAR.TARGET) bits |= gl.COLOR_BUFFER_BIT; if (flags & CLEAR.ZBUFFER) bits |= gl.DEPTH_BUFFER_BIT; if (flags & CLEAR.STENCIL) bits |= gl.STENCIL_BUFFER_BIT;
    for (const r of list){
      const x0 = Math.max(r.left, this.vp.X), y0 = Math.max(r.top, this.vp.Y), x1 = Math.min(r.right, this.vp.X + this.vp.Width), y1 = Math.min(r.bottom, this.vp.Y + this.vp.Height);
      if (x1 <= x0 || y1 <= y0) continue;
      gl.scissor(x0, this.height - y1, x1 - x0, y1 - y0); gl.clear(bits);
    }
    gl.disable(gl.SCISSOR_TEST);
    return HR.OK;
  }
  /** Present: blit the back buffer to the canvas through the gamma ramp. */
  Present(){
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true);
    gl.useProgram(this.presentProg); gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.color); gl.bindSampler(0, null);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.gammaTex); gl.bindSampler(1, null);
    gl.uniform1i(gl.getUniformLocation(this.presentProg, "uC"), 0); gl.uniform1i(gl.getUniformLocation(this.presentProg, "uG"), 1);
    gl.uniform1i(gl.getUniformLocation(this.presentProg, "uUseG"), this.gamma ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    return HR.OK;
  }
  /** Test helper: RGBA of back-buffer pixel (x, y) in D3D coordinates (top-left origin). */
  readPixel(x, y){ const gl = this.gl, p = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.readPixels(x, this.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return [...p]; }

  /* -------------------------------------------------- draw */
  applyGLState(){
    const gl = this.gl, rs = this.rs, B = GLBLEND(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(this.vp.X, this.height - this.vp.Y - this.vp.Height, this.vp.Width, this.vp.Height);
    gl.depthRange(this.vp.MinZ, this.vp.MaxZ);
    if (rs[RS.ZENABLE]){ gl.enable(gl.DEPTH_TEST); gl.depthFunc(0x200 + rs[RS.ZFUNC] - 1); } else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(!!rs[RS.ZWRITEENABLE]);
    const cull = rs[RS.CULLMODE];
    if (cull === 1) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(cull === 3 ? gl.CW : gl.CCW); }
    if (rs[RS.ALPHABLENDENABLE]){
      gl.enable(gl.BLEND);
      let s = rs[RS.SRCBLEND], d = rs[RS.DESTBLEND];
      if (s === 12){ s = 5; d = 6; } else if (s === 13){ s = 6; d = 5; }     // BOTHSRCALPHA / BOTHINVSRCALPHA
      gl.blendFunc(B[s] ?? gl.ONE, B[d] ?? gl.ZERO);
      gl.blendEquation([0, gl.FUNC_ADD, gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT, gl.MIN, gl.MAX][rs[RS.BLENDOP]] || gl.FUNC_ADD);
    } else gl.disable(gl.BLEND);
    const cw = rs[RS.COLORWRITEENABLE];
    // an X8R8G8B8 back buffer has no alpha: keep it at 1 so DESTALPHA blends read 1 like on D3D
    gl.colorMask(!!(cw & 1), !!(cw & 2), !!(cw & 4), !!(cw & 8) && this.backFormat !== FMT.X8R8G8B8);
    const zb = rs[RS.ZBIAS];
    if (zb){ gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-0.5 * zb, -2 * zb); } else gl.disable(gl.POLYGON_OFFSET_FILL);   // [I] scale
    if (rs[RS.STENCILENABLE]){
      const O = GLSTENCILOP(gl);
      gl.enable(gl.STENCIL_TEST); gl.stencilFunc(0x200 + rs[RS.STENCILFUNC] - 1, rs[RS.STENCILREF], rs[RS.STENCILMASK]);
      gl.stencilOp(O[rs[RS.STENCILFAIL]], O[rs[RS.STENCILZFAIL]], O[rs[RS.STENCILPASS]]); gl.stencilMask(rs[RS.STENCILWRITEMASK]);
    } else gl.disable(gl.STENCIL_TEST);
  }
  sampler(st){
    const gl = this.gl, t = this.tss[st], tex = this.textures[st];
    const mips = tex && tex.levels > 1, key = [t[TSS.ADDRESSU], t[TSS.ADDRESSV], t[TSS.MAGFILTER], t[TSS.MINFILTER], mips ? t[TSS.MIPFILTER] : 0, t[TSS.MAXANISOTROPY]].join(",");
    let s = this.samplers.get(key);
    if (!s){
      s = gl.createSampler();
      const wrap = [gl.REPEAT, gl.REPEAT, gl.MIRRORED_REPEAT, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE];  // BORDER -> clamp [I]
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, wrap[t[TSS.ADDRESSU]] || gl.REPEAT);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, wrap[t[TSS.ADDRESSV]] || gl.REPEAT);
      const lin = f => f >= 2;
      gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, lin(t[TSS.MAGFILTER]) ? gl.LINEAR : gl.NEAREST);
      const mn = lin(t[TSS.MINFILTER]), mp = mips ? t[TSS.MIPFILTER] : 0;
      gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, mp === 0 ? (mn ? gl.LINEAR : gl.NEAREST)
        : mp === 1 ? (mn ? gl.LINEAR_MIPMAP_NEAREST : gl.NEAREST_MIPMAP_NEAREST) : (mn ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR));
      if (this.aniso && (t[TSS.MINFILTER] === 3 || t[TSS.MAGFILTER] === 3)) gl.samplerParameterf(s, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.max(1, t[TSS.MAXANISOTROPY]));
      this.samplers.set(key, s);
    }
    return s;
  }
  program(L){
    const key = shaderKey(this, L);
    let p = this.programs.get(key);
    if (!p){
      const g = genShaders(this, L), prog = this.link(g.vs, g.fs), gl = this.gl;
      const U = {}, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++){ const u = gl.getActiveUniform(prog, i), name = u.name.replace(/\[0\]$/, ""); U[name] = gl.getUniformLocation(prog, name); }
      p = {prog, U, stages: g.stages, src: g, key};
      this.programs.set(key, p); this.stats.programs++;
    }
    return p;
  }
  setUniforms(p){
    const gl = this.gl, U = p.U, rs = this.rs, view = this.xf.get(TS.VIEW);
    gl.useProgram(p.prog);
    const m = (n, v) => U[n] && gl.uniformMatrix4fv(U[n], false, v), v4 = (n, v) => U[n] && gl.uniform4fv(U[n], v);
    m("uWorld", this.xf.get(TS.WORLD)); m("uView", view); m("uProj", this.xf.get(TS.PROJECTION));
    if (U.uTexM){ const all = new Float32Array(128); for (let i = 0; i < 8; i++) all.set(this.xf.get(TS.TEXTURE0 + i), i * 16); gl.uniformMatrix4fv(U.uTexM, false, all); }
    v4("uVp", [this.vp.X, this.vp.Y, this.vp.Width, this.vp.Height]); U.uDepth && gl.uniform2f(U.uDepth, this.vp.MinZ, this.vp.MaxZ);
    v4("uTF", color4(rs[RS.TEXTUREFACTOR])); v4("uFogC", color4(rs[RS.FOGCOLOR]));
    v4("uFog", [asFloat(rs[RS.FOGSTART]), asFloat(rs[RS.FOGEND]), asFloat(rs[RS.FOGDENSITY]), 0]);
    U.uARef && gl.uniform1f(U.uARef, rs[RS.ALPHAREF] & 255);
    v4("uAmb", color4(rs[RS.AMBIENT]));
    const M = this.mat; v4("uMatD", M.Diffuse); v4("uMatA", M.Ambient); v4("uMatS", M.Specular); v4("uMatE", M.Emissive); U.uMatP && gl.uniform1f(U.uMatP, M.Power);
    if (U.uLD){
      // lights are given in world space; lighting runs in view space (D3D8 behaviour)
      const ls = this.activeLights(), arr = n => new Float32Array(32), D = arr(), S = arr(), A = arr(), P = arr(), Dir = arr(), Att = arr(), Sp = arr();
      const xp = (v, w) => [0, 1, 2].map(c => v[0] * view[c] + v[1] * view[4 + c] + v[2] * view[8 + c] + w * view[12 + c]);
      ls.forEach((l, i) => {
        D.set(l.Diffuse, i * 4); S.set(l.Specular, i * 4); A.set(l.Ambient, i * 4);
        P.set(xp(l.Position, 1), i * 4); Dir.set(xp(l.Direction, 0), i * 4);
        Att.set([l.Attenuation0, l.Attenuation1, l.Attenuation2, l.Range || 1e30], i * 4);
        Sp.set([Math.cos(l.Theta / 2), Math.cos(l.Phi / 2), l.Falloff || 1, 0], i * 4);
      });
      v4("uLD", D); v4("uLS", S); v4("uLA", A); v4("uLP", P); v4("uLDir", Dir); v4("uLAtt", Att); v4("uLSpot", Sp);
    }
    for (let s = 0; s < p.stages; s++){
      const tex = this.textures[s]; if (!U["uS" + s]) continue;
      gl.activeTexture(gl.TEXTURE0 + s); gl.bindTexture(gl.TEXTURE_2D, tex ? tex.tex : null); gl.bindSampler(s, this.sampler(s));
      gl.uniform1i(U["uS" + s], s);
    }
  }
  /** Bind the vertex layout; `base` = byte offset of vertex 0 inside the bound GL buffer. */
  bindLayout(L, buf, base, stride){
    const gl = this.gl;
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (let i = 0; i < 13; i++) gl.disableVertexAttribArray(i);
    const at = (loc, n, type, norm, off) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, type, norm, stride, base + off); };
    at(0, L.posSize, gl.FLOAT, false, L.pos);
    if (L.normal >= 0) at(1, 3, gl.FLOAT, false, L.normal);
    if (L.diffuse >= 0) at(2, 4, gl.UNSIGNED_BYTE, true, L.diffuse);
    if (L.specular >= 0) at(3, 4, gl.UNSIGNED_BYTE, true, L.specular);
    L.tex.forEach((t, i) => at(4 + i, t.size, gl.FLOAT, false, t.off));
  }
  prepare(L){
    for (const t of this.dirtyTex) t.upload(); this.dirtyTex.clear();
    const p = this.program(L); this.applyGLState(); this.setUniforms(p); return p;
  }
  glMode(pt){ const gl = this.gl; return [0, gl.POINTS, gl.LINES, gl.LINE_STRIP, gl.TRIANGLES, gl.TRIANGLE_STRIP, gl.TRIANGLE_FAN][pt]; }
  vcount(pt, n){ return [0, n, n * 2, n + 1, n * 3, n + 2, n + 2][pt]; }
  /** FILLMODE=WIREFRAME has no WebGL equivalent: convert triangle indices to a line list. */
  wireIndices(pt, idx){
    const out = [], tri = (a, b, c) => out.push(a, b, b, c, c, a);
    if (pt === PT.TRIANGLELIST) for (let i = 0; i + 2 < idx.length; i += 3) tri(idx[i], idx[i + 1], idx[i + 2]);
    else if (pt === PT.TRIANGLESTRIP) for (let i = 0; i + 2 < idx.length; i++) tri(idx[i], idx[i + 1], idx[i + 2]);
    else if (pt === PT.TRIANGLEFAN) for (let i = 1; i + 1 < idx.length; i++) tri(idx[0], idx[i], idx[i + 1]);
    return new Uint32Array(out);
  }
  drawRange(pt, L, buf, base, stride, first, count, idx){
    const gl = this.gl;
    if (this.rs[RS.FILLMODE] === 2 && pt >= PT.TRIANGLELIST){
      const src = idx ? Array.from(idx) : [...Array(count)].map((_, i) => first + i);
      const lines = this.wireIndices(pt, src);
      this.bindLayout(L, buf, base, stride);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.upIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines, gl.STREAM_DRAW);
      gl.drawElements(gl.LINES, lines.length, gl.UNSIGNED_INT, 0);
      return;
    }
    this.bindLayout(L, buf, base, stride);
    if (idx){
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.upIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STREAM_DRAW);
      gl.drawElements(this.glMode(pt), count, idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    } else gl.drawArrays(this.glMode(pt), first, count);
  }
  DrawPrimitive(pt, startVertex, primCount){
    const L = decodeFVF(this.fvf), vb = this.stream.vb; if (!vb) return HR.INVALIDCALL;
    vb.flush(); this.prepare(L);
    this.drawRange(pt, L, vb.buf, 0, this.stream.stride || L.stride, startVertex, this.vcount(pt, primCount), null);
    this.stats.draws++; this.stats.prims += primCount; return HR.OK;
  }
  /** D3D8: indices are relative to the BaseVertexIndex given to SetIndices; WebGL2 has no base vertex, so the
   *  attribute pointers are offset by base*stride instead. */
  DrawIndexedPrimitive(pt, minIndex, numVertices, startIndex, primCount){
    const L = decodeFVF(this.fvf), vb = this.stream.vb, ib = this.indices.ib; if (!vb || !ib) return HR.INVALIDCALL;
    vb.flush(); ib.flush(); this.prepare(L);
    const stride = this.stream.stride || L.stride, n = this.vcount(pt, primCount), is32 = ib.ifmt === FMT.INDEX32, gl = this.gl;
    if (this.rs[RS.FILLMODE] === 2 && pt >= PT.TRIANGLELIST){
      const idx = is32 ? new Uint32Array(ib.mem.u8.buffer, ib.mem.u8.byteOffset + startIndex * 4, n) : new Uint16Array(ib.mem.u8.buffer, ib.mem.u8.byteOffset + startIndex * 2, n);
      this.drawRange(pt, L, vb.buf, this.indices.base * stride, stride, 0, n, idx);
    } else {
      this.bindLayout(L, vb.buf, this.indices.base * stride, stride);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib.buf);
      gl.drawElements(this.glMode(pt), n, is32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, startIndex * (is32 ? 4 : 2));
    }
    this.stats.draws++; this.stats.prims += primCount; return HR.OK;
  }
  /** UP variants: vertex/index data is client memory (wasm memory views in the port). */
  DrawPrimitiveUP(pt, primCount, data, stride){
    const L = decodeFVF(this.fvf), gl = this.gl, n = this.vcount(pt, primCount);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upBuf); gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(data.buffer, data.byteOffset, n * stride), gl.STREAM_DRAW);
    this.prepare(L); this.drawRange(pt, L, this.upBuf, 0, stride, 0, n, null);
    this.stats.draws++; this.stats.prims += primCount; return HR.OK;
  }
  DrawIndexedPrimitiveUP(pt, minIndex, numVertices, primCount, indexData, indexFmt, vertexData, stride){
    const L = decodeFVF(this.fvf), gl = this.gl, n = this.vcount(pt, primCount);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(vertexData.buffer, vertexData.byteOffset, (minIndex + numVertices) * stride), gl.STREAM_DRAW);
    const idx = indexFmt === FMT.INDEX32 ? new Uint32Array(indexData.buffer, indexData.byteOffset, n).slice() : new Uint16Array(indexData.buffer, indexData.byteOffset, n).slice();
    this.prepare(L); this.drawRange(pt, L, this.upBuf, 0, stride, 0, n, idx);
    this.stats.draws++; this.stats.prims += primCount; return HR.OK;
  }

  /** Run fn with a private state (used by HLE helpers such as the D3DXFont emulation); restores everything after. */
  withState(fn){
    const save = {rs: this.rs.slice(), tss: this.tss.map(t => t.slice()), tex: this.textures.slice(), xf: new Map([...this.xf].map(([k, v]) => [k, v.slice()])),
      fvf: this.fvf, stream: this.stream, indices: this.indices, mat: this.mat, rec: this.recording};
    this.recording = null;
    try { return fn(); } finally {
      this.rs = save.rs; this.tss = save.tss; this.textures = save.tex; this.xf = save.xf; this.fvf = save.fvf;
      this.stream = save.stream; this.indices = save.indices; this.mat = save.mat; this.recording = save.rec;
    }
  }
}

/* ------------------------------------------------------------------ IDirect3D8 (adapter queries) */
export class Direct3D8 {
  constructor(opts = {}){ this.opts = opts; this.refs = 1; }
  AddRef(){ return ++this.refs; } Release(){ return --this.refs; }
  GetAdapterCount(){ return 1; }
  GetAdapterIdentifier(){ return {Driver: "webgl2", Description: "WebGL2 (d3d8.js)", VendorId: 0, DeviceId: 0}; }
  GetAdapterModeCount(){ return this.modes().length; }
  EnumAdapterModes(a, i){ return this.modes()[i]; }
  modes(){ return [[640, 480], [800, 600], [1024, 768], [1280, 720], [1280, 960], [1600, 900], [1920, 1080]].map(([w, h]) => ({Width: w, Height: h, RefreshRate: 60, Format: FMT.X8R8G8B8})); }
  GetAdapterDisplayMode(){ return {Width: screen.width || 1920, Height: screen.height || 1080, RefreshRate: 60, Format: FMT.X8R8G8B8}; }
  CheckDeviceType(){ return HR.OK; }
  CheckDeviceFormat(a, type, adapterFmt, usage, rtype, fmt){
    const ok = [FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.R5G6B5, FMT.A1R5G5B5, FMT.X1R5G5B5, FMT.A4R4G4B4, FMT.A8, FMT.DXT1, FMT.DXT3, FMT.DXT5, FMT.D24S8, FMT.D16];
    return ok.includes(fmt) ? HR.OK : HR.NOTAVAILABLE;
  }
  CheckDepthStencilMatch(){ return HR.OK; }
  /** D3DCAPS8 subset the game reads (offsets in docs section 2.7): chosen to keep it on its simplest paths */
  GetDeviceCaps(){ return {TextureOpCaps: 0x03feffff, MaxTextureBlendStages: 8, MaxSimultaneousTextures: 8, MaxActiveLights: 8,
    MaxAnisotropy: 16, MaxPrimitiveCount: 0xfffff, MaxVertexIndex: 0xffffff, MaxTextureWidth: 4096, MaxTextureHeight: 4096}; }
  GetAdapterMonitor(){ return 1; }
  CreateDevice(adapter, type, hwnd, flags, pp, gl){ return new Device(gl, {width: pp.BackBufferWidth, height: pp.BackBufferHeight, alloc: this.opts.alloc, backFormat: pp.BackBufferFormat}); }
}
