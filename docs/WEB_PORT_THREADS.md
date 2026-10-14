# Web port: threads and synchronization (Meridian.exe -> wasm in Chrome)

Static analysis only (2026-10-13). Sources: `Hobbit-RE/db/decomp_units8`, `callgraph_units8.tsv`, `auto/xrefs.tsv`,
`auto/imports.tsv`, capstone disassembly of the Reference exe (`tools/disasm_exe.py`), raw pointer scans of the
exe image. **[V]** = seen in disassembly/decomp; **[I]** = inferred. Names in quotes are ours.

## 0. Summary

- The game creates **exactly 3 extra threads** [V]: "io_mgr dispatcher", "audio dispatcher" (both via the xCore
  `x_thread` constructor 00653780 -> CreateThread) and the Bink service thread (CRT `_beginthread` 006c2b30).
  CreateThread has 2 call sites (00653780, and 006c2b30 inside `_beginthread`); 00653780 has 2 callers
  (00677060, 0067c2d0); `_beginthread` has 1 (006abc60). No `_beginthreadex`, timers (`timeSetEvent`), APCs,
  thread pools or DirectSound notify events are imported/used [V].
- **The audio dispatcher never does any work** [V]: its only producer, 0067c490 "audio_submit", has no
  references anywhere in the image (pointer scan of all sections = 0 hits). The thread parks forever on its
  first blocking receive. `00677270` (which "installs" 004fd0f0/004fd160) is an empty function: those two
  callbacks are never stored or called [V].
- DirectSound mixing is done by DirectSound itself, not by a game thread. All buffer Lock/copy/Unlock and
  play-cursor polling is on the main thread (0067b260 -> 0067a700 -> 0067b860) [V for the call chain].
- **All xCore sync funnels into one wait function**: `x_thread_wait` 006539a0 = `WaitForSingleObject(rec->sem,
  INFINITE)` on the calling thread's own semaphore, and one wake function 006539d0 = `ReleaseSemaphore`.
  Message queues, semaphores and recursive mutexes are built on top, under one global CRITICAL_SECTION
  007e86b0 [V].
- Every game thread is pinned to CPU 0 (`SetThreadAffinityMask(h,1)` in 00653600/00653780) and the workers
  run at higher priority than the main thread [V]. On the original, the game is therefore **effectively
  serialized on one core with priority preemption**. A cooperative single-threaded browser design reproduces
  this faithfully; real parallelism would *change* behaviour.

**Recommendation in one line:** no wasm threads. Run the main thread on the browser main thread with JSPI; run
each Win32 thread as a **JSPI green thread** (its own promising wasm call stack, unshared memory) scheduled
cooperatively by a tiny Win32 shim; replace file I/O, DirectSound and Bink with browser APIs (section 4).

## 1. Thread table

| # | Thread | Creator (caller) | Entry | Prio / affinity | Stack | Loop body, each iteration | Blocks on | Lifetime |
|---|---|---|---|---|---|---|---|---|
| T0 | main "AppMain" | x_thread record 00653600 (from 00653df0 <- 00653550 <- 00655430 x_Init) | WinMain | NORMAL (0), mask 1 [V] | process | whole game: frame loop 004fee90, message pump 0066f810 | see section 3 | process |
| T1 | "io_mgr dispatcher" | 00677060 io_mgr::Init (<- 004fdb90 game init) -> 00653780 | 00676f60 [V] | 2 = HIGHEST, mask 1 [V] | 0x2000 | recv request from mq 007f8730 (blocking); take device lock mq dev+0x17c; if request state==1 (new): insert in priority list, if list was empty start it; else (completion): 00680720 finish (copy, state 4/5, run request callback req+0x24, release req sema req+0x3c) then 00680890 start next; release device lock [V] | mq recv (x_thread_wait reason 5) | created at init; killed by 00677110 (<- 004fe1b0 shutdown) via 006538e0 [V] |
| T2 | "audio dispatcher" | 0067c2d0 (<- 00657e10 audio init <- 004fdb90) -> 00653780 | LAB_0067c200 (not a Ghidra function) [V] | 2 = HIGHEST, mask 1 [V] | 0x2000 | sets 00808ea4=1; recv mq 00808e40 then lock mq 00808dd8; finish current op 00808eb4 (callback +0x1c); pick head of list 00808db4, state 2; unlock [V] | mq 00808e40 recv **forever**: only sender is dead code 0067c490 [V] | created at init; its kill function 0067c380 has no references [V], dies with the process |
| T3 | Bink service | 006abc60 (<- 006ab920 movie open <- 006ab250 <- 0051e860, 0052ae30) -> `_beginthread(006abba0, 0x2000, obj)` | 006abba0 (not a Ghidra function) [V] | `SetThreadPriority(GetCurrentThread(),15)` = TIME_CRITICAL; affinity **not** set [V] | 0x2000 | `CreateEventA(0,0,0,0)` once (never signalled: a 125 ms timer); loop: EnterCS(obj+0x24); while obj+0x1c (HBINK) != 0 { BinkService(h); track max interval via timeGetTime; LeaveCS; WaitForSingleObject(event,125); EnterCS }; LeaveCS; obj+0x3c=0; CloseHandle(event) [V] | event wait 125 ms timeout | one per movie; exits when the main thread closes the movie (006abad0 sets obj+0x1c=0 under the CS) [V] |
| (T4+) | binkw32.dll / DirectSound / DirectInput / D3D8 internal threads | external DLLs | - | - | - | Bink 1.x mixes its audio into the game's IDirectSound8 (`BinkSetSoundSystem(BinkOpenDirectSound, ds8)` at 006ab855) [V]; Bink memory goes through x_malloc/x_free (`RADSetMemory(006ab7f0, 006ab810)`) [V] so DLL threads may take 007e86b0 [I] | - | disappear with the DLLs in the port |

x_thread record (0x84 bytes) [V offsets, I names]: +0x08 name[64], +0x48 thread id, +0x4c HANDLE, +0x50
semaphore (`CreateSemaphoreA(0,0,0x80,0)`), +0x58 alive, +0x5c kill-requested, +0x60 index, +0x64/+0x68
priority, +0x74..+0x7c stack info, +0x80 wait reason (5 mq-recv, 6 mq-send-full, 7 sema-acquire, 8
sema-release-full, 2 = exited). `x_thread_current` 00653c70 caches GetCurrentThreadId -> record.

## 2. Synchronization primitives and shared state

| Primitive | Address | Ops (functions) | Users / sides | Protects |
|---|---|---|---|---|
| CS "xcore big lock" | 007e86b0 (lazy init flag 007e86cc, depth 007e3570) | lock 00653cf0, unlock 00653d20 [V] | everything in xCore: x_thread, mq, sema, mutex, **x_malloc 0064ff70/0064ff90** [V]; T0, T1, T2, and Bink DLL threads via RADSetMemory [I] | thread list (007e35fc), all mq/sema/mutex state, CRT heap calls. Always released **before** a thread blocks (unlock then 006539a0) [V] |
| Per-thread semaphore | rec+0x50 | wait 006539a0 (`WaitForSingleObject INFINITE`), signal 006539d0 (`ReleaseSemaphore 1`) [V] | the only blocking primitive of xCore | wake-ups for mq/sema/mutex waiters |
| x_mq (ring of dwords + 2 waiter lists) | object | send 00655630 (flag 1 = block when full, 2 = push front), recv 00655730 (flag 1 = block when empty; param_2 = also recv from a 2nd mq) [V] | see rows below | |
| io request mq | 007f8730 | send: 00677150 (submit, T0), 00680700 (completion, T1 inside device read); recv: 00676f60 (T1) [V] | T0 -> T1, T1 -> T1 | request pointers |
| io device lock (token mq used as mutex) | device+0x17c (device = 00808f30 "PC_DVD") | recv = lock, send(0,1) = unlock: 00676f60 (T1), 00680c50 open, 00680d00 close, 00680d80 set path (T0) [V] | T0 vs T1. **T1 holds it across the synchronous fread** (00680890 -> vtable+0x18 = 00687d40) [V] | device request list (+0x1e8), free-handle list (+0x178), path (+0x48) |
| x_sema (count) | object | acquire 006559a0, release 00655a60 [V] | per-request sema req+0x3c: T0 waits (006768b0), T1 releases (00680720) [V]; IOFS cache-block sema (006762a0 acquire / 00676390 release, T0 only) [V] | read completion; cache block ownership |
| x_mutex (recursive, owner = thread rec) | object; 00655890 lock / 006558d0 unlock [V] | io_fs 007f72c0+0x1404 (006755f0, 00675840, 00675910, 00675fa0, 006761b0/f0, 00676250, 00676570, 00676660, 00676860: T0 only [I: no T1 path reaches them]); audio lock obj+0x20 via 0067be00/0067be20 (14 callers, audio mgr, T0) [V callers]; thread-manager mutex 007e35fc+0xc (00653780, 006538e0) | mount table, file handles, open streams |
| audio dispatcher mqs | 00808e40 (wake), 00808dd8 (lock token) | 0067c200 (T2), 0067c490 (dead), 0067c2d0 init [V] | T2 only in practice | op list 00808db0 |
| CS "x_files" | 007ce4e8 (init flag 007ce500) | 0064ec80 init; 0064ecc0..0064f970 (x_fopen 0064f210, x_fclose 0064f2b0, x_fread 0064f350, x_fwrite, x_fprintf, x_fflush, x_fseek, x_ftell, x_flength, hook install 0064ee70/0064ef00, log hooks 0064efa0..0064f190) [V] | T0 (all file I/O and logging). **x_fread holds it while the hook runs** (Enter 0064f381, hook call 0064f3e6, Leave 0064f407) [V], i.e. across the blocking wait for T1. T1 never takes it [V: device read uses CRT fread directly; I: no x_printf on the T1 path] | hook table 007ce504..524, open-file registry 007cd428 |
| CS audio voices | 00806ae0 | init 0067b470 (with DirectSoundCreate8), 0067b6d0 (mark voice used), 0067b700 (release voice + DS buffer), delete 0067b620 [V] | T0 only [I: T2 idle, io callbacks don't touch it] | voice table +0x78 (DS buffer) / +0x80 (active) |
| CS Bink | movie obj+0x24 | 006ab830 init, 006ab920 open (T0), 006abad0 close (T0), 006abba0 service loop (T3) [V] | T0 vs T3 | HBINK at obj+0x1c (BinkService vs BinkOpen/Close). Per-frame BinkWait/DoFrame/NextFrame/CopyToBuffer in 006abc80 run on T0 **without** the CS [V] |
| CRT locks | 006c4928/006c4957 (_lock/_unlock), 006c5508/006c56d0/006c56f9 (lock init), 006ca5f6/006ca856 (stream locks), 006bf84b `std::_Lockit` (CS 00815d08 + InterlockedExchange spin with Sleep(1)) [V] | CRT internals | heap, FILE streams, iostreams |
| Interlocked* | only CRT (006bf84b, 006c0e60, 006ca900, 006ccb1f, 006cd7d4, 006cda7f) [V: game_caller_funcs = 0] | CRT | refcounts / locale |
| Unlocked cross-thread fields | io request +0x28 state (1 new, 2 queued, 3 active, 4 done, 5 error) and +0x2c result | written by T1, polled by T0 with no lock: 00675e90 (`while state<4 Sleep(1)`), 00677990/00677a80 audio streams [V] | | |
| | stream fields +0x114/+0x108 | written by io callbacks 006773a0.. (tables 00752820/00752858, run on **T1** from 00680720) [V]; read by T0 in 0067b260 [I] | | "buffer half ready" flags |
| | device pending count dev+0x1dc | T1 writes, T0 polls via 006771b0/00680d70 [V] | | |

## 3. Main-thread waits (the critical list)

| # | Where | Waits for | How | Browser replacement |
|---|---|---|---|---|
| W1 | x_fread 0064f350 -> hook 00675700 -> IOFS read 006768b0 (cache miss) | T1 to finish the read | `00677150` submit, then `x_sema_acquire(req+0x3c, block)` -> 006539a0 INFINITE [V]. Retries with `x_sleep(1)` if state != 4; after `this+0x170` retries it spins in `x_sleep(1)` forever (hang on read error) [V] | WaitForSingleObject shim suspends T0 (JSPI) and runs T1. Reads must never fail. This is the level-load path (all DFS archive reads) |
| W2 | mount 00675910 -> 00675e90 (reads a DFS header) | request state >= 4 | `Sleep(1)` poll loop [V] | Sleep shim = yield; T1 runs meanwhile |
| W3 | x_fopen -> 00676660 -> 00680c50 device open | device lock held by T1 during a read | mq recv block [V]; then CRT `fopen`+`fseek/ftell` (00687cc0) **on T0** [V] | lock shim suspends; fopen goes to the async file backend |
| W4 | 00659c10 (audio/layer flush; <- 0052d740 Pause_Mgr::Toggle, 0040a510, 0055b420 layer_mgr::Flush) | device 0 pending == 0 | `x_sleep(10)` poll [V] | yield loop |
| W5 | 00659b70 / 00659c10 / 00659ce0 volume fades; 004fd0f0/004fd160 (dead) | wall time | `x_sleep(15)` twice [V] | setTimeout-based Sleep |
| W6 | Bink frame 006abc80 (first frame, idx < 0) | `BinkWait` == 0 | `x_sleep(1)` poll [V] | BinkWait shim driven by the video clock |
| W7 | frame limiter in 004fee90 | 33 ms frame period (const 006efbd8 = 33.0, x_time = timeGetTime ms, timeBeginPeriod(1) at 0064cb30) [V] | `Sleep(33 - elapsed)` [V] | Sleep shim; Present must also yield (below) |
| W8 | message pump 0066f810, D3D 0065f480 | - | `Sleep(0)` each frame [V] | yield point (scheduler.yield / MessageChannel, not setTimeout(0)) |
| W9 | lost device 00660da0 `Sleep(100)`, reset fail 00660f70 `Sleep(1000)`, 0065f190 `Sleep(0)` [V] | device back | Sleep | map to WebGL context-lost |
| W10 | shutdown: 006538e0 kill loop | worker state == 2 | signal + `x_sleep(1)` until the worker exits via 006539a0 -> 00653a20 -> 006539f0 ExitThread [V] | green thread exits; ExitThread shim |
| W11 | `std::_Lockit` 006bf84b first use | init race | `Sleep(1)` spin [V] | never contended cooperatively |

Not a wait: audio stream reads (00677a80 "audio_stream_mgr::ReadStream") submit and return; completion is
polled later [V]. Bink open/close only take the Bink CS (T3 holds it only during one BinkService call).

## 4. Recommended browser design per thread

Common base: **a Win32 thread shim on JSPI green threads.** Every thread (T0, T1, T2, T3) is a separate
`WebAssembly.promising` call into the same, *non-shared* wasm instance, so each has its own suspendable wasm
stack. CreateThread/_beginthread allocate an x86 stack in linear memory and a TEB (FS base: the SEH chain
FS:[0] is per thread [V: the CRT `_beginthread` wrapper 006c2ba7 and most game functions push FS:[0] frames]). Blocking imports
(`WaitForSingleObject`, `Sleep`, `EnterCriticalSection` when owned by another green thread, async file reads,
Present) are `WebAssembly.Suspending`: they save the emulated register globals (ESP, EBP, FS base, and any
other registers the recompiler keeps in globals), return a promise, and the scheduler resumes another runnable
green thread. `ReleaseSemaphore`/`SetEvent`/`LeaveCriticalSection` mark waiters runnable; if the woken thread
has a higher priority than the caller (T1/T2 = HIGHEST, T3 = TIME_CRITICAL vs T0 NORMAL), the caller yields
immediately, which reproduces single-core preemption on CPU 0. Critical sections need a real owner +
recursion count + waiter list (two are held across suspension points: 007ce4e8 by T0 and dev+0x17c by T1).

| Thread | Design | Why | What breaks with the alternatives |
|---|---|---|---|
| T0 main | Browser main thread, JSPI. Yields at: Present (await one rAF or a MessageChannel tick, so the canvas is composited), Sleep(n) (await setTimeout n / scheduler.yield for 0), and every blocking import above | The browser composites only when the task ends, so the frame loop must yield at Present even when the limiter computes Sleep(0). The limiter measures from the previous frame start (0075fb70), so time spent in the rAF wait is absorbed and the 30 fps cap holds [I] | Main loop in a Worker with OffscreenCanvas + Atomics.wait: avoids JSPI but needs `transferToImageBitmap` per frame, input/audio forwarded by SAB/postMessage, and OPFS sync handles; viable fallback, more plumbing. Asyncify instead of JSPI: works but bloats a static recompile of ~16k functions and slows every call |
| T1 io_mgr | **(b') green thread** running the original 00676f60 unchanged. Replace only the "PC_DVD" device vtable (006f9d44: open 00687cc0, read 00687d40, close 00687de0) with host functions: open = OPFS/HTTP lookup, read = async range read (OPFS `File.slice().arrayBuffer()` or `fetch` with `Range` from the local server), then call the original completion 00687da0 | Data is 1.8 GB, too big to preload into wasm memory. Replacing the device below CRT `fread` keeps CRT FILE locks out of suspension points. Keeps the request queue, priorities, cache and callbacks byte-for-byte | (a) real Worker thread + SAB: needs the whole wasm memory to be shared, COOP/COEP, and makes the main-thread W1 a real blocking wait, which is forbidden on the main thread (would need busy polling); also exposes races the single-core original never had. (b) hand-rewriting 00676f60 as a per-frame step: possible (40 lines) but W1/W2/W4 then need special "pump io inside the wait" code; the green thread gets that for free. (c) direct synchronous reads in x_fread with no io thread: loses priority ordering and the completion callbacks the audio streams rely on |
| T2 audio dispatcher | **Do not create it.** Patch 0067c2d0 to skip 00653780 (keep its mq init and globals), or let the shim create a green thread that suspends at its first wait forever (free) | It never receives work [V] | Nothing breaks either way; a real Worker would be pure waste |
| DirectSound (no game thread) | **(c) WebAudio AudioWorklet** implementing IDirectSound8 / IDirectSoundBuffer8: game PCM written by T0 Lock/Unlock into per-buffer rings in a SharedArrayBuffer (or posted via MessagePort), worklet mixes (volume, pan, frequency, loop) and publishes play cursors with Atomics | All mixing was already off-thread in DirectSound; the game only polls cursors from T0 (0067b260) | Mixing on the main thread: glitches whenever a frame or JSPI await stalls. The SAB for audio needs COOP/COEP (fine on the local server); wasm memory itself stays unshared |
| T3 Bink | **(c) replace binkw32** with a shim over pre-transcoded movies (WebM/VP9 + Opus via `<video>`, frames uploaded with `texImage2D(video)`; BinkWait from `requestVideoFrameCallback`, BinkDoFrame/NextFrame/CopyToBuffer = upload, BinkSetVolume = media volume, BinkService = no-op). Keep the game's thread code: it becomes a green thread that sleeps 125 ms between no-op services, or patch 006abc60 to not start it and set obj+0x3c = 0 | binkw32.dll is a closed DLL, not recompiled with the exe; its own audio mixing and threads disappear with it | Decoding Bink 1 in wasm (FFmpeg's bink decoder) in a Worker: exact frames but more work, and Bink audio would need its own worklet path. Transcoding loses nothing visible for FMV |

## 5. Timing-dependent behaviour and risks

1. **Single-core serialization is the real contract** [V: affinity mask 1 on T0/T1/T2]. Wake-ups of T1 by T0
   preempt T0 at once. The shim must yield after waking a higher-priority thread; otherwise T0 keeps running
   past `00677150` and request ordering can differ (only matters for code that polls state without waiting).
2. **T3 is not pinned** [V], so on the PC BinkService ran truly in parallel with T0's BinkDoFrame/CopyToBuffer
   (no lock on that path). The shim removes this race.
3. **Read errors hang the game** (W1 retry exhaustion spins forever) [V]. The async backend must retry
   internally and never report a failed read to 00687da0 unless the file is genuinely missing.
4. **Audio streams depend on completion latency** [I]: 00677a80 double-buffers (half flags +0x114, 0x9000-byte
   halves in 0067a700 [V]). If an async read takes longer than half a buffer of audio, music/speech stutters
   ("Stream %x should be done" message in 0067b260). Prefetch stream files (OPFS) and give T1 priority over T0
   in the scheduler.
5. **Unlocked polled fields** (request +0x28, stream +0x114/+0x108, dev+0x1dc) are safe under cooperative
   scheduling; they would need `Atomics` loads if T1 ever became a real thread.
6. **Frame pacing**: 30 fps cap from Sleep(33 - elapsed) [V constant]. Browser timers clamp nested
   setTimeout to >= 4 ms and throttle background tabs to 1 s; use `scheduler.postTask`/MessageChannel for
   short sleeps and pause the game on `visibilitychange`. Game logic that integrates real elapsed time keeps
   working; logic that assumes Sleep(1) ~ 1 ms (W2, W6) only gets slower, not wrong.
7. **x_time** = `timeGetTime` with a monotonic clamp (0064cb70) [V]: back it with `performance.now()` as an
   integer ms counter; never let it go backwards across suspensions.
8. **Fades with `x_sleep(15)`** (W5) block T0 for 30 ms each; with JSPI they become real waits, same as PC.
9. **Shared register globals**: if the recompiler keeps x86 registers or the FPU stack/control word in wasm
   globals, *every* suspension must save/restore them per green thread (the FPU control word is per thread on
   Windows: T0 sets `_controlfp(_PC_53)` after CreateDevice, workers keep the default).
10. **Locks held across suspension**: 007ce4e8 (T0, during x_fread) and dev+0x17c (T1, during a read). Any
    future code path where T1 logs through x_printf (takes 007ce4e8) while T0 is inside x_fread would
    deadlock; it would also have deadlocked on the PC, so none should exist [I].
11. Shutdown: T2 is never killed (0067c380 unreferenced) and T3 exits on its own; the shim must let the page
    unload with suspended green threads (just drop the promises).

## 6. Open checks (cheap, static)

- Confirm no T1-reachable function calls x_printf/x_fread (closure of 00676f60's callees, including request
  callbacks in 00752820/00752858 and any other `req+0x24` producers).
- List every `006806b0` caller to enumerate all request callbacks (only 006768b0, 00675e90, 0067a940 seen).
- Check that nothing besides 0067b260 reads the stream half flags, and that BinkPause gate 00813180 (006abb20)
  is main-thread only.
