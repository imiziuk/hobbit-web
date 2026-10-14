# Hobbit Web

**The Hobbit (2003, PC) running in Chrome.** It's the original game code, not a remake: `Meridian.exe` is translated
instruction by instruction into WebAssembly. Windows, DirectX 8, DirectInput and DirectSound are replaced by
browser code (WebGL2, keyboard events, Web Audio).

Status (Oct 14, 2026): boots through the legal screen and main menu into **Dream World, and Bilbo is playable**.
Sound works (effects, voices, ambience and music through Web Audio; it starts on your first click or key press,
volume slider + Sound checkbox above the game). Movies are black and silent, and C++ exceptions can't resume yet, so expect crashes past the first area.

> You need your **own installed copy** of the game. This repo contains no game files and no translated game code;
> both are produced locally from your copy. Keep the repo private.

## Play

Requirements: **Python 3.10+**, **Chrome or Edge 137+** (it uses WebAssembly JSPI), ~1 GB free disk for the build.
Node.js is optional.

```
python start.py
```
On Windows you can also double-click `start.bat`.

**Finding your game folder:** the first run looks for it in this order, then remembers the answer in `config.json`
(gitignored, so every developer keeps their own path):
1. `--game "<folder>"`, if you pass it;
2. the folder saved in `config.json`, if it still contains the game;
3. the `HOBBIT_GAME_DIR` environment variable;
4. a `game/` folder inside or next to the repo (a copy, or a link: `mklink /J game "D:\Games\The Hobbit"`);
5. the Windows uninstall registry (where the installer put it);
6. the usual install folders on drives C: to H: (`Program Files (x86)\Sierra\The Hobbit` and similar), plus folders
   named like "hobbit" in Downloads, Games, Desktop and Documents;
7. otherwise it lists what it found, or asks you to type the path.

A folder counts as the game if it has `Meridian.exe` and `common.DFS`. Use `python start.py --find` to search again,
or `--game` to point it somewhere else.

The first run takes a few minutes. It sets up `.venv` (capstone, pefile) and downloads wasi-sdk 34, which is clang for
WebAssembly (~120 MB, into `tools/`). Then it translates the exe to C and compiles `recomp/out/hobbit_flat.wasm`
(38 MB). After that it starts two local servers and opens the game:

| Server | What it serves |
|---|---|
| `127.0.0.1:5190` | this folder (the page + wasm) |
| `127.0.0.1:5191` | your game folder, **read-only**, with HTTP Range reads (nothing is copied or written) |

Click the canvas first to give it keyboard focus. Options: `--rebuild`, `--port N`, `--no-browser`.

`--single` puts everything on **one port** instead: the page at `/`, the game folder at `/data/`, the multiplayer relay
at `/relay` (WebSocket). The page finds out by itself (it asks `/__mode`). This is the default in Docker and what a
login proxy such as Cloudflare Access needs, because one login then covers everything.

**Traffic:** the wasm is sent gzip-compressed (34.7 MB -> 6.3 MB; `recomp/out/hobbit_flat.wasm.gz` is made once per
build), every file is revalidated with an ETag, and the game data blocks the browser has read are kept in its Cache
Storage (secure pages only: `https://` or `127.0.0.1` / `localhost`). Measured (Chrome, single-origin server):

| | first visit | next visits |
|---|---|---|
| to the main menu | 170 requests, 20.3 MB | 14 requests, 7 KB |
| into Dream World | ~580 requests, ~49 MB | 14 requests, 7 KB (0 game-data requests) |

To free the space: DevTools > Application > Storage > Clear site data (the cache is called `hobbit-data-v1`).

### Controls

**Keyboard and mouse:** the game's PC defaults. Arrows or W/S move, A/D strafe, Space jumps, Enter is Use and also skips
movies and cutscenes, and Esc pauses. The mouse works in every menu: hover, then click.

**Gamepad:** any controller Chrome recognises (Xbox, PlayStation, Switch Pro, ...). Plug it in and press a button. It reaches the
game as a DirectInput joystick, so the game's own *Options → Controls → Gamepad* screen can rebind it.

| Button | In game | In menus |
|---|---|---|
| Left stick | Move | Navigate |
| Right stick | Camera | |
| A | Jump | Accept |
| X | Attack | |
| B | Crouch | Back |
| Y | Use | Accept |
| LB / RB | Equip Ring / Target | |
| Back (View) | Toggle view | |
| Start | Pause | Skip movie / cutscene |
| D-pad | Walking-stick (left), Stones (up), Sword (right) | Navigate |

### Phone (Android)

The game runs in **Chrome 137+ on Android** with on-screen touch controls. The game still runs on your PC's
servers; the phone only opens the page.

1. Make the page reachable from the phone: `python start.py --lan` (same Wi-Fi, or Tailscale on both), or use the
   Docker + Tailscale setup below (HTTPS, works from anywhere on your tailnet).
2. On the phone, open `http://<PC address>:5190/web/game.html` (or the `https://hobbit-web.…ts.net/web/game.html` address).
3. Tap **Fullscreen** and turn the phone sideways. The first load downloads the 35 MB wasm, so use Wi-Fi.

**Phone controls** switch on by themselves on a touch screen. The checkbox in the top-left corner turns them on or
off (it is remembered), and `?touch=1` or `?touch=0` in the address forces it. They act as a virtual gamepad, so the
buttons do what the gamepad table above says:

| On screen | In game | In menus |
|---|---|---|
| Left half: touch and drag | Move (a joystick appears under your thumb) | |
| Right half: touch and drag | Camera | |
| A / B / X / Y (labelled) | Jump / Crouch / Attack / Use | OK / Back / - / OK |
| D-pad (top left) | Walking-stick, Stones, Sword | Navigate |
| LB / RB, Back, Start (top) | Ring / Target, Toggle view, Pause | Start = Enter (skips movies and cutscenes) |
| Tap a menu item | | Selects it, like a mouse click |

The labels change between gameplay, cutscenes and menus. **Panels** opens the log and the Multiplayer panel as a
drawer. A physical controller still works alongside the touch controls.

**iPhone / iPad: not supported.** The game needs WebAssembly JSPI, which lets the translated code wait for the
browser mid-function. Safari doesn't have it, and every iOS browser (Chrome included) is Safari underneath. The page
says so instead of starting. The only alternative is Asyncify, which would make the 35 MB module much bigger and slower.

Verified game version: Meridian.exe md5 `3e351efeea5c7e1eb55095d8f5b12fab` (retail PC). Other versions will warn,
because the translation tables in `auto/` describe this exact binary.

## Multiplayer (up to 8 players)

```
python start.py --mp            # relay on port+2 (5192), this machine only
python start.py --mp --lan      # reachable from your LAN / Tailscale; prints the URLs
```
Each player runs their own copy (`start.py --mp`) and types the host's `IP:5192` into the **Multiplayer** panel under
the game (or opens `game.html?mp=IP:5192&name=YourName`). Start or load any level; players on the same level see each
other. Remote players are the fake-Bilbo NPCs of **The Hobbit Synchrony v3**
(https://github.com/hobbit-kingdom/hobbit-synchrony-v3, BSD-3): its data files are downloaded once from its release
into `cache/` and served as virtual archives; nothing is written to the game folder. Details and what is not synced
yet: `docs/MULTIPLAYER.md`.

## Run it in Docker (with its own Tailscale node)

```
cp .env.example .env          # then set GAME_DIR to your game folder (the one with Meridian.exe)
docker compose up -d --build
docker logs hobbit-tailscale  # first start only: open the login link it prints to add the node to your tailnet
```
Two containers start:
- **hobbit-web**: the game (page, game data and multiplayer relay). The first start translates and compiles the game,
  about 4 minutes (`docker logs -f hobbit-web`). The build is kept in `recomp/out/`.
- **hobbit-tailscale**: a separate Tailscale machine called **hobbit-web**. The game lives inside its network, so over
  the network the game is reachable **only** through that node. Your PC, your other devices and your tailnet stay
  private.

| Who | Address |
|---|---|
| you, on this PC | http://127.0.0.1:5190/web/game.html |
| anyone you share the node with | https://hobbit-web.YOUR-TAILNET.ts.net/web/game.html |

The container runs the single-origin server (`--single`): page, game data (`/data/`) and relay (`/relay`) all on
port 5190, which the Tailscale address serves on 443 with a real HTTPS certificate (`tailscale serve`, see
`tailscale/serve.json`). The old separate ports stay on as well (data 5191 -> 8443, relay 5192 -> 10000), so older
links and remembered relay addresses keep working. The page finds the data and relay addresses by itself.
Your game folder is mounted read-only. The game files are streamed to the browsers that open the page, so share the node
only with people who own the game.

## Publish temporarily with Cloudflare (Tunnel + Access)

For friends who don't use Tailscale: a Cloudflare Tunnel gives the game a public `https://` name on a domain you
have in Cloudflare, and Cloudflare Access puts a login in front of it (only the email addresses you list, each gets a
one-time PIN). Nothing is opened on your router; the `cloudflared` container dials out to Cloudflare. It shares the
game container's network, so its `localhost` is the game and nothing else.

**Only share it with people who own the game.** The page streams your game files to everyone who gets past the
login. Keep the Access policy to an email allow-list, and turn the tunnel off when you're done.

1. **Create the tunnel.** Cloudflare dashboard > Zero Trust > Networks > Tunnels > *Create a tunnel* > **Cloudflared**,
   name it (e.g. `hobbit`), connector environment **Docker**. Copy only the token (the long string after `--token`)
   and put it into **your** `.env` as `CF_TUNNEL_TOKEN=...`. Never commit it, paste it in chat or put it in `.env.example`.
2. **Public hostname** (tab *Public Hostname* > *Add*): subdomain e.g. `hobbit`, your domain, path empty,
   service type **HTTP**, URL **`127.0.0.1:5190`**, i.e. the service is `http://127.0.0.1:5190`. (`localhost:5190`
   works too; `127.0.0.1` avoids an IPv6 lookup.) WebSockets are on by default; leave them on (the relay needs them).
3. **Access application, before you start the tunnel:** Zero Trust > Access > Applications > *Add an application* >
   **Self-hosted**, application domain = the same hostname (e.g. `hobbit.example.com`, path empty so it covers `/`,
   `/data/` and `/relay`). Policy: action **Allow**, include **Emails** = your friends' addresses (and yours).
   Login method: **One-time PIN** (Settings > Authentication, if it isn't on yet).
4. **Start it:** `docker compose --profile cloudflare up -d` (the game containers keep running; only `cloudflared`
   is added). `docker logs hobbit-cloudflared` should say *Registered tunnel connection*.
5. Friends open `https://hobbit.example.com/web/game.html?name=TheirName&room=main` in Chrome 137+, enter their email,
   type the PIN they get, and play. Multiplayer connects to `/relay` on the same name by itself.

**Bandwidth per friend** (measured, see the Traffic table above): about 20 MB to the main menu and ~49 MB into Dream
World on the first visit; later visits ~7 KB plus whatever new parts of the game they reach (game data is kept in
the browser, keyed by the file's size and date, so it is only fetched again when your game files change). Cloudflare
does not cache the game data by default (.DFS archives read with Range requests), so every first visit is served by your PC
through the tunnel.

**Turn it off:** `docker compose --profile cloudflare stop cloudflared` (or `rm -sf cloudflared`), then delete the
public hostname or the whole tunnel in the dashboard. A plain `docker compose up -d` never starts `cloudflared`.

## Play with a friend

1. **Host:** run the containers as above and add the node (login link). In the Tailscale admin console → Machines →
   **hobbit-web** (not your PC) → **Share…**, send the invite link. Shared users can reach only that machine.
2. **Friend:** install Tailscale, accept the invite, and open
   `https://hobbit-web.YOUR-TAILNET.ts.net/web/game.html?name=TheirName&room=main` in Chrome 137+. Nothing else
   to install: the game streams from the host.
3. **Host** plays at `http://127.0.0.1:5190/web/game.html?name=Ivan&room=main`.
4. Both start a New Game (Enter skips the movie and the cutscene) and meet in Dream World. The panel lists the players.

Without Docker: `python start.py --mp` plays locally. A friend with their own copy can run it too and connect to the
host's relay by typing its address in the Multiplayer panel.

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
| `start.py`, `start.bat` | launcher (setup, build, servers; `--single` = one-port server) |
| `docker-compose.yml`, `Dockerfile`, `.env.example`, `tailscale/` | Docker: game + Tailscale node, optional `cloudflared` (profile `cloudflare`) |
| `recomp/` | translator (`cfg.py`, `x86c.py`), `build.py`, C runtime, JS host layer, headless Node runner `boot_node.mjs`, capsule harness |
| `web/` | `game.html` / `game.mjs` (the game page), `touch.mjs` (phone controls), `audio.mjs` + `audio-worklet.js` (DirectSound output), `d3d8/` (Direct3D 8 on WebGL2 + its self-test `d3d8/test.html`) |
| `auto/` | function boundaries, ABI table and cross-references for this exact exe (from the Ghidra analysis) |
| `d3drec/` | proxy `d3d8.dll` that records the original game's D3D calls + a Chrome replayer that diffs the frames |

Headless run (no browser): `node --experimental-wasm-jspi recomp/boot_node.mjs --frames 4000`. Set `HOBBIT_GAME_DIR`
and `HOBBIT_EXE`, or use the default sibling paths. `--audio-wav out.wav` also writes what the speakers would play.

## Not done yet
- Movie sound (Bink audio): movies are silent.
- Bink movies: they play black for their real length.
- Resuming C++ exceptions.
- Saving settings in the browser.
- Testing beyond Dream World.
- Gamepad: tested with a simulated pad (menus, New Game, skipping, moving, pause menu); not yet with a physical controller.
- Phone: tested in Chrome's phone emulation with simulated touches (menus, New Game, skipping, running, jumping,
  camera, pause); not yet on a real phone. Expect a lower frame rate than on a PC.
