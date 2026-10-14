# d3drec: Direct3D 8 call recorder + WebGL2 replay diff

Purpose: record every D3D8 call the ORIGINAL Meridian.exe makes during a play session (with the data needed to
replay it), then replay the stream in Chrome through the WebGL2 D3D8 layer (`web/d3d8/`, see WEB_PORT_D3D8.md) and
diff each recorded back-buffer screenshot against the replayed frame. This tests the web port's graphics layer on real
game data before the recompiler exists (WEB_PORT_D3D8.md 3.2), and the log enumerates the data-driven FVFs / primitive
types / formats the static inventory could not.

Status (2026-10-14): built and verified OFFLINE only (mock D3D8 runtime, synthetic logs, headless Chrome). **The game
has not been launched with it.** Marks: [V] verified by running, [I] inferred.

## 1. Files (`Hobbit-Decomp/d3drec/`)
| File | Content |
|---|---|
| `src/dllmain.cpp` | `Direct3DCreate8` export: loads the chain DLL on first call (not in DllMain), wraps the result; `D3DRec_Finish` test hook |
| `src/wrap.cpp/.h` | COM wrappers: IDirect3D8 (16 methods), IDirect3DDevice8 (97), IDirect3DTexture8 (19), IDirect3DSurface8 (11), IDirect3DVertexBuffer8 / IndexBuffer8 (14 each) = all 171 vtable methods; lock capture; screenshots |
| `src/rec.cpp/.h` | config, record encoder, blob dedupe + VB/IB diff, matrix cache, LZ4 compressor, writer thread, crash flush |
| `src/d3d8min.h` | D3D8 types/interfaces (the installed Windows SDK has no d3d8.h); layouts static_asserted |
| `ops.def` + `gen_ops.py` | the single definition of every record (-> `src/ops_gen.h`, `ops.js`) |
| `reader.js` | log reader (browser + Node): chunks, LZ4 decode, records, blob store (LRU of decompressed chunks), struct helpers |
| `replayer.js`, `replay.html` | replay through `web/d3d8/d3d8.js` + per-shot diff (metrics + heat map); automation via URL params |
| `dump.mjs`, `nodefile.mjs` | Node CLI: size/frames/fps/op histogram/data kinds/events, `--list from to`, `--fvf` (FVF x draw x primitive inventory) |
| `install.ps1`, `uninstall.ps1` | install into a dedicated hard-link test copy; refuse `The Hobbit - Clean` / `- Reference` |
| `build.bat` | MSVC x86 build into `build/` (gitignored by `Hobbit-Decomp/.gitignore` `build/`) |
| `test/mock_d3d8.cpp`, `test/synth.cpp`, `test/check_log.mjs`, `test/bench.cpp` | offline tests (section 6) |

Build: `d3drec\build.bat` (VS 18 vcvars32, `/O2 /MT`; output `build\d3d8.dll`, 0 warnings, imports KERNEL32 only) [V].

## 2. Config (`d3drec.ini` next to the DLL; missing file = defaults)
| key | default | meaning |
|---|---|---|
| enabled | 1 | 0 = pure pass-through: returns the chain's IDirect3D8 unwrapped, no log, no overhead |
| chain | d3d8_chain.dll | DLL to forward to: relative to the DLL folder, absolute, or `system` (SysWOW64\d3d8.dll). Falls back to system if missing; never loads itself |
| output_dir | d3drec_logs | log folder (relative to the DLL folder or absolute); files `d3drec_<yyyymmdd_hhmmss>.d3dr` + `.txt` side log |
| shot_interval | 60 | back-buffer shot every N frames (0 = none) |
| shot_scale | 2 | box downscale factor of shots (1 = full size) |
| shot_method | auto | `auto` = lockable back buffer, else render-target copy, else sysmem copy; or `lockbb`, `rtcopy`, `copyrects`, `off` (3.6) |
| chunk_kb | 512 | uncompressed chunk handed to the writer (also handed off every 250 ms) |
| queue_mb | 256 | writer backlog before the game thread waits |
| max_mb | 8192 | stop recording at this file size |
| diff | 1 | VB/IB unlocks as changed spans when cheaper |
| compress | 1 | LZ4 chunks |
| stop_after_frames | 0 | stop after N frames |
| veh_flush | 1 | flush on first-chance fatal exceptions (3.7) |

## 3. Log format (`.d3dr`, little-endian)
```
file    "D3DR" u32 version=1, u32 jsonLen, json header (exe, pid, time, chain path, config)
chunk*  "CHNK" u32 seq, u32 rawLen, u32 compLen (0 = stored), payload (LZ4 block if compLen)
```
- Chunks are independent LZ4 blocks; each is written by ONE WriteFile (whole or absent). Sequence numbers increase;
  the reader drops repeats (an emergency flush may rewrite the last chunk) and stops at a truncated tail.
- Decompressed chunk = records; a record never spans chunks. Record = `u8 op` [+ varuint `this` id for interface ops
  < 192] + fields per `ops.def`. Op codes: 0-96 IDirect3DDevice8 vtable index, 100-115 IDirect3D8, 120-138 Texture,
  140-150 Surface, 152-165 VB, 166-179 IB, 192+ meta (Shot, Destroy, Event, End, Unwrapped, Create), 240 = HR prefix
  (the NEXT record's call returned this HRESULT; only written when != S_OK).
- Field kinds: `u` varuint, `i` zigzag, `d` raw u32, `f` f32, `o` object id (0 = NULL/unwrapped), `r` optional RECT,
  `R`/`P` rect/point lists, `B` bytes (len+1, 0 = NULL), `s` string, `M` matrix, `X` lock data.
- Object ids: every wrapper gets a sequential id (Meta::Create gives the IDirect3D8's). Outputs (created objects,
  GetSurfaceLevel/GetBackBuffer results, state-block tokens, Get* values and out-structs) are recorded after the call.
- **X (lock data)**, captured at Unlock before the real Unlock: kind 0 none (READONLY), 1 NEW (blobId, len, bytes),
  2 REF (blobId: same content stored earlier; key = 64-bit hash + length), 3 DIFF (spans vs the buffer's shadow copy,
  VB/IB only; used when < 1/2 of the range). Textures send packed rows (`rowBytes`, `rows` in the Unlock record; DXT =
  block rows). DrawPrimitiveUP / DrawIndexedPrimitiveUP vertex+index data also use X (text/fog quads repeat every
  frame -> REF).
- **M (matrix)**: 4096-slot cache shared by reader and writer: 0 NULL, 1 new (64 bytes, stored in slot
  `newCount++ & 4095`), 2 cached (slot). Static objects re-send identical WORLD matrices every frame, and LZ4's 64 KB
  window cannot see the previous frame.
- **Shot** (meta 192): frame, w, h, scale, source format, RGBA8 pixels; written immediately BEFORE that frame's Present
  record. Box filter `(sum + n/2) / n` in both recorder and replayer.
- **Present** carries the frame number (0-based) and ms since start; **End** carries frames + total calls.

### 3.6 Screenshots [V mock, I real]
The folder's `d3d8.dll` (crosire d3d8to9) loads only `d3dx9_43.dll`, which is NOT installed on the laptop (SysWOW64
has d3dx9_24..36) [V: strings + directory listing]. d3d8to9 sends any CopyRects whose destination is not DEFAULT-pool
through `D3DXLoadSurfaceFromSurface`, so such copies fail with INVALIDCALL [I: from d3d8to9's source structure]. That
also means **the game's own screen grabs (CopyRects back buffer -> MANAGED X8R8G8B8 texture, 0065fd00/0065fed0/
006606a0) probably fail under this wrapper**; the log's HR prefixes will show it. Hence `shot_method=auto`:
1. `lockbb`: CreateDevice/Reset get `D3DPRESENTFLAG_LOCKABLE_BACKBUFFER` added (only lockability changes; if the runtime
   refuses, the call is retried with the game's exact parameters; the game's `pp->Flags` is restored either way), then
   LockRect(READONLY) on the back buffer.
2. `rtcopy`: lockable DEFAULT-pool render target + CopyRects (d3d8to9: StretchRect) + LockRect.
3. `copyrects`: system-memory image surface + CopyRects.
The first method that works is kept; failures are logged as Events; 30 consecutive failures disable shots. All
temporaries are released immediately (nothing DEFAULT-pool survives into a Reset). Shots use the real device directly,
so they never appear in the call stream.

### 3.7 Threads, flushing, crashes
- The game thread only appends records to a memory chunk (one CRITICAL_SECTION); the writer thread compresses + writes.
- Device/IDirect3D8 final Release: flush and wait (5 s). DLL unload: END + close. Process exit (DLL_PROCESS_DETACH with
  other threads gone): lock-free emergency write of the backlog + END.
- Crash: a vectored handler registered LAST, returning `EXCEPTION_CONTINUE_SEARCH` always, so the game's
  `SetUnhandledExceptionFilter` handler (0065ea60) and any SEH run unchanged. On a fatal first-chance code (AV, illegal
  instruction, divide, stack overflow, ...) it hands the current chunk to the writer and waits <= 1 s, and records
  the first 50 exceptions as Events (code, address, frame). Handled first-chance AVs only cause an early flush.
- Lifetime: wrappers mirror the real refcount; a texture-level surface shares its container's count (its Release
  reaching 0 destroys the texture wrapper); Meta::Destroy tells the replayer. QueryInterface/GetContainer/GetDevice/
  Get* return the existing wrapper by real pointer. Cube/volume textures and extra swap chains (never used by the game)
  are passed through unwrapped and reported (Meta::Unwrapped).
- D3DX8 is statically linked in the exe, so its texture loading and ID3DXFont drawing go through the wrapped
  interfaces and are recorded like game calls (font: state blocks, DrawPrimitiveUP, glyph texture locks) [I].

## 4. Replay (`replay.html`)
Serve `Hobbit-Decomp/` (`python -m http.server 5198 --directory Hobbit-Decomp`), open
`http://127.0.0.1:5198/d3drec/replay.html`, pick a `.d3dr` (read in slices, not loaded whole) or pass `?log=<url>`.
Run all / Next frame / Run to frame N / Stop; per-shot table (mean |d|, max, % pixels with a channel diff > threshold,
PSNR, bounding box of bad pixels, PASS if bad px <= pass %); click a row for recorded / replayed / heat-map images
(kept for failing shots and the first 8). Warnings list records the layer cannot replay. Automation:
`?auto=1&log=..[&expect=..][&until=N][&nos3tc=1]` writes JSON into `#result` and sets the title to `D3DREPLAY DONE`.
Replay mapping (`replayer.js`): objects by recorded id, state blocks by recorded token (Begin/End blocks -> d3d8.js
blocks; CreateStateBlock -> full snapshot/restore [I: D3D8 SBT types not distinguished]); failed calls (HR prefix) are
skipped; lock data written into d3d8.js lock views (rows re-pitched); CopyRects/GetFrontBuffer read the FBO;
CreateImageSurface -> 1-level texture; Create{RenderTarget,DepthStencil} alias the back buffer (unused by the game).

`node d3drec/dump.mjs <log>`: size, LZ4 ratio, frames, fps, MB per 20 min at the recorded rate, data kinds, bytes per
op, events. `--fvf` lists FVF x draw call x primitive type (fills WEB_PORT_D3D8.md 3.1's open "mesh FVFs").

## 5. Overhead and size
`test/bench.cpp` models a busy frame from the inventory (400 mesh DIPs with ApplyStateBlock / SetTexture / WORLD
matrix / stream+indices / 2 render states / 3 stage states, a quarter of the objects moving; 24 batcher flushes into
3 rotating 0xCE40 dynamic VBs, 16 repeating UI + 8 random-float particle locks of 2 KB; 12 font DrawPrimitiveUP;
fog-plane DIPUP; 640x480 back buffer, shot every 60 frames at 1/2; startup 250 DXT textures + 50 mesh VB/IB), ~4,500
calls/frame, against the mock runtime [V numbers, I model]:

| | value |
|---|---|
| recorder cost on the game thread | **0.35 ms/frame** (enabled=0: 0.035 ms) = ~1 % of a 33 ms frame |
| log, 1,800 frames (60 s at 30 fps) | 39.6 MB file (106.8 MB raw, LZ4 x2.7) |
| **20 minutes at 30 fps** | **~0.79 GB** (target < ~1 GB) |
| biggest contributors | random-float particle VB data (incompressible by construction; real particles are more regular), moving WORLD matrices, stage states |
| before matrix cache + UP dedupe | 1.07 GB / 20 min, 0.80 ms/frame |

Real numbers come from the first session (`dump.mjs` prints MB per 20 min). If too big: `shot_interval` 120 / scale 4
cuts shots (1/6 of the bench file), `max_mb` caps the file. The writer handles ~150 MB/s raw, far above the ~2 MB/s
raw a 30 fps game produces.

## 6. Verification done (offline, no game, no window)
- `test/mock_d3d8.cpp`: a COM D3D8 runtime with heap-backed resources (padded pitches to exercise row packing,
  container-shared surface refcounts, CopyRects), no window or GPU.
- `test/synth.cpp` loads `build\d3d8.dll` exactly like the game would (chain -> mock), renders 6 frames of the game's call
  mix: RHW DrawPrimitiveUP quads, a dynamic VB with DISCARD then NOOVERWRITE, static VB+IB DIP, an XYZ quad through
  WORLD/VIEW/PROJ with DIPUP, A8R8G8B8 (surface lock) and DXT1 (texture lock) textures, a 2-level texture with a sub-rect
  lock, a duplicate upload, an incompressible texture, a state block for alpha blending, lights/material/gamma, a
  CopyRects screen grab, two failing calls; it paints the same picture on the CPU into the mock back buffer (= shot
  ground truth) and sabotages frame 3 with a 10x10 magenta box.
- `test/check_log.mjs`: 21 checks per log (counts, texture CRCs after REF resolution, dedupe REF used, dynamic VB rebuilt
  from DIFF spans, HR prefixes, shot size/pixels, END): **ALL PASS** for 3 configs (scale 1 / interval 1 / lockbb;
  scale 2 / interval 2 / 64 KB chunks / rtcopy; no diff, no compression, copyrects) [V].
- Headless Chrome (`--headless=new --use-angle=swiftshader`, temporary profile, no window) on `replay.html?auto=1`:
  **4/4 runs pass** (the 3 logs + CPU-DXT path): every shot pixel-exact (mean 0, max 0), the sabotaged frame FAILS with
  bad-pixel box exactly [130,90,140,100] [V].
- `install.ps1`/`uninstall.ps1` on a fake folder: hard links for >= 4 MB files, copies for small ones, experiment files
  skipped, d3d8.dll -> d3d8_chain.dll, refusal of a folder named `The Hobbit - Clean`, double-install refusal, clean
  uninstall back to the original d3d8.dll [V].
- Replayer on the 8.1 M-record bench log: no unhandled records; SwiftShader (CPU) needs ~3.5 s per bench frame
  (random full-screen geometry); use GPU Chrome for real logs [V].
- One outside caller was seen: the very first synth.exe run recorded an `IUnknown` QueryInterface + Release on the
  IDirect3D8 and device that our code does not make (not repeated in later runs); harmless, recorded as is.

## 7. The recording session (later, with Ivan's permission; he must not be using the laptop)
1. Build: `Hobbit-Decomp\d3drec\build.bat` (or reuse `build\d3d8.dll`).
2. Make a dedicated copy and install (one command; same NTFS volume):
   ```
   powershell -ExecutionPolicy Bypass -File Hobbit-Decomp\d3drec\install.ps1 `
     -Target "C:\Users\ivanm\Downloads\IRA\The.Hobbit.-.Clean\The Hobbit - D3DRec" `
     -CreateFrom "C:\Users\ivanm\Downloads\IRA\The.Hobbit.-.Clean\The Hobbit - Clean"
   ```
   (no dinput8 proxy in the copy: the original game + d3d8to9 + recorder only).
3. Smoke test (play-tester agent, one launch): start `Record Hobbit.bat`, reach the main menu, quit from the menu.
   Check `d3drec_logs\*.txt`: "device created, lockable back buffer for shots: yes", "shots use method ...", no
   "shot failed"; `node Hobbit-Decomp\d3drec\dump.mjs <log>` shows frames and an END record.
4. Session: Ivan plays ~20 min (New Game, a level, menus, a cutscene/Bink video), quits from the menu (saves are in
   Documents\The Hobbit: never delete or overwrite them). Watch fps; the recorder should not be noticeable.
5. Analyse: `dump.mjs <log>` (size per 20 min, events, failed calls), `dump.mjs <log> --fvf`; replay in Chrome (GPU)
   via `replay.html`, triage failing shots (heat map) into d3d8.js fixes (WEB_PORT_D3D8.md 3.3 "fix-ups from real data").
6. Uninstall: `uninstall.ps1 -Target "...\The Hobbit - D3DRec"` (keeps logs) or delete the copy.

## 8. Open / inferred
- Never run on the real d3d8to9/D3D9 or real D3D8; the shot methods, `LOCKABLE_BACKBUFFER` acceptance, and frame timing
  are [I] until step 3. If d3d8to9 rejects the flag, `auto` falls back automatically.
- Reading WRITEONLY DEFAULT-pool VBs at Unlock reads write-combined memory (slow) [I]; the game's dynamic batcher VBs
  are SYSTEMMEM (pool 2) and mesh VBs are written once at load, so this should only cost load time.
- Replay does not resize on Reset; 16-bit back buffers replay as X8R8G8B8 (the diff then contains quantisation:
  raise the threshold); SetRenderTarget/patches/shaders are not replayed (the game uses none).
- The game is single-threaded on D3D as far as the inventory shows [I]; the recorder is thread-safe anyway (one lock).
