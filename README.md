# Hobbit Web

**The Hobbit (2003, PC) running in Chrome.** It's the original game code, not a remake: `Meridian.exe` is translated
instruction by instruction into WebAssembly. Windows, DirectX 8, DirectInput and DirectSound are replaced by
browser code (WebGL2, keyboard events, Web Audio).

Status (Oct 14, 2026): boots through the legal screen and main menu into **Dream World, and Bilbo is playable**.
No sound yet, movies are black, and C++ exceptions can't resume yet, so expect crashes past the first area.

> You need your **own installed copy** of the game. This repo contains no game files and no translated game code;
> both are produced locally from your copy. Keep the repo private.

## Play

Requirements: **Python 3.10+**, **Chrome or Edge 137+** (it uses WebAssembly JSPI), ~1 GB free disk for the build.
Node.js is optional.

```
python start.py --game "D:\Games\The Hobbit"      # first run: the folder that contains Meridian.exe
python start.py                                   # later runs remember the folder
```
On Windows you can double-click `start.bat` instead; on the first run, pass the folder: `start.bat "D:\Games\The Hobbit"`.

The first run takes a few minutes. It sets up `.venv` (capstone, pefile) and downloads wasi-sdk 34, which is clang for
WebAssembly (~120 MB, into `tools/`). Then it translates the exe to C and compiles `recomp/out/hobbit_flat.wasm`
(38 MB). After that it starts two local servers and opens the game:

| Server | What it serves |
|---|---|
| `127.0.0.1:5190` | this folder (the page + wasm) |
| `127.0.0.1:5191` | your game folder, **read-only**, with HTTP Range reads (nothing is copied or written) |

Controls are the game's defaults: arrow keys move, Space jumps, Enter selects in menus. Click the canvas first to give
it focus. Options: `--rebuild`, `--port N`, `--no-browser`.

Verified game version: Meridian.exe md5 `3e351efeea5c7e1eb55095d8f5b12fab` (retail PC). Other versions will warn,
because the translation tables in `auto/` describe this exact binary.

## How it works

```
Meridian.exe ──recomp/cfg.py + x86c.py──> C (one function per x86 function; registers, flags, stack, x87 emulated exactly)
             ──wasi-sdk clang──────────> hobbit_flat.wasm (exe image mapped at 0x400000 in wasm memory)
browser: web/game.mjs ── recomp/host/*.mjs   Win32 shims, PE loader, green threads, SEH, file system over HTTP
                      └─ web/d3d8/*.js      Direct3D 8 fixed-function -> WebGL2 (COM vtables live in wasm memory)
```
- Indirect calls and jumps (vtables, switch tables) go through an address → function table.
- The game's own loops yield to the browser through JSPI at three points: page flip, input pump and `Sleep`. It is capped at 30 fps.
- The game's 3 threads (all pinned to one CPU in the original) run as cooperative green threads.

**Correctness:** each translated function was checked against 22,227 calls recorded from the real game (registers,
memory writes, return values). All 22,227 match. Deliberate sabotage of the translation is caught, so the check is real.

Docs: `docs/RECOMP.md` (translator), `docs/RECOMP_BOOT.md` (boot, host layer, run options),
`docs/WEB_PORT_LOOPS.md`, `docs/WEB_PORT_THREADS.md`, `docs/WEB_PORT_D3D8.md`, `docs/D3DREC.md` (D3D8 call recorder).

## Layout

| Path | What |
|---|---|
| `start.py`, `start.bat` | launcher (setup, build, servers) |
| `recomp/` | translator (`cfg.py`, `x86c.py`), `build.py`, C runtime, JS host layer, headless Node runner `boot_node.mjs`, capsule harness |
| `web/` | `game.html` / `game.mjs` (the game page), `d3d8/` (Direct3D 8 on WebGL2 + its self-test `d3d8/test.html`) |
| `auto/` | function boundaries, ABI table and cross-references for this exact exe (from the Ghidra analysis) |
| `d3drec/` | proxy `d3d8.dll` that records the original game's D3D calls + a Chrome replayer that diffs the frames |

Headless run (no browser): `node --experimental-wasm-jspi recomp/boot_node.mjs --frames 4000`. Set `HOBBIT_GAME_DIR`
and `HOBBIT_EXE`, or use the default sibling paths.

## Not done yet
- Sound: DirectSound → Web Audio.
- Bink movies: they play black for their real length.
- Resuming C++ exceptions.
- Saving settings in the browser.
- Testing beyond Dream World.
