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
| `recomp/host/dx.mjs` | DirectInput8 + DirectSound8 host COM objects; D3D8 via `web/d3d8/com.js` ComBridge; `nullGL()` for Node |
| `recomp/host/vfs.mjs`, `node_fs.mjs` | path mapping (`C:\HOBBIT` = game folder read-only, `C:\APPDATA` = settings), Node fs backend, HTTP Range backend (64 KB block cache), memory backend |
| `recomp/boot_node.mjs` | headless runner; writes `recomp/out/boot/{boot.log, summary.json, files.txt, entered.txt}` |
| `recomp/serve_game.py` | read-only Range + CORS server for the game folder on 127.0.0.1:5191, `/__manifest` (launch.json `hobbit-game-data`) |
| `web/game.html`, `web/game.mjs` | Chrome page (served by `hobbit-web`, port 5190): JSPI, real d3d8.js device on the canvas, keyboard/mouse -> DirectInput, `?snap=20,90` keeps frames as images |
| `web/d3d8/com.js` | fixed: full stdcall argument table (IDirect3D8::GetDeviceCaps = 3 args, surface LockRect/UnlockRect = 3/0), GetDirect3D / GetDisplayMode / GetCreationParameters (used by D3DX8), GeForce-class D3DCAPS8 (HW T&L, all blend/compare caps) |

Run:
```
python recomp/build.py --flat
node --experimental-wasm-jspi recomp/boot_node.mjs --frames 4000      # Node 24 needs the JSPI flag
python recomp/serve_game.py      &  python -m http.server 5190 --bind 127.0.0.1 --directory Hobbit-Decomp
-> http://127.0.0.1:5190/web/game.html          (Chrome 137+: JSPI on by default; no Asyncify fallback)
```
Runner options: `--frames N`, `--seconds S`, `--trace N` (log the first N host calls), `--keys frame:DIK[:len],...`,
`--vis-reset <addr>` (functions entered after a milestone), `--peek addr,...`.

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
2. DirectSound -> WebAudio (buffers exist in guest memory, play cursors follow the clock; nothing is audible).
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
