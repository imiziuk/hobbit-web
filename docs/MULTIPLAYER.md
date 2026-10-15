# Multiplayer in the web port (MVP, Oct 14 2026)

Up to 8 players per room see each other's Bilbo running around the same level. This is a browser port of the
player sync of **The Hobbit Synchrony v3** (https://github.com/hobbit-kingdom/hobbit-synchrony-v3, BSD-3-Clause,
by Mr_Kliff, modera, king174rus and AiOne of the Hobbit Kingdom community). The approach, the fake-Bilbo layer, all
memory offsets and the engine call used for animations come from Synchrony (`Player.cpp`, `NPC.cpp`,
`GuidManager.cpp`, `client.cpp`, `MultiplayerSetupSource/`). Its level/asset data is downloaded from its v1.0 release
at run time and never committed. Nothing from the release that is executable (.exe/.dll) is extracted or run.

## How to play

```
python start.py --mp                 # this machine only (127.0.0.1); relay on port+2 (5192)
python start.py --mp --lan           # listen on all interfaces; prints LAN / Tailscale URLs
```
- First `--mp` run downloads the Synchrony release zip (14.6 MB) into `cache/synchrony/` (gitignored) and extracts
  only its data files (`.EXPORT .NPCGEOM .INFO .XBMP .CHARANIM .RGEOM .TXT`).
- The page has a **Multiplayer** panel: name, server (default = this page's host and port + 2), room, Connect /
  Disconnect, player list with each player's level. URL parameters connect automatically:
  `game.html?mp=192.168.1.20:5192&name=Bilbo&room=main`.
- Everyone starts or loads a level (New Game works). Players on the same level see each other.
- **Friends with their own copy of the game** (the normal case): each runs `start.py --mp` on their own computer and
  puts the host's `IP:5192` in the Server field. Only the host's relay has to be reachable (`--lan` on the host).
- `--lan` also exposes the host's page and game data server, so someone without the game files can open the host's
  printed URL and stream them. Use it only on a trusted network (home LAN / your Tailscale tailnet). On Windows the
  first `--lan` run may show a firewall prompt for Python.

- **Single-origin server** (`start.py --single`, the Docker default, required behind Cloudflare Access): the relay is
  the WebSocket path `/relay` on the page's own port (`ws://host:5190/relay`, or `wss://<name>/relay` over HTTPS);
  the panel's default server is that URL (the page reads `/__mode`). A remembered server that was just the old
  port+2 / :10000 default is replaced by `/relay` automatically. In Docker the old relay port 5192 (Tailscale 10000)
  stays on and shares the same rooms.

Dev setup in IRA (`.claude/launch.json`): `hobbit-single` (5390: `webrepo/start.py --single --mp`, page
`http://127.0.0.1:5390/web/game.html`), or the 3-port one: `hobbit-web` (5190) + `hobbit-game-data-mp` (5193, `serve_game.py --mp`) +
`hobbit-mp-relay` (5192), page `http://localhost:5190/web/game.html?data=http://127.0.0.1:5193&mp=localhost:5192`.

## 1. Assets: virtual patched archives (`recomp/mp_assets.py`)

Synchrony adds remote players as 8 level-authored NPCs of creature type `BilboRM`, GUIDs `0D8AD910_E8851002..09`, in a
layer `FAKE_HOBBITS` (also 4 weapon-holder NPCs `..0A..0D` and name/status markers `0D8AD911_*`, `0D8AD912_*`). Its
`MultiplayerSetup.exe` copies `FAKE_HOBBITS.EXPORT` + `BILBOFAKE.NPCGEOM` into every `Levels\<level>\` of an
*unpacked* (loose-file) install and appends the layer to `ALLUSEDLAYERS.TXT` / `INITIALOBJECTLAYERS.TXT`
(bumping `[ Layers : N ]`).

We keep the retail exe and its DFS archives and never write to the game folder. The game-data server serves virtual
archives instead (built in memory at start, about 2 s):
- `<level>.DFS`: the original index plus new entries (dir/name/ext fragments appended to the string table); the
  entries of the two layer lists are re-pointed to patched copies.
- `<level>.000`: original bytes, zero padding to the archive alignment 0x800, then the appended file data. Only the
  appended tail is held in memory; Range requests below it read the original file.
- `common.DFS/.000`: the Synchrony `Common\` files (8 skins `bilb1..8[d].xbmp`, `BILBOFAKE*.NPCGEOM`,
  `BILBORMANIMS/STATES.INFO`, `BILBORMANIMS.CHARANIM`, props...). A file that already exists in some archive replaces
  that entry there (the BilboRM files exist in common and in Ch02_Roa); the rest is appended to common. Four textures
  that `BILBOFAKE.NPCGEOM` names as `props/bilbo_*` exist in retail only under `COMMON\BILBO\`; copies are added under
  `COMMON\PROPS\` (they showed up as `rsc_mgr::Load(failed) File not found` in the first run).
- 13 archives change (12 levels + common); audio and boot are untouched. `python recomp/mp_assets.py --game <dir>
  --check` rebuilds and verifies them offline.

Observed: the retail exe also tries loose files first (`.\Levels\Ch00_DreamWorld\...` misses in the file log before
each DFS read), so a loose overlay directory would probably work too; the virtual archives do not depend on that.

## 2. Netcode (`recomp/mp_relay.py`, stdlib only)

A WebSocket relay (RFC 6455 handshake, masking, fragmentation, ping/pong, close) on port+2, started by
`start.py --mp` or standalone (`python recomp/mp_relay.py --port 5192 [--host 0.0.0.0]`); with `start.py --single
--mp` the same code runs as an upgrade on the HTTP server's `/relay` path (`mp_relay.serve_upgrade`). Rooms of up to 8; each client
gets the lowest free slot 0..7 = fake Bilbo GUID `0D8AD910_E885100(2+slot)` (Synchrony `GuidManager::assignGuid`, with
`FAKE_BILBO_GUID.txt` order). The relay does not interpret state: it stamps the sender id and forwards. Sockets idle
for 20 s are dropped (clients send at least once per second).

Messages are JSON text frames:

| direction | message |
|---|---|
| C→S | `{"t":"hello","name":"Bilbo","room":"main"}` (first message) |
| S→C | `{"t":"welcome","id":3,"slot":2,"guid":"0D8AD910_E8851004","room":"main","players":[{id,slot,guid,name,level}...]}` |
| S→C | `{"t":"join",id,slot,guid,name,level}` / `{"t":"leave","id":3}` / `{"t":"full"}` |
| C→S→others | state, 20 Hz while in a level: `{"t":"s","l":0,"p":[x,y,z],"r":yaw,"a":anim,"f":frame,"w":weapon}` (+`"id"` added by the relay); `l` = level id from 0x00762B5C (0 = Dream World), `l:-1` = not in a level (sent once per second as keepalive) |
| C→S | `{"t":"name","name":"..."}`, `{"t":"ping","ts":...}` → `{"t":"pong","ts":...}` |
| both | developer mode: `{"t":"dev",...}`, `{"t":"room","allowDev":...}`, `hello.allowDev`, `welcome.owner/allowDev/events`, `players[].dev`: see `docs/DEVMODE.md` section 3 |

~90 bytes per state message, 20 Hz, so about 2 KB/s up per player and 2 KB/s × (players−1) down.

## 3. Game side (`recomp/host/mp.mjs`)

Installed by `web/game.mjs` (`window.hobbit.mp`). Runs from `W.onPresent`, i.e. inside the Present call at the end
of a frame, never during the game's logic update.
- **Local state** (Synchrony `readLocalPlayerState`): `g_pBilbo` 0x0075BA3C → position +0x7C4/7C8/7CC, yaw +0x7AC
  (radians), animation id `[[bilbo+0x560]+8]`, frame +0x530; weapon = prop-set pointer at 0x0075C738, mapped to
  0..3 by comparing with the prop sets (+0x260) of the weapon-holder NPCs `..0D/0B/0A/0C` (none/sting/staff/stone).
  Level 0x00762B5C; "in a level" = Game_LevelLoop flag 0x00760354 and `g_pBilbo` set.
- **Finding the fake Bilbos** (`findGameObjByGUID`): object table base `[0x0076F648]`, count `[0x0076F660]`, 0x14-byte
  entries with the object pointer first; GUID at object+8 (low dword) / +0xC (high); type tag object+0x7C = 0x1C (NPC).
  Rescanned when the level or `g_pBilbo` changes, every 5 s, and immediately if a cached object no longer validates.
- **Applying a remote player** (`Player::tickLerp`, `NPC::setPosition/setRotationY/setHealth/setNPCAnim`): position
  linearly interpolated from the displayed position to the newest snapshot over 1/20 s (snaps when > 2000 units away),
  written to +0x14, +0x20 and the animation root (`ctrl+8-0xC4`); yaw (shortest arc) to +0x6C; health +0x290 pinned at
  1000; animations 21, 22, 36-39 lifted by 100 units (Synchrony's display offset). When the animation id changes the
  engine's own `anim_track_controller::SetAnim` 0x005434B0 is called through `m.callGuest` (thiscall: ECX =
  controller `[[[npc+0x304]+0x50]+0x10C]`, checked against vtable 0x006F3C4C; args `(int anim, float 0.15)`; ECX/EDX/EAX
  restored afterwards). Weapon: copy the weapon NPC's prop set to npc+0x260 (`NPC::setWeapon`).
- **Unused fake Bilbos** (no player, or the player is on another level / in a menu) are written back to their authored
  spawn position every frame (about 8,700 units above Dream World's floor), so they stay out of sight instead of falling.

## 4. What ran (Oct 14, Claude desktop browser pane, two tabs "Alice" and "Bob", same machine)
- Virtual archives load: in Dream World all 12 `FAKE_HOBBITS` NPCs exist in the object table (type 0x1C, team 1, at
  the authored spawn) plus the 12 marker objects.
- Both tabs: New Game → Dream World, cutscenes skipped, relay assigned slots, `fake Bilbos found 8/8`.
- Alice ran forward/back with the arrow keys; Bob's slot-2 NPC followed (memory: identical coordinates within 0.1;
  screenshots `recomp/out/mp/bob_view_*.jpg`: the fake Bilbo next to Bob, running away, running back with the run
  animation). Bob turned/moved; Alice's slot-1 NPC matched his position. 0 apply errors, SetAnim called on each
  animation change.

## 5. Not done / known gaps
- Skins per slot (Synchrony's `bilbN[d].xbmp` are served but not assigned), name/status markers above the head,
  chat.
- World sync (Synchrony has it all, next steps in roughly this order): enemies (host-authoritative NPC position/anim/
  health per team, `Enemy` struct, AI mode byte +0x268), pickups/chests/switches/triggers/levers by GUID, stones and
  projectiles (`CreateProjectile` 0x004B53A0), damage between players (pain hooks), cinema sync (`cinema::Start`,
  `SYNCED_CINEMAS.txt`), ring stealth, hoistables and push blocks, web walls.
- Animation frames are not synced (Synchrony also leaves this commented out); death (17) hold is not ported.
- Fake Bilbos are team 1 NPCs with state control on, so local goblins may react to them; Synchrony controls this
  with its sense/pain hooks (not ported).
- No authentication or encryption on the relay (Synchrony uses yojimbo secure connect tokens); use LAN/Tailscale.
- Old saves made without the layer will not have the fake Bilbos (same as Synchrony).
- Level id → name table in the panel is a best guess for ids 1-11 (only 0 = Dream World was observed).
