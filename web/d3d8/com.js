// COM bridge: exposes d3d8.js objects to recompiled x86 code living in wasm memory.
//
// Model (docs section 3.4). The recompiled module keeps the x86 stack in linear memory and compiles
//   call dword ptr [reg + off]
// into "fn = load32(load32(this) + off); dispatch(fn, esp)". Game code addresses dispatch to recompiled functions;
// addresses inside the reserved HLE range [THUNK_BASE, THUNK_BASE + 4*N) dispatch to call_indirect on an
// imported table whose entries are JS functions (esp) -> eax. Each COM object we hand out is 8 bytes of wasm
// memory: [vtable pointer][object id]; each vtable is an array of thunk addresses. The thunk reads `this` and
// the stdcall arguments from the emulated stack ([esp] = return address) and reports how many bytes the callee
// pops (stdcall) through popBytes / the POP cell, which the dispatcher adds to esp after the call.
"use strict";
import {Device, Direct3D8, Texture, Surface, Buffer, HR, asFloat, FMT} from "./d3d8.js";

export const THUNK_BASE = 0x7ffe0000;            // reserved "code" addresses (outside the image and the heap)

/* ------------------------------------------------------------------ wasm memory heap (first fit, coalescing) */
export class Heap {
  constructor(memory, base, size){ this.memory = memory; this.free = [{a: base, n: size}]; this.used = new Map(); }
  get u8(){ return new Uint8Array(this.memory.buffer); }
  alloc(n){
    n = (n + 15) & ~15;
    const i = this.free.findIndex(f => f.n >= n); if (i < 0) throw new Error("Heap: out of memory");
    const f = this.free[i], a = f.a; f.a += n; f.n -= n; if (!f.n) this.free.splice(i, 1);
    this.used.set(a, n);
    const heap = this;
    // `u8` is re-created on access because memory.grow() detaches old views
    return {ptr: a, get u8(){ return new Uint8Array(heap.memory.buffer, a, n); }, free(){ heap.release(a); }};
  }
  release(a){
    const n = this.used.get(a); if (!n) return; this.used.delete(a);
    this.free.push({a, n}); this.free.sort((x, y) => x.a - y.a);
    for (let i = 0; i + 1 < this.free.length;){ const x = this.free[i], y = this.free[i + 1]; if (x.a + x.n === y.a){ x.n += y.n; this.free.splice(i + 1, 1); } else i++; }
  }
}

/* ------------------------------------------------------------------ vtable layouts (d3d8.h) */
const UNK = ["QueryInterface", "AddRef", "Release"];
const RES = [...UNK, "GetDevice", "SetPrivateData", "GetPrivateData", "FreePrivateData", "SetPriority", "GetPriority", "PreLoad", "GetType"];
export const VTBL = {
  IDirect3D8: [...UNK, "RegisterSoftwareDevice", "GetAdapterCount", "GetAdapterIdentifier", "GetAdapterModeCount", "EnumAdapterModes",
    "GetAdapterDisplayMode", "CheckDeviceType", "CheckDeviceFormat", "CheckDeviceMultiSampleType", "CheckDepthStencilMatch", "GetDeviceCaps",
    "GetAdapterMonitor", "CreateDevice"],
  IDirect3DDevice8: [...UNK, "TestCooperativeLevel", "GetAvailableTextureMem", "ResourceManagerDiscardBytes", "GetDirect3D", "GetDeviceCaps",
    "GetDisplayMode", "GetCreationParameters", "SetCursorProperties", "SetCursorPosition", "ShowCursor", "CreateAdditionalSwapChain", "Reset",
    "Present", "GetBackBuffer", "GetRasterStatus", "SetGammaRamp", "GetGammaRamp", "CreateTexture", "CreateVolumeTexture", "CreateCubeTexture",
    "CreateVertexBuffer", "CreateIndexBuffer", "CreateRenderTarget", "CreateDepthStencilSurface", "CreateImageSurface", "CopyRects",
    "UpdateTexture", "GetFrontBuffer", "SetRenderTarget", "GetRenderTarget", "GetDepthStencilSurface", "BeginScene", "EndScene", "Clear",
    "SetTransform", "GetTransform", "MultiplyTransform", "SetViewport", "GetViewport", "SetMaterial", "GetMaterial", "SetLight", "GetLight",
    "LightEnable", "GetLightEnable", "SetClipPlane", "GetClipPlane", "SetRenderState", "GetRenderState", "BeginStateBlock", "EndStateBlock",
    "ApplyStateBlock", "CaptureStateBlock", "DeleteStateBlock", "CreateStateBlock", "SetClipStatus", "GetClipStatus", "GetTexture", "SetTexture",
    "GetTextureStageState", "SetTextureStageState", "ValidateDevice", "GetInfo", "SetPaletteEntries", "GetPaletteEntries",
    "SetCurrentTexturePalette", "GetCurrentTexturePalette", "DrawPrimitive", "DrawIndexedPrimitive", "DrawPrimitiveUP", "DrawIndexedPrimitiveUP",
    "ProcessVertices", "CreateVertexShader", "SetVertexShader", "GetVertexShader", "DeleteVertexShader", "SetVertexShaderConstant",
    "GetVertexShaderConstant", "GetVertexShaderDeclaration", "GetVertexShaderFunction", "SetStreamSource", "GetStreamSource", "SetIndices",
    "GetIndices", "CreatePixelShader", "SetPixelShader", "GetPixelShader", "DeletePixelShader", "SetPixelShaderConstant",
    "GetPixelShaderConstant", "GetPixelShaderFunction", "DrawRectPatch", "DrawTriPatch", "DeletePatch"],
  IDirect3DTexture8: [...RES, "SetLOD", "GetLOD", "GetLevelCount", "GetLevelDesc", "GetSurfaceLevel", "LockRect", "UnlockRect", "AddDirtyRect"],
  IDirect3DSurface8: [...UNK, "GetDevice", "SetPrivateData", "GetPrivateData", "FreePrivateData", "GetContainer", "GetDesc", "LockRect", "UnlockRect"],
  IDirect3DVertexBuffer8: [...RES, "Lock", "Unlock", "GetDesc"],
  IDirect3DIndexBuffer8: [...RES, "Lock", "Unlock", "GetDesc"],
  ID3DXFont: [...UNK, "GetDevice", "GetLogFont", "Begin", "DrawTextA", "DrawTextW", "End", "OnLostDevice", "OnResetDevice"],
};
/** stdcall argument count (without `this`) of every method in the vtables (d3d8.h / d3dx8core.h); "Iface::Name" entries
 *  override the plain name where interfaces differ (IDirect3D8::GetDeviceCaps takes 3, the device's takes 1; surface
 *  LockRect/UnlockRect take 3/0, the texture's 4/1). Unimplemented methods still pop the right number of bytes. */
const NARGS = {QueryInterface: 2, AddRef: 0, Release: 0,
  RegisterSoftwareDevice: 1, GetAdapterCount: 0, GetAdapterIdentifier: 3, GetAdapterModeCount: 1, EnumAdapterModes: 3, GetAdapterDisplayMode: 2,
  CheckDeviceType: 5, CheckDeviceFormat: 6, CheckDeviceMultiSampleType: 5, CheckDepthStencilMatch: 5, "IDirect3D8::GetDeviceCaps": 3,
  GetAdapterMonitor: 1, CreateDevice: 6,
  TestCooperativeLevel: 0, GetAvailableTextureMem: 0, ResourceManagerDiscardBytes: 1, GetDirect3D: 1, GetDeviceCaps: 1, GetDisplayMode: 1,
  GetCreationParameters: 1, SetCursorProperties: 3, SetCursorPosition: 3, ShowCursor: 1, CreateAdditionalSwapChain: 2, Reset: 1, Present: 4,
  GetBackBuffer: 3, GetRasterStatus: 1, SetGammaRamp: 2, GetGammaRamp: 1, CreateTexture: 7, CreateVolumeTexture: 8, CreateCubeTexture: 6,
  CreateVertexBuffer: 5, CreateIndexBuffer: 5, CreateRenderTarget: 6, CreateDepthStencilSurface: 5, CreateImageSurface: 4, CopyRects: 5,
  UpdateTexture: 2, GetFrontBuffer: 1, SetRenderTarget: 2, GetRenderTarget: 1, GetDepthStencilSurface: 1, BeginScene: 0, EndScene: 0, Clear: 6,
  SetTransform: 2, GetTransform: 2, MultiplyTransform: 2, SetViewport: 1, GetViewport: 1, SetMaterial: 1, GetMaterial: 1, SetLight: 2, GetLight: 2,
  LightEnable: 2, GetLightEnable: 2, SetClipPlane: 2, GetClipPlane: 2, SetRenderState: 2, GetRenderState: 2, BeginStateBlock: 0, EndStateBlock: 1,
  ApplyStateBlock: 1, CaptureStateBlock: 1, DeleteStateBlock: 1, CreateStateBlock: 2, SetClipStatus: 1, GetClipStatus: 1, GetTexture: 2,
  SetTexture: 2, GetTextureStageState: 3, SetTextureStageState: 3, ValidateDevice: 1, GetInfo: 3, SetPaletteEntries: 2, GetPaletteEntries: 2,
  SetCurrentTexturePalette: 1, GetCurrentTexturePalette: 1, DrawPrimitive: 3, DrawIndexedPrimitive: 5, DrawPrimitiveUP: 4,
  DrawIndexedPrimitiveUP: 8, ProcessVertices: 5, CreateVertexShader: 4, SetVertexShader: 1, GetVertexShader: 1, DeleteVertexShader: 1,
  SetVertexShaderConstant: 3, GetVertexShaderConstant: 3, GetVertexShaderDeclaration: 3, GetVertexShaderFunction: 3, SetStreamSource: 3,
  GetStreamSource: 3, SetIndices: 2, GetIndices: 2, CreatePixelShader: 2, SetPixelShader: 1, GetPixelShader: 1, DeletePixelShader: 1,
  SetPixelShaderConstant: 3, GetPixelShaderConstant: 3, GetPixelShaderFunction: 3, DrawRectPatch: 3, DrawTriPatch: 3, DeletePatch: 1,
  GetDevice: 1, SetPrivateData: 4, GetPrivateData: 3, FreePrivateData: 1, SetPriority: 1, GetPriority: 0, PreLoad: 0, GetType: 0,
  SetLOD: 1, GetLOD: 0, GetLevelCount: 0, GetLevelDesc: 2, GetSurfaceLevel: 2, LockRect: 4, UnlockRect: 1, AddDirtyRect: 1,
  GetContainer: 2, GetDesc: 1, "IDirect3DSurface8::LockRect": 3, "IDirect3DSurface8::UnlockRect": 0,
  Lock: 4, Unlock: 0, GetLogFont: 1, Begin: 0, DrawTextA: 5, DrawTextW: 5, End: 0, OnLostDevice: 0, OnResetDevice: 0};

export class ComBridge {
  /** memory: WebAssembly.Memory shared with the recompiled module; heap: Heap in that memory. */
  constructor(memory, heap, gl){
    Object.assign(this, {memory, heap, gl});
    this.thunks = [];                  // index -> {iface, name, nargs, fn}
    this.vtables = {};                 // iface -> address
    this.objs = new Map();             // ptr -> js object
    this.popBytes = 0; this.log = [];
    this.d3d = null;
    for (const [iface, names] of Object.entries(VTBL)) this.buildVtable(iface, names);
  }
  get dv(){ return new DataView(this.memory.buffer); }
  u32(a){ return this.dv.getUint32(a, true); } f32(a){ return this.dv.getFloat32(a, true); }
  w32(a, v){ this.dv.setUint32(a, v >>> 0, true); }
  bytes(a, n){ return new Uint8Array(this.memory.buffer, a, n); }
  buildVtable(iface, names){
    const vt = this.heap.alloc(names.length * 4).ptr;
    names.forEach((name, i) => {
      const idx = this.thunks.length;
      this.thunks.push({iface, name, nargs: NARGS[iface + "::" + name] ?? NARGS[name] ?? 0, impl: this.impl(iface, name)});
      this.w32(vt + i * 4, THUNK_BASE + idx * 4);
    });
    this.vtables[iface] = vt;
  }
  /** Allocate the 8-byte COM object for js object `o` (idempotent). */
  wrap(o, iface){
    if (!o) return 0;
    if (o.__ptr) return o.__ptr;
    const p = this.heap.alloc(8).ptr; this.w32(p, this.vtables[iface]); this.w32(p + 4, this.objs.size + 1);
    o.__ptr = p; o.__iface = iface; this.objs.set(p, o); return p;
  }
  obj(p){ return p ? this.objs.get(p) : null; }
  /** The JS side of thunk `idx`: what the imported table entry calls. Returns eax. */
  dispatch(idx, esp){
    const t = this.thunks[idx];
    if (!t) throw new Error("bad thunk " + idx);
    const self = this.obj(this.u32(esp + 4)), args = [];
    for (let i = 0; i < t.nargs; i++) args.push(this.u32(esp + 8 + i * 4));
    this.popBytes = 4 + 4 * t.nargs;
    if (!t.impl){ this.log.push(`unimplemented ${t.iface}::${t.name}`); return HR.INVALIDCALL; }
    const r = t.impl(self, args);
    return (r === undefined ? 0 : r) | 0;
  }
  /** JS functions for the thunk module's import list (one per thunk). */
  thunkFunctions(){ return this.thunks.map((_, i) => esp => this.dispatch(i, esp)); }

  /* -------------------------------------------------- struct readers (d3d8types.h layouts) */
  matrix(p){ return new Float32Array(this.memory.buffer.slice(p, p + 64)); }
  rect(p){ return p ? {left: this.u32(p) | 0, top: this.u32(p + 4) | 0, right: this.u32(p + 8) | 0, bottom: this.u32(p + 12) | 0} : null; }
  color(p){ return [this.f32(p), this.f32(p + 4), this.f32(p + 8), this.f32(p + 12)]; }
  viewport(p){ return {X: this.u32(p), Y: this.u32(p + 4), Width: this.u32(p + 8), Height: this.u32(p + 12), MinZ: this.f32(p + 16), MaxZ: this.f32(p + 20)}; }
  material(p){ return {Diffuse: this.color(p), Ambient: this.color(p + 16), Specular: this.color(p + 32), Emissive: this.color(p + 48), Power: this.f32(p + 64)}; }
  light(p){ const v = o => [this.f32(p + o), this.f32(p + o + 4), this.f32(p + o + 8)];
    return {Type: this.u32(p), Diffuse: this.color(p + 4), Specular: this.color(p + 20), Ambient: this.color(p + 36), Position: v(52), Direction: v(64),
      Range: this.f32(p + 76), Falloff: this.f32(p + 80), Attenuation0: this.f32(p + 84), Attenuation1: this.f32(p + 88), Attenuation2: this.f32(p + 92),
      Theta: this.f32(p + 96), Phi: this.f32(p + 100)}; }
  pp(p){ return {BackBufferWidth: this.u32(p), BackBufferHeight: this.u32(p + 4), BackBufferFormat: this.u32(p + 8), BackBufferCount: this.u32(p + 12),
    MultiSampleType: this.u32(p + 16), SwapEffect: this.u32(p + 20), hDeviceWindow: this.u32(p + 24), Windowed: this.u32(p + 28),
    EnableAutoDepthStencil: this.u32(p + 32), AutoDepthStencilFormat: this.u32(p + 36), Flags: this.u32(p + 40)}; }

  /** Method implementations: (self, args[]) -> HRESULT / value. Only the subset Meridian.exe uses. */
  impl(iface, name){
    const B = this;
    const common = {
      AddRef: o => o.AddRef ? o.AddRef() : 1,
      Release: o => o.Release ? o.Release() : 0,
      QueryInterface: () => 0x80004002 | 0,
    };
    if (common[name]) return common[name];
    if (iface === "IDirect3D8") return ({
      GetAdapterCount: d => d.GetAdapterCount(),
      GetAdapterModeCount: d => d.GetAdapterModeCount(),
      EnumAdapterModes: (d, [a, i, out]) => { const m = d.EnumAdapterModes(a, i); [m.Width, m.Height, m.RefreshRate, m.Format].forEach((v, k) => B.w32(out + 4 * k, v)); return 0; },
      GetAdapterDisplayMode: (d, [a, out]) => { const m = d.GetAdapterDisplayMode(); [m.Width, m.Height, m.RefreshRate, m.Format].forEach((v, k) => B.w32(out + 4 * k, v)); return 0; },
      GetAdapterIdentifier: (d, [a, f, out]) => { B.bytes(out, 1068).fill(0); const s = new TextEncoder().encode("WebGL2"); B.bytes(out, s.length).set(s); B.bytes(out + 512, s.length).set(s); return 0; },
      CheckDeviceType: d => 0, CheckDepthStencilMatch: d => 0,
      CheckDeviceFormat: (d, a) => d.CheckDeviceFormat(...a),
      GetDeviceCaps: (d, [a, t, out]) => { B.writeCaps(out, d.GetDeviceCaps()); return 0; },
      GetAdapterMonitor: d => 1,
      CreateDevice: (d, [adapter, type, hwnd, flags, ppp, ppDev]) => {
        const dev = d.CreateDevice(adapter, type, hwnd, flags, B.pp(ppp), B.gl);
        dev.hwnd = hwnd; dev.createFlags = flags;
        B.device = dev; B.w32(ppDev, B.wrap(dev, "IDirect3DDevice8")); return 0; },
    })[name];
    if (iface === "IDirect3DDevice8") return ({
      TestCooperativeLevel: d => d.TestCooperativeLevel(), GetAvailableTextureMem: d => d.GetAvailableTextureMem(),
      ResourceManagerDiscardBytes: d => 0, ShowCursor: (d, [b]) => d.ShowCursor(b), Reset: d => 0,
      GetDeviceCaps: (d, [out]) => { B.writeCaps(out, B.d3d ? B.d3d.GetDeviceCaps() : {}); return 0; },
      // used by the statically linked D3DX8 (texture requirement checks)
      GetDirect3D: (d, [pp]) => { if (B.d3d) B.d3d.AddRef(); B.w32(pp, B.wrap(B.d3d, "IDirect3D8")); return 0; },
      GetDisplayMode: (d, [p]) => { [d.width, d.height, 60, d.backFormat].forEach((v, k) => B.w32(p + 4 * k, v)); return 0; },
      GetCreationParameters: (d, [p]) => { [0, 1, d.hwnd || 0, d.createFlags || 0x40].forEach((v, k) => B.w32(p + 4 * k, v)); return 0; },
      Present: d => d.Present(), BeginScene: d => d.BeginScene(), EndScene: d => d.EndScene(),
      Clear: (d, [n, pr, flags, color, z, st]) => d.Clear(n, pr ? [...Array(n)].map((_, i) => B.rect(pr + 16 * i)) : null, flags, color, asFloat(z), st),
      SetTransform: (d, [t, pm]) => d.SetTransform(t, B.matrix(pm)),
      GetTransform: (d, [t, pm]) => { B.bytes(pm, 64).set(new Uint8Array(d.GetTransform(t).buffer)); return 0; },
      SetViewport: (d, [p]) => d.SetViewport(B.viewport(p)),
      GetViewport: (d, [p]) => { const v = d.GetViewport(); [v.X, v.Y, v.Width, v.Height].forEach((x, k) => B.w32(p + 4 * k, x)); B.dv.setFloat32(p + 16, v.MinZ, true); B.dv.setFloat32(p + 20, v.MaxZ, true); return 0; },
      SetMaterial: (d, [p]) => d.SetMaterial(B.material(p)),
      SetLight: (d, [i, p]) => d.SetLight(i, B.light(p)), LightEnable: (d, [i, on]) => d.LightEnable(i, !!on),
      SetRenderState: (d, [s, v]) => d.SetRenderState(s, v), GetRenderState: (d, [s, p]) => (B.w32(p, d.GetRenderState(s)), 0),
      SetTextureStageState: (d, [st, s, v]) => d.SetTextureStageState(st, s, v),
      GetTextureStageState: (d, [st, s, p]) => (B.w32(p, d.GetTextureStageState(st, s)), 0),
      SetTexture: (d, [st, p]) => d.SetTexture(st, B.obj(p)),
      BeginStateBlock: d => d.BeginStateBlock(), EndStateBlock: (d, [p]) => (B.w32(p, d.EndStateBlock()), 0),
      ApplyStateBlock: (d, [h]) => d.ApplyStateBlock(h), DeleteStateBlock: (d, [h]) => d.DeleteStateBlock(h),
      ValidateDevice: (d, [p]) => (B.w32(p, 1), 0),
      SetGammaRamp: (d, [f, p]) => { const w = k => [...Array(256)].map((_, i) => B.dv.getUint16(p + k * 512 + i * 2, true)); return d.SetGammaRamp(f, {red: w(0), green: w(1), blue: w(2)}); },
      GetGammaRamp: (d, [p]) => { const r = d.GetGammaRamp(); [r.red, r.green, r.blue].forEach((a, k) => a.forEach((v, i) => B.dv.setUint16(p + k * 512 + i * 2, v, true))); return 0; },
      CreateTexture: (d, [w, h, lv, usage, fmt, pool, pp]) => { B.w32(pp, B.wrap(d.CreateTexture(w, h, lv, usage, fmt, pool), "IDirect3DTexture8")); return 0; },
      CreateVertexBuffer: (d, [n, usage, fvf, pool, pp]) => { B.w32(pp, B.wrap(d.CreateVertexBuffer(n, usage, fvf, pool), "IDirect3DVertexBuffer8")); return 0; },
      CreateIndexBuffer: (d, [n, usage, fmt, pool, pp]) => { B.w32(pp, B.wrap(d.CreateIndexBuffer(n, usage, fmt, pool), "IDirect3DIndexBuffer8")); return 0; },
      GetRenderTarget: (d, [pp]) => { B.w32(pp, B.wrap(d.GetRenderTarget(), "IDirect3DSurface8")); return 0; },
      CopyRects: (d, [src, pr, n, dst, pts]) => d.CopyRects(B.obj(src), pr ? [...Array(n)].map((_, i) => B.rect(pr + 16 * i)) : null, B.obj(dst),
        pts ? [{x: B.u32(pts), y: B.u32(pts + 4)}] : null),
      SetVertexShader: (d, [h]) => d.SetVertexShader(h),
      SetStreamSource: (d, [n, p, stride]) => d.SetStreamSource(n, B.obj(p), stride),
      SetIndices: (d, [p, base]) => d.SetIndices(B.obj(p), base),
      DrawPrimitive: (d, a) => d.DrawPrimitive(...a), DrawIndexedPrimitive: (d, a) => d.DrawIndexedPrimitive(...a),
      DrawPrimitiveUP: (d, [pt, n, pv, stride]) => d.DrawPrimitiveUP(pt, n, B.bytes(pv, d.vcount(pt, n) * stride), stride),
      DrawIndexedPrimitiveUP: (d, [pt, mi, nv, n, pi, ifmt, pv, stride]) =>
        d.DrawIndexedPrimitiveUP(pt, mi, nv, n, B.bytes(pi, d.vcount(pt, n) * (ifmt === FMT.INDEX32 ? 4 : 2)), ifmt, B.bytes(pv, (mi + nv) * stride), stride),
    })[name];
    if (iface === "IDirect3DTexture8") return ({
      GetLevelCount: t => t.GetLevelCount(),
      GetLevelDesc: (t, [l, p]) => { const d = t.GetLevelDesc(l); [d.Format, d.Type, d.Usage, d.Pool, d.Size, 0, d.Width, d.Height].forEach((v, k) => B.w32(p + 4 * k, v)); return 0; },
      GetSurfaceLevel: (t, [l, pp]) => { B.w32(pp, B.wrap(t.GetSurfaceLevel(l), "IDirect3DSurface8")); return 0; },
      LockRect: (t, [l, plr, pr, f]) => { const r = t.LockRect(l, B.rect(pr), f); B.w32(plr, r.pitch); B.w32(plr + 4, r.ptr); return 0; },
      UnlockRect: (t, [l]) => t.UnlockRect(l),
    })[name];
    if (iface === "IDirect3DSurface8") return ({
      GetDesc: (s, [p]) => { const d = s.GetDesc(); [d.Format, d.Type || 1, d.Usage || 0, d.Pool || 0, d.Size || 0, 0, d.Width, d.Height].forEach((v, k) => B.w32(p + 4 * k, v)); return 0; },
      LockRect: (s, [plr, pr, f]) => { const r = s.LockRect(B.rect(pr), f); if (!r) return HR.INVALIDCALL; B.w32(plr, r.pitch); B.w32(plr + 4, r.ptr); return 0; },
      UnlockRect: s => s.UnlockRect(),
    })[name];
    if (iface === "IDirect3DVertexBuffer8" || iface === "IDirect3DIndexBuffer8") return ({
      Lock: (b, [off, size, pp, flags]) => { B.w32(pp, b.Lock(off, size, flags).ptr); return 0; },
      Unlock: b => b.Unlock(),
      GetDesc: (b, [p]) => { const d = b.GetDesc(); [d.Format, d.Type, d.Usage, d.Pool, d.Size, d.FVF].slice(0, b.kind === "vb" ? 6 : 5).forEach((v, k) => B.w32(p + 4 * k, v)); return 0; },
    })[name];
    if (iface === "ID3DXFont") return ({
      DrawTextA: (f, [s, n, pr, fmt, color]) => f.drawText(B.cstr(s, n), B, pr, fmt, color),
      DrawTextW: (f, [s, n, pr, fmt, color]) => f.drawText(B.wstr(s, n), B, pr, fmt, color),
    })[name];
    return null;
  }
  cstr(p, n){ const u = new Uint8Array(this.memory.buffer); let e = p; while ((n < 0 || n === 0xffffffff) ? u[e] : e - p < n) e++; return new TextDecoder("latin1").decode(u.slice(p, e)); }
  wstr(p, n){ const d = this.dv; let s = ""; for (let i = 0; n === 0xffffffff || n < 0 ? d.getUint16(p + 2 * i, true) : i < n; i++) s += String.fromCharCode(d.getUint16(p + 2 * i, true)); return s; }
  /** D3DCAPS8 field offsets that Meridian.exe reads (docs 2.7). Everything else stays 0. */
  writeCaps(p, c){
    this.bytes(p, 0xd4).fill(0);
    const put = (o, v) => this.w32(p + o, v);
    // a GeForce-class HAL device (hardware T&L, all compare/blend modes) so the game takes its normal paths
    put(0x00, 1); put(0x08, 0x20000); put(0x0c, 0x20000000); put(0x10, 0x20); put(0x14, 0x8000000f); put(0x18, 1);
    put(0x1c, 0x000bbef0); put(0x20, 0x2ce); put(0x24, 0x07732191); put(0x28, 0xff); put(0x2c, 0x1fff); put(0x30, 0x1fff); put(0x34, 0xff);
    put(0x38, 0x41ef8); put(0x3c, 0x0001ec85); put(0x40, 0x03030303 | 0x0400); put(0x44, 0x03030303); put(0x48, 0x03030303); put(0x4c, 0x3f);
    put(0x50, 0x3f); put(0x54, 0x1f); put(0x64, 8192); put(0x68, 8192); put(0x70, 0x4b189680); put(0x88, 0xff); put(0x8c, 0x80008);
    put(0x9c, 0x3b); put(0xa4, 6); put(0xa8, 4); put(0xb0, 0x42000000); put(0x58, c.MaxTextureWidth || 4096); put(0x5c, c.MaxTextureHeight || 4096);
    put(0x6c, c.MaxAnisotropy || 16); put(0x90, c.TextureOpCaps ?? 0x03feffff); put(0x94, c.MaxTextureBlendStages || 8); put(0x98, c.MaxSimultaneousTextures || 8);
    put(0xa0, c.MaxActiveLights || 8); put(0xb4, c.MaxPrimitiveCount || 0xfffff); put(0xb8, c.MaxVertexIndex || 0xffffff); put(0xbc, 1); put(0xc0, 255);
  }
  /** Direct3DCreate8(SDKVersion) HLE (IAT slot of d3d8.dll!Direct3DCreate8, thunk 0067da02). */
  Direct3DCreate8(sdk){ this.d3d = new Direct3D8({alloc: n => this.heap.alloc(n)}); return this.wrap(this.d3d, "IDirect3D8"); }
}

/* ------------------------------------------------------------------ tiny wasm assembler for the bridge modules */
const uleb = n => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sleb = n => { const o = []; n |= 0; for (;;){ const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))){ o.push(b); return o; } o.push(b | 0x80); } };
const str = s => [...uleb(s.length), ...new TextEncoder().encode(s)];
const vec = items => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const T_ESP = [0x60, 1, 0x7f, 1, 0x7f];                       // (i32 esp) -> i32 eax

/** Module that places N imported JS functions into the imported table (elem segment): the "HLE thunk table". */
export function thunkModule(n){
  const imports = [...[...Array(n)].map((_, i) => [...str("env"), ...str("f" + i), 0x00, 0x00]), [...str("env"), ...str("tbl"), 0x01, 0x70, 0x00, ...uleb(n)]];
  return new Uint8Array([...HEADER, ...section(1, vec([T_ESP])), ...section(2, vec(imports)),
    ...section(9, vec([[0x00, 0x41, 0x00, 0x0b, ...vec([...Array(n)].map((_, i) => uleb(i)))]]))]);
}
/** Stand-in for recompiled game code: com_call(this, off, esp) = call_indirect(table[(load(load(this)+off) - THUNK_BASE) >> 2])(esp). */
export function callerModule(n){
  const body = [0x00,                                          // no locals
    0x20, 0x02,                                                // local.get esp
    0x20, 0x00, 0x28, 0x02, 0x00,                              // i32.load [this]       -> vtable
    0x20, 0x01, 0x6a, 0x28, 0x02, 0x00,                        // i32.load [vt + off]   -> fake code address
    0x41, ...sleb(THUNK_BASE), 0x6b, 0x41, 0x02, 0x76,         // (addr - THUNK_BASE) >> 2
    0x11, 0x00, 0x00, 0x0b];                                   // call_indirect (type 0) table 0
  const imports = [[...str("env"), ...str("mem"), 0x02, 0x00, 0x01], [...str("env"), ...str("tbl"), 0x01, 0x70, 0x00, ...uleb(n)]];
  return new Uint8Array([...HEADER, ...section(1, vec([T_ESP, [0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f]])), ...section(2, vec(imports)),
    ...section(3, vec([[1]])), ...section(7, vec([[...str("com_call"), 0x00, 0x00]])), ...section(10, vec([[...uleb(body.length), ...body]]))]);
}
/** Instantiate both modules against `memory` and return com_call. */
export async function linkBridge(bridge){
  const n = bridge.thunks.length, tbl = new WebAssembly.Table({initial: n, element: "anyfunc"});
  const env = {tbl}; bridge.thunkFunctions().forEach((f, i) => env["f" + i] = f);
  await WebAssembly.instantiate(thunkModule(n), {env});
  const {instance} = await WebAssembly.instantiate(callerModule(n), {env: {mem: bridge.memory, tbl}});
  return instance.exports.com_call;
}
