# Web port: blocking loops and browser yield points (2026-10-13)

Scope: every loop in `Meridian.exe` that can run longer than one frame without returning to the
MAIN LOOP of GameMain 004fd7c0, how each one paces itself, and where the wasm build must yield to the
browser (JSPI). Static analysis only. Addresses are from the Reference exe; names by address.
[V] = seen in the disassembly or the decompiled C (`Hobbit-RE/db/decomp_units8`), [I] = inferred.

Method: loops = backward branches inside each units8 function (capstone). A loop "pumps" when a direct
call in its body reaches `Sys_PumpMessagesAndPollInput` 0066f810 transitively (`callgraph_units8.tsv`, 24
functions reach it, 12 call it directly). It "presents" when the body reaches `eng_PageFlip` 0065f480 (the only
caller of `IDirect3DDevice8::Present`; see 1). Also checked every importer of Sleep, WaitForSingleObject,
PeekMessageA/GetMessageA and timeGetTime, and scanned all functions for call-free spin loops on globals (none found).
Indirect (vtable) calls inside loop bodies were not followed. The results agree with the call lists in RUNTIME_INIT.md.

## 1. The two frame primitives [V]
- **Pump** `0066f810`: `Sleep(0)`; if `007f23a8 == 0`: `while PeekMessageA(PM_NOREMOVE) { GetMessageA (0 => 007f239c = 1, return 0);
  TranslateMessage; DispatchMessageA -> WndProc 0065d860 }`; `0066f940`; keyboard 0066fa10+006603b0 over 007f1644[007f1638],
  mouse 0066fb60 over 007f16c4[007f163c]; joysticks 0066fc30 over 007f1744[007f1640] (always). It returns `007f23a4`
  (cleared on entry and set by the input code 0066f780/0066fb30/006701f0). So **non-zero = an input event this frame, not
  "quit"**: Game_ProcessInput 004ff0a0 returns 1 early when it is 0 [V]. The old notes' "0 = quit" reading is wrong. Quit is
  `006628b0` (checked at the top of Game_LevelLoop and FrontEnd_Mgr::Update), and GetMessage returning 0 sets 007f239c.
- **PageFlip** `0065f480` = eng_PageFlip: if `007eff74 == 0` (device not ready) -> `Sleep(0)`, return (no Present).
  Otherwise, if no scene is open, BeginScene through 0065f190; then the 2D/text flush (0067d640/0067d1e0), the FPS overlay, and
  **EndScene** `call [ecx+0x8c]` at 0065F5D9; **Present** `call [ecx+0x3c]` at **0065F624**, only if `007eff70 != 0`
  (0065b910, the window is visible); then 00671320, frame statistics 0065f670 (timeGetTime ring), and the stopwatches.
  `007f00a8 >= 2` (multiple viewports) goes to 0065f730, which presents itself (`call [..+0x3c]`). Every render loop in the game
  calls 0065f480 directly (15 call sites, table 2). 0065fd10/006606a0 call another interface's slot 0x3c (not the device).
- BeginScene 0065f190: `TestCooperativeLevel`; on D3DERR_DEVICELOST -> 00660da0 (`Sleep(100)` per call while lost);
  on DEVICENOTRESET -> Reset, or `Sleep(0)` if Reset fails; 00660f70 (OnUserReset) runs `Sleep(1000)` when Reset fails. These are
  per-frame sleeps, not loops; in the browser the device is never lost (only WebGL context loss) [V code / I browser].

## 2. Loop table
"Pump" = calls 0066f810 on every iteration (Game_ProcessInput: if the pump returns non-zero it goes on to BeginScene/the input
handling, 004ff0a0). "Present" = calls 0065f480 on every iteration. None of these loops sleeps except
Game_LevelLoop. Without vsync they would busy-run; the original relied on D3D fullscreen vsync (presentation interval not set:
0 = DEFAULT, no writes to 007f0478 found [I]).

| # | Loop (function, loop range) | What | Caller chain | Pump | Present | Wait | Yield point | Conf |
|---|---|---|---|---|---|---|---|---|
| 1 | GameMain 004fd7c0, 004fd978-004fdb60 | MAIN LOOP: FE -> LoadLevel -> Game_LevelLoop -> teardown 004fedc0 | WinMain 004fd630 -> AppMain 004fd670 | via children | via children | none | none (children yield) | V |
| 2 | LegalScreen 004fb310, 004fb4c6-004fb6b0 | legal splash, 5.0 s (006e92f4) on its own stopwatch (0064cd90) | GameMain | **only after 2.0 s** (006e999c), at 004fb643 | yes, 004fb628 | busy | PageFlip 004fb628 | V |
| 3 | PlayMovie 0052ae30, 0052aed0-0052aef4 | waits for keys 0x5d and 0xb9 to be released before the movie | see 4 | yes, 0052aed0 | **no** | busy | Pump 0052aed0 | V |
| 4 | PlayMovie 0052ae30, 0052afd1-0052b08b | Bink movie (0052ade0 = done/skip), FrontEnd_Mgr::Update 0052b560 inside | GameMain (VUGlogo, Sierra, FizzBumper, Inevitable, intro_6-2); FrontEnd_Mgr::Update 0052b560; level vtables 0040a510 (PageTurn_13, Smaug) and 00513ea0 (Narrator PageTurns, intro_6-2), i.e. **inside Game_LevelLoop -> Game_RunLogic 004ff9f0 -> level vtbl** | yes, 0052aff4 | yes, 0052b07c | Bink frame: 006ab2e0 -> 006abc80 `while BinkWait() Sleep(1)` (006abcaa) until the first frame is decoded | PageFlip 0052b07c (+ Sleep, see 4) | V |
| 5 | MoviePlaceholder 0052b120, 0052b206-0052b2d8 | "XXX MOVIE HERE" text for param_3 s (5 s), when a movie fails | GameMain, 0052b560 | only if param_2 (skippable), 0052b271 | yes, 0052b263 | busy | PageFlip 0052b263 | V |
| 6 | RunFrontEnd 004fe3e0, 004fe468-004fe4bb | front end: FrontEnd_Mgr::Update 0052b560, UI 006a0490/006a1120 | GameMain | yes, 004fe486 | yes, 004fe4aa | busy (vsync); audio/music updated with **fixed dt 0.033366702** per frame | PageFlip 004fe4aa | V |
| 7 | PressStart 0051e860, outer 0051e8f0-0051ea3b, inner 0051e986-0051ea1f | "press start" screen looping the movie "New_intro_final" | RunFrontEnd -> 0052b560 (state 1) | yes, 0051e9df / 0051ea7a | yes, 0051ea0e / 0051ea93 | Bink as in 4 | PageFlip | V |
| 8 | LevelSelect 004fc380, 004fc3d7-004fc3fb | key-release wait (keys 0x5d, 0xb9) | RunFrontEnd -> 0052b560 (state 7, "LevelList.txt") | yes, 004fc3d7 | **no** | busy | Pump 004fc3d7 | V |
| 9 | LevelSelect 004fc380, 004fc6e0-004fc6f3 | "Select Level" menu: render 004fc090 + input 004fc850 | same | yes, 004fc852 | yes (in 004fc090) | busy | PageFlip in 004fc090 | V |
| 10 | DemoEnd 0052c080, 0052c146-0052c69f | "Thank you for playing this Demo" | 0052b560 | yes, 0052c4a7 | yes, 0052c696 | busy | PageFlip 0052c696 | V |
| 11 | Game_LevelLoop 004fee90, 004feec4-004ff077 | gameplay frame (section 3) | GameMain | yes, Game_ProcessInput 004ff0a0 -> 004ff0b9 | yes, Game_Render 004ff4d0 -> 004ff844; skipped when 00760358 != 0 | **Sleep frame limiter** at 004fef36 | PageFlip 004ff844 (+ Sleep 004fef36, section 3) | V |
| 12 | SystemMenu 00500740, 005007d0-005007e1 | dev "System Menu" (speed, screenshot size; "Press ~ again to return") while 0076200c | Game_LevelLoop when 0075fb98 != 0 (set by 004ff0a0 and 0051a240) | yes, 00500801 | yes (render 005005d0) | busy | PageFlip in 005005d0 | V |
| 13 | TextureViewer 00502dc0, 00502e40-00502e51 | dev texture browser ("Viewing %d of %d") while 00762504 | 00502280 (no static caller, dev) | yes, 00503201 | yes (render 00502e60) | busy | PageFlip in 00502e60 | V |
| 14 | LoadLevel 004fe5a0 + layer_mgr loaders | level load; no frame loop. LoadScreen__Render 004f9d20 renders + presents (004fa21c) **at most every 0.5 s** (006efa68, its own timeGetTime clock) while 0075f8c8 != 0 | GameMain; 004f9d20 called at 004fe5d2, 004febf4, 004fec08 and from loops in layer_mgr__LoadResourcesFromFile 00559b70 (00559cbb), layer_mgr__LoadObjects 0055a400 (0055a4cc, 0055a5bc), layer_mgr__Flush 0055b420 (0055b923) | **no** (one pump at 004febef just before SingleStep(1/30)) | about 2 Hz | synchronous file reads (section 4) | PageFlip 004fa21c; reads (section 4) | V |
| 15 | hud__BlackOutScreen 004f8fb0, 004f8fc0-004f905e | clears both buffers: exactly 2 iterations, 2 Presents | Game_LevelLoop, level teardown 004fedc0, Game_Render, 0051e860, 0052b560, vtable 0050c5f0 | no | yes, 004f9058 | none | PageFlip (costs 2 frames) | V |
| 16 | logic_mgr__Execute 00557890, 00557930-005579d3 (+ re-step 005579b6-005579c5 while 00798548) | sub-steps inside one frame | Game_RunLogic | no | no | none, bounded | none | V |
| 17 | Shutdown 004fe1b0 | no loop, but xthread kill 006538e0 spins `ReleaseSemaphore; Sleep(1)` until the thread state (+0x80) == 2; ends in `exit(0)` in eng_Kill 0065c0d0 | GameMain | no | no | thread join (section 5) | none needed: stop the page loop | V |
| 18 | Fatal paths | eng_Fatal 0065d0f0: `MessageBoxA("... The application will now exit")` then `exit(1)`; x_assert 0064e5e0 -> 0064e630 -> 0064e610 `MessageBoxA("ERROR")`, then returns 1. The top-level filter 0065ea60 only logs | init code (0065cd80, 0065de70, 0065e0a0, 0065e490, 0065f0c0) | no | no | modal MessageBox | no yield: show a DOM overlay and stop (exit) | V |
| 19 | Pause / in-game menus, save/load | no own loop found: Pause_Mgr (0052c8c0, Toggle 0052d740) runs inside Game_LevelLoop frames (`007600f4` pauses logic only) | Game_LevelLoop | via #11 | via #11 | 0052d740 -> 00659c10 (section 5) | none | V for pause; save/load I (not traced separately; vtable bodies not followed) |
| 20 | Bink service thread 006abba0, 006abbf5-006abc38 | `SetThreadPriority(15)`; `while (bink+0x1c) { BinkService; WaitForSingleObject(event, 125 ms) }` | `_beginthread` from 006abc60 | n/a (thread) | n/a | 125 ms timed wait | browser: call BinkService from the frame yield or a timer | V |

Not loops but worth knowing: the PageFlip `Sleep(0)` path (007eff74 == 0, e.g. minimized) and BeginScene failure both make a
render loop iterate with **no Present**, so only the pump runs. The yield rule below covers this.

## 3. Frame limiter and timing [V]
- **Clock**: all game time comes from `timeGetTime` (WINMM; `timeBeginPeriod(1)` in 0064cb30). No QueryPerformanceCounter or GetTickCount.
  `0064cb70` = monotonic ms (clamped against 007cd000); the 64-bit stopwatch keeps EDX = 0 (0064cb7c `xor edx,edx`).
  Ticks per second = 1000 (0064cba0); 0064cbc0 = ms * 0.001 (s). Stopwatch struct (0x18): start64, accum64, running, laps.
  0064cbe0 = init, 0064cc00 = start, 0064cc30 = reset/stop, 0064cd30 = elapsed ms (x87 fild), 0064ce40 = **lap** (returns elapsed
  ms and restarts), 0064cd90 = elapsed s.
- **Game_LevelLoop limiter**: `e = elapsed(g_FrameTimer 0075fb70); if (33.0 - e > 0.0) Sleep(__ftol(33.0 - e))` (006efbd8 = 33.0f,
  006e92e4 = 0.0f; the Sleep at 004fef36 goes through the register loaded at 004feebe); then `0075fb68 = lap(g_FrameTimer)`
  (frame ms, read only by the debug registration 004fca90). So the original caps gameplay at about 30 Hz and renders at the same rate.
  The front end, movies and splash screens have **no limiter** (vsync only).
- **logic_mgr__Execute 00557890** (this = 00771d78): `dt_ms = lap(this+8) * timescale(+4)` (timescale from 00557850 via 007607f0: 1.0,
  or 30.0 for the dev fast-forward key 0xdb); `dt_ms = min(dt_ms, max_frame +0x30 = 100)`; **if dt_ms > remainder_min (+0x28 = 10)**:
  repeat { `s = min(left, max_step +0x2c = 128)`; SingleStep(s * 0.001) (006e9350); left -= s } while left > 10.
  The leftover (<= 10 ms) is **discarded** and the lap already restarted the clock, so:
  * frames shorter than 10 ms advance the game by **0**: at 100+ Hz with no limiter the game freezes or crawls;
  * frames longer than 100 ms are clamped, so the game runs in slow motion (a background tab, long hitches);
  * between those two limits the speed is correct at any rate (variable dt, 1 step per frame because 100 < 128).
- **Browser mapping**:
  1. `timeGetTime()` -> `(uint32)Math.floor(performance.now() + bias)`; `timeBeginPeriod`/`timeEndPeriod` = no-ops.
     Keep integer ms (the original resolution).
  2. The frame yield (section 6) waits for `requestAnimationFrame` until **both** `now >= sleepDeadline` and
     `now - lastFrame >= 33 - 2` ms (2 ms of slack, so that at 60 Hz this lands on every second vsync = 33.3 ms instead of
     slipping to 50 ms). Use the same 30 Hz cap everywhere: it matches the limiter constant 33.0 and the front end's fixed dt
     1/29.97 that it feeds to the audio mgr 00658330 and music 00532ff0 (at 60 Hz, front-end audio timers would run twice as fast [I]).
     Bink movies and the legal/placeholder screens are wall-clock based, so 30 Hz is safe for them (movies of 30 fps or less [I]).
  3. Main-thread `Sleep(n>0)` -> set `sleepDeadline = now + n` and return without blocking. The limiter is the only main-thread
     Sleep inside a frame loop. Because Sleep now runs before the frame's work instead of pausing it, the period stays
     max(33 ms, work time) rounded up to a vsync. `Sleep(0)` = no-op.
  4. Hidden tab: rAF stops, so the game pauses (like minimized). The first frame back is clamped to 100 ms, which is harmless.
  5. Never let the yield return sooner than 10 ms after the previous one, even if the cap above changes (logic would stall).

## 4. Waits on other threads (for the threads agent)
| Where | Waits for | How | Called from (main thread?) | Conf |
|---|---|---|---|---|
| io_fs sync read 00675e90 | io dispatcher sets the request status (+0x28 in the 0x1ac request) to >= 4 | `while (status < 4) Sleep(1)` (00675f42) after enqueue 00677150 | io_fs__MountFileSystem 00675910 (EngineInit x6, LoadLevel `<level>.DFS`) - main | V |
| io_fs::Read cache miss 006768b0 | io dispatcher completion | enqueue 00677150, then **semaphore receive 006559a0(..,1) -> 006539a0 WaitForSingleObject(INFINITE)**; retry with xthread Sleep(1) 00676bc2; past the retry limit (this+0x170) **infinite `Sleep(1)` loop** 00676b34 (hang on I/O error) | every file read through io_fs (vtable 00675725) - main, during load and streaming | V |
| io request enqueue 00677150 -> mq send 00655630 | queue space | blocks in 006539a0 when the queue is full (flag 1) | main | V |
| audio resume 00659c10 | io_mgr has no pending requests (006771b0(0)) | `while (pending) Sleep(10)` (00659c25), then 2x Sleep(15) | Pause_Mgr__Toggle 0052d740, layer_mgr__Flush 0055b420, 0040a510 (PageTurn) - main | V |
| audio pause/stop 00659b70, 00659ce0 | nothing (fixed delays) | 2x xthread Sleep(15) | 0040a510, layer_mgr__Flush, GameMain 004fda53, LoadLevel 004fe5ef, KillCoreSystems 004fe3c2, 00590190, audio kill 00657f10 - main | V |
| Bink frame 006abc80 | Bink decode/IO of the first frame | `while (BinkWait()) Sleep(1)` (006abcaa) | movie loops #4, #7 - main | V |
| Bink service thread 006abba0 | event or 125 ms timeout | WaitForSingleObject(event, 0x7d) | own thread | V |
| xthread kill 006538e0 | target thread reports state 2 | `ReleaseSemaphore; Sleep(1)` loop | shutdown: 00653590, audio 00657f10, io kill 00677110, 0067b620, 0067c380 - main | V |
| generic xthread blocking 00655630 / 00655730 / 006559a0 / 00655a60 | mq send / receive, semaphore down / up | all funnel into **006539a0 = WaitForSingleObject(sem +0x50, INFINITE)**, the only WaitForSingleObject site in game code | io dispatcher body 00676f60 and audio thread 0067c490 block in receive 00655730 (thread side); main side as above | V |
| audio mgr update 00658330 | audio thread | critical section 0067be00/0067be20 (Enter/LeaveCriticalSection) | main, every frame | V |
| 00677240 | nothing | `for (;;) xthread Sleep(50)` | no static caller (thread entry or dead) | I |
| CRT 006bf84b (std::_Lockit) | lock init | Sleep spin | CRT, replaced by the modern runtime | V |
| 004fd0f0 / 004fd160 | (would pause and resume the game around disc access with Sleep(60)) | | registered through 00677270, which is an **empty stub** on PC, so dead | V |

Single-threaded wasm: every main-thread wait above must either complete synchronously (an inline io dispatcher reading from
preloaded or OPFS-sync files, a Bink frame decoded on demand) or loop through the JSPI `Sleep` so that the JS side (a worker or a
fetch) can finish the request. With the deadline-Sleep of section 3 it must then be: `Sleep(n)` blocks (awaits) **only when called
outside the limiter call site 004fef36**, or when a "waiting on I/O" flag is set by the io layer.

## 5. Minimal JSPI yield set
Three suspending imports make every loop in table 2 browser-safe:
1. **`host_frame()` at the end of `eng_PageFlip` 0065f480** (all return paths, including the `007eff74 == 0` and failed-BeginScene
   exits; it covers 0065f730 and both Present sites). It awaits rAF under the section 3 rules and sets `presentedSinceLastPump = 1`.
   This covers loops 2, 4-7, 9-15.
2. **`Sys_PumpMessagesAndPollInput` 0066f810**: drop `Sleep(0)`; if `presentedSinceLastPump == 0`, await one rAF tick
   (with the same 10 ms floor); then clear the flag, drain the browser event queue into the Win32 message queue and WndProc
   0065d860 (**dispatched from wasm, not from a JS callback**), and copy key/mouse/gamepad state into the device tables
   007f1644/007f16c4/007f1744. This covers the pump-only loops 3 and 8 and the no-Present iterations. In loops that also present,
   the pump never waits twice in one frame.
3. **kernel32 `Sleep`** (IAT 006e91c4; also reached through the xthread wrapper 00653be0/00653c00): the deadline for the limiter
   site 004fef36; an awaited timeout (`setTimeout(n)`, at least 1 ms) at the thread-wait sites of section 4 if those are emulated
   asynchronously. If the io and Bink waits are made synchronous, item 3 reduces to the deadline only and needs no suspension.
   (WaitForSingleObject 006539a0 joins this set only if threads are emulated cooperatively on one stack. The threads agent decides.)

JSPI constraints [I]: the whole game runs under one `WebAssembly.promising(WinMain)` call. Between that export and the suspending
import there may be only wasm frames. Vtable calls (call_indirect) are fine, but D3D8/DirectInput/DirectSound shims must not call
back into wasm from JS on a path that can reach 0065f480 or 0066f810 (a WndProc callback, for example). The movie loop #4 suspends
deep inside Game_RunLogic -> level vtable (0040a510, 00513ea0), so the suspendable stack must hold the full game stack (stack
switching in V8 grows these stacks; check the size limit).

## 6. Evidence pointers
Pump body 0066f810, limiter 004fee90, PageFlip disassembly 0065F5D9 (EndScene)/0065F624 (Present), stopwatch disassembly
0064cb70-0064cbdf / 0064cd30, Execute 00557930-005579d3, constants 006efbd8 = 33.0f, 006e9350 = 0.001f, 006efa68 = 0.5,
006e92f4 = 5.0f, 006e999c = 2.0f, Bink thread disassembly 006abba0-006abc5a. Call-site addresses are from `auto/xrefs.tsv` (CALL rows).
Loop scan scripts: scratchpad only (not kept). Re-derive them with capstone over `callgraph_units8.tsv` function starts.
