// Replays a .d3dr call stream through the WebGL2 D3D8 layer (web/d3d8/d3d8.js) and diffs every recorded
// back-buffer shot against the replayed back buffer. Browser only (needs WebGL2).
//   const rp = new Replayer({container});            // canvases are created at CreateDevice (back-buffer size)
//   await rp.run(reader, {untilFrame, onShot(result), onFrame(n)});
// Objects are keyed by the recorder's ids; state-block tokens by the recorded token values.
"use strict";
import {Device, Direct3D8, Surface, FMT} from "../web/d3d8/d3d8.js";
import {S} from "./reader.js";

/** RGBA8 (top row first) box-downscaled by s with (sum + n/2) / n rounding: identical to the recorder's shot code. */
export function downscale(px, w, h, s){
  if (s === 1) return px;
  const ow = Math.floor(w / s), oh = Math.floor(h / s), out = new Uint8Array(ow * oh * 4), n = s * s;
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++){
    let r = 0, g = 0, b = 0;
    for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++){ const i = ((oy * s + yy) * w + ox * s + xx) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; }
    const o = (oy * ow + ox) * 4; out[o] = (r + (n >> 1)) / n | 0; out[o + 1] = (g + (n >> 1)) / n | 0; out[o + 2] = (b + (n >> 1)) / n | 0; out[o + 3] = 255;
  }
  return out;
}

/** Per-pixel comparison of two RGBA8 images (alpha ignored). Returns metrics + a diff heat map (RGBA8). */
export function compare(a, b, w, h, thr = 8){
  const heat = new Uint8Array(w * h * 4);
  let sum = 0, sq = 0, over = 0, max = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
    const i = (y * w + x) * 4, dr = Math.abs(a[i] - b[i]), dg = Math.abs(a[i + 1] - b[i + 1]), db = Math.abs(a[i + 2] - b[i + 2]);
    const d = Math.max(dr, dg, db);
    sum += dr + dg + db; sq += dr * dr + dg * dg + db * db; if (d > max) max = d;
    const lum = (a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11) * 0.35 | 0;
    if (d > thr){ over++; heat[i] = 255; heat[i + 1] = Math.max(0, 160 - d); heat[i + 2] = 0; if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; }
    else { heat[i] = lum + d * 8; heat[i + 1] = lum + d * 8; heat[i + 2] = lum + d * 8; }
    heat[i + 3] = 255;
  }
  const n = w * h, mse = sq / (n * 3);
  return {mean: sum / (n * 3), max, over, pctOver: 100 * over / n, psnr: mse ? 10 * Math.log10(255 * 255 / mse) : Infinity,
    bbox: bx1 >= 0 ? [bx0, by0, bx1 + 1, by1 + 1] : null, heat};
}

const d3dRect = r => ({left: r.left, top: r.top, right: r.right, bottom: r.bottom});

export class Replayer {
  /** opts: {container: element for the canvas, threshold: per-channel diff counted as bad (default 8),
   *  passPct: max % of bad pixels for PASS (default 0.5), noS3TC} */
  constructor(opts = {}){
    this.opts = opts; this.threshold = opts.threshold ?? 8; this.passPct = opts.passPct ?? 0.5;
    this.objs = new Map(); this.tokens = new Map(); this.pending = new Map();
    this.frame = 0; this.dev = null; this.canvas = null; this.warn = new Map(); this.events = [];
    this.calls = 0; this.unhandled = new Map(); this.results = [];
  }
  warnOnce(key, msg){ const n = this.warn.get(key) || 0; this.warn.set(key, n + 1); if (n === 0) console.warn("replay:", msg); }
  obj(id){ return id ? this.objs.get(id) || null : null; }

  createDevice(pp, id){
    const W = pp.BackBufferWidth || 640, H = pp.BackBufferHeight || 480;
    this.canvas = document.createElement("canvas"); this.canvas.width = W; this.canvas.height = H;
    if (this.opts.container) this.opts.container.replaceChildren(this.canvas);
    const gl = this.canvas.getContext("webgl2", {antialias: false, preserveDrawingBuffer: true, alpha: false});
    if (!gl) throw new Error("WebGL2 not available");
    const fmt = pp.BackBufferFormat === FMT.A8R8G8B8 || pp.BackBufferFormat === FMT.X8R8G8B8 ? pp.BackBufferFormat : FMT.X8R8G8B8;
    if (pp.BackBufferFormat !== fmt) this.warnOnce("bbfmt", `back buffer format ${pp.BackBufferFormat} replayed as X8R8G8B8 (the shot diff then includes the 16-bit quantisation)`);
    this.dev = new Device(gl, {width: W, height: H, backFormat: fmt, noS3TC: this.opts.noS3TC});
    this.objs.set(id, this.dev);
  }
  /** Back buffer as RGBA8, top row first (D3D orientation). */
  readBack(){
    const gl = this.dev.gl, W = this.dev.width, H = this.dev.height, px = new Uint8Array(W * H * 4), out = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dev.fbo);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    return out;
  }
  shot([frame, w, h, scale, srcFmt, px]){
    if (!this.dev) return null;
    const mine = downscale(this.readBack(), this.dev.width, this.dev.height, scale);
    const c = compare(mine, px, w, h, this.threshold);
    const res = {frame, w, h, scale, srcFmt, ...c, pass: c.pctOver <= this.passPct, recorded: px.slice(), replayed: mine};
    this.results.push(res);
    return res;
  }

  snapshot(){
    const d = this.dev;
    return {rs: d.rs.slice(), tss: d.tss.map(t => t.slice()), textures: d.textures.slice(), xf: new Map([...d.xf].map(([k, v]) => [k, v.slice()])),
      vp: {...d.vp}, mat: JSON.parse(JSON.stringify(d.mat)), lights: new Map([...d.lights].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])),
      lightOn: new Set(d.lightOn), fvf: d.fvf, stream: {...d.stream}, indices: {...d.indices}};
  }
  restore(s){
    const d = this.dev;
    d.rs = s.rs.slice(); d.tss = s.tss.map(t => t.slice()); d.textures = s.textures.slice(); d.xf = new Map([...s.xf].map(([k, v]) => [k, v.slice()]));
    d.vp = {...s.vp}; d.mat = JSON.parse(JSON.stringify(s.mat)); d.lights = new Map([...s.lights].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
    d.lightOn = new Set(s.lightOn); d.fvf = s.fvf; d.stream = {...s.stream}; d.indices = {...s.indices};
  }
  /** CaptureStateBlock on a Begin/End-recorded block: refresh the recorded values from the current state. */
  recapture(list){
    const d = this.dev;
    for (const e of list){
      const [fn, a] = e;
      if (fn === "SetRenderState") a[1] = d.rs[a[0]];
      else if (fn === "SetTextureStageState") a[2] = d.tss[a[0]][a[1]];
      else if (fn === "SetTexture") a[1] = d.textures[a[0]];
      else if (fn === "SetTransform") a[1] = (d.xf.get(a[0]) || a[1]).slice();
      else if (fn === "SetViewport") a[0] = {...d.vp};
      else if (fn === "SetMaterial") a[0] = JSON.parse(JSON.stringify(d.mat));
      else if (fn === "SetVertexShader") a[0] = d.fvf;
    }
  }
  /** Writes recorded lock data into a lock result {pitch, bytes}. Texture data comes packed (rowBytes x rows). */
  putData(lk, data, rowBytes, rows){
    if (!lk || !data || !data.kind) return;
    if (data.kind === 3){ for (const s of data.spans) lk.bytes.set(s.bytes.subarray(0, Math.max(0, lk.bytes.length - s.off)), s.off); return; }
    const src = data.bytes;
    if (rowBytes === undefined || lk.pitch === undefined || lk.pitch === rowBytes) { lk.bytes.set(src.subarray(0, Math.min(src.length, lk.bytes.length))); return; }
    for (let y = 0; y < rows; y++){
      const o = y * lk.pitch; if (o >= lk.bytes.length) break;
      lk.bytes.set(src.subarray(y * rowBytes, (y + 1) * rowBytes).subarray(0, lk.bytes.length - o), o);
    }
  }

  /** Apply one record. Returns a shot result for Meta::Shot records. */
  apply(rec){
    this.calls++;
    const a = rec.args, dev = this.dev, self = rec.self;
    const key = rec.iface + "::" + rec.name;
    switch (key){
      /* ---------------- meta */
      case "Meta::Create": this.objs.set(a[1], new Direct3D8()); return;
      case "Meta::Shot": return this.shot(a);
      case "Meta::Destroy": {
        const o = this.objs.get(a[0]);
        if (o && o !== this.dev && typeof o.destroy === "function"){ try { o.destroy(); } catch (e) { this.warnOnce("destroy", "destroy: " + e.message); } }
        if (o !== this.dev) this.objs.delete(a[0]);
        return;
      }
      case "Meta::Event": this.events.push(`[frame ${this.frame}] ${a[0]}`); return;
      case "Meta::Unwrapped": this.warnOnce("unwrapped" + a[1], `game created an unwrapped ${a[1]} (not replayed)`); return;
      case "Meta::End": return;
      /* ---------------- IDirect3D8 */
      case "D3D::CreateDevice": if (!rec.hr && a[5]) this.createDevice(S.pp(a[4]), a[5]); return;
    }
    if (key === "Device::Present"){ if (this.dev) this.dev.Present(); this.frame = a[4] + 1; return; }   // counted even when it failed (lost device)
    if (rec.hr && rec.hr < 0) return;           // failed calls changed nothing on the real device
    if (rec.iface === "D3D") return;            // adapter queries
    if (!dev) { this.warnOnce("nodev", "records before CreateDevice"); return; }
    switch (key){
      /* ---------------- device: state */
      case "Device::SetRenderState": dev.SetRenderState(a[0], a[1]); return;
      case "Device::SetTextureStageState": dev.SetTextureStageState(a[0], a[1], a[2]); return;
      case "Device::SetTexture": dev.SetTexture(a[0], this.obj(a[1])); return;
      case "Device::SetTransform": if (a[1]) dev.SetTransform(a[0], a[1]); return;
      case "Device::MultiplyTransform": if (a[1]) dev.MultiplyTransform(a[0], a[1]); return;
      case "Device::SetViewport": dev.SetViewport(S.viewport(a[0])); return;
      case "Device::SetMaterial": dev.SetMaterial(S.material(a[0])); return;
      case "Device::SetLight": dev.SetLight(a[0], S.light(a[1])); return;
      case "Device::LightEnable": dev.LightEnable(a[0], !!a[1]); return;
      case "Device::SetVertexShader": dev.SetVertexShader(a[0]); return;
      case "Device::SetStreamSource": dev.SetStreamSource(a[0], this.obj(a[1]), a[2]); return;
      case "Device::SetIndices": dev.SetIndices(this.obj(a[0]), a[1]); return;
      case "Device::SetGammaRamp": dev.SetGammaRamp(a[0], S.gamma(a[1])); return;
      case "Device::BeginStateBlock": dev.BeginStateBlock(); return;
      case "Device::EndStateBlock": this.tokens.set(a[0], {h: dev.EndStateBlock()}); return;
      case "Device::CreateStateBlock": this.tokens.set(a[1], {snap: this.snapshot()}); return;
      case "Device::ApplyStateBlock": { const t = this.tokens.get(a[0]); if (!t) return this.warnOnce("sb", "unknown state block " + a[0]);
        if (t.snap) this.restore(t.snap); else dev.ApplyStateBlock(t.h); return; }
      case "Device::CaptureStateBlock": { const t = this.tokens.get(a[0]); if (!t) return;
        if (t.snap) t.snap = this.snapshot(); else this.recapture(dev.blocks.get(t.h) || []); return; }
      case "Device::DeleteStateBlock": { const t = this.tokens.get(a[0]); if (t && !t.snap) dev.DeleteStateBlock(t.h); this.tokens.delete(a[0]); return; }
      /* ---------------- device: frame */
      case "Device::BeginScene": dev.BeginScene(); return;
      case "Device::EndScene": dev.EndScene(); return;
      case "Device::Clear": dev.Clear(a[0] ? a[0].length : 0, a[0] ? a[0].map(d3dRect) : null, a[1], a[2], a[3], a[4]); return;
      case "Device::Reset": { const pp = S.pp(a[0]); if (pp.BackBufferWidth && (pp.BackBufferWidth !== dev.width || pp.BackBufferHeight !== dev.height))
        this.warnOnce("reset", `Reset to ${pp.BackBufferWidth}x${pp.BackBufferHeight} (replay keeps ${dev.width}x${dev.height})`); return; }
      /* ---------------- device: draws */
      case "Device::DrawPrimitive": dev.DrawPrimitive(a[0], a[1], a[2]); return;
      case "Device::DrawIndexedPrimitive": dev.DrawIndexedPrimitive(a[0], a[1], a[2], a[3], a[4]); return;
      case "Device::DrawPrimitiveUP": if (a[3].bytes) dev.DrawPrimitiveUP(a[0], a[1], a[3].bytes.slice(), a[2]); return;
      case "Device::DrawIndexedPrimitiveUP": if (a[6].bytes && a[7].bytes) dev.DrawIndexedPrimitiveUP(a[0], a[1], a[2], a[3], a[6].bytes.slice(), a[4], a[7].bytes.slice(), a[5]); return;
      /* ---------------- device: resources */
      case "Device::CreateTexture": try { this.objs.set(a[6], dev.CreateTexture(a[0], a[1], a[2], a[3], a[4], a[5])); }
        catch (e) { this.warnOnce("tex" + a[4], `CreateTexture format ${a[4]}: ${e.message}`); } return;
      case "Device::CreateVertexBuffer": this.objs.set(a[4], dev.CreateVertexBuffer(a[0], a[1], a[2], a[3])); return;
      case "Device::CreateIndexBuffer": this.objs.set(a[4], dev.CreateIndexBuffer(a[0], a[1], a[2], a[3])); return;
      case "Device::CreateImageSurface": try { const t = dev.CreateTexture(a[0], a[1], 1, 0, a[2], 2); this.objs.set(a[3], new Surface(dev, t, 0)); }
        catch (e) { this.warnOnce("img", "CreateImageSurface: " + e.message); } return;
      case "Device::CreateRenderTarget": case "Device::CreateDepthStencilSurface":
        this.warnOnce(key, key + " is replayed as an alias of the back buffer"); this.objs.set(a[a.length - 1], new Surface(dev, null, 0)); return;
      case "Device::GetBackBuffer": case "Device::GetRenderTarget": case "Device::GetDepthStencilSurface": {
        const id = a[a.length - 1]; if (id && !this.objs.has(id)) this.objs.set(id, new Surface(dev, null, 0)); return; }
      case "Device::CopyRects": {
        const src = this.obj(a[0]), dst = this.obj(a[2]);
        if (!dst || !dst.tex) return this.warnOnce("copyrects", "CopyRects into a non-texture surface skipped");
        if (src && src.tex) this.warnOnce("copyrects2", "CopyRects from a texture surface is replayed as a back-buffer copy");
        try { dev.CopyRects(src, a[1] ? a[1].map(d3dRect) : null, dst, a[3]); } catch (e) { this.warnOnce("copyrects3", "CopyRects: " + e.message); }
        return;
      }
      case "Device::GetFrontBuffer": { const dst = this.obj(a[0]); if (dst && dst.tex) try { dev.CopyRects(null, null, dst, null); } catch (e) {} return; }
      case "Device::UpdateTexture": {
        const s = this.obj(a[0]), d = this.obj(a[1]); if (!s || !d || !s.lv || !d.lv) return;
        for (let l = 0; l < Math.min(s.levels, d.levels); l++){ d.lv[l].mem.u8.set(s.lv[l].mem.u8.subarray(0, d.lv[l].size)); d.lv[l].dirty = true; }
        dev.dirtyTex.add(d); return;
      }
      case "Device::SetRenderTarget": this.warnOnce("rt", "SetRenderTarget is not replayed (Meridian.exe never calls it)"); return;
      /* ---------------- textures / surfaces */
      case "Texture::GetSurfaceLevel": { const t = this.obj(self); if (t && a[1] && !this.objs.has(a[1])) this.objs.set(a[1], new Surface(dev, t, a[0])); return; }
      case "Texture::LockRect": { const t = this.obj(self); if (t) this.pending.set(self + ":" + a[0], t.LockRect(a[0], a[1], a[2])); return; }
      case "Texture::UnlockRect": { const t = this.obj(self), k = self + ":" + a[0];
        this.putData(this.pending.get(k), a[3], a[1], a[2]); this.pending.delete(k); if (t) t.UnlockRect(a[0]); return; }
      case "Surface::LockRect": { const s = this.obj(self); if (s) this.pending.set(self + ":s", s.LockRect(a[0], a[1])); return; }
      case "Surface::UnlockRect": { const s = this.obj(self), k = self + ":s";
        this.putData(this.pending.get(k), a[2], a[0], a[1]); this.pending.delete(k); if (s) s.UnlockRect(); return; }
      /* ---------------- buffers */
      case "VB::Lock": case "IB::Lock": { const b = this.obj(self); if (!b) return;
        const st = this.pending.get(self + ":b") || []; st.push(b.Lock(a[0], a[1], a[2])); this.pending.set(self + ":b", st); return; }
      case "VB::Unlock": case "IB::Unlock": { const b = this.obj(self), st = this.pending.get(self + ":b"); if (!b || !st || !st.length) return;
        this.putData(st.pop(), a[0]); b.Unlock(); return; }
    }
    if (/^(Get|Check|Enum|Validate|Test|QueryInterface|AddRef|Release|ShowCursor|SetCursor|ResourceManager|SetPriority|PreLoad|SetLOD|AddDirtyRect|SetPrivate|FreePrivate)/.test(rec.name)) return;
    this.unhandled.set(key, (this.unhandled.get(key) || 0) + 1);
  }

  /** Drive the whole log (or up to untilFrame). Yields to the browser every few ms so the page stays responsive. */
  async run(reader, {untilFrame = Infinity, onShot, onFrame, stop} = {}){
    let t = performance.now();
    for await (const rec of reader.records()){
      const r = this.apply(rec);
      if (r && onShot) await onShot(r);
      if (rec.iface === "Device" && rec.name === "Present"){
        if (onFrame) await onFrame(this.frame);
        if (this.frame > untilFrame || (stop && stop())) return false;
        if (performance.now() - t > 30){ await new Promise(res => setTimeout(res, 0)); t = performance.now(); }
      }
    }
    return true;
  }
}
