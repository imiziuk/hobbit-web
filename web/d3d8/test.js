// Self-checking scenes for d3d8.js (synthetic data only). Every check reads back-buffer pixels.
"use strict";
import {Device, RS, TSS, TOP, TA, FMT, FVF, PT, TS, LOCK, CLEAR, TCI, LIGHT, asBits, decodeFVF, color4} from "./d3d8.js";
import {setupStage, GAME_STRINGS} from "./stagelang.js";
import {D3DXCreateFont, D3DXLoadSurfaceFromMemory} from "./d3dx.js";
import {ComBridge, Heap, linkBridge, VTBL} from "./com.js";

const results = [];
const check = (name, ok, detail = "") => { results.push({name, ok: !!ok, detail}); return ok; };
const near = (a, b, tol = 3) => a.every((v, i) => b[i] === undefined || Math.abs(v - b[i]) <= tol);
const fmtPx = p => `(${p.join(",")})`;
const W = 256, H = 256;

/* ------------------------------------------------------------------ helpers */
function rhwQuad(x0, y0, x1, y1, color, uv = [0, 0, 1, 1]){
  // XYZRHW|DIFFUSE|TEX1, triangle strip, pixel-aligned (D3D8: -0.5 puts edges between pixel centres)
  const b = new ArrayBuffer(4 * 28), f = new Float32Array(b), u = new Uint32Array(b);
  [[x0, y0, uv[0], uv[1]], [x1, y0, uv[2], uv[1]], [x0, y1, uv[0], uv[3]], [x1, y1, uv[2], uv[3]]].forEach(([x, y, s, t], i) => {
    f.set([x - 0.5, y - 0.5, 0.5, 1], i * 7); u[i * 7 + 4] = color >>> 0; f[i * 7 + 5] = s; f[i * 7 + 6] = t; });
  return new Uint8Array(b);
}
function basic2D(dev){
  dev.SetRenderState(RS.ZENABLE, 0); dev.SetRenderState(RS.LIGHTING, 0); dev.SetRenderState(RS.CULLMODE, 1);
  dev.SetRenderState(RS.ALPHABLENDENABLE, 0); dev.SetRenderState(RS.ALPHATESTENABLE, 0); dev.SetRenderState(RS.FOGENABLE, 0);
  dev.SetTextureStageState(0, TSS.COLOROP, TOP.SELECTARG1); dev.SetTextureStageState(0, TSS.COLORARG1, TA.DIFFUSE);
  dev.SetTextureStageState(0, TSS.ALPHAOP, TOP.SELECTARG1); dev.SetTextureStageState(0, TSS.ALPHAARG1, TA.DIFFUSE);
  dev.SetTextureStageState(1, TSS.COLOROP, TOP.DISABLE); dev.SetTextureStageState(1, TSS.ALPHAOP, TOP.DISABLE);
  dev.SetTexture(0, null); dev.SetTexture(1, null);
  dev.SetVertexShader(FVF.XYZRHW | FVF.DIFFUSE | 0x100);
}
function argbTexture(dev, w, h, px){             // px(x,y) -> 0xAARRGGBB
  const t = dev.CreateTexture(w, h, 1, 0, FMT.A8R8G8B8, 1), lk = t.LockRect(0, null, 0);
  const dv = new DataView(lk.bytes.buffer, lk.bytes.byteOffset);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dv.setUint32(y * lk.pitch + x * 4, px(x, y) >>> 0, true);
  t.UnlockRect(0); return t;
}
function dxt3Solid(r5, g6, b5, a4){             // one DXT3 block with a single colour
  const blk = new Uint8Array(16), c = r5 << 11 | g6 << 5 | b5;
  blk.fill(a4 * 17, 0, 8); blk[8] = c & 255; blk[9] = c >> 8; blk[10] = c & 255; blk[11] = c >> 8; return blk;
}
function perspLH(fovy, aspect, n, f){            // D3DXMatrixPerspectiveFovLH, D3D memory order
  const ys = 1 / Math.tan(fovy / 2), xs = ys / aspect;
  return new Float32Array([xs, 0, 0, 0, 0, ys, 0, 0, 0, 0, f / (f - n), 1, 0, 0, -n * f / (f - n), 0]);
}
const translate = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const ident = () => translate(0, 0, 0);
function cube(){                                  // XYZ|NORMAL|TEX1, 24 verts, 36 indices (CW front faces, D3D style)
  const v = [], idx = [];
  const faces = [[[0, 0, -1], [1, 0, 0], [0, 1, 0]], [[0, 0, 1], [-1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, -1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, -1]]];
  faces.forEach(([n, r, u], fi) => {
    for (const [a, b, s, t] of [[-1, 1, 0, 0], [1, 1, 1, 0], [-1, -1, 0, 1], [1, -1, 1, 1]])
      v.push(n[0] + a * r[0] + b * u[0], n[1] + a * r[1] + b * u[1], n[2] + a * r[2] + b * u[2], ...n, s, t);
    const o = fi * 4; idx.push(o, o + 1, o + 2, o + 2, o + 1, o + 3);   // clockwise when seen from outside
  });
  return {v: new Float32Array(v), idx: new Uint16Array(idx)};
}

/* ------------------------------------------------------------------ CPU reference of the D3D8 stage combiner */
function refCombine(stages, inp){
  const clamp = x => Math.min(1, Math.max(0, x));
  let cur = inp.D.slice(), tmp = [0, 0, 0, 0];
  for (let s = 0; s < stages.length; s++){
    const t = stages[s]; if (t[TSS.COLOROP] === TOP.DISABLE) break;
    const tex = inp.X[s] || [1, 1, 1, 1];
    const get = a => { let v = [inp.D, s ? cur : inp.D, tex, inp.K, inp.S, tmp][a & 0xf] || [1, 1, 1, 1]; v = v.slice();
      if (a & TA.ALPHAREPLICATE) v = [v[3], v[3], v[3], v[3]]; if (a & TA.COMPLEMENT) v = v.map(x => 1 - x); return v; };
    const op = (o, a0, a1, a2, k) => {          // k = channel index
      const x1 = a1[k], x2 = a2[k], x0 = a0[k];
      switch (o){
        case TOP.SELECTARG1: return x1; case TOP.SELECTARG2: return x2; case TOP.MODULATE: return x1 * x2;
        case TOP.MODULATE2X: return 2 * x1 * x2; case TOP.MODULATE4X: return 4 * x1 * x2; case TOP.ADD: return x1 + x2;
        case TOP.ADDSIGNED: return x1 + x2 - 0.5; case TOP.ADDSIGNED2X: return 2 * (x1 + x2 - 0.5); case TOP.SUBTRACT: return x1 - x2;
        case TOP.ADDSMOOTH: return x1 + x2 - x1 * x2;
        case TOP.BLENDDIFFUSEALPHA: return x1 * inp.D[3] + x2 * (1 - inp.D[3]);
        case TOP.BLENDTEXTUREALPHA: return x1 * tex[3] + x2 * (1 - tex[3]);
        case TOP.BLENDFACTORALPHA: return x1 * inp.K[3] + x2 * (1 - inp.K[3]);
        case TOP.BLENDCURRENTALPHA: { const c = s ? cur : inp.D; return x1 * c[3] + x2 * (1 - c[3]); }
        case TOP.MULTIPLYADD: return x0 + x1 * x2; case TOP.LERP: return x0 * x1 + (1 - x0) * x2;
        case TOP.MODULATEALPHA_ADDCOLOR: return k < 3 ? x1 + a1[3] * x2 : x1;
        default: return NaN;
      }
    };
    const C = [0, 1, 2].map(k => clamp(op(t[TSS.COLOROP], get(t[TSS.COLORARG0]), get(t[TSS.COLORARG1]), get(t[TSS.COLORARG2]), k)));
    const A = t[TSS.ALPHAOP] === TOP.DISABLE ? (s ? cur : inp.D)[3] : clamp(op(t[TSS.ALPHAOP], get(t[TSS.ALPHAARG0]), get(t[TSS.ALPHAARG1]), get(t[TSS.ALPHAARG2]), 3));
    if ((t[TSS.RESULTARG] & 0xf) === TA.TEMP) tmp = [...C, A]; else cur = [...C, A];
  }
  return cur;
}

/* ------------------------------------------------------------------ scenes */
export async function run(canvas, canvas2, log){
  const gl = canvas.getContext("webgl2", {antialias: false, preserveDrawingBuffer: true});
  const dev = new Device(gl, {width: W, height: H, noS3TC: typeof location !== "undefined" && location.search.includes("nos3tc")});
  check("WEBGL_compressed_texture_s3tc available (else CPU DXT decode)", true, dev.s3tc ? "native S3TC" : "CPU fallback");
  dev.SetViewport({X: 0, Y: 0, Width: W, Height: H, MinZ: 0, MaxZ: 1});

  // 1. Clear
  dev.BeginScene();
  dev.Clear(0, null, CLEAR.TARGET | CLEAR.ZBUFFER, 0xff336699, 1, 0);
  check("Clear colour", near(dev.readPixel(5, 5), [0x33, 0x66, 0x99, 255], 0), fmtPx(dev.readPixel(5, 5)));

  // 2. Pre-transformed HUD quad: D3D8 pixel coverage (pixels 10..19 covered, 9 and 20 not)
  basic2D(dev);
  dev.DrawPrimitiveUP(PT.TRIANGLESTRIP, 2, rhwQuad(10, 10, 20, 20, 0xffff0000), 28);
  const inside = [[10, 10], [19, 19], [10, 19], [19, 10]].every(([x, y]) => near(dev.readPixel(x, y), [255, 0, 0], 0));
  const outside = [[9, 10], [20, 10], [10, 9], [10, 20]].every(([x, y]) => near(dev.readPixel(x, y), [0x33, 0x66, 0x99], 0));
  check("XYZRHW quad covers exactly pixels 10..19 (D3D8 half-pixel rule)", inside && outside, `in ${inside} out ${outside}`);

  // 3. Lit, textured (DXT3), fogged cube vs the same cube without fog
  {
    const tex = dev.CreateTexture(8, 8, 1, 0, FMT.DXT3, 1), lk = tex.LockRect(0, null, 0), blk = dxt3Solid(31, 32, 0, 15);
    for (let i = 0; i < 4; i++) lk.bytes.set(blk, i * 16);
    tex.UnlockRect(0);
    const c = cube(), L = decodeFVF(FVF.XYZ | FVF.NORMAL | 0x100);
    const vb = dev.CreateVertexBuffer(c.v.byteLength, 0, 0, 1), ib = dev.CreateIndexBuffer(c.idx.byteLength, 0, FMT.INDEX16, 1);
    vb.Lock(0, 0, 0).bytes.set(new Uint8Array(c.v.buffer)); vb.Unlock();
    ib.Lock(0, 0, 0).bytes.set(new Uint8Array(c.idx.buffer)); ib.Unlock();
    dev.SetRenderState(RS.ZENABLE, 1); dev.SetRenderState(RS.ZWRITEENABLE, 1); dev.SetRenderState(RS.CULLMODE, 3);
    dev.SetRenderState(RS.LIGHTING, 1); dev.SetRenderState(RS.AMBIENT, 0);
    dev.SetMaterial({Diffuse: [0.8, 0.8, 0.8, 1], Ambient: [0, 0, 0, 0], Specular: [0, 0, 0, 0], Emissive: [0, 0, 0, 0], Power: 0});
    dev.SetLight(0, {Type: LIGHT.DIRECTIONAL, Diffuse: [1, 1, 1, 1], Specular: [0, 0, 0, 0], Ambient: [0, 0, 0, 0], Position: [0, 0, 0], Direction: [0, 0, 1],
      Range: 0, Falloff: 0, Attenuation0: 0, Attenuation1: 0, Attenuation2: 0, Theta: 0, Phi: 0});
    dev.LightEnable(0, true);
    dev.SetTransform(TS.VIEW, ident()); dev.SetTransform(TS.PROJECTION, perspLH(Math.PI / 2, 1, 0.5, 100));
    dev.SetTexture(0, tex);
    dev.SetTextureStageState(0, TSS.COLOROP, TOP.MODULATE); dev.SetTextureStageState(0, TSS.COLORARG1, TA.TEXTURE); dev.SetTextureStageState(0, TSS.COLORARG2, TA.DIFFUSE);
    dev.SetTextureStageState(0, TSS.ALPHAOP, TOP.SELECTARG1); dev.SetTextureStageState(0, TSS.ALPHAARG1, TA.TEXTURE);
    dev.SetTextureStageState(0, TSS.MAGFILTER, 2); dev.SetTextureStageState(0, TSS.MINFILTER, 2);
    dev.SetVertexShader(L.fvf); dev.SetStreamSource(0, vb, L.stride); dev.SetIndices(ib, 0);
    dev.SetRenderState(RS.FOGCOLOR, 0xff0000ff); dev.SetRenderState(RS.FOGTABLEMODE, 3);
    dev.SetRenderState(RS.FOGSTART, asBits(0)); dev.SetRenderState(RS.FOGEND, asBits(8));
    dev.SetRenderState(RS.FOGENABLE, 1); dev.SetTransform(TS.WORLD, translate(-2, 0, 5));
    dev.DrawIndexedPrimitive(PT.TRIANGLELIST, 0, 24, 0, 12);
    dev.SetRenderState(RS.FOGENABLE, 0); dev.SetTransform(TS.WORLD, translate(2, 0, 5));
    dev.DrawIndexedPrimitive(PT.TRIANGLELIST, 0, 24, 0, 12);
    // front face at eye z = 4: texel (255,129,0) * 0.8 = (204,103,0); linear fog f = (8-4)/8 = 0.5 toward blue
    const fogged = dev.readPixel(64, 128), plain = dev.readPixel(192, 128);
    check("Lit DXT3 cube, N.L = 1, material 0.8", near(plain, [204, 103, 0], 3), fmtPx(plain) + " expect (204,103,0)");
    check("Linear table fog f = 0.5", near(fogged, [102, 52, 128], 3), fmtPx(fogged) + " expect (102,52,128)");
    // depth test: the second cube's back faces must not show through (centre pixel stays the front face colour)
    // 4. a point light at the camera, attenuation 1/(1 + 0.25 d), lit per vertex: corner d = sqrt(18), att 0.485, N.L 0.943
    dev.SetLight(1, {Type: LIGHT.POINT, Diffuse: [1, 1, 1, 1], Specular: [0, 0, 0, 0], Ambient: [0, 0, 0, 0], Position: [0, 0, 0], Direction: [0, 0, 1],
      Range: 100, Falloff: 0, Attenuation0: 1, Attenuation1: 0.25, Attenuation2: 0, Theta: 0, Phi: 0});
    dev.LightEnable(0, false); dev.LightEnable(1, true);
    dev.Clear(0, null, CLEAR.ZBUFFER, 0, 1, 0);
    dev.SetTransform(TS.WORLD, translate(0, 0, 5));
    dev.SetViewport({X: 96, Y: 0, Width: 64, Height: 64, MinZ: 0, MaxZ: 1});
    dev.DrawIndexedPrimitive(PT.TRIANGLELIST, 0, 24, 0, 12);
    const pl = dev.readPixel(128, 32);
    check("Point light attenuation 1/(a0+a1 d), viewport offset", near(pl, [93, 47, 0], 3), fmtPx(pl) + " expect (93,47,0): per-vertex (Gouraud) like D3D8, corners d=4.24, N.L=0.943");
    dev.SetViewport({X: 0, Y: 0, Width: W, Height: H, MinZ: 0, MaxZ: 1}); dev.LightEnable(1, false);
    dev.SetTexture(0, null); tex.Release();
  }

  // 5. Alpha test (GREATER 0x80) on a cut-out texture; 6. alpha blend 50 %
  {
    basic2D(dev);
    const t = argbTexture(dev, 4, 4, x => x < 2 ? 0x0000ff00 : 0xff00ff00);
    dev.SetTexture(0, t);
    dev.SetTextureStageState(0, TSS.COLORARG1, TA.TEXTURE); dev.SetTextureStageState(0, TSS.ALPHAARG1, TA.TEXTURE);
    dev.SetTextureStageState(0, TSS.MINFILTER, 1); dev.SetTextureStageState(0, TSS.MAGFILTER, 1);
    dev.SetRenderState(RS.ALPHATESTENABLE, 1); dev.SetRenderState(RS.ALPHAFUNC, 5); dev.SetRenderState(RS.ALPHAREF, 0x80);
    dev.DrawPrimitiveUP(PT.TRIANGLESTRIP, 2, rhwQuad(40, 200, 72, 232, 0xffffffff), 28);
    const l = dev.readPixel(44, 210), r = dev.readPixel(68, 210);
    check("Alpha test GREATER 0x80 discards the transparent half", near(l, [0x33, 0x66, 0x99], 0) && near(r, [0, 255, 0], 0), `left ${fmtPx(l)} right ${fmtPx(r)}`);
    dev.SetRenderState(RS.ALPHATESTENABLE, 0); dev.SetTexture(0, null); t.Release();
    basic2D(dev);
    dev.DrawPrimitiveUP(PT.TRIANGLESTRIP, 2, rhwQuad(80, 200, 100, 220, 0xff0000ff), 28);
    dev.SetRenderState(RS.ALPHABLENDENABLE, 1); dev.SetRenderState(RS.SRCBLEND, 5); dev.SetRenderState(RS.DESTBLEND, 6);
    dev.DrawPrimitiveUP(PT.TRIANGLESTRIP, 2, rhwQuad(80, 200, 100, 220, 0x80ff0000), 28);
    const b = dev.readPixel(90, 210);
    check("Alpha blend SRCALPHA/INVSRCALPHA, 128/255", near(b, [128, 0, 127], 2), fmtPx(b));
    dev.SetRenderState(RS.ALPHABLENDENABLE, 0);
  }

  // 7. Dynamic VB/IB: Lock DISCARD then NOOVERWRITE, DrawIndexedPrimitive with BaseVertexIndex
  {
    basic2D(dev);
    const L = decodeFVF(FVF.XYZRHW | FVF.DIFFUSE), vb = dev.CreateVertexBuffer(8 * L.stride, 0x208, 0, 0), ib = dev.CreateIndexBuffer(12, 0x208, FMT.INDEX16, 0);
    const quad = (x0, y0, x1, y1, c) => { const b = new ArrayBuffer(4 * 20), f = new Float32Array(b), u = new Uint32Array(b);
      [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].forEach(([x, y], i) => { f.set([x - 0.5, y - 0.5, 0.5, 1], i * 5); u[i * 5 + 4] = c; }); return new Uint8Array(b); };
    ib.Lock(0, 12, LOCK.DISCARD).bytes.set(new Uint8Array(new Uint16Array([0, 1, 2, 2, 1, 3]).buffer)); ib.Unlock();
    vb.Lock(0, 4 * L.stride, LOCK.DISCARD).bytes.set(quad(120, 200, 130, 210, 0xffffff00)); vb.Unlock();
    dev.SetVertexShader(L.fvf); dev.SetStreamSource(0, vb, L.stride); dev.SetIndices(ib, 0);
    dev.DrawIndexedPrimitive(PT.TRIANGLELIST, 0, 4, 0, 2);
    vb.Lock(4 * L.stride, 4 * L.stride, LOCK.NOOVERWRITE).bytes.set(quad(135, 200, 145, 210, 0xff00ffff)); vb.Unlock();
    dev.SetIndices(ib, 4);
    dev.DrawIndexedPrimitive(PT.TRIANGLELIST, 0, 4, 0, 2);
    const a = dev.readPixel(125, 205), c = dev.readPixel(140, 205);
    check("VB Lock DISCARD/NOOVERWRITE + SetIndices BaseVertexIndex", near(a, [255, 255, 0], 0) && near(c, [0, 255, 255], 0), `${fmtPx(a)} ${fmtPx(c)}`);
    // DrawPrimitive (non-indexed) from the same VB, LINELIST/POINTLIST/TRIANGLEFAN smoke
    dev.SetStreamSource(0, vb, L.stride);
    dev.DrawPrimitive(PT.TRIANGLESTRIP, 4, 2);
    check("DrawPrimitive TRIANGLESTRIP from a VB", near(dev.readPixel(140, 205), [0, 255, 255], 0));
    // wireframe (FILLMODE 2): interior pixel untouched, edge pixel drawn
    dev.SetRenderState(RS.FILLMODE, 2);
    vb.Lock(0, 4 * L.stride, LOCK.DISCARD).bytes.set(quad(150, 200, 170, 220, 0xffffffff)); vb.Unlock();
    dev.SetIndices(ib, 0); dev.DrawIndexedPrimitive(PT.TRIANGLELIST, 0, 4, 0, 2);
    dev.SetRenderState(RS.FILLMODE, 3);
    const edge = dev.readPixel(155, 200), mid = dev.readPixel(165, 203);
    check("FILLMODE WIREFRAME via line conversion", near(edge, [255, 255, 255], 0) && near(mid, [0x33, 0x66, 0x99], 0), `edge ${fmtPx(edge)} mid ${fmtPx(mid)}`);
    vb.Release(); ib.Release();
  }

  // 8. State blocks (the game records 20 of them in FUN_005c9fc0): recording must not apply, Apply must
  {
    dev.SetRenderState(RS.ZBIAS, 0);
    dev.BeginStateBlock();
    dev.SetRenderState(RS.ZBIAS, 5); dev.SetTextureStageState(2, TSS.COLOROP, TOP.MODULATE2X);
    const h = dev.EndStateBlock();
    const before = dev.rs[RS.ZBIAS] === 0 && dev.tss[2][TSS.COLOROP] === TOP.DISABLE;
    dev.ApplyStateBlock(h);
    const after = dev.rs[RS.ZBIAS] === 5 && dev.tss[2][TSS.COLOROP] === TOP.MODULATE2X;
    check("Begin/End/ApplyStateBlock semantics", before && after, `before ${before} after ${after}`);
    dev.SetRenderState(RS.ZBIAS, 0); dev.SetTextureStageState(2, TSS.COLOROP, TOP.DISABLE); dev.DeleteStateBlock(h);
  }

  // 9. DrawIndexedPrimitiveUP with FVF 0x342 / stride 0x28 (fog_plane__RenderCustom path) + texture transform COUNT2
  {
    basic2D(dev);
    const t = argbTexture(dev, 2, 1, x => x ? 0xffffffff : 0xff000000);
    dev.SetTexture(0, t); dev.SetTextureStageState(0, TSS.COLORARG1, TA.TEXTURE); dev.SetTextureStageState(0, TSS.ALPHAARG1, TA.TEXTURE);
    dev.SetTextureStageState(0, TSS.MINFILTER, 1); dev.SetTextureStageState(0, TSS.MAGFILTER, 1); dev.SetTextureStageState(0, TSS.ADDRESSU, 3);
    dev.SetTransform(TS.VIEW, ident()); dev.SetTransform(TS.PROJECTION, perspLH(Math.PI / 2, 1, 0.5, 100)); dev.SetTransform(TS.WORLD, ident());
    const L = decodeFVF(0x342), b = new ArrayBuffer(4 * L.stride), f = new Float32Array(b), u = new Uint32Array(b);
    [[-1, 1, 0, 0], [1, 1, 1, 0], [-1, -1, 0, 1], [1, -1, 1, 1]].forEach(([x, y, s, tt], i) => {
      f.set([x * 0.5 - 2, y * 0.5 + 2, 4], i * 10); u[i * 10 + 3] = 0xffffffff; f.set([s, tt, 0, 0, 0, 0], i * 10 + 4); });
    dev.SetVertexShader(0x342);
    // u' = 0.5 u + 0.5 -> only the white texel is sampled
    dev.SetTransform(TS.TEXTURE0, new Float32Array([0.5, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1]));
    dev.SetTextureStageState(0, TSS.TEXTURETRANSFORMFLAGS, 2);
    dev.DrawIndexedPrimitiveUP(PT.TRIANGLELIST, 0, 4, 2, new Uint8Array(new Uint16Array([0, 1, 2, 2, 1, 3]).buffer), FMT.INDEX16, new Uint8Array(b), L.stride);
    const q = dev.readPixel(56, 56);
    check("DrawIndexedPrimitiveUP FVF 0x342 + TEXTURETRANSFORMFLAGS COUNT2", near(q, [255, 255, 255], 0), `${fmtPx(q)}`);
    // reflection-vector texgen compiles and draws (env-map path of FUN_00559300, TCI | 0x30000)
    dev.SetTextureStageState(0, TSS.TEXCOORDINDEX, TCI.CAMERASPACEREFLECTIONVECTOR);
    let ok = true; try { dev.DrawIndexedPrimitiveUP(PT.TRIANGLELIST, 0, 4, 2, new Uint8Array(new Uint16Array([0, 1, 2, 2, 1, 3]).buffer), FMT.INDEX16, new Uint8Array(b), L.stride); } catch (e){ ok = false; log(e.message); }
    check("CAMERASPACEREFLECTIONVECTOR texgen program builds", ok);
    dev.SetTextureStageState(0, TSS.TEXCOORDINDEX, 0); dev.SetTextureStageState(0, TSS.TEXTURETRANSFORMFLAGS, 0);
    dev.SetTexture(0, null); t.Release();
  }

  // 10. The game's stage strings, through the game's own parser, through the shader generator, vs a CPU reference
  {
    basic2D(dev);
    const D = [0.8, 0.4, 0.2, 0.6], S = [0.3, 0.7, 0.5, 0.25], K = [0.5, 0.25, 1.0, 0.75], X = [0.9, 0.6, 0.1, 0.4];
    const tx = argbTexture(dev, 1, 1, () => (Math.round(X[3] * 255) << 24 | Math.round(X[0] * 255) << 16 | Math.round(X[1] * 255) << 8 | Math.round(X[2] * 255)) >>> 0);
    const q8 = v => v.map(x => Math.round(x * 255) / 255), Dq = q8(D), Sq = q8(S), Kq = q8(K), Xq = q8(X);
    const toC = v => (Math.round(v[3] * 255) << 24 | Math.round(v[0] * 255) << 16 | Math.round(v[1] * 255) << 8 | Math.round(v[2] * 255)) >>> 0;
    dev.SetRenderState(RS.TEXTUREFACTOR, toC(K)); dev.SetRenderState(RS.SPECULARENABLE, 0);
    const cases = [];
    for (const c of GAME_STRINGS.colour) cases.push([c, ""]);
    for (const a of GAME_STRINGS.alpha) if (a) cases.push(["c", a]);
    let pass = 0, fail = [], cell = 0, programs0 = dev.stats.programs;
    for (const mode of ["current", "temp"]) for (const [cs, as] of cases){
      const calls = setupStage(1, cs, as);
      if (!calls){ fail.push(`parse ${cs}/${as}`); continue; }
      // stage 0 puts S in CURRENT ("current" mode) or in TEMP ("temp" mode, CURRENT stays D); stage 1 = the game string
      const st0 = Uint32Array.from(dev.tss[0]);
      const T0 = (k, v) => dev.SetTextureStageState(0, k, v);
      T0(TSS.COLOROP, TOP.SELECTARG1); T0(TSS.COLORARG1, TA.SPECULAR); T0(TSS.ALPHAOP, TOP.SELECTARG1); T0(TSS.ALPHAARG1, TA.SPECULAR);
      T0(TSS.RESULTARG, mode === "temp" ? TA.TEMP : TA.CURRENT);
      const t1 = dev.tss[1]; t1.fill(0);
      t1[TSS.COLOROP] = TOP.DISABLE; t1[TSS.ALPHAOP] = TOP.DISABLE; t1[TSS.COLORARG1] = t1[TSS.ALPHAARG1] = TA.TEXTURE; t1[TSS.COLORARG2] = t1[TSS.ALPHAARG2] = TA.CURRENT;
      t1[TSS.COLORARG0] = t1[TSS.ALPHAARG0] = TA.CURRENT; t1[TSS.RESULTARG] = TA.CURRENT; t1[TSS.TEXCOORDINDEX] = 0;
      t1[TSS.ADDRESSU] = t1[TSS.ADDRESSV] = 1; t1[TSS.MAGFILTER] = t1[TSS.MINFILTER] = 1;
      for (const [s, k, v] of calls) dev.SetTextureStageState(s, k, v);
      dev.SetTexture(1, tx); dev.SetTextureStageState(2, TSS.COLOROP, TOP.DISABLE);
      dev.SetVertexShader(FVF.XYZRHW | FVF.DIFFUSE | FVF.SPECULAR | 0x100);
      const x = 4 + (cell % 31) * 8, y = 140 + Math.floor(cell / 31) * 8; cell++;
      const b = new ArrayBuffer(4 * 32), f = new Float32Array(b), u = new Uint32Array(b);
      [[x, y], [x + 6, y], [x, y + 6], [x + 6, y + 6]].forEach(([px, py], i) => { f.set([px - 0.5, py - 0.5, 0.5, 1], i * 8); u[i * 8 + 4] = toC(D); u[i * 8 + 5] = toC(S); f.set([0.5, 0.5], i * 8 + 6); });
      dev.DrawPrimitiveUP(PT.TRIANGLESTRIP, 2, new Uint8Array(b), 32);
      const got = dev.readPixel(x + 3, y + 3).map(v => v / 255);
      const exp = refCombine([dev.tss[0], dev.tss[1]], {D: Dq, S: Sq, K: Kq, X: [null, Xq]});
      // the back buffer is X8R8G8B8 (alpha not stored), so compare colour; alpha is checked through a colour copy below
      if (near(got.slice(0, 3).map(v => v * 255), exp.slice(0, 3).map(v => v * 255), 3)) pass++; else fail.push(`${mode} "${cs}"/"${as}" got ${fmtPx(got.map(v => Math.round(v * 255)))} exp ${fmtPx(exp.map(v => Math.round(v * 255)))}`);
      dev.tss[0].set(st0);
    }
    // alpha channel check: route stage-1 alpha into colour with a stage 2 "@c" (SELECTARG1 CURRENT|ALPHAREPLICATE)
    let apass = 0, afail = [];
    for (const as of GAME_STRINGS.alpha.filter(a => a)){
      const calls = setupStage(1, "c", as); for (const [s, k, v] of calls) dev.SetTextureStageState(s, k, v);
      const T0 = (k, v) => dev.SetTextureStageState(0, k, v);
      T0(TSS.COLOROP, TOP.SELECTARG1); T0(TSS.COLORARG1, TA.SPECULAR); T0(TSS.ALPHAOP, TOP.SELECTARG1); T0(TSS.ALPHAARG1, TA.SPECULAR); T0(TSS.RESULTARG, TA.CURRENT);
      for (const [s, k, v] of setupStage(2, "@c", "c")) dev.SetTextureStageState(s, k, v);
      dev.SetTexture(1, tx);
      const x = 4 + (cell % 31) * 8, y = 140 + Math.floor(cell / 31) * 8; cell++;
      const b = new ArrayBuffer(4 * 32), f = new Float32Array(b), u = new Uint32Array(b);
      [[x, y], [x + 6, y], [x, y + 6], [x + 6, y + 6]].forEach(([px, py], i) => { f.set([px - 0.5, py - 0.5, 0.5, 1], i * 8); u[i * 8 + 4] = toC(D); u[i * 8 + 5] = toC(S); f.set([0.5, 0.5], i * 8 + 6); });
      dev.DrawPrimitiveUP(PT.TRIANGLESTRIP, 2, new Uint8Array(b), 32);
      const got = dev.readPixel(x + 3, y + 3)[0], exp = refCombine([dev.tss[0], dev.tss[1]], {D: Dq, S: Sq, K: Kq, X: [null, Xq]})[3] * 255;
      if (Math.abs(got - exp) <= 3) apass++; else afail.push(`alpha "${as}" got ${got} exp ${Math.round(exp)}`);
      dev.SetTextureStageState(2, TSS.COLOROP, TOP.DISABLE);
    }
    dev.SetTextureStageState(1, TSS.COLOROP, TOP.DISABLE); dev.SetTextureStageState(1, TSS.ALPHAOP, TOP.DISABLE); dev.SetTexture(1, null);
    check(`Game stage strings: colour+alpha via combiner (${pass}/${pass + fail.length})`, fail.length === 0, fail.slice(0, 6).join("; "));
    check(`Game stage strings: alpha channel (${apass}/${apass + afail.length})`, afail.length === 0, afail.slice(0, 6).join("; "));
    check("Shader programs generated for the sweep", true, `${dev.stats.programs - programs0} programs`);
    // the water stage-1 op (MODULATEALPHA_ADDCOLOR, water__RenderCustom 004eab90)
    dev.SetTextureStageState(0, TSS.COLOROP, TOP.SELECTARG1); dev.SetTextureStageState(0, TSS.COLORARG1, TA.DIFFUSE);
    dev.SetTextureStageState(0, TSS.ALPHAOP, TOP.SELECTARG1); dev.SetTextureStageState(0, TSS.ALPHAARG1, TA.DIFFUSE);
    dev.SetTextureStageState(1, TSS.COLOROP, TOP.MODULATEALPHA_ADDCOLOR); dev.SetTextureStageState(1, TSS.COLORARG1, TA.CURRENT); dev.SetTextureStageState(1, TSS.COLORARG2, TA.TEXTURE);
    dev.SetTextureStageState(1, TSS.ALPHAOP, TOP.SELECTARG1); dev.SetTextureStageState(1, TSS.ALPHAARG1, TA.CURRENT); dev.SetTexture(1, tx);
    dev.SetVertexShader(FVF.XYZRHW | FVF.DIFFUSE | 0x100);
    const D2 = [0.2, 0.1, 0.3, 0.5];
    dev.DrawPrimitiveUP(PT.TRIANGLESTRIP, 2, rhwQuad(240, 240, 250, 250, toC(D2), [0.5, 0.5, 0.5, 0.5]), 28);
    const wexp = [0, 1, 2].map(k => Math.min(1, q8(D2)[k] + q8(D2)[3] * Xq[k]) * 255), wgot = dev.readPixel(245, 245);
    check("MODULATEALPHA_ADDCOLOR (water stage 1)", near(wgot, wexp, 3), `${fmtPx(wgot)} exp ${fmtPx(wexp.map(Math.round))}`);
    dev.SetTextureStageState(1, TSS.COLOROP, TOP.DISABLE); dev.SetTextureStageState(1, TSS.ALPHAOP, TOP.DISABLE); dev.SetTexture(1, null);
    tx.Release();
  }

  // 11. D3DXFont emulation (UI text goes through ID3DXFont::DrawTextW in the game)
  {
    const font = D3DXCreateFont(dev, {height: -14, weight: 700, face: "Arial"});
    const r = {left: 160, top: 4, right: 252, bottom: 40};
    const calc = {...r}, h = font.DrawText("HOBBIT", calc, 0x400 | 0x20, 0xffffffff);
    font.DrawText("HOBBIT", r, 0x20, 0xffffffff);
    let lit = 0; for (let y = r.top; y < r.top + h; y++) for (let x = r.left; x < calc.right; x++) if (dev.readPixel(x, y)[0] > 200) lit++;
    check("D3DXFont DrawText (CALCRECT + draw)", h > 10 && calc.right > r.left + 20 && lit > 20, `h=${h} w=${calc.right - r.left} lit=${lit}`);
  }

  // 12. D3DXLoadSurfaceFromMemory: XBMP-style sources into the formats FUN_00674c70 requests
  {
    const t = dev.CreateTexture(4, 4, 1, 0, FMT.DXT1, 1), s = t.GetSurfaceLevel(0);
    const src = new Uint8Array(4 * 4 * 2), dv = new DataView(src.buffer);
    for (let i = 0; i < 16; i++) dv.setUint16(i * 2, 0x07e0, true);           // R5G6B5 pure green
    D3DXLoadSurfaceFromMemory(s, null, src, FMT.R5G6B5, 8, {left: 0, top: 0, right: 4, bottom: 4}, -1, 0);
    basic2D(dev); dev.SetTexture(0, t); dev.SetTextureStageState(0, TSS.COLORARG1, TA.TEXTURE);
    dev.DrawPrimitiveUP(PT.TRIANGLESTRIP, 2, rhwQuad(200, 230, 210, 240, 0xffffffff), 28);
    const g = dev.readPixel(205, 235);
    check("D3DXLoadSurfaceFromMemory R5G6B5 -> (DXT1 request, kept uncompressed)", near(g, [0, 255, 0], 0), `${fmtPx(g)} fmt now ${t.fmt}`);
    dev.SetTexture(0, null); s.Release(); t.Release();
  }

  // 13. Gamma ramp + Present (visual only) and CopyRects back buffer -> texture
  {
    const t = dev.CreateTexture(W, H, 1, 0, FMT.X8R8G8B8, 1), s = t.GetSurfaceLevel(0), bb = dev.GetRenderTarget();
    dev.CopyRects(bb, null, s, null);
    const lk = t.LockRect(0, {left: 10, top: 10, right: 11, bottom: 11}, LOCK.READONLY);
    const px = [lk.bytes[2], lk.bytes[1], lk.bytes[0]];
    check("CopyRects back buffer -> X8R8G8B8 texture (row order)", near(px, [255, 0, 0], 0), fmtPx(px));
    s.Release(); bb.Release(); t.Release();
  }
  dev.EndScene(); dev.Present();
  check("Programs compiled / draws", true, `${dev.stats.programs} programs, ${dev.stats.draws} draws`);

  // 14. COM bridge: hand-assembled wasm module calls through vtables in wasm memory into JS
  await bridgeTest(canvas2, log);
  return results;
}

async function bridgeTest(canvas, log){
  const memory = new WebAssembly.Memory({initial: 512});            // 32 MB
  const heap = new Heap(memory, 0x01000000, 0x00f00000);
  const gl = canvas.getContext("webgl2", {antialias: false, preserveDrawingBuffer: true});
  const B = new ComBridge(memory, heap, gl), com_call = await linkBridge(B);
  const dv = () => new DataView(memory.buffer), STACK = 0x00ff0000;
  const M = (iface, name) => VTBL[iface].indexOf(name) * 4;
  // simulate the recompiled caller: push args right-to-left, push this, call (return address), dispatch
  const call = (obj, iface, name, ...args) => {
    const esp = STACK - 4 * (args.length + 2), d = dv();
    d.setUint32(esp, 0xdeadbeef, true); d.setUint32(esp + 4, obj, true); args.forEach((a, i) => d.setUint32(esp + 8 + 4 * i, a >>> 0, true));
    const eax = com_call(obj, M(iface, name), esp);
    if (B.popBytes !== 4 * (args.length + 1)) throw new Error(`${name}: pop ${B.popBytes}`);
    return eax;
  };
  const scratch = heap.alloc(4096).ptr, out = scratch, pp = scratch + 64;
  const p3d = B.Direct3DCreate8(120);
  // D3DPRESENT_PARAMETERS: 128 x 128, X8R8G8B8, windowed
  [128, 128, FMT.X8R8G8B8, 1, 0, 1, 0, 1, 1, FMT.D24S8, 0].forEach((v, i) => dv().setUint32(pp + 4 * i, v, true));
  let hr = call(p3d, "IDirect3D8", "CreateDevice", 0, 1, 0, 0x40, pp, out);
  const pdev = dv().getUint32(out, true);
  check("Bridge: IDirect3D8::CreateDevice via wasm call_indirect", hr === 0 && B.objs.get(pdev) instanceof Device, `dev @0x${pdev.toString(16)}`);
  call(pdev, "IDirect3DDevice8", "SetRenderState", RS.LIGHTING, 0);
  call(pdev, "IDirect3DDevice8", "SetRenderState", RS.ZENABLE, 0);
  call(pdev, "IDirect3DDevice8", "SetRenderState", RS.CULLMODE, 1);
  call(pdev, "IDirect3DDevice8", "SetTextureStageState", 0, TSS.COLOROP, TOP.SELECTARG1);
  call(pdev, "IDirect3DDevice8", "SetTextureStageState", 0, TSS.COLORARG1, TA.DIFFUSE);
  // D3DVIEWPORT8
  [0, 0, 128, 128].forEach((v, i) => dv().setUint32(scratch + 128 + 4 * i, v, true)); dv().setFloat32(scratch + 144, 0, true); dv().setFloat32(scratch + 148, 1, true);
  call(pdev, "IDirect3DDevice8", "SetViewport", scratch + 128);
  call(pdev, "IDirect3DDevice8", "BeginScene");
  call(pdev, "IDirect3DDevice8", "Clear", 0, 0, 3, 0xff202020, asBits(1), 0);
  // vertex buffer created and filled "by the game": Lock returns a pointer into wasm memory
  call(pdev, "IDirect3DDevice8", "CreateVertexBuffer", 4 * 20, 0x208, 0, 0, out);
  const pvb = dv().getUint32(out, true);
  call(pvb, "IDirect3DVertexBuffer8", "Lock", 0, 0, out, LOCK.DISCARD);
  const bits = dv().getUint32(out, true);
  [[30, 30], [90, 30], [30, 90], [90, 90]].forEach(([x, y], i) => { const d = dv(), o = bits + i * 20;
    d.setFloat32(o, x - 0.5, true); d.setFloat32(o + 4, y - 0.5, true); d.setFloat32(o + 8, 0.5, true); d.setFloat32(o + 12, 1, true); d.setUint32(o + 16, 0xff00ff80, true); });
  call(pvb, "IDirect3DVertexBuffer8", "Unlock");
  call(pdev, "IDirect3DDevice8", "SetVertexShader", FVF.XYZRHW | FVF.DIFFUSE);
  call(pdev, "IDirect3DDevice8", "SetStreamSource", 0, pvb, 20);
  hr = call(pdev, "IDirect3DDevice8", "DrawPrimitive", PT.TRIANGLESTRIP, 0, 2);
  const dev = B.objs.get(pdev), px = dev.readPixel(60, 60), bg = dev.readPixel(10, 10);
  check("Bridge: VB Lock pointer in wasm memory -> DrawPrimitive", hr === 0 && near(px, [0, 255, 128], 0) && near(bg, [32, 32, 32], 0), `${fmtPx(px)} bg ${fmtPx(bg)} @0x${bits.toString(16)}`);
  // texture through the bridge: CreateTexture + LockRect + SetTexture
  call(pdev, "IDirect3DDevice8", "CreateTexture", 2, 2, 1, 0, FMT.A8R8G8B8, 1, out);
  const ptex = dv().getUint32(out, true);
  call(ptex, "IDirect3DTexture8", "LockRect", 0, scratch + 256, 0, 0);
  const pitch = dv().getUint32(scratch + 256, true), tb = dv().getUint32(scratch + 260, true);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) dv().setUint32(tb + y * pitch + x * 4, 0xffff8000, true);
  call(ptex, "IDirect3DTexture8", "UnlockRect", 0);
  call(pdev, "IDirect3DDevice8", "SetTexture", 0, ptex);
  call(pdev, "IDirect3DDevice8", "SetTextureStageState", 0, TSS.COLORARG1, TA.TEXTURE);
  call(pdev, "IDirect3DDevice8", "SetVertexShader", FVF.XYZRHW | FVF.DIFFUSE | 0x100);
  const q = rhwQuad(100, 100, 120, 120, 0xffffffff), qp = scratch + 512; new Uint8Array(memory.buffer, qp, q.length).set(q);
  call(pdev, "IDirect3DDevice8", "DrawPrimitiveUP", PT.TRIANGLESTRIP, 2, qp, 28);
  const tp = dev.readPixel(110, 110);
  check("Bridge: CreateTexture/LockRect/SetTexture/DrawPrimitiveUP", near(tp, [255, 128, 0], 0), fmtPx(tp));
  const refs = call(ptex, "IDirect3DTexture8", "Release");
  check("Bridge: refcount (SetTexture holds a reference)", refs === 1, `Release -> ${refs}`);
  call(pdev, "IDirect3DDevice8", "EndScene"); call(pdev, "IDirect3DDevice8", "Present", 0, 0, 0, 0);
  if (B.log.length) log("bridge log: " + B.log.join("; "));
}
