// HLE replacements for the statically linked D3DX8 code in Meridian.exe (docs section 3.5).
// The recompiler routes these addresses to JS instead of recompiling D3DX (it would drag GDI into the port):
//   0067d9ce D3DXCreateFont(dev, HFONT, ID3DXFont**)              -> new Font (Canvas2D text)
//   0067e0c4 D3DXCheckTextureRequirements(dev,&w,&h,&mips,usage,&fmt,pool)
//   0067e0ec D3DXCreateTexture(dev,w,h,mips,usage,fmt,pool,&tex)
//   0067de8e D3DXLoadSurfaceFromMemory(dst,dstPal,dstRect,src,srcFmt,srcPitch,srcPal,srcRect,filter,colorKey)
//   0067e152 D3DXLoadSurfaceFromSurface(dst,dstPal,dstRect,src,srcPal,srcRect,filter,colorKey)
//   0067e814 D3DXCreateTextureFromFileA(dev, path, &tex)           -> TODO: needs the port's VFS + DDS/BMP/TGA loader
"use strict";
import {FMT, formatInfo, toRGBA8, fromRGBA8, decodeDXT, levelLayout, RS, TSS, TOP, TA, FVF, PT, HR, color4} from "./d3d8.js";

const isDXT = f => f === FMT.DXT1 || f === FMT.DXT3 || f === FMT.DXT5 || f === FMT.DXT2 || f === FMT.DXT4;

export function D3DXCheckTextureRequirements(dev, req){
  // WebGL2 has NPOT + large textures; keep the request, only resolve mips = 0 (full chain) and unknown formats
  let {w, h, mips, fmt} = req;
  w = Math.max(1, Math.min(w || 256, 4096)); h = Math.max(1, Math.min(h || 256, 4096));
  let full = 1; for (let s = Math.max(w, h); s > 1; s >>= 1) full++;
  mips = !mips ? full : Math.min(mips, full);
  if (!formatInfo(fmt)) fmt = FMT.A8R8G8B8;
  return {w, h, mips, fmt};
}
export function D3DXCreateTexture(dev, w, h, mips, usage, fmt, pool){
  const r = D3DXCheckTextureRequirements(dev, {w, h, mips, fmt});
  return dev.CreateTexture(r.w, r.h, r.mips, usage, r.fmt, pool);
}

/** Any source (incl. DXT) -> RGBA8 rect. */
function srcToRGBA(srcBytes, srcFmt, srcPitch, rect){
  const w = rect.right - rect.left, h = rect.bottom - rect.top;
  if (isDXT(srcFmt)){
    // decode the whole block rows covering the rect, then crop
    const bw = (rect.right + 3) >> 2, bh = (rect.bottom + 3) >> 2, full = decodeDXT(srcFmt, srcBytes, bw * 4, bh * 4);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(full.subarray(((rect.top + y) * bw * 4 + rect.left) * 4, ((rect.top + y) * bw * 4 + rect.left + w) * 4), y * w * 4);
    return out;
  }
  const fi = formatInfo(srcFmt), off = rect.top * srcPitch + rect.left * fi.bpp;
  return toRGBA8(srcFmt, srcBytes.subarray(off), w, h, srcPitch);
}
function resample(rgba, w, h, W, H){              // D3DX_FILTER_* -> box/point; exact copy when sizes match
  if (w === W && h === H) return rgba;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
    const sx = Math.min(w - 1, (x * w / W) | 0), sy = Math.min(h - 1, (y * h / H) | 0);
    out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * W + x) * 4);
  }
  return out;
}
/** dst: Surface of a Texture level. src: Uint8Array of the source bits. */
export function D3DXLoadSurfaceFromMemory(dst, dstRect, src, srcFmt, srcPitch, srcRect, filter, colorKey){
  const tex = dst.tex, lv = tex.lv[dst.level];
  const dr = dstRect || {left: 0, top: 0, right: lv.w, bottom: lv.h};
  // same DXT format and full-surface copy: move the blocks unchanged (the common XBMP DXT1/DXT3 path)
  if (isDXT(srcFmt) && srcFmt === tex.fmt && !dstRect && srcRect.left === 0 && srcRect.top === 0 && srcRect.right === lv.w && srcRect.bottom === lv.h){
    const lk = dst.LockRect(null, 0), rows = Math.max(1, (lv.h + 3) >> 2);
    for (let r = 0; r < rows; r++) lk.bytes.set(src.subarray(r * srcPitch, r * srcPitch + lv.pitch), r * lv.pitch);
    dst.UnlockRect(); return HR.OK;
  }
  let rgba = srcToRGBA(src, srcFmt, srcPitch, srcRect);
  rgba = resample(rgba, srcRect.right - srcRect.left, srcRect.bottom - srcRect.top, dr.right - dr.left, dr.bottom - dr.top);
  if (colorKey) for (let i = 0; i < rgba.length; i += 4){
    const c = (rgba[i + 3] << 24 | rgba[i] << 16 | rgba[i + 1] << 8 | rgba[i + 2]) >>> 0; if (c === colorKey >>> 0) rgba.fill(0, i, i + 4);
  }
  if (isDXT(tex.fmt)){
    // D3DX would compress here. Nobody reads these textures back, so keep them uncompressed instead
    // (one-time retarget of the whole texture to A8R8G8B8; docs 3.5).
    retarget(tex, FMT.A8R8G8B8);
  }
  const lk = dst.LockRect(dr, 0);
  fromRGBA8(tex.fmt, rgba, dr.right - dr.left, dr.bottom - dr.top, lk.bytes, lk.pitch);
  dst.UnlockRect(); return HR.OK;
}
function retarget(tex, fmt){
  if (tex.fmt === fmt) return;
  tex.lv.forEach(v => v.mem.free());
  tex.fmt = fmt;
  tex.lv = tex.lv.map(v => { const lay = levelLayout(fmt, v.w, v.h); return {w: v.w, h: v.h, ...lay, mem: tex.dev.alloc(lay.size), dirty: true}; });
}
export function D3DXLoadSurfaceFromSurface(dst, dstRect, src, srcRect, filter, colorKey){
  if (!src.tex){                                            // back buffer source: read it back via CopyRects logic
    const d = src.GetDesc(), tmp = src.dev.CreateTexture(d.Width, d.Height, 1, 0, FMT.A8R8G8B8, 2), s = tmp.GetSurfaceLevel(0);
    src.dev.CopyRects(src, null, s, null);
    const r = D3DXLoadSurfaceFromSurface(dst, dstRect, s, srcRect, filter, colorKey); s.Release(); tmp.Release(); return r;
  }
  const lv = src.tex.lv[src.level], sr = srcRect || {left: 0, top: 0, right: lv.w, bottom: lv.h};
  return D3DXLoadSurfaceFromMemory(dst, dstRect, lv.mem.u8, src.tex.fmt, lv.pitch, sr, filter, colorKey);
}

/* ------------------------------------------------------------------ ID3DXFont via Canvas2D */
const DT = {CENTER: 1, RIGHT: 2, VCENTER: 4, BOTTOM: 8, WORDBREAK: 0x10, SINGLELINE: 0x20, NOCLIP: 0x100, CALCRECT: 0x400};
class GLTex { constructor(tex){ this.tex = tex; this.levels = 1; } AddRef(){} Release(){} }

export class Font {
  /** logfont: {height (px, negative = character height like GDI), weight, italic, face} */
  constructor(dev, logfont){
    this.dev = dev; this.lf = logfont; this.refs = 1; this.cache = new Map();
    const px = Math.abs(logfont.height || 12);
    this.css = `${logfont.italic ? "italic " : ""}${logfont.weight || 400} ${px}px ${logfont.face ? `"${logfont.face}", ` : ""}Arial, sans-serif`;
    this.lineH = Math.round(px * 1.2);
    this.canvas = (typeof OffscreenCanvas !== "undefined") ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
  }
  AddRef(){ return ++this.refs; } Release(){ return --this.refs; }
  lines(text, width, fmt){
    const ctx = this.ctx; ctx.font = this.css;
    const paras = (fmt & DT.SINGLELINE) ? [text.replace(/\n/g, " ")] : text.split("\n");
    if (!(fmt & DT.WORDBREAK)) return paras;
    const out = [];
    for (const p of paras){ let line = ""; for (const w of p.split(/(\s+)/)){ const t = line + w; if (line && ctx.measureText(t).width > width){ out.push(line.trimEnd()); line = w.trimStart(); } else line = t; } out.push(line); }
    return out;
  }
  /** DrawText(text, rect {left,top,right,bottom}, format, color): returns the text height like D3DX/GDI. */
  DrawText(text, rect, fmt, color){
    const lines = this.lines(text, rect.right - rect.left, fmt), ctx = this.ctx;
    ctx.font = this.css;
    const w = Math.ceil(Math.max(1, ...lines.map(l => ctx.measureText(l).width))), h = lines.length * this.lineH;
    if (fmt & DT.CALCRECT){ rect.right = rect.left + w; rect.bottom = rect.top + h; return h; }
    let x = rect.left, y = rect.top;
    if (fmt & DT.CENTER) x = Math.round((rect.left + rect.right - w) / 2); else if (fmt & DT.RIGHT) x = rect.right - w;
    if (fmt & DT.VCENTER) y = Math.round((rect.top + rect.bottom - h) / 2); else if (fmt & DT.BOTTOM) y = rect.bottom - h;
    const key = this.css + "\u0001" + fmt + "\u0001" + lines.join("\n");
    let ent = this.cache.get(key);
    if (!ent){
      const gl = this.dev.gl;
      this.canvas.width = w; this.canvas.height = h;
      ctx.font = this.css; ctx.textBaseline = "top"; ctx.fillStyle = "#fff"; ctx.clearRect(0, 0, w, h);
      lines.forEach((l, i) => { const lw = ctx.measureText(l).width; ctx.fillText(l, (fmt & DT.CENTER) ? (w - lw) / 2 : (fmt & DT.RIGHT) ? w - lw : 0, i * this.lineH + Math.round(this.lineH * 0.1)); });
      const tex = gl.createTexture(); this.dev.bindForUpload(tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
      ent = {tex: new GLTex(tex), w, h}; this.cache.set(key, ent);
      if (this.cache.size > 256){ const [k, v] = this.cache.entries().next().value; gl.deleteTexture(v.tex.tex); this.dev.texDeleted(v.tex.tex); this.cache.delete(k); }
    }
    // clip (no DT_NOCLIP): shrink the quad to the rect
    let x0 = x, y0 = y, x1 = x + ent.w, y1 = y + ent.h, u0 = 0, v0 = 0, u1 = 1, v1 = 1;
    if (!(fmt & DT.NOCLIP)){
      const cx0 = Math.max(x0, rect.left), cy0 = Math.max(y0, rect.top), cx1 = Math.min(x1, rect.right), cy1 = Math.min(y1, rect.bottom);
      if (cx1 <= cx0 || cy1 <= cy0) return h;
      u0 = (cx0 - x0) / ent.w; u1 = (cx1 - x0) / ent.w; v0 = (cy0 - y0) / ent.h; v1 = (cy1 - y0) / ent.h; x0 = cx0; y0 = cy0; x1 = cx1; y1 = cy1;
    }
    const dev = this.dev, vb = new ArrayBuffer(4 * 28), f = new Float32Array(vb), u = new Uint32Array(vb);
    // XYZRHW|DIFFUSE|TEX1, strip; -0.5 so texel centres land on pixel centres (D3D8 convention)
    [[x0, y0, u0, v0], [x1, y0, u1, v0], [x0, y1, u0, v1], [x1, y1, u1, v1]].forEach(([px, py, tu, tv], i) => {
      f.set([px - 0.5, py - 0.5, 0, 1], i * 7); u[i * 7 + 4] = color >>> 0; f[i * 7 + 5] = tu; f[i * 7 + 6] = tv; });
    dev.withState(() => {
      const S = (s, v) => dev.SetRenderState(s, v), T = (s, k, v) => dev.SetTextureStageState(s, k, v);
      S(RS.ZENABLE, 0); S(RS.ZWRITEENABLE, 0); S(RS.ALPHABLENDENABLE, 1); S(RS.SRCBLEND, 5); S(RS.DESTBLEND, 6); S(RS.BLENDOP, 1);
      S(RS.ALPHATESTENABLE, 0); S(RS.CULLMODE, 1); S(RS.LIGHTING, 0); S(RS.FOGENABLE, 0); S(RS.FILLMODE, 3); S(RS.SPECULARENABLE, 0);
      S(RS.STENCILENABLE, 0); S(RS.COLORWRITEENABLE, 15); S(RS.ZBIAS, 0);
      T(0, TSS.COLOROP, TOP.MODULATE); T(0, TSS.COLORARG1, TA.TEXTURE); T(0, TSS.COLORARG2, TA.DIFFUSE);
      T(0, TSS.ALPHAOP, TOP.MODULATE); T(0, TSS.ALPHAARG1, TA.TEXTURE); T(0, TSS.ALPHAARG2, TA.DIFFUSE);
      T(0, TSS.TEXCOORDINDEX, 0); T(0, TSS.TEXTURETRANSFORMFLAGS, 0); T(0, TSS.RESULTARG, TA.CURRENT);
      T(0, TSS.MINFILTER, 1); T(0, TSS.MAGFILTER, 1); T(0, TSS.MIPFILTER, 0); T(0, TSS.ADDRESSU, 3); T(0, TSS.ADDRESSV, 3);
      T(1, TSS.COLOROP, TOP.DISABLE); T(1, TSS.ALPHAOP, TOP.DISABLE);
      dev.textures = dev.textures.slice(); dev.textures[0] = ent.tex;
      dev.SetVertexShader(FVF.XYZRHW | FVF.DIFFUSE | 0x100);
      dev.DrawPrimitiveUP(PT.TRIANGLESTRIP, 2, new Uint8Array(vb), 28);
    });
    return h;
  }
  /** COM-side entry (ComBridge ID3DXFont::DrawTextA/W): rect is read from / written to wasm memory. */
  drawText(text, bridge, prect, fmt, color){
    const r = bridge.rect(prect), h = this.DrawText(text, r, fmt, color);
    if (fmt & DT.CALCRECT){ bridge.w32(prect + 8, r.right); bridge.w32(prect + 12, r.bottom); }
    return h;
  }
}
export function D3DXCreateFont(dev, logfont){ return new Font(dev, logfont); }
