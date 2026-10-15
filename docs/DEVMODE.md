# Developer mode in the web port (Oct 15 2026)

`web/devmode.mjs` (+ the Developer panel in `web/game.html` / `web/game.mjs`). A port of the native proxy's
`src/core/devmode.cpp` to the JS host, built mostly on the retail exe's own developer code, which is still in the game
behind the flag `0x007600E8`. In multiplayer every switch and every dev action is **announced to the room and logged by
the relay** (section 3).

## 1. Keys and panel

Dev keys work only while developer mode is on. Ours are caught in the capture phase and never reach the game; the game's
own dev keys (Ctrl+F, F4, F5) pass through and only do something while the flag is set.

| Key | Panel | What it does | How |
|---|---|---|---|
| **F10** | Developer mode | on / off | sets / clears `0x007600E8`; off restores everything below |
| Ctrl+F | Fly (Ctrl+F) | flight on/off; **A = up, D = down**, arrows/WASD move (~860 u/s) | the game's own key (injected for the button); state FLY = 2 at Bilbo+0x8D4. Writing the fly flag 0x00720F84 / Bilbo+0x364 does NOT enter FLY |
| F4 | - | the game's fast-forward toggle (time scale 30, clamped) | game code; announced as `speed` (native) |
| F5 | Wireframe | wireframe on/off | `0x00777ADC` (the game's render-mode toggle); `web/d3d8` turns FILLMODE=WIREFRAME into line lists |
| F6 | God mode | invulnerability + health kept at max | `0x0075FBF4` (SysMenu "Invulnerability") + health `0x0075BDBC` = max `0x0075C714` every 250 ms |
| F7 | Refill health | health = max | |
| F8 / F9 | Save position / Teleport to slot | 4 slots (Slot select), per level, remembered in localStorage | `bilbo::Move` = vtable slot 5 (0x0041E0B0, thiscall `(vec3*, 0)`), called between two frames |
| - | Teleport to player | next to another player on the same level | same, target = that player's last relayed position + (60, 0, 60) |
| [ / ] | Speed | x0.25, 0.5, 1, 2, 3, 4 | time scale `0x007607F0` (logic_mgr 0x00771D78 copies it each frame, clamp 0..10) and logic_mgr+0x30 (max elapsed per frame, 100 ms) raised by the same factor, otherwise the clamp eats the speed-up at low fps (measured: x3 gave x1.05 at 10 fps without it, x2.79 with it) |
| - | Level + Warp | load any level 0..11 | the game's own SysMenu "Exit Level" path: level index `0x00762B5C` = target - 1, then `0x00760354` = 0 and `0x0076200C` = 0 (no summary / vendor screens). Waits for ~20 frames of normal play (not loading, Bilbo not NULL/CINEMATIC, pad mode "game"): ending a level in a cutscene crashes the original too |
| F2 | Overlay | top-right text: FPS, position, yaw, Bilbo state id + name, hp, level, FE state, pad mode, speed, god, wireframe | |

Not done: free camera (wireframe was chosen instead), a phone dev menu (the panel is reachable through Panels on a
phone), SysMenu cheats beyond reporting that it was opened (`0x0075FB98`).

The page also **watches** the game's dev variables while dev mode is on (flight state, time scale, wireframe flag,
invulnerability, SysMenu request) and reports every change, so a native key or a SysMenu toggle is announced the same
way as a panel button.

## 2. On/off rules
- Offline: dev mode turns on at once; events go to the local log.
- Online: the page sends `{"t":"dev","a":"on"}` and turns dev mode on only when the relay echoes it back (4 s timeout);
  the relay refuses it when the room does not allow it. After a reconnect an active dev mode is announced again.
- Off restores: lands a flight (Ctrl+F), speed x1 (+ the logic_mgr clamp), god off, wireframe off, then clears the flag.

## 3. Multiplayer transparency (`recomp/mp_relay.py`, `recomp/host/mp.mjs`)

| Dir | Message |
|---|---|
| C→S | `{"t":"hello",...,"allowDev":true}`: `allowDev` only counts for the player who creates the room (default true) |
| C→S | `{"t":"dev","a":"on"\|"off"\|"fly"\|"speed"\|"teleport"\|"god"\|"health"\|"warp"\|"wire"\|"sysmenu", ...detail}` (detail = up to 8 small fields, e.g. `on`, `x`, `to`, `from`, `slot`, `player`, `level`) |
| S→all | `{"t":"dev","ts":"2026-10-14T18:23:40-07:00","id":2,"name":"Alice","a":"teleport","dev":true,"player":"Bob",...}` to **everyone in the room, the sender too** (`"suspicious":true` on flags) |
| S→C | `{"t":"dev","a":"denied",...}` when the room does not allow dev mode |
| C→S | `{"t":"room","allowDev":false}` (room owner only; others are refused and logged) |
| S→all | `{"t":"room","owner":2,"allowDev":false,"by":2}`; disallowing switches every dev player off (`a:"off","forced":true`) |
| S→C | `welcome` now has `owner`, `allowDev`, `events` (the room's last 50 dev events) and every player has `"dev"` |

- **The DEV badge comes from the relay's state** (`Conn.dev`, in `welcome`/`join`/`dev`), not from a client's claim.
  Late joiners get the badges in `welcome` and the history in `events`.
- Every client shows: the badge next to the player (and next to "you"), a toast over the game ("Alice teleported to
  Bob"), and the "Developer-mode log" list in the Multiplayer panel (suspicious lines in red).
- **Relay log** (stdout -> `docker logs`), one line per event with time, room, player id/name, IP and level:
  ```
  [relay] 2026-10-14T18:23:25-07:00 DEV room 'devtest' #2 'Alice' ip 127.0.0.1 level 0: on via="test"
  [relay] 2026-10-14T18:23:40-07:00 DEV room 'devtest' #2 'Alice' ip 127.0.0.1 level 0: teleport to=[1745,-398.3,-1313.4] from=[1725.8,-398.3,-1436.3] player="Bob" pid=3
  [relay] 2026-10-14T18:24:32-07:00 DEV SUSPICIOUS room 'devtest' #3 'Bob' ip 127.0.0.1 level 0: flag note="moved 3000 units in 0.23 s without dev mode (respawns/cutscenes can also do this)" to=[4685.0,-398.3,-1373.4]
  [relay] 2026-10-14T18:24:43-07:00 room 'devtest' #2 'Alice' ip 127.0.0.1 (owner) set allowDev=False
  [relay] 2026-10-14T18:24:44-07:00 DEV room 'devtest' #3 'Bob' ip 127.0.0.1: tried to enable dev mode, denied (allowDev=false)
  ```
- **IP**: behind Cloudflare / a reverse proxy the relay uses `CF-Connecting-IP`, `X-Real-IP` or the first
  `X-Forwarded-For` entry, but only when the TCP peer is a private/loopback address (our own proxy); the peer is
  printed as `(via ...)` when it differs.
- **Heuristic** for players that did NOT announce dev mode (`check_motion`): one state update moving > 1500 units, or
  > 1400 units/s averaged over >= 1 s on the same level, is logged and broadcast as `a:"flag"`, suspicious (at most one
  per player per 10 s). A dev action sent without dev mode on is broadcast too, marked suspicious. Respawns,
  cutscenes and level scripts can also move Bilbo far, so a flag is a hint, not proof. A modified client can still
  cheat silently within those limits: this is transparency for honest clients, not anti-cheat.
- **Room owner** = the player who created the room; when the owner leaves, the longest-connected player takes over
  (logged, `room` message with `by: null`).

## 4. Verified (Oct 15, Claude browser pane, `hobbit-single` 5390, tabs Alice / Bob / Carol, room "devtest")
- Alice: dev on via the relay, Ctrl+F flight (state 2), A for 0.8 s raised y -398 -> -50, speed x3, god, save slot
  -> teleport back to the slot (exact), teleport next to Bob, wireframe screenshot, health refill, warp to level 1
  (Bag End gameplay start 74.4, -1693.7, -317.2 after the page-turn movie; no summary/vendor screens).
- Bob's tab: DEV badge next to Alice, toasts, the full log (9 lines). Carol (late joiner): badge + 9 history lines.
- Bob without dev: a 3000-unit jump flagged within 0.23 s; a fake `teleport` message marked suspicious.
- Alice (owner) disallowed dev: Alice forced off (flight landed, flag cleared, wireframe off), Bob's attempt denied.
- Synthetic key events: F10 / F6 / ] / F10 on Bob's tab -> on, god, speed x2, off; F10 did not reach the game's
  DirectInput keys; off restored speed 1.
- `node --experimental-wasm-jspi recomp/boot_node.mjs --frames 600`: 600 presents, unchanged.
