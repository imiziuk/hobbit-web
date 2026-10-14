# Booting the recompiled Meridian.exe (wasm) to the main menu (2026-10-14)

Continuation of `docs/RECOMP.md`. The same translated C (x86c.py) is now also built as a **game build**: flat guest
memory, host imports, and a JS host that plays Windows. It boots from the real PE entry point **0x006C0C90**
to the front-end main menu, first headless in Node, then in Chrome with the real `web/d3d8` WebGL2 device.

## 1. Result (what actually ran)
| | Node headless (`recomp/boot_node.mjs`) | Chrome (`web/game.html`, Claude desktop browser pane) |
|---|---|---|
| Path | entry -> CRT (`_cinit`, 803 initializers) -> WinMain -> EngineInit (window, D3D device, DirectInput, DirectSound, io/audio threads, 6 DFS mounts, UI) -> LegalScreen -> 5 PlayMovie -> `x_Log("Starting Main Loop")` -> RunFrontEnd -> PressStart (New_intro_final, 1,875 frames) -> FE state 6 = `main_menu` | same |
| Proof | probe log `[x_Log] Starting Main Loop (frame 156)`; FE state `[0x762B58] = 6` | screenshots `recomp/out/boot/chrome_legal_and_menu.jpg` (legal screen at Present 20, menu at Present 90), `chrome_main_menu.jpg`; ArrowDown moves the menu highlight |
| Presents | 4,000 in 28.6 s wall (virtual clock, null GL) | 30 fps with rAF; about 11 fps when the pane is hidden (timer fallback) |
| Functions entered | 2,405 translated functions | - |
| Threads | main, audio dispatcher, io_mgr dispatcher, 6 Bink service threads (green threads) | same |
| Exceptions | 3 x RaiseException 0x406D1388 (thread naming), handled by `_except_handler3` via the FS:[0] walk | same |
| Files | read-only from the game folder; settings files are absent (defaults) | 155 HTTP Range requests, 10.3 MB for the boot |

Not done: Bink frames are black (a header-timing stub plays movies for their real length), sound is silent, no level
was loaded. The menu text is the game's own bitmap font (section 6), not D3DXFont.

## 2. Files
| file | role |
|---|---|
| `recomp/build.py --flat` | compiles out/c with `-DRT_FLAT` into `out/o_flat/`, links `out/hobbit_flat.wasm` (34.7 MB; wasm data + C stack at 0..1.2 MB, below the image) |
| `recomp/runtime/rt.h`, `rt.c` | `RT_FLAT`: inline flat accessors (guest address = linear address); `rt_ext` (unknown target: trap in the harness, `host_call` in the game build), `rt_hle`, `rt_probe`, `rt_call` |
| `recomp/x86c.py` | dispatcher not-found path -> `rt_ext`; `recomp/hle.txt` (functions replaced by host code, flat build only, empty now); `recomp/probes.txt` (function entries that notify the host, flat build only) |
| `recomp/host/machine.mjs` | wasm instance, memory views, PE image mapping, IAT binding, host-call protocol, guest heap, TEB/FS, green-thread scheduler, clocks |
| `recomp/host/pe.mjs` | PE sections + import directory |
| `recomp/host/win32.mjs` | KERNEL32/USER32/GDI32/SHELL32/WINMM/binkw32/shfolder shims, MSLU W functions, fake DLL images, message queue, SEH |
| `recomp/host/dx.mjs` | DirectInput8 + DirectSound8 host COM objects (sound: `dsmix.mjs` mixer, `web/audio.mjs` + `web/audio-worklet.js`); D3D8 via `web/d3d8/com.js` ComBridge; `nullGL()` for Node |
| `recomp/host/vfs.mjs`, `node_fs.mjs` | path mapping (`C:\HOBBIT` = game folder read-only, `C:\APPDATA` = settings), Node fs backend, HTTP Range backend (64 KB blocks: memory cache, blocks in flight, then the persistent Cache API store `hobbit-data-v1` keyed by file + manifest version + size, then one Range request per run of missing blocks; sequential read-ahead; no store in Node), memory backend. `web/prefetch.mjs` downloads into the same store in the background (see the last section) |
| `recomp/boot_node.mjs` | headless runner; writes `recomp/out/boot/{boot.log, summary.json, files.txt, entered.txt}` |
| `recomp/serve_game.py` | read-only Range + CORS server for the game folder on 127.0.0.1:5191, `/__manifest` (`[path, size, version]`), ETag on every response, `?v=` URLs immutable (launch.json `hobbit-game-data`); `serve_path()` is reused by `start.py --single` under `/data/` |
| `web/game.html`, `web/game.mjs` | Chrome page (served by `hobbit-web`, port 5190): JSPI, real d3d8.js device on the canvas, keyboard/mouse -> DirectInput, `?snap=20,90` keeps frames as images |
| `web/d3d8/com.js` | fixed: full stdcall argument table (IDirect3D8::GetDeviceCaps = 3 args, surface LockRect/UnlockRect = 3/0), GetDirect3D / GetDisplayMode / GetCreationParameters (used by D3DX8), GeForce-class D3DCAPS8 (HW T&L, all blend/compare caps) |

Run:
```
python recomp/build.py --flat
node --experimental-wasm-jspi recomp/boot_node.mjs --frames 4000      # Node 24 needs the JSPI flag
python recomp/serve_game.py      &  python -m http.server 5190 --bind 127.0.0.1 --directory Hobbit-Decomp
-> http://127.0.0.1:5190/web/game.html          (Chrome 137+: JSPI on by default; no Asyncify fallback)
```
Single-origin alternative (what Docker and Cloudflare Access use): `python Hobbit-Decomp/webrepo/start.py --single [--mp]
--game <dir> --port 5390` (launch.json `hobbit-single`) serves the repo at `/`, the game folder at `/data/`, the relay at
`/relay` and `/__mode`; `web/game.mjs` asks `<repo>/__mode` and then uses `<repo>/data` and `ws(s)://<repo>/relay`
(`?data=` / `?mp=` still win). Static files: gzip (wasm from `hobbit_flat.wasm.gz`, made at startup when stale) + ETag /
`no-cache` revalidation. Measured first vs repeat visit: menu 170 req / 20.3 MB vs 14 req / 7 KB; Dream World ~580 req /
~49 MB vs 14 req / 7 KB (0 game-data requests).
Runner options: `--frames N`, `--seconds S`, `--trace N` (log the first N host calls), `--keys frame:DIK[:len],...`,
`--vis-reset <addr>` (functions entered after a milestone), `--peek addr,...`, `--dstrace N` (log the first N DirectSound calls), `--audio-wav f.wav` (offline mix, see "Audio").

## 3. Memory and the host-call protocol
- Linear memory = guest address space: wasm data + C shadow stack below 0x00400000, exe image at 0x00400000 (headers +
  sections copied from the PE, bss zero), guest heap from 0x01000000 (JS allocator, size classes, grows the memory).
- IAT slots hold host thunk addresses `0x7F000000 + 4k`; COM vtables of DirectInput/DirectSound use the same range;
  `web/d3d8` ComBridge thunks are `0x7FFE0000 + 4k`. Any call/jmp to `[0x7F000000, 0x80000000)` that is not a
  translated function goes to `env.host_call(t)`: the host reads the arguments at `[R.esp+4..]`, runs the stub, pops
  the return address (+ arguments for stdcall), puts the return address in `R.retaddr` (the translated caller's
  CALLCHK verifies it) and sets EAX/EDX. Tail jumps through `jmp [IAT]` work unchanged.
- Host -> guest calls (WndProc from Send/DispatchMessage, DirectInput EnumDevices callbacks, SEH handlers):
  push args + a sentinel return address, call the exported `rt_call`. These nested calls must not block.
- MSLU: the exe resolves 18 W functions by walking the export table of `GetModuleHandleA("kernel32.dll")` etc.
  (0x006CD6D5). The host builds fake PE images with sorted export tables in guest memory whose RVAs point at host
  thunks. `GetFileAttributesW("???.???")` returns ERROR_INVALID_NAME, so it takes the NT path.

## 4. Threads (JSPI green threads)
- Every Win32 thread is a separate `WebAssembly.promising(rt_call)` call with its own guest stack + TEB (FS base) and
  its own C shadow stack (`__stack_pointer` swapped). Blocking stubs return a `Wait`; `host_call` then returns 1 and the
  wasm side calls `env.host_wait` (a `WebAssembly.Suspending` import). The scheduler saves R/FPU/XMM/MMX +
  `__stack_pointer`, picks the next thread (priority, round robin) and resumes it.
- If the current thread can continue (its wait is already satisfied, or virtual time can jump to its deadline) there
  is no suspension at all. ReleaseSemaphore returns a `Yield` so a woken higher-priority thread runs first
  (single-CPU preemption, WEB_PORT_THREADS.md).
- Implemented: CreateThread/ResumeThread/ExitThread, semaphores, events, WaitForSingleObject with timeouts,
  CRITICAL_SECTION with owner + recursion, Sleep, TLS, thread priorities.

## 5. Time and frames
- Node: `VirtualClock` (deterministic). Sleep/waits jump time when every thread is blocked; Present waits 33.4 ms of
  virtual time after the previous frame; a pump with no Present since the last pump waits 10 ms (so pump-only loops and
  logic_mgr's 10 ms minimum step advance).
- Chrome: `RealClock` (performance.now); Present awaits requestAnimationFrame until >= 31 ms after the previous frame,
  with a timer fallback when rAF is throttled.
- `CreateDevice` drops the x87 CW to 24-bit precision as D3D8 does without FPU_PRESERVE.

## 6. What the boot needed (fixes found by running it)
1. ComBridge pop count: `popBytes` is the stdcall `ret N` (this + args), the return address comes on top.
2. `IDirect3D8::GetDeviceCaps` has 3 arguments (the bridge used the device's 1): the caps were written to a wrong
   address and the game stopped with "You need a video card which supports multitexturing".
3. D3DX8 (statically linked, recompiled) calls `IDirect3DDevice8::GetDirect3D` and then `CheckDeviceFormat` 9,600 times.
4. Missing D3DDEVCAPS_HWTRANSFORMANDLIGHT gave "Your video card doesn't support ... transform or lighting".
5. **The front end needs a movie to succeed**: PlayMovie 0x0052AE30 sets FE state 0x11 and restores the previous
   state only after a successful BinkOpen. With BinkOpen = 0 the game sits in RunFrontEnd in state 0x11 forever
   (also true for the original exe with missing movies). The Bink stub therefore opens the real .bik, reads the header
   (frames, size, fps) and plays black frames with real timing (`BinkWait`/`BinkNextFrame`, HBINK +8 Frames, +0xC FrameNum).
   In this install the logo movies are 1-frame files; New_intro_final has 1,875 frames.
6. ShowWindow must deliver WM_ACTIVATE(WA_ACTIVE) synchronously: WndProc 0x0065D860 sets 0x007EFF70 = 2, and
   eng_PageFlip only Presents while that flag is non-zero.
7. `x_Log` 0x00650010 is compiled out (`return 0`, shared by other functions through ICF): the probe logs only string
   arguments that point into .rdata.

Text: the legal screen and menu text are the game's own bitmap fonts (xbmp) drawn with DrawPrimitiveUP; D3DXFont
(GDI) is not on the boot path, so no HLE of D3DX was needed.

## 7. SEH / C++ exceptions
`RaiseException` builds EXCEPTION_RECORD + CONTEXT below the stack and calls each FS:[0] handler (cdecl, nested).
ExceptionContinueExecution returns to the caller; `RtlUnwind` calls the handlers with EXCEPTION_UNWINDING and pops
the chain. **Empirically the boot raises only 0x406D1388 (MSVC thread naming) 3 times**, all continued by
`_except_handler3`. No C++ throw (0xE06D7363) and no hardware fault happened on the path to the main menu.
Not implemented: resuming at a catch continuation (`_JumpToContinuation` = `jmp eax` into the middle of a function).
That needs multi-entry functions or a "resume at address" path in the translator; it traps with `ext` today.

## 8. Known gaps / next steps
1. Bink decoding (frames are black; a Bink 1 decoder in a worker, or transcoded WebM per WEB_PORT_THREADS.md).
2. ~~DirectSound -> WebAudio~~ done Oct 14, see "Audio" below. Bink movie audio is still silent.
3. New Game -> LoadLevel (not tried yet); C++ exception continuations if a level load throws.
4. HLE of D3DX texture loading if the recompiled path is too slow (9,600 CheckDeviceFormat calls at boot).
5. Settings files are not persisted in the browser (MemBackend); Node writes them to `recomp/out/appdata`.

## Input: mouse and gamepad (Oct 14)
- **Mouse in menus:** the game reads the cursor with `GetCursorPos` from the pump (00660420 -> 006603b0 stores client
  coordinates at 0x7effc8/cc), and button state from WM_LBUTTON/RBUTTON/MBUTTON in its WndProc (0065d860 -> 0x7effd4/d8/dc).
  Other screens read the DirectInput mouse buttons. The shim used to return a fixed (320, 240). Now:
  - `W.mouseEvent` posts WM_MOUSEMOVE (coalesced) and button messages in window client coordinates, and sets the cursor.
  - Button-up messages are held for 3 pumps, and DirectInput buttons are latched for 3 polls, so a quick click is not lost between frames.
- **Gamepad:** a virtual DirectInput joystick is always enumerated (GAMECTRL), so a pad can be plugged in at any time.
  - The game sets `c_dfDIJoystick2` (0x6f9d04, 272 bytes) and sets DIPROP_RANGE -1000..1000 per axis in its EnumObjects
    callback (00670dc0). It polls GetDeviceState(0x110) in 0066fc30.
  - Our product GUID matches none of the pads it knows (00670860), so it uses its generic profile (type 0).
  - Default bindings, from its Controls screen (0-based button numbers): Move = X/Y, Camera = Z/RZ, Toggle View 0, Ring 1,
    Jump 2, Attack 3, Crouch 4, Use 5 (also menu accept), Target 7, D-pad = Walking-stick / Stones / Sword.
  - `dx.mjs padState` maps the W3C standard gamepad onto those indices per mode. The page decides the mode:
    - `menu` = level loop off (0x760354 == 0), logic paused (0x7600f4), or the pause menu open (0x76321c, a field of the
      pause object found by diffing globals);
    - `cutscene` = g_pBilbo (0x75ba3c) + 0x44c == 1 (set by 00422980, "CINEMA: Bilbo Input set FALSE");
    - otherwise `game`.
  - Start = Esc in game, and Enter in menus and cutscenes (Enter skips movies; it is Use in gameplay, so it is not sent there).
    B = Esc in menus.
- Tested in the browser pane: real mouse hover and click through Options → Controls → Gamepad, and a simulated
  standard gamepad through menu → New Game → skip movie and cutscene → run → pause menu (navigate, open Audio, back)
  → resume. Not yet tested with a physical controller.

## Phone / touch controls (Oct 14)
- `web/touch.mjs` (page-only; boot_node never loads it) draws an overlay in `#stage` that behaves as a virtual W3C standard
  gamepad. `W.input.readPad()` = `mergePads(physical, touch)`: the buttons are ORed, and each axis takes the value with
  the larger magnitude. Left half = floating stick (left stick); right half = drag stick (right stick, its anchor
  follows the finger beyond the radius); A/B/X/Y, D-pad, LB/RB, Back/Start buttons. Pointer events, multi-touch, `touch-action: none`.
- The labels and drag areas follow `padMode()` every 100 ms. In `menu` mode the drag areas are `pointer-events: none`, so a
  tap reaches the canvas: pointerdown (non-mouse, preventDefault so there are no compatibility mouse events) -> WM_MOUSEMOVE,
  WM_LBUTTONDOWN 120 ms later, WM_LBUTTONUP >= 100 ms after that. Verified: tap Options -> Options screen, tap DONE, tap New Game.
- Checkbox "Phone controls": `?touch=1|0`, then localStorage `hobbit.touch`, then `(pointer: coarse)`. `body.touch` = fixed
  full-screen stage (canvas 4:3 contained), panels in a drawer ("Panels"). Fullscreen button: documentElement in phone
  mode, `#stage` on desktop, + `screen.orientation.lock('landscape')`. No JSPI -> message (iOS can't run it).
- Two pad fixes found with it (they apply to physical pads too):
  1. Menus: a D-pad press moved the cursor two items (POV; the same press on lY moved one). `padState` now sends the D-pad
     as the left stick in `menu` mode, with no POV.
  2. Start = Esc opened the pause menu, then the mode became `menu` while Start was still held, so the page sent Enter
     and selected "Exit Game". The Start/B key is now chosen on press and kept until release.
- Tested in the browser pane (synthetic touch PointerEvents, 800x450 and a 640x360 emulated phone): D-pad 1 step per tap,
  canvas taps, New Game, Start skips the movie and the cutscenes, the left stick runs Bilbo (moved ~350 units in 1.5 s), A jumps (Y +94),
  camera drag rotates the view, Start pauses, B resumes, checkbox off restores the desktop layout. Not tried on a real phone.

## Audio (Oct 14)
The game does its own audio work and only needs plain DirectSound: it decodes IMA ADPCM (36-byte blocks -> 64 samples,
0067b860) into **16-bit mono PCM** secondary buffers (flags 0x500c0 = CTRLPAN|CTRLVOLUME|GETCURRENTPOSITION2|GLOBALFOCUS,
no 3D), and refills streams from the main thread by polling the play cursor (0067b260). So the port makes the
DirectSound stub real instead of replacing any game code.

**Pipeline.** `recomp/host/dx.mjs installDirectSound(m, W, S, out)` keeps the buffers in guest memory (Lock returns
pointers into them). Each buffer has timeline segments `{t0, c0, rate, loop}`; the play cursor at time t is
`c0 + (t - t0) * rate`. Every state change (Play, Stop, SetCurrentPosition, SetFrequency, SetVolume) takes effect at
`now + lead` (50 ms in the browser) and is posted with that time to the mixer; Unlock posts a copy of the written
bytes. The mixer (`recomp/host/dsmix.mjs`, linear resampling, DirectSound volume/pan in hundredths of a dB, primary
buffer volume = master) applies each change on exactly that output frame, so the cursor the game polls is the one being
played. Write cursor = play cursor + lead + 15 ms.
- Browser: `web/audio.mjs` -> `AudioWorkletNode('ds-mixer')` (`web/audio-worklet.js`, the same mixer on the audio
  thread) -> analyser -> user gain -> speakers. No SharedArrayBuffer (no COOP/COEP needed); messages only.
  Not a secure context (plain-http LAN page): the same mixer runs in a ScriptProcessorNode on the main thread.
- Clock: while the AudioContext runs, the timeline is `ctx.currentTime`; before the first gesture (autoplay policy)
  or while suspended, it is `performance.now()` so sounds still start and end for the game. On every switch all live
  buffers are re-sent (`W.ds.resync()`): measured, suspend 2 s -> resume -> "7 live buffers resent", sound continues.
- Node: no `out` = silent, the timeline is the virtual clock (same behaviour as the old stub).
  `boot_node.mjs --audio-wav f.wav [--audio-seconds N]` renders the mix offline with the same mixer.
- Page: "Sound" checkbox + volume slider (`localStorage` `hobbit.mute`, `hobbit.vol`; gain = slider^2), status line
  `sound N voices -18 dB`; `hobbit.audio.capture(sec)` -> `{rms, peak, wav}` and `hobbit.audio.rmsLog` for tests;
  `hobbit.W.ds.status()` lists the live buffers.

**DirectSound subset used by the game** (measured call counts after ~4 min in Dream World): CreateSoundBuffer 1,444,
Play 1,429, Stop 1,450, SetCurrentPosition 1,443, SetVolume 11,567, Lock/Unlock 2,913, GetCurrentPosition 10,623,
GetStatus 18,669, GetCaps 1,697, AddRef/Release, plus SetCooperativeLevel, IDirectSound8::GetCaps, primary SetFormat
once. Never called: SetPan, SetFrequency (implemented; pitch path 0067be50 flag 4), DuplicateSoundBuffer (implemented),
QueryInterface, 3D interfaces. DSCAPS reports no hardware mixing, like DirectSound on Vista+, so the game uses 16
voices (0067b470 clamps caps+0x14 to 16..64).

**What the game does with it.**
- One-shot sounds: a new buffer per play, sample + 0x2274 bytes of silence (0067bad0), Release when done.
- Streams: 0x40000-byte buffers in two 0x20000 halves, refilled (0x9000 ADPCM bytes per half) when the cursor
  leaves a half (0067b260; wrap detected when the cursor drops below the previous value). Measured: every refill was
  written into the half that was not playing (e.g. half 0 written at cursor 132,860).
- **Stereo = two mono buffers.** Streams and stereo samples are one voice per channel; the voice record holds a pan
  of -1/+1 (float at voice+0x34, gains 0.707 at +0x38/+0x3c), but the PC build's update (0067be50) clears the pan
  flag (2) without calling SetPan. The original PC game therefore plays both channels centred, and so does the port.
  A "true stereo" option would have to read voice+0x34; not done (not faithful).
- Front end: only UI sounds (two 21,108-byte voices per menu move, -14.9 dB); no music buffer is created in the menu
  in this build (the intro/menu music, if any, would be Bink audio, out of scope).

**Evidence** (`recomp/out/audio/`, gitignored): `browser_dreamworld.wav` = 8 s captured from the worklet output in Dream
World while running (48 kHz stereo; RMS 0.13-0.38 per 0.5 s, peak 1.0 with 474 clipped samples of 768,000, longest
digital silence 0.02 ms = no stream gaps), 2-14 voices playing; `node_menu.wav` = Node offline render of the boot
(the PressStart sound at 5 s, RMS 0.019). Frame rate with sound: 29 fps, heap stable at 61 MB.

Known gaps: Bink audio; no DS3D (the game does not use it); sound names are not shown (the voice -> AUDIOPKG
descriptor link is not mapped); clipping is hard (as DirectSound).

## Glitchy sound on a first visit: diagnosis, GetStatus fix, read-ahead + background prefetch (Oct 14, evening)
Report: the first seconds sounded glitchy on a first visit over Cloudflare/Tailscale. Measured in the browser pane
against `start.py --single --throttle MS:MBIT` (dev option, also `recomp/serve_game.py --throttle` / env
`HOBBIT_THROTTLE`: every data response waits MS before its headers, all bodies share MBIT; launch.json
`hobbit-throttle` 5490 = 80:20, `hobbit-throttle-slow` 5491 = 200:10, `hobbit-local` 5590 = none). Cold = Cache
Storage cleared. Test driver in the page: `hobbit.autoNewGame()` (menu -> New Game -> skip movie -> mark `runlevel`),
then `hobbit.report(20)` = the first 20 s of Dream World; `hobbit.diag()` has the raw numbers.

**Instruments.** `vfs.mjs`: every game read that has to wait (`trace`: time, file, offset, size, ms, blocks from the
network / store, thread). `dx.mjs` `DS.diag`: per 4 KB chunk of every looping buffer the lap its last write was meant
for, so replaying old data = `stale` (the game refilled too late), `torn` = writes into the chunk being played,
`short` = sounds stopped/released < 100 ms after Play, `log` = Play/Stop/SetCurrentPosition/Release/Unlock of
buffers >= 128 KB. Mixer (`dsmix.mjs`): `late` = timed commands that arrived after their frame. Chrome's
`AudioContext.playbackStats` (worklet underruns). Page: frame times (`hobbit.D.frames`, long frames).

**Findings.**
1. The audio output itself never starved: `playbackStats.underrunEvents` 0, `late` 0, `stale` 0, `torn` 0 in every run
   (cold, warm, 80 ms, 200 ms). Streams are 0x40000-byte buffers (two halves of 2 s at 32 kHz, 6 s at 11 kHz) and
   were always refilled in time; the 50 ms lead was never too short (CPU-heavy frames only delay when commands are
   issued, they are stamped `now + lead` at that moment).
2. **A port bug clipped most sounds** (also with a warm cache, worse on a cold one): state changes take effect at
   `now + 50 ms`, but `GetStatus` answered for `now`, so a buffer polled in the frame after its `Play` read "stopped"
   and the game stopped and released it after one frame (30-40 ms blips; the log showed big buffers playing 0.03 s).
   Warm: 378 of 593 plays clipped (64 %); cold 80 ms: 404 of 529 (76 %). Fix: `GetStatus` reports the state of the
   last command while it is still pending (real DirectSound applies Play/Stop at once). After: 30 of 478 (6 %) warm,
   21 of 379 cold; what is left are sounds the game itself stops early.
3. **Network round trips stalled the game.** All file reads come from the io thread (thread@00676f60) in serial
   32 KB `ReadFile` calls, and the main thread waits for that io: ~115 ms per 32 KB at 80 ms latency (0.3 MB/s).
   Cold 80:20: Dream World load 46.4 s, then in the first 20 s 52 blocking network reads (6.4 s), one 3.9 s freeze;
   200:10: load 100 s, an 8.5 s freeze in the first seconds of the level. Warm: load 1.5 s, 0 network reads.

**Fixes.**
- `dx.mjs` GetStatus (above).
- `vfs.mjs` HttpBackend: **read-ahead** for sequential reads (2, 4 .. 16 blocks = 1 MB, fetched in the background);
  **claims**: every block a reader looks up is registered in `inflight` synchronously, so the game, read-ahead and
  the prefetcher never download a block twice (measured: 1211.4 MB fetched for the 1211 MB set); bodies are read as a
  stream and each 64 KB block is handed out as soon as it is complete; `cache: 'no-store'` (the blocks live in Cache
  Storage, Chrome's HTTP cache would keep a second copy). `gameWaiting`, `onOpen`, `onStored` hooks for the prefetcher.
- `web/prefetch.mjs` (new): background download into the same Cache Storage blocks. The game comes first: while a
  game read waits, only the file it is reading is prefetched (1 request, <= 512 KB); idle: 2 requests of ~250 ms of
  transfer (256 KB-2 MB, from the measured throughput); while a level is played: 1 request then a pause as long as it
  took (prefetching at full speed cost ~10 % fps: 17.6 vs 19.2). Order: the archive the game opened last, the DFS
  headers, Dream World (still in the menu), common, boot, audio2, audio1, the next level; "everything" adds the other
  levels, small files and the first 128 KB of each Bink movie (movies are stubbed, only headers are read). Off with
  Save-Data or 2G, backs off 60 s below 64 KB/s, resumes from a one-time listing of the store (18,511 blocks in 336 ms).
  Sizes: background set 848 MB (811 MB while in the menu), everything 1,211 MB (of the 2.7 GB folder: no movies,
  logs, dlls).
- Page "Game data" panel: "Download game data in background" (default on, `localStorage hobbit.prefetch`),
  "Download everything for offline" (progress bar MB done / total; `hobbit.offline` = resume on the next visit until
  complete; asks for persistent storage), "Clear downloaded data". Test URL options: `?prefetch=0|bg|all`,
  `?readahead=N` (0 = off).

**Before / after** (80 ms + 20 Mbit, cold, first 20 s of Dream World, browser pane):

| | before (no read-ahead, no prefetch, old GetStatus) | after |
|---|---|---|
| menu reached | 25.0 s | 17.0 s |
| Dream World load (skip -> RunLevel) | 46.4 s | 16.8 s |
| blocking game reads / time waiting / from the network | 52 / 6.4 s / 52 | 23 / 2.0 s / 10 |
| longest frame | 3,863 ms | 512 ms |
| fps (pane; warm reference 21-24) | 18.6 | 20.9 |
| clipped sounds | 404 of 529 | 21 of 379 |
| worklet underruns / stale stream chunks | 0 / 0 | 0 / 0 |
| data downloaded by then | 44 MB | 110 MB (prefetch keeps going at ~5 Mbit while playing) |

Warm visit (prefetch on or off): load 1.3-1.6 s, 0-2 data requests (new sound samples only); after the full
download 0 requests. Unthrottled local server: the 848 MB background set is complete about 35 s after the page
opens, load unchanged (1.6 s). Node (`boot_node.mjs --frames 600`) unchanged: no Cache Storage, no prefetch.
