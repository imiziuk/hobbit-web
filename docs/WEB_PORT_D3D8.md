# Web port: Direct3D 8 -> WebGL2

Part of the plan to run Meridian.exe in Chrome by static x86 -> WebAssembly recompilation. This document covers the
graphics layer only: what the exe asks of Direct3D 8, how a WebGL2 implementation of exactly that subset works, and the
prototype in `web/d3d8/` (2026-10-13/14). Marks: **[V]** verified (disassembly, decompiled C, or a passing prototype
check), **[I]** inferred.

**Summary.** The game uses a small, fixed-function slice of D3D8 [V]: 37 of 97 IDirect3DDevice8 methods (459 call
sites in 86 functions), 11 IDirect3D8 methods, texture/surface/VB/IB lock paths, no vertex or pixel shaders, no cube
or volume textures, no render-to-texture. Rendering funnels through very few functions: all `DrawPrimitive` calls are in
one immediate-mode batcher (0066c920), all mesh `DrawIndexedPrimitive` calls in one (00664810), `SetTexture` in three
tiny wrappers over a 5,000-slot texture table. The texture-stage combiner setup is **data-driven by a tiny text
language** compiled at runtime by the game itself (`"x*2d"`, `"t<@x>c"`, `"&f=c*~@f+f"` ...); all of its strings live in
.rdata, so the set of combiner states is enumerable, and the prototype runs every one of them. D3DX8 is statically linked
(font, texture creation, surface loading); those six entry points should be HLE'd in JS rather than recompiled.
Prototype: `web/d3d8/` (d3d8.js 845 lines, com.js, d3dx.js, stagelang.js, test.html), **26/26 self-checks pass** in
Chrome with native S3TC and with the CPU DXT fallback, including a wasm module calling through COM vtables in wasm
memory into JS.

---------------------------------------------------------------------------------------------------------
## 1. Inventory of the D3D8 surface Meridian.exe uses

Method: `web/d3d8/tools/scan_d3d8_calls.py` (capstone) sweeps `.text` linearly with per-function register tracking:
loads of `g_pD3DDevice` 0x007F1000 / `g_pD3D` 0x007F0310, `mov reg,[reg]` (vtable), `call [reg+off]`, and the pushes
since the previous call (= stdcall arguments, right to left). `summarize_d3d8_calls.py` turns that into the tables
below. The decompiled C (`Hobbit-RE/db/decomp_units8/`) and targeted disassembly were used for everything the sweep
cannot see (calls through object fields, D3DX internals, argument values in registers). The sweep found 459 device + 15 IDirect3D8
calls against 421 code xrefs to 0x007F1000 (several calls per load) [V]. Branch merges can attach a wrong constant to a
call in a linear sweep (one case found: FOGEND at 00587ece shows as FOGENABLE 0); the per-state value columns are
therefore "constants seen", not a proof that no other values exist [I].

### 1.1 IDirect3DDevice8 (g_pD3DDevice 0x007F1000) [V]
| Method | vtbl | sites | funcs | example sites |
|---|---|---|---|---|
| Release | +0x8 | 1 | 1 | 0065c0d0 |
| TestCooperativeLevel | +0xc | 1 | 1 | 0065f190 |
| GetAvailableTextureMem | +0x10 | 2 | 2 | 00674a00, 00674e80 |
| ResourceManagerDiscardBytes | +0x14 | 5 | 5 | 00660da0, 00662390, 00662590, 00662930 |
| ShowCursor | +0x30 | 3 | 2 | 0065d4e0, 00660340 |
| Reset | +0x38 | 2 | 2 | 0065f190, 00660f70 |
| Present | +0x3c | 2 | 2 | 0065f480, 0065f730 |
| SetGammaRamp | +0x48 | 3 | 3 | 006606a0, 006608d0, 00660a10 |
| GetGammaRamp | +0x4c | 1 | 1 | 0065e490 |
| CreateTexture | +0x50 | 2 | 2 | 0065fd00, 006606a0 |
| CreateVertexBuffer | +0x5c | 3 | 3 | 00662390, 00663de0, 0066c130 |
| CreateIndexBuffer | +0x60 | 3 | 3 | 00662590, 00663de0, 0066c130 |
| CopyRects | +0x70 | 3 | 3 | 0065fd00, 0065fed0, 006606a0 |
| GetRenderTarget | +0x80 | 3 | 3 | 0065fd00, 0065fed0, 006606a0 |
| BeginScene | +0x88 | 2 | 2 | 0065f190, 0065fed0 |
| EndScene | +0x8c | 3 | 3 | 0065f480, 0065f730, 0065fed0 |
| Clear | +0x90 | 3 | 3 | 004f9470, 0065f190, 00660f70 |
| SetTransform | +0x94 | 25 | 10 | 00483d30, 00559300, 00559490, 005855e0 |
| SetViewport | +0xa0 | 5 | 5 | 0065caf0, 0065e490, 0065f190, 00660270 |
| SetMaterial | +0xa8 | 1 | 1 | 0065caf0 |
| SetLight | +0xb0 | 3 | 3 | 005837f0, 00583930, 0065c9a0 |
| LightEnable | +0xb8 | 6 | 4 | 00581f30, 005837f0, 00583930, 0065c9a0 |
| SetRenderState | +0xc8 | 163 | 37 | 0044e4a0, 00483d30, 00488150, 004d99c0 |
| GetRenderState | +0xcc | 1 | 1 | 005c4320 |
| BeginStateBlock | +0xd0 | 20 | 1 | 005c9fc0 |
| EndStateBlock | +0xd4 | 20 | 1 | 005c9fc0 |
| ApplyStateBlock | +0xd8 | 20 | 1 | 005c9fc0 |
| DeleteStateBlock | +0xe0 | 1 | 1 | 00559540 |
| SetTexture | +0xf4 | 3 | 3 | 00674940, 00674970, 00674db0 |
| SetTextureStageState | +0xfc | 131 | 17 | 00483d30, 004d99c0, 004eab90, 0054f240 |
| ValidateDevice | +0x100 | 1 | 1 | 00660a80 |
| DrawPrimitive | +0x118 | 5 | 1 | 0066c920 |
| DrawIndexedPrimitive | +0x11c | 2 | 2 | 00664810, 0066c920 |
| DrawIndexedPrimitiveUP | +0x124 | 1 | 1 | 00483d30 |
| SetVertexShader | +0x130 | 4 | 3 | 00483d30, 00664810, 0066c3a0 |
| SetStreamSource | +0x14c | 2 | 2 | 006624e0, 00664810 |
| SetIndices | +0x154 | 3 | 2 | 00662590, 00664810 |

Not called anywhere [V]: GetBackBuffer, SetRenderTarget, CreateRenderTarget/DepthStencilSurface/ImageSurface,
UpdateTexture, cube/volume textures, CreateVertexShader/pixel shaders/constants (FVF codes only), ProcessVertices,
palettes, clip planes, patches, GetTexture/GetLight/GetMaterial, CaptureStateBlock/CreateStateBlock, DrawPrimitiveUP
(the D3DX font uses it internally, see 1.5).

What the sites do [V]:
- **Frame**: BeginScene/Clear in 0065f190 (Clear(0, NULL, TARGET|ZBUFFER|STENCIL = 7, color [007edaf0], 1.0, 0)) and
  004f9470 (Clear ZBUFFER only, 1.0); EndScene + Present(NULL, NULL, NULL, NULL) in 0065f480, windowed Present(0, 0, hWnd,
  &rect) in 0065f730. TestCooperativeLevel + Reset(&D3DPP 007f0448) = lost-device path (0065f190, 00660f70).
- **Transforms**: SetTransform WORLD (0x100), VIEW (2), PROJECTION (3), TEXTUREn via table 0x0073d9f0[stage]
  (00559490/00559300). 25 sites, 10 functions (render_mgr__SetupRender 005855e0, fog_plane 00483d30, 0063aae0, 005b7f00,
  005c3a90, 005c3ef0, 005c16a0, 0066cb10, ...).
- **Lights**: SetLight in 005837f0 (POINT, Type = 1) and 00583930 (DIRECTIONAL, Type = 3), both zero a 26-dword
  D3DLIGHT8 first; LightEnable in lighting_mgr__ActivateLights 00581f30 (disables), 0065c9a0 (light 0 default).
  SetMaterial once (0065caf0, default material) - material colours otherwise come from vertex colours
  (DIFFUSEMATERIALSOURCE = SPECULARMATERIALSOURCE = COLOR2, EMISSIVE = MATERIAL in 00582a70).
- **State blocks**: FUN_005c9fc0 + the twenty 005ca170..005cbfd0 material setups record a block lazily
  (BeginStateBlock; stage + blend setup; EndStateBlock(&token in tables 0x007bab40..0x007cbb40); ApplyStateBlock) and
  re-apply it each time; DeleteStateBlock in 00559540.
- **Buffers**: the immediate-mode batcher 0066c130 creates 3 rotating VBs of 0xCE40 bytes (usage 0x208 =
  WRITEONLY|DYNAMIC, FVF 0, pool 2) at 0x007f1544[3] and one 0xE10-byte INDEX16 quad index buffer 0x007f14e4 (filled
  once). Meshes (00663de0) create a VB of `this+0x34c` bytes and an INDEX16 IB, FVF 0 (format set per draw with
  SetVertexShader). 00662390/00662590 keep a cached copy VB/IB (usage | 8) per original in a map at 0x007f0498 when the
  device mode (0065bb00) is not 3; ResourceManagerDiscardBytes(0) precedes each creation.
- **Draws**: DrawPrimitive only in 0066c920 (batcher flush; POINTLIST/LINELIST/LINESTRIP/TRIANGLELIST/TRIANGLESTRIP by
  0x007f158c, strides 0x20/0x24/0x2c; quads 5..7 go through DrawIndexedPrimitive with the quad IB), once per viewport
  in a view list (0065fcf0/0065fd00 = split views). DrawIndexedPrimitive on meshes in 00664810 (per sub-mesh
  SetStreamSource/SetIndices/SetVertexShader(fvf from the record)/DIP(type, ...)). DrawIndexedPrimitiveUP once:
  fog_plane__RenderCustom 00483d30 (TRIANGLELIST, 4 verts, 2 prims, INDEX16, FVF 0x342, stride 0x28).
- **Screen grabs**: GetRenderTarget + D3DXCreateTexture/CreateTexture(w, h, 1, 0, X8R8G8B8 = 0x16, MANAGED) + CopyRects
  (0065fd00, 0065fed0, 006606a0); 0065fed0 then D3DXLoadSurfaceFromSurface. Gamma: GetGammaRamp at init (0065e490),
  SetGammaRamp in 006606a0/006608d0/00660a10 (fades / brightness).

### 1.2 IDirect3D8 (g_pD3D 0x007F0310) [V]
| Method | vtbl | sites | example |
|---|---|---|---|
| Release | +0x8 | 1 | 0065c0d0 |
| GetAdapterIdentifier | +0x14 | 1 | 0065e490 |
| GetAdapterModeCount | +0x18 | 2 | 0065bb60, 0065bc20 |
| EnumAdapterModes | +0x1c | 2 | 0065bb60, 0065bc20 |
| GetAdapterDisplayMode | +0x20 | 1 | 0065e490 |
| CheckDeviceType | +0x24 | 1 | 0065c730 |
| CheckDeviceFormat | +0x28 | 1 | 0065c780 |
| CheckDepthStencilMatch | +0x30 | 1 | 0065c780 |
| GetDeviceCaps | +0x34 | 1 | 0065e490 |
| GetAdapterMonitor | +0x38 | 3 | 0065cd80, 0065de70, 0065e490 |
| CreateDevice | +0x3c | 1 | 0065e490 |

Direct3DCreate8(120) through the IAT thunk 0067da02. CreateDevice(adapter [007edafc], HAL or REF, hWnd, 0x20/0x40/0x80,
&D3DPP 007f0448, &g_pD3DDevice) [V] (RUNTIME_INIT 4.1 row 6a). Caps copy at 0x007f0f10 (D3DCAPS8); fields read by game
code [V]: +0x6c MaxAnisotropy (0x007f0f7c, MAXANISOTROPY), +0x90 TextureOpCaps (0x007f0fa0: bits 0x800/0x1000/0x2000/0x8000
choose BLENDDIFFUSE/TEXTURE/FACTOR/CURRENTALPHA over LERP in the stage parser), +0xb4 MaxPrimitiveCount (0x007f0fc4,
batch size, clamped to 0x10000). The port controls these numbers, so it can steer the game onto the simplest paths.

### 1.3 SetRenderState (vtbl +0xC8): states and constant values [V]
Values in hex; "dyn" = value computed at run time (register/memory). D3D8 enum numbers.
| State | id | sites | constant values (count) | functions |
|---|---|---|---|---|
| ZENABLE | 7 | 6 | 0x0(1), 0x1(5) | 00483d30, 005c3a90, 005c9fc0, 0063aae0, 0065e0a0 +1 |
| FILLMODE | 8 | 5 | 0x2(3), 0x3(2) | 00483d30, 00554210, 005b7f00, 0066c3a0 |
| SHADEMODE | 9 | 1 | 0x2(1) | 0065e0a0 |
| ZWRITEENABLE | 14 | 14 | 0x0(8), 0x1(5), dyn(1) | 0044e4a0, 00483d30, 004d99c0, 0054f240, 00554770 +6 |
| ALPHATESTENABLE | 15 | 13 | 0x0(8), 0x1(4), dyn(1) | 00483d30, 004d99c0, 004f2b00, 00554fb0, 00584190 +2 |
| SRCBLEND | 19 | 23 | 0x1(3), 0x2(2), 0x5(15), 0x9(3) | 0044e4a0, 00483d30, 004f2b00, 004f8ec0, 0054f290 +8 |
| DESTBLEND | 20 | 22 | 0x1(3), 0x2(13), 0x4(1), 0x6(5) | 0044e4a0, 00483d30, 004f2b00, 004f8ec0, 0054f290 +8 |
| CULLMODE | 22 | 9 | 0x1(7), 0x2(2) | 0044e4a0, 00483d30, 004d99c0, 00554210, 005c9d30 +3 |
| ZFUNC | 23 | 4 | 0x4(4) | 005c22b0, 005c3a90, 0065e0a0, 0066c3a0 |
| ALPHAREF | 24 | 5 | 0x0(1), 0x7f(1), 0x80(1), dyn(2) | 004d99c0, 00554fb0, 0066c3a0 |
| ALPHAFUNC | 25 | 5 | 0x2(1), 0x4(1), 0x5(1), 0x7(2) | 004d99c0, 00554fb0 |
| DITHERENABLE | 26 | 1 | 0x1(1) | 0065e0a0 |
| ALPHABLENDENABLE | 27 | 12 | 0x0(1), 0x1(11) | 00483d30, 004f2b00, 004f8ec0, 0054f290, 00554770 +5 |
| FOGENABLE | 28 | 3 | 0x0(2), 0x1(1) | 00488150, 00587d00 |
| FOGCOLOR | 34 | 1 | dyn(1) | 00587d00 |
| FOGTABLEMODE | 35 | 1 | 0x3(1) | 00587d00 |
| FOGSTART | 36 | 1 | dyn(1) | 00587d00 |
| FOGDENSITY | 38 | 1 | dyn(1) | 00587d00 |
| ZBIAS | 47 | 6 | 0x0(4), 0x5(1), dyn(1) | 00483d30, 0054f240, 0054f370, 00554770, 00554fb0 +1 |
| STENCILENABLE | 52 | 3 | 0x0(2), dyn(1) | 00554770, 00554fb0, 0066c3a0 |
| TEXTUREFACTOR | 60 | 7 | 0x10171500(1), 0x170000(1), dyn(5) | 004eab90, 00553fa0, 00554770, 00558d10, 00558e90 +1 |
| LIGHTING | 137 | 7 | 0x0(4), 0x1(1), dyn(2) | 004eab90, 00582a70, 005c4320, 0065e0a0, 0066c3a0 |
| AMBIENT | 139 | 1 | dyn(1) | 0065caf0 |
| NORMALIZENORMALS | 143 | 1 | 0x1(1) | 005b7f00 |
| DIFFUSEMATERIALSOURCE | 145 | 1 | 0x2(1) | 00582a70 |
| SPECULARMATERIALSOURCE | 146 | 1 | 0x2(1) | 00582a70 |
| EMISSIVEMATERIALSOURCE | 148 | 1 | 0x0(1) | 00582a70 |
| SOFTWAREVERTEXPROCESSING | 153 | 2 | 0x0(2) | 0065bb10, 0065e490 |
| COLORWRITEENABLE | 168 | 3 | 0xf(2), dyn(1) | 00554fb0, 0066c3a0 |
| BLENDOP | 171 | 3 | 0x1(3) | 00554fb0, 0066c3a0 |

Plus, from the decompiled C where the sweep loses the value [V]: FOGEND (37, dyn, 00587d00), and the frame-blend
compiler 00554fb0 also sets ALPHAFUNC 2/4/5/7 and ALPHAREF 0/0x7f/0x80/0xff automatically for blend modes
that can be done as alpha test. Meaning of the main values: ZFUNC 4 = LESSEQUAL; CULLMODE 1 NONE / 2 CW (default CCW
= 3 from the device default); FILLMODE 2 WIREFRAME (dev/debug views) / 3 SOLID; SRCBLEND/DESTBLEND 1 ZERO, 2 ONE,
4 INVSRCCOLOR, 5 SRCALPHA, 6 INVSRCALPHA, 9 DESTCOLOR; FOGTABLEMODE 3 = LINEAR (pixel fog; render_mgr__EnableFog
00587d00: FOGENABLE, FOGTABLEMODE 3, FOGDENSITY [007407b4], FOGCOLOR, FOGSTART, FOGEND); BLENDOP 1 = ADD only.
Never set [V]: SPECULARENABLE, RANGEFOGENABLE, FOGVERTEXMODE, VERTEXBLEND, CLIPPLANEENABLE, POINT*, LOCALVIEWER,
SHADEMODE flat, STENCILFUNC/OP (STENCILENABLE is only ever turned off or copied).

### 1.4 SetTextureStageState (vtbl +0xFC) [V]
| State | id | sites | constant values (count) | functions |
|---|---|---|---|---|
| COLOROP | 1 | 10 | 0x1(4), 0x12(1), 0x2(1), 0x4(3), 0x7(1) | 00483d30, 004eab90, 00554f00, 005c9fc0, 0066c3a0 |
| COLORARG1 | 2 | 7 | 0x1(1), 0x2(3), 0x3(1), dyn(2) | 00483d30, 004eab90, 005c9fc0, 0066c3a0 |
| COLORARG2 | 3 | 4 | 0x0(1), 0x1(1), 0x2(1), 0x3(1) | 00483d30, 004eab90, 005c9fc0 |
| ALPHAOP | 4 | 10 | 0x1(4), 0x2(2), 0x4(4) | 00483d30, 004eab90, 00554f00, 005c9fc0, 0066c3a0 |
| ALPHAARG1 | 5 | 8 | 0x0(1), 0x2(2), 0x3(2), dyn(3) | 00483d30, 004eab90, 005c9fc0, 0066c3a0 |
| ALPHAARG2 | 6 | 4 | 0x0(4) | 00483d30, 004eab90, 005c9fc0 |
| TEXCOORDINDEX | 11 | 10 | 0x0(5), 0x1(2), dyn(3) | 00483d30, 004eab90, 00559100, 00559300, 00559490 +2 |
| ADDRESSU | 13 | 9 | 0x1(3), 0x3(5), dyn(1) | 004d99c0, 004eab90, 0054f240, 00559100, 0065e0a0 +2 |
| ADDRESSV | 14 | 9 | 0x1(3), 0x3(5), dyn(1) | 004d99c0, 004eab90, 0054f240, 00559100, 0065e0a0 +2 |
| MAGFILTER | 16 | 11 | 0x1(2), 0x2(8), 0x3(1) | 004eab90, 00559100, 0065e0a0, 0066db80, 0066dc10 +1 |
| MINFILTER | 17 | 10 | 0x1(1), 0x2(8), 0x3(1) | 004eab90, 00559100, 0065e0a0, 0066db80, 0066dc10 +1 |
| MIPFILTER | 18 | 9 | 0x0(1), 0x1(7), 0x2(1) | 004eab90, 00559100, 0065e0a0, 0066db80, 0066dc10 +1 |
| MAXANISOTROPY | 21 | 1 | dyn(1) | 00559100 |
| TEXTURETRANSFORMFLAGS | 24 | 7 | 0x0(5), 0x2(2) | 004eab90, 00559300, 00559490, 0066db80, 0066dc10 |
| RESULTARG | 28 | 3 | 0x1(3) | 00554860, 00554910, 0066c3a0 |
| (state chosen by the stage-string compiler 00554910) | var | 19 | 0x1(4), 0x10(1), 0x19(1), 0x1a(1), 0x2(2), 0xc(1), 0xd(1), 0xe(1), dyn(7) | 00554910 |

Hard-coded stage setups [V]: water__RenderCustom 004eab90 (stage 0 MODULATE(TEXTURE, TFACTOR), alpha MODULATE(TFACTOR,
DIFFUSE); stage 1 **MODULATEALPHA_ADDCOLOR (18)**(CURRENT, TEXTURE); 3 stages of sampler state), fog_plane 00483d30,
0066c3a0 (batcher defaults), 0065e0a0 (device defaults), sampler setup 00559100 (ADDRESSU/V 1 WRAP / 3 CLAMP, MAG/MIN
1 POINT / 2 LINEAR / 3 ANISOTROPIC with MAXANISOTROPY = caps, MIPFILTER 0/1/2). TEXCOORDINDEX = per-material UV channel
byte (`material + 0x9bc + 2*i`) OR'ed with **0x30000 = CAMERASPACEREFLECTIONVECTOR** (environment maps; 5 call sites of
00559300 push 0x30000), with TEXTURETRANSFORMFLAGS = COUNT2 and a scale/offset texture matrix (e.g. scale 0.45,
offset -0.5).

### 1.5 The game's texture-stage language (data-driven combiners) [V]
FUN_00554860(stage, colourStr, alphaStr) compiles two strings into SetTextureStageState calls (00554910 per channel,
token readers 00555ab0 / 00555900). Ported 1:1 in `web/d3d8/stagelang.js`.
- Arguments: `d` DIFFUSE, `c` CURRENT, `x` TEXTURE, `k` TFACTOR, `s` SPECULAR, `t` TEMP, `f` frame buffer (blend
  strings only), `0`/`1` constants; prefixes `~` COMPLEMENT, `@` ALPHAREPLICATE, `&` (blend: alpha channel).
- Operators: `*` MODULATE, `*2` MODULATE2X, `*4` MODULATE4X, `+` ADD, `+-` ADDSIGNED, `+-2` ADDSIGNED2X, `-` SUBTRACT,
  `+*` ADDSMOOTH, `%` DOTPRODUCT3; `a*b+c` / `a+b*c` -> MULTIPLYADD; `a<b>c` -> BLEND{DIFFUSE,TEXTURE,FACTOR,CURRENT}ALPHA
  when b is `@d/@x/@k/@c` and the caps bit is set, else LERP(b); `t=...` -> RESULTARG TEMP; empty string -> SELECTARG1
  CURRENT; NULL -> leave the channel alone.
- All strings passed to it are in .rdata (37 colour, 10 alpha + empty, 6 frame-blend; list in `stagelang.js` GAME_STRINGS).
  Compiled, they use only **SELECTARG1, MODULATE, MODULATE2X, ADD, MULTIPLYADD, LERP, BLENDDIFFUSEALPHA,
  BLENDTEXTUREALPHA** (+ DISABLE, + MODULATEALPHA_ADDCOLOR from the water code), args D/C/X/K/TEMP with
  COMPLEMENT/ALPHAREPLICATE, RESULTARG CURRENT/TEMP.
- Curiosity [V]: the parser maps `a*b+c` to ARG0=a, ARG1=b, ARG2=c, and D3D8 MULTIPLYADD is ARG0 + ARG1*ARG2, so
  `"x*d+c"` renders as x + d*c on real hardware. The port must reproduce D3D, not the string's intent.
- Frame blend strings (00554fb0): `f` = destination, `c` = source; produces COLORWRITEENABLE (alpha-only writes for
  `&f=`/`@f=`), SRCBLEND/DESTBLEND from factor map 00555730 (ZERO, ONE, SRC/INVSRC COLOR/ALPHA, DEST/INVDEST
  COLOR/ALPHA), BLENDOP ADD, and alpha-test shortcuts.

### 1.6 Formats, FVFs, primitives, locks [V]
- **Texture formats** (FUN_00674c70 maps XBMP format id -> D3D source format and requested device format; textures
  are created with D3DXCreateTexture(..., MANAGED) and filled with D3DXLoadSurfaceFromMemory):

  | XBMP fmt | source format | requested texture format |
  |---|---|---|
  | 3 | A8R8G8B8 | DXT3 |
  | 4 | X8R8G8B8 | DXT1 |
  | 5 | R8G8B8 | DXT1 |
  | 7 | A4R4G4B4 | DXT3 |
  | 10 | A1R5G5B5 | DXT1 |
  | 11 | X1R5G5B5 | DXT1 |
  | 12 | R5G6B5 | DXT1 |
  | 0x49 (73) | DXT1 | DXT1 |
  | 0x4b (75) | A8 | A8 (A8R8G8B8 -> DXT3 if A8 unsupported) |
  | 0x4e (78) | DXT3 | DXT3 |
  | no data (Bink / dynamic) | = source | = source |

  Mip count = XBMP levels minus the `TextureQuality` setting. Texture handle table 0x007f2430 (5,000 slots, free list:
  values <= 5000 are indices, larger values are IDirect3DTexture8 pointers, **so COM pointers must be > 5000**).
  Bink video (006abc80) locks level 0 with LockRect(0, &rect, 0) every frame. Screen grabs use X8R8G8B8.
- **FVFs** passed to SetVertexShader: 0x342 XYZ|DIFFUSE|TEX3 (stride 40, fog plane), 0x252 XYZ|NORMAL|DIFFUSE|TEX2 (44),
  0x244 XYZRHW|DIFFUSE|TEX2 (36), 0x242 XYZ|DIFFUSE|TEX2 (32) (batcher); meshes pass an FVF from the mesh record
  (data, RGEOM) [I: not enumerated; the decoder handles every D3D8 FVF bit except blend weights].
- **Index format** INDEX16 only. **Primitive types** 1-5 (batcher), 4 (quads, fog plane), meshes: from data [I].
- **Lock flags**: VB/IB 0, DISCARD 0x2000, NOOVERWRITE 0x1000 (`offset ? 0x1000 : 0x2000`, 00664fa0/006645b0); texture
  LockRect 0 (Bink); D3DX locks internally.
- **Pools**: MANAGED (textures), 2 (batcher VB/IB), from the mesh (meshes).

### 1.7 D3DX8, statically linked [V]
Reached from game code (callgraph closure: 223 D3DX functions, + 77 CRT): **D3DXCreateFont** 0067d9ce (GetObjectA on
the HFONT, then D3DXCreateFontIndirect 0067d8f0; fonts from 0065e0a0/00660e80 debug font 0x007edae0 and 006aa640 UI
fonts `this+0x54`), **D3DXCheckTextureRequirements** 0067e0c4, **D3DXCreateTexture** 0067e0ec,
**D3DXLoadSurfaceFromMemory** 0067de8e, **D3DXLoadSurfaceFromSurface** 0067e152, **D3DXCreateTextureFromFileA**
0067e814 (one caller, 006748e0). ID3DXFont methods used: DrawTextA (+0x18, debug text 0065c8d0), **DrawTextW (+0x1c, all
UI text: 006a9f00, 006aa030; formats 0x420 CALCRECT|SINGLELINE, 0x120 NOCLIP|SINGLELINE)**, Release. Inside, D3DX8 font
code renders glyphs with GDI into a DIB (006881ca: CreateDIBSection/DrawTextW via the MSLU thunks) and uploads with
LoadSurfaceFromMemory: recompiling it would require a GDI text emulation; HLE avoids that entirely.

---------------------------------------------------------------------------------------------------------
## 2. Design: WebGL2 implementation of that subset

### 2.1 Layers
```
recompiled Meridian.wasm  --call [reg+off]-->  dispatch(addr)  --addr in HLE range-->  table[(addr-BASE)>>2](esp)
                                                                                         |
   com.js (ComBridge): reads this + stdcall args from the emulated stack, struct readers (D3DMATRIX, D3DVIEWPORT8,
   D3DMATERIAL8, D3DLIGHT8, D3DRECT, D3DPRESENT_PARAMETERS, D3DGAMMARAMP), writes out-params, reports popBytes
                                                                                         |
   d3d8.js: Device / Texture / Surface / Buffer / Direct3D8 - JS objects named like D3D8, state cache, shader generator
   d3dx.js: HLE D3DX (texture create/load, ID3DXFont via Canvas2D)
                                                                                         |
   WebGL2 (one canvas, back buffer = FBO, Present = gamma blit)
```

### 2.2 COM objects and vtables in wasm memory [V prototype]
- Every object handed to the game is 8 bytes in a JS-managed heap inside wasm memory: `[vtable ptr][object id]`; the
  vtables (one per interface, real d3d8.h order) hold **fake code addresses** `0x7FFE0000 + 4*i` (prototype
  `THUNK_BASE`, outside the image 0x400000-0x818000 and outside the heap).
- The recompiler's indirect-call dispatcher must treat that range specially: `call_indirect` on an imported
  `WebAssembly.Table` whose entries are the JS thunks (imported functions placed in the table by an elem segment, the
  only portable way to put JS functions in a table). Signature `(esp: i32) -> eax: i32`; the thunk reads `this` at
  esp+4 and the arguments at esp+8.. (all D3D8 arguments are 32-bit, floats arrive as bit patterns).
- stdcall cleanup: the bridge knows each method's argument count and returns `popBytes` (4 + 4*n); the dispatcher adds
  it to esp (or the recompiler takes it from a per-thunk table emitted at link time). Prototype: `ComBridge.popBytes`.
- HLE for non-COM entry points (Direct3DCreate8 import thunk, the six D3DX functions) uses the same mechanism: the
  recompiler replaces calls to those addresses with imports.
- Lock pointers: every lockable resource keeps its system-memory copy **in wasm memory** (allocated by the bridge), so
  Lock returns a real game pointer; Unlock uploads the dirty range (`bufferSubData` / `texImage2D`). Memory growth
  detaches views, so views are re-created on access (`Heap.alloc().u8` getter).

### 2.3 Device state and draw path [V prototype]
- State cache: `rs[256]`, `tss[8][32]`, textures[8], transforms (WORLD/VIEW/PROJECTION/TEXTUREn), viewport, material,
  lights (map + enabled set), FVF, stream 0, indices + BaseVertexIndex, D3D8 default values.
- Each draw: upload dirty textures, compute the **shader key** (FVF + lighting/fog/alpha-test/material-source states +
  per active stage: ops, args, RESULTARG, TEXCOORDINDEX, TEXTURETRANSFORMFLAGS, texture bound), fetch or build the
  program, then apply GL state (depth, cull, blend, color mask, stencil, polygon offset, viewport/depthRange),
  uniforms, sampler objects (cached by address/filter key), vertex attributes from the FVF layout.
- State blocks: recording diverts Set* calls into a list without applying them (Wine/D3D behaviour); Apply replays.

### 2.4 Fixed-function emulation (generated GLSL ES 3.0) [V prototype]
- Vertex: positions XYZ (W*V*P with the raw D3D matrices: a row-major row-vector matrix uploaded unchanged *is* the
  column-major transpose GL expects) or XYZRHW (screen -> NDC with the viewport, w = 1/rhw for perspective-correct
  interpolation); lighting in view space, per vertex like D3D8 (directional / point / spot, attenuation
  1/(a0+a1 d+a2 d^2), range, spot falloff, ambient/diffuse/specular, material sources COLOR1/COLOR2/MATERIAL,
  global AMBIENT); texgen CAMERASPACENORMAL/POSITION/REFLECTIONVECTOR; texture coordinates padded (u, v, 1, 0) and
  multiplied by the texture matrix when TEXTURETRANSFORMFLAGS != 0 (PROJECTED divides in the fragment shader).
- Fragment: the stage chain until COLOROP = DISABLE, every D3DTOP formula (BUMPENVMAP* and PREMODULATE approximated;
  not used by the game), arguments with COMPLEMENT/ALPHAREPLICATE, CURRENT/TEMP result registers, saturate per stage;
  specular add; fog (table LINEAR/EXP/EXP2 on eye depth; vertex fog; specular-alpha fog for RHW); alpha test on the
  8-bit quantised alpha against ALPHAREF.
- GL state: blend factors/op (incl. BOTHSRCALPHA), ZFUNC/stencil func = 0x200 + (D3DCMP - 1), cull: D3D "cull CCW" =
  GL frontFace(CW) + cull BACK (no y flip is needed in clip space: NDC +y is up in both APIs), ZBIAS ->
  polygonOffset [I: scale needs calibrating against the original], FILLMODE WIREFRAME -> triangles converted to a line
  index list (WebGL has no polygon mode).

### 2.5 Coordinate conventions [V prototype]
- Clip z: D3D 0..w, GL -w..w: `gl_Position.z = 2z - w` after the projection; viewport MinZ/MaxZ -> `depthRange`.
- D3D8 pixel centres are at integer coordinates: every vertex is shifted by (+1/vpW, -1/vpH) * w in clip space. Check:
  a pre-transformed quad from 9.5 to 19.5 covers exactly pixels 10..19.
- Rects (viewport, scissor for Clear, readbacks, CopyRects) flip y against the target height (D3D origin top-left).
- Texture rows: D3D row 0 = first row in memory = GL row 0; texture v=0 samples it in both, so no flip.
- D3DCOLOR (BGRA bytes) is a normalised UNSIGNED_BYTE attribute swizzled `.bgra` in the shader.

### 2.6 Resources [V prototype]
- Formats: DXT1/3/5 -> `WEBGL_compressed_texture_s3tc` when present and the level size is legal (level 0 multiple of
  4), else CPU decode to RGBA8; A8 -> legacy unsized `ALPHA` (samples (0,0,0,a), which is D3D's A8 rule); other
  uncompressed formats converted to RGBA8 on unlock (WebGL2 has no BGRA, no ARGB1555/4444 layouts).
- Mipmaps: one `texImage2D` per locked level, TEXTURE_MAX_LEVEL = levels - 1.
- D3DXLoadSurfaceFromMemory into a DXT texture from an uncompressed source would require DXT compression; nobody reads
  such textures back, so the HLE retargets the texture to A8R8G8B8 instead (better quality, no encoder). DXT -> same
  DXT copies blocks unchanged.
- VB/IB: GL buffers + the wasm-memory copy; DISCARD/NOOVERWRITE need no special handling because GL orders uploads
  with draws (a ring of GL buffers would avoid implicit syncs if profiling shows stalls [I]).
- WebGL2 has no BaseVertexIndex: DrawIndexedPrimitive offsets the attribute pointers by base*stride instead.
- Back buffer = FBO (RGBA8 + DEPTH24_STENCIL8). X8R8G8B8 back buffers get alpha writes masked off so DESTALPHA blends
  read 1.0 as on D3D. Present blits through a 256-entry gamma LUT texture built from SetGammaRamp.
- CopyRects/screen grabs: readPixels with a row flip into the destination's system copy.

### 2.7 Things the port controls (caps and adapter answers)
CheckDeviceFormat accepts A8R8G8B8, X8R8G8B8, R5G6B5, A1R5G5B5, X1R5G5B5, A4R4G4B4, A8, DXT1/3/5, D24S8, D16.
D3DCAPS8: TextureOpCaps all ops (the stage parser then picks BLEND*ALPHA), 8 stages, 8 lights, MaxAnisotropy 16,
MaxPrimitiveCount 0xFFFFF. Display modes: a short fixed list. All [I] until the game boots on them.

---------------------------------------------------------------------------------------------------------
## 3. Prototype (`Hobbit-Decomp/web/d3d8/`)

| File | Content |
|---|---|
| `d3d8.js` | constants; FVF decoder; format table, DXT decoder, format converters; Texture/Surface/Buffer; shader key + GLSL generator; Device (all methods of 1.1 plus GetTransform/MultiplyTransform/GetViewport/DrawPrimitiveUP); Direct3D8 (adapter queries, CreateDevice) |
| `com.js` | wasm heap allocator, all eight vtable layouts from d3d8.h, ComBridge (thunks, struct readers, out-params, caps writer, Direct3DCreate8 HLE), a tiny wasm assembler for the thunk table module and a stand-in "recompiled caller" module |
| `d3dx.js` | HLE of the six D3DX entry points; ID3DXFont via Canvas2D (DT_CALCRECT, CENTER/RIGHT/VCENTER/BOTTOM, WORDBREAK, SINGLELINE, NOCLIP; cached text textures) |
| `stagelang.js` | 1:1 port of the game's stage-string compiler + every string from .rdata |
| `test.html` / `test.js` | 26 self-checks on synthetic data; serve `web/` (e.g. `python -m http.server 5197 --directory web`) and open `/d3d8/test.html` (`?nos3tc` forces the CPU DXT path) |
| `tools/` | the inventory scanner and table generator used for section 1 |

Checks (all PASS, Chrome, 2026-10-14, both S3TC and CPU-DXT runs) [V]: Clear; XYZRHW coverage = D3D8 pixel rule; lit
DXT3 cube (204,104,0 vs 204,103,0 expected); linear table fog f = 0.5 (exact); point light with per-vertex attenuation
and a viewport offset; alpha test GREATER 0x80; alpha blend 50 %; dynamic VB/IB with DISCARD + NOOVERWRITE +
BaseVertexIndex; DrawPrimitive from a VB; wireframe via lines; state block record/apply semantics;
DrawIndexedPrimitiveUP with FVF 0x342 + COUNT2 texture matrix; reflection texgen builds; **all 37 game colour strings
and 10 alpha strings, compiled by the ported game parser, rendered through the generated shaders in two
configurations (CURRENT/TEMP inputs) and compared with an independent CPU model of the D3D8 combiner: 94/94 + 10/10**
(102 distinct programs); MODULATEALPHA_ADDCOLOR (water); D3DXFont DrawText; D3DXLoadSurfaceFromMemory R5G6B5 into a
DXT1 request; CopyRects back buffer -> X8R8G8B8 texture; **a hand-assembled wasm module calling
IDirect3D8::CreateDevice, SetRenderState, SetViewport, Clear, CreateVertexBuffer, Lock (pointer into wasm memory),
DrawPrimitive, CreateTexture/LockRect/SetTexture/DrawPrimitiveUP and Release through vtables in wasm memory, with
stdcall pop counts checked**.

### 3.1 Not covered / open
- Not run against real game data or the real exe (rule: no launches; game assets not copied). The first real test is the
  recompiled exe itself or a capture replay (below).
- Mesh FVFs and primitive types come from RGEOM data: not enumerated [I]; the decoder is generic.
- Exact D3D8 behaviours still [I]: ZBIAS scale, texture border colour (BORDER -> clamp), unbound texture used as
  D3DTA_TEXTURE (returns 1,1,1,1 here), table fog on w vs z, LOCALVIEWER=false vector, NORMALIZENORMALS (always
  normalised here), multisample (none), point size.
- D3DXCreateTextureFromFileA needs the port's VFS + an image decoder (one caller, probably debug); D3DXFont needs the
  LOGFONT from the port's GDI CreateFontA/W emulation (face, height, weight); text metrics will differ slightly from
  GDI (UI layout uses DT_CALCRECT, so it adapts).
- Lost device: TestCooperativeLevel maps to `webglcontextlost`; recreating GL objects after a restore is not written.
- ShowCursor/SetCursorProperties, GetAdapterMonitor (returns a dummy HMONITOR), windowed Present rect are stubs.
- Performance: a program switch per state change is cached, but uniform uploads are not diffed; the 5,000 textures
  each own a GL texture (fine); no batching beyond what the game does.

### 3.2 Suggested verification with the original (no gameplay needed)
Record a D3D8 command stream from the original game (a d3d8 proxy DLL that logs every device call with arguments and
the locked data, same idea as the capsule recorder), then replay it through `d3d8.js` in Chrome and diff frames
against screenshots taken by the proxy. That tests this layer on real data before the recompiler is ready, and the
log also enumerates the data-driven FVFs/primitive types.

### 3.3 Remaining work (estimate)
| Item | Effort |
|---|---|
| Wire ComBridge into the recompiler's indirect-call dispatch + import HLE addresses (needs its ABI: stack in memory, esp global) | 1-2 days |
| D3D8 call-stream recorder (proxy DLL) + JS replayer + frame diff | 3-4 days |
| Fix-ups from real data (FVFs, blend/alpha edge cases, ZBIAS, fog details, sampler states) | 3-5 days |
| D3DXFont: LOGFONT from the GDI layer, glyph metrics close to GDI, cache tuning | 1-2 days |
| D3DXCreateTextureFromFileA (DDS/BMP/TGA via VFS), Bink frames (texture LockRect path is done; decoder is another track) | 1 day (+ Bink) |
| Lost-context restore, resize/fullscreen, gamma/brightness UI | 1-2 days |
| Performance pass (uniform diffing, buffer rings, state sorting if needed) | 2-3 days |
| **Total for the D3D8 layer** | **~2-3 weeks** after the recompiler can run the init code |
