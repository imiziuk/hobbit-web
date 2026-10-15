# Enemy (NPC) sync in the web port's multiplayer (Oct 14 2026)

`recomp/host/mp_enemies.mjs`, installed by `web/game.mjs` after `mp.mjs` (`window.hobbit.mp.ext.enemies`). A JS port of
the enemy sync of **The Hobbit Synchrony v3** (https://github.com/hobbit-kingdom/hobbit-synchrony-v3, BSD-3-Clause,
Hobbit Kingdom community): `GameTypes.h` (`Enemy`), `NPC.cpp` (team, AI flag byte, shield), `client.cpp`
(`readEnemiesState`, `changeEnemiesAIMode`, the per-level exception lists, the GetCurrentGoal "goal starving" hook and the
SetGoalList action filter). Player sync and the relay are described in `docs/MULTIPLAYER.md`.

## 1. Design

- **Host per level.** Among the players currently on a level (me included) the one with the **lowest relay id** is that
  level's host. Relay ids grow with connection order, so this is the longest-connected player on the level; it is the
  room owner whenever the owner is on that level (the owner is the first id in the room, or the longest-connected player
  after a handover), and a level without the owner still has a host. Re-evaluated every frame from `mp.players[*].level`
  (`welcome`/`join` carry the level, state messages update it, `l:-1` = not in a level), so a host leaving the room, the
  level, or dropping to a menu hands the role to the next lowest id within one frame. No negotiation, nothing stored on
  the relay.
- **Host** runs the NPCs' real AI (untouched) and sends, at 15 Hz:
  `{"t":"e","l":<level>,"n":[["0D8AD451_173BC001",x,y,z,yaw,anim,health,shield], ...],"full":0|1}`
  GUID = `HHHHHHHH_LLLLLLLL` (high dword, low dword; Synchrony's spelling), position rounded to 0.1, yaw to 0.001,
  health to 0.1, `shield` 1/0. Only NPCs that are "synced" (below). Entries whose string is unchanged since the last
  send are skipped; every 1 s a `full:1` packet resends everything (late joiners, dropped frames). At most 256 entries
  (Synchrony's `MaxEnemyUpdatesPerMessage`); 12 Dream World enemies measured 3.7 KB/s on the follower, so a 256-NPC
  level stays far below the relay's 64 KB frame limit (about 70 bytes per changed entry).
  The relay forwards `t:"e"` unchanged to everyone else in the room with `"id"` stamped (no relay change was needed).
- **Follower** (any other player on that level): the synced NPCs' AI is switched off (section 3) and they are puppeted
  from the host's snapshots exactly like remote players in `mp.mjs`: position interpolated from the displayed position to
  the newest snapshot over 1/15 s (snap when > 2000 units), written to +0x14, +0x20 and the animation root (`mp.setPos`);
  yaw to +0x6C (shortest arc); health to +0x290; `anim_track_controller::SetAnim` through `mp.setAnim` whenever the
  controller's current animation id differs from the host's (every frame, so the local PhysController cannot keep an
  animation of its own); `NPCObject::ShatterShield` 0x004A40D0 (thiscall, no args, `m.callGuest` with ECX = the NPC)
  once when the host says the shield is gone and the local prop set still has one.
  Snapshots from anyone but the current host, or for another level, are ignored. Messages only touch JS state; all
  memory writes and engine calls happen in the frame hook (between two game frames).
- **Which NPCs** (Synchrony `readGamePointers` + `readEnemiesState`): every object with type tag `+0x7C == 0x1C` and the
  NPC class signature `+0x10 == 0x04004232`, except the fake Bilbos / weapon holders (GUID high dword `0D8AD910`) and ring
  ghosts (`0D8AD913`). Bilbo himself is type 0x12, so he never matches. Of those, an NPC is *synced* on a given frame when
  it is imported/active (`+0x7F & 0x10`) and on team 1 or 2 (`+0x1A4`), or force-listed; neutral NPCs keep their local AI
  everywhere. Teams are re-read every frame because level scripts move NPCs between teams. The table is rescanned every
  5 s and on every level / Bilbo-pointer change (`mp.levelHooks`), nothing persists across levels.
- **Per-level exceptions** (ported verbatim from Synchrony, untested here): levels 1 (Hobbiton) and 9 (Smaug) keep local
  AI entirely (module role `local`); level 6 keeps its scripted goal lists (PhysController bit left on, see section 3);
  level 3 force-syncs the Trollshaw troll `0D8AD98D_A6188400`; level 4 has 16 GUIDs that are never host-driven.
- **Handover**: when my role changes from follower to anything else, every NPC I suppressed gets its original AI flags
  back (`restoreAIState`); when I become host I start sending at once (`full` first). On disconnect / level exit the
  same restore runs if the objects are still valid.
- Panel line under the Multiplayer panel (`#mpExt`): `enemies: host, 12 synced, 15 Hz` or
  `enemies: following #2 Follower, 12 synced, 12 AI off, 12 received`. Debug: `mp.ext.enemies.list()`, `.stats`,
  `.mode`, `.levelHost(level)`.

## 2. Offsets and addresses

| what | where | source |
|---|---|---|
| object table | `[0x0076F648]`, count `[0x0076F660]`, 0x14-byte entries, object pointer first | mp.mjs / Synchrony |
| GUID | obj+0x08 low, obj+0x0C high | Synchrony NPC.cpp |
| NPC class signature | obj+0x10 == 0x04004232 | Synchrony client.cpp |
| type tag / active | obj+0x7C == 0x1C; obj+0x7F & 0x10 = imported | Synchrony NPC.h |
| position / root / yaw | obj+0x14, obj+0x20, animCtrl+8-0xC4; yaw obj+0x6C | mp.mjs |
| team | obj+0x1A4 (0 neutral, 1/2 sides) | Synchrony NPC.h |
| prop set / shield GUID | obj+0x260 -> propSet+0x10 (uint64, 0 = no shield) | Synchrony NPC.cpp |
| AI flags | obj+0x268 (dword; Synchrony writes the low byte) | NPCObject::AdvanceFullUpdate 0x004A1750 |
| health | obj+0x290 (float) | Synchrony |
| StateController | obj+0x300: +0x118 goal queue count, +0x11C array, +0x130 flags (bit0 = empty) | Synchrony client.cpp, 0x005AF980 |
| PhysController | obj+0x304: +0x190 cached current goal; +0x50 -> +0x10C anim_track_controller | 0x00595310, mp.mjs |
| SetAnim / ShatterShield | 0x005434B0 (vtable 0x006F3C4C) / 0x004A40D0 | mp.mjs / Synchrony |

AI flag bits, from the decompile of `NPCObject::OnAdvanceLogic` 0x004A14C0 and `AdvanceFullUpdate` 0x004A1750
(`param_1[0x9a]` = +0x268): **0x08** = run `StateController::OnAdvanceLogic` 0x005ACC40 (the AI state machine),
**0x10** = run `PhysController::OnAdvanceLogic` 0x00594BE0 (goal processing, navigation, animation selection and the
animation playback), **0x20** = senses, 0x2000 = sleep, 0x80000 = skip the full update, 0x100000 = `AdvanceMove`;
when neither 0x08 nor 0x10 is set OnAdvanceLogic takes an early-out path that only advances the `CharAnimPlayer`
(0x00542580). Synchrony's `setAIMode(0)` = low byte 87 = 0x7F & ~(0x08|0x20): state and senses off, phys on.

## 3. Synchrony's goal hook and what replaces it

Synchrony found that switching the AI flag byte alone is not enough: the StateController's action queue (+0x118/+0x11C)
is consumed by `PhysController::UpdateGoals` 0x00595310 -> `StateController::GetCurrentGoal` 0x005AF960 ->
`ProcessGoal` 0x00595730 on every PhysController tick, regardless of the state bit. Goals already queued (initial patrol
lists pushed by level scripts at import) and goals pushed later by scripts (`ActionSetGoalList`, AIManager) keep
walking the NPC around on the client, fighting the host's positions. Synchrony detours `GetCurrentGoal` to answer
"no goal" for host-driven NPCs (and filters `ActionSetGoalList` fires in `AIAction::OnAdvanceLogic` 0x005CC330).

The recompiled game calls these functions directly from C (only indirect calls go through the dispatch table), so there
is no hook point. Two replacements were measured in the browser (`E.mode`):

- **`goal-starve` (default)**: Synchrony's mode 0 (bits 0x08 and 0x20 cleared, PhysController on) plus, every frame
  between two game frames, the goal queue count set to 0 (+0x130 |= 1, the same bookkeeping `PopFrontGoal` does when the
  queue empties) and the PhysController's cached goal +0x190 cleared. With the state machine off nothing re-pushes goals
  except level scripts, and a goal pushed during a tick can run for at most that one tick before our position/yaw/anim
  writes override it. Measured on a fighting Dream World goblin: 2.2 units of drift in 3 s without any position writes;
  animation frames advance normally (frame counter at animCtrl+0x10 moving, SetAnim honoured).
- **`phys-off`**: additionally clears 0x10. The NPC stops completely (0 drift), but the animation playback freezes
  (frame counter stuck, also after SetAnim), so it is only kept as a debugging option.

The `ActionSetGoalList` filter is not ported: on the levels tested the per-frame queue clearing covers it (a script-started
goal list runs at most one tick); if a level turns out to need it, the AIAction objects would have to be found and their
pending counters zeroed from the frame hook.

If the game sets the suppressed bits again while an NPC is followed (a script enabling its AI), `suppress()` records the
new value as the one to restore and clears the bits again, so a handover restores what the game wanted last.

## 4. Verified (Oct 14, Claude browser pane, `hobbit-single-b` port 5490, room "enemies", tabs "Host" and "Follower")

Both tabs: New Game -> Dream World; 27 NPC objects found (12 team-1/2 imported = synced; 8 fake Bilbos excluded by GUID).
- **Roles**: Host #1 = `enemies: host, 12 synced, 15 Hz`; Follower #2 = `following #1 Host, 12 synced, 12 AI off,
  12 received`; AI flags on the follower `0x1005A17F -> 0x1005A157` (bits 0x08/0x20 cleared), goal queue count 0.
- **Tracking** (traces of the 4 goblins near Bilbo, `0D8AD451_173BC001`, `..173B9001`, `0D8AD590_E2A97C0A`,
  `0D8ADD11_16E57001`, sampled by frame hooks on both tabs with `Date.now()` stamps, 6 s overlapping):
  at the same wall-clock 100 ms the follower's copies were at the host's positions within 0-26 units (one 15 Hz snapshot
  of a running goblin), e.g. host 4021 ms `1932/-396/-1784 anim 4 hp 98 yaw 5.72` vs follower 4013 ms
  `1931/-396/-1784 anim 4 hp 98 yaw 5.72`; animation ids identical on all 4, health identical, yaw within 0.03.
  A second (sequential) trace matched the last host row and the first follower row exactly on all four NPCs.
- **No local AI on the follower**: with the host's packets the follower's goblins never diverge from the host (above);
  with `phys-off` the drift without writes is 0, with `goal-starve` 2.2 units/3 s. The suppression counter stays at 12
  (the game did not re-enable the bits during the run).
- **Handover**: Host disconnected -> within 3 s the Follower became host (`restored: 12`, flags back to `0x1005A57F`,
  goal queue count 1 again, goblins moved 393 / 420 units on their own in 2 s, 21 packets sent in 2 s at ~10 fps).
  The old host reconnected as #3 and became the follower of #2 (12 suppressed, 12 received); after a page reload and a
  fresh New Game it joined as #4, again as follower (3.7 KB/s received, `errors: 0`).
- `mp.stats.errors` 0 and `enemies.stats.errors` 0 on both tabs throughout; no console errors.
- Offline: `node --experimental-wasm-jspi recomp/boot_node.mjs --frames 600` -> 600 presents, unchanged. A tab
  without a relay keeps role `off` (no memory writes, no sends).
- Screenshots (gitignored): `recomp/out/mp/enemies_follower_view.jpg` (the follower's view: a synced goblin attacking
  at the host's Bilbo position, which is also the follower's spawn) and `recomp/out/mp/enemies_host_view.jpg`.

## 5. Known gaps

- Damage from enemies to remote players, projectiles / stones, and the pain hooks are out of scope (an enemy only
  hurts the host's Bilbo; a follower hit by a puppeted goblin takes no damage, and a follower's hits do not reach the
  host: Synchrony's pain/health hooks).
- Death: health is copied, but the follower's death timer/fade runs locally once health <= 0 (PhysController is on,
  so the engine's own death path runs); not observed in the test run.
- Per-level exceptions (levels 1, 3, 4, 6, 9) are ported from Synchrony but untested in the browser.
- `ActionSetGoalList` filter not ported (section 3); cutscenes that drive synced NPCs through goal lists may look wrong on
  followers.
- Animation frames are not synced (same as players); a late joiner sees an animation from its start.
- A follower that joins mid-fight sees the host's NPC positions at once but the NPCs' local state objects (targets,
  combat flags) stay whatever they were at import, which only matters after a handover.
- Host selection is by relay id only; there is no latency or fps consideration (a host tab running at 10 fps sends at
  10 Hz).
