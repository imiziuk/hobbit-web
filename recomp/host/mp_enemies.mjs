// Host-authoritative enemy (NPC) sync for the web port's multiplayer. Design + verification: docs/MP_ENEMIES.md.
// A JS port of the enemy sync of The Hobbit Synchrony v3 (https://github.com/hobbit-kingdom/hobbit-synchrony-v3,
// BSD-3-Clause, Hobbit Kingdom community): GameTypes.h `Enemy`, NPC.cpp (team / AI flag byte / shield), client.cpp
// (readEnemiesState, changeEnemiesAIMode, the per-level exception lists and the GetCurrentGoal "goal starving" hook).
//
// Rule: on every level the player with the LOWEST relay id among the players on that level (me included) is that
// level's host. The host runs the NPCs' real AI and sends their state at 15 Hz ({"t":"e"}, relayed to the room);
// everyone else on the level switches those NPCs' AI off and puppets them from the host's snapshots. When the host
// leaves the level/room the next lowest id takes over automatically (AI restored, sending starts).
//
// Installed by web/game.mjs after mp.mjs; uses only mp's extension points (listeners / frameHooks / levelHooks) and
// helpers. Engine calls (SetAnim, ShatterShield) happen only from the frame hook, i.e. between two game frames.
//
// Object layout used (NPCObject; verified against Hobbit-RE/db/decomp_hl 004a14c0 / 004a1750 NPCObject::OnAdvanceLogic /
// AdvanceFullUpdate, and Synchrony NPC.h):
//   +0x08/+0x0C GUID lo/hi    +0x10 class signature 0x04004232 (NPC)    +0x7C type tag 0x1C    +0x7F bit 0x10 = imported/active
//   +0x14 position  +0x20 root position  (+ the animation root at animCtrl+8-0xC4, written by mp.setPos)
//   +0x6C yaw (radians)   +0x1A4 team (0 neutral, 1/2 fighting sides)   +0x260 prop set (-> +0x10 uint64 shield GUID)
//   +0x268 AI flags dword: bit 3 (0x08) StateController::OnAdvanceLogic, bit 4 (0x10) PhysController::OnAdvanceLogic,
//          bit 5 (0x20) senses. Synchrony's setAIMode(0) writes the low byte 87 = 0x7F & ~(0x08|0x20).
//   +0x290 health (float)   +0x300 StateController (+0x118 goal queue count, +0x11C ptr array, +0x130 flags bit0 = empty)
//   +0x304 PhysController (+0x190 cached current goal; +0x50 -> +0x10C anim_track_controller)
//   NPCObject::ShatterShield 0x004A40D0 (thiscall, no args).

const NPC_TYPE = 0x1C, NPC_SIG = 0x04004232;
const O = { guidLo: 0x08, guidHi: 0x0C, sig: 0x10, pos: 0x14, yaw: 0x6C, type: 0x7C, act: 0x7F, team: 0x1A4, props: 0x260,
  ai: 0x268, health: 0x290, stateCtrl: 0x300, physCtrl: 0x304 };
const SC = { qCount: 0x118, qFlags: 0x130 }, PC = { goal: 0x190 };
const AI_STATE = 0x08, AI_PHYS = 0x10, AI_SENSE = 0x20;
const SHATTER_SHIELD = 0x004A40D0;
const FAKE_HI = 0x0D8AD910, GHOST_HI = 0x0D8AD913;      // fake Bilbos (+ weapon holders) and Synchrony ring ghosts
const SEND_HZ = 15, FULL_S = 1, LERP_S = 1 / SEND_HZ, MAX_N = 256, SNAP_DIST = 2000, SCAN_S = 5;

// Per-level exceptions, ported from Synchrony client.cpp (levelKeepsLocalAI / levelKeepsGoalLists / isForceSyncedNpc /
// isLocalAiNpc). Level ids: 0x00762B5C (0 = Dream World, 1 = Hobbiton ... 9 = Smaug).
const LEVEL_LOCAL_AI = new Set([1, 9]);       // nothing is host-driven there
const LEVEL_LOCAL_GOALS = new Set([6]);       // scripted goal lists must keep running locally: leave PhysController on
const FORCE_SYNCED = { 3: new Set(['0D8AD98D_A6188400']) };   // Trollshaw troll: host-driven even while a cutscene parks it on team 0
const LOCAL_AI = { 4: new Set(['0D8AD68C_C88FF000', '0D8AD68C_C890A800', '0D8AD68C_C891C000', '0D8AD1CC_C3644400', '0D8AD68C_C8905C00',
  '0D8AD68C_C88E9800', '0D8AD68C_C8922000', '0D8AD68C_C88F2400', '0D8AD68C_C88F8800', '0D8AD68C_C8918400', '0D8AD68C_C890F400',
  '0D8AD68C_C8A67C11', '0D8AD68C_C8A67C13', '0D8AD44C_C8160800', '0D8AD68C_C8A75C01', '0D8AD68C_C89BF400']) };

const hex8 = v => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const guidKey = (hi, lo) => hex8(hi) + '_' + hex8(lo);
const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;

export function installEnemies({ mp, m, W, log = console.log, panel }) {
  const { rf, wf, now } = mp;
  const E = {
    role: 'off',          // off | local (level keeps its AI) | host | follow
    host: null,           // relay id of this level's host
    // follower AI suppression: 'goal-starve' = Synchrony's mode 0 (state + senses off, PhysController on) + the goal queue
    // emptied every frame (replaces its GetCurrentGoal hook); 'phys-off' also clears the PhysController bit, which stops the
    // NPC completely but FREEZES its animation playback (measured: frame counter stuck), so it is only a debugging option.
    mode: 'goal-starve',
    npcs: new Map(),      // guid key -> { obj, hi, lo, key, orig, supp }   (every NPC on the level except fake Bilbos / ghosts)
    remote: new Map(),    // guid key -> { prev, target, t0, cur, a, hp, sh, seq }  (host snapshots)
    lastScan: -1e9, lastSend: 0, lastFull: 0, lastSent: new Map(), lastUi: 0, seq: 0, recvAt: 0, bytes: 0, bytesT: 0, kbps: 0,
    stats: { sent: 0, recv: 0, applied: 0, animCalls: 0, shatters: 0, suppressed: 0, restored: 0, errors: 0, ignored: 0 },
  };
  mp.ext = mp.ext || {};

  /* ------------------------------------------------------------------ NPC table */
  const validNpc = N => m.r32(N.obj + O.guidLo) === N.lo && m.r32(N.obj + O.guidHi) === N.hi && m.r8(N.obj + O.type) === NPC_TYPE;
  const activeNpc = N => (m.r8(N.obj + O.act) & 0x10) !== 0;
  const team = N => m.r32(N.obj + O.team);
  const hasShield = N => { const p = m.r32(N.obj + O.props); return !!p && (m.r32(p + 0x10) | m.r32(p + 0x14)) !== 0; };
  // Synchrony readEnemiesState: synced = NPC type, active, not on the local-AI list, and (team 1/2 or force-listed)
  function synced(N, level) {
    if (!validNpc(N) || !activeNpc(N)) return false;
    const L = LOCAL_AI[level]; if (L && L.has(N.key)) return false;
    const t = team(N); if (t === 1 || t === 2) return true;
    const F = FORCE_SYNCED[level]; return !!(F && F.has(N.key));
  }
  function scan(t) {
    E.lastScan = t;
    const seen = new Set();
    const objs = mp.scanObjects(o => m.r8(o + O.type) === NPC_TYPE && m.r32(o + O.sig) === NPC_SIG);
    for (const o of objs) {
      const hi = m.r32(o + O.guidHi), lo = m.r32(o + O.guidLo);
      if (hi === FAKE_HI || hi === GHOST_HI) continue;            // remote players are driven by mp.mjs, never as AI
      const key = guidKey(hi, lo);
      seen.add(key);
      const old = E.npcs.get(key);
      if (old && old.obj === o) continue;
      E.npcs.set(key, { obj: o, hi, lo, key, orig: m.r32(o + O.ai), supp: false });
    }
    for (const key of [...E.npcs.keys()]) if (!seen.has(key)) E.npcs.delete(key);
  }

  /* ------------------------------------------------------------------ AI on / off (Synchrony NPC::setAIMode / restoreAIState) */
  const maskFor = level => (LEVEL_LOCAL_GOALS.has(level) || E.mode === 'goal-starve') ? AI_STATE | AI_SENSE : AI_STATE | AI_PHYS | AI_SENSE;
  function suppress(N, mask) {
    const cur = m.r32(N.obj + O.ai);
    if (cur & mask) {                       // first time, or the game switched the AI back on meanwhile: remember what it wanted
      N.orig = cur; m.w32(N.obj + O.ai, cur & ~mask);
      if (!N.supp) E.stats.suppressed++;
      N.supp = true;
    }
    if (cur & AI_PHYS & ~mask) starveGoals(N);   // PhysController left on: keep its goal queue empty (replaces Synchrony's GetCurrentGoal hook)
  }
  function starveGoals(N) {
    const sc = m.r32(N.obj + O.stateCtrl), pc = m.r32(N.obj + O.physCtrl);
    if (sc && m.r32(sc + SC.qCount) > 0) { m.w32(sc + SC.qCount, 0); m.w32(sc + SC.qFlags, m.r32(sc + SC.qFlags) | 1); }
    if (pc) m.w32(pc + PC.goal, 0);
  }
  function restore(N) {
    if (!N.supp) return;
    N.supp = false;
    if (validNpc(N)) { m.w32(N.obj + O.ai, N.orig); E.stats.restored++; }
  }
  const restoreAll = () => { for (const N of E.npcs.values()) restore(N); };

  function thiscall(addr, self, args = []) {   // mp.setAnim's register save/restore pattern
    const save = [m.eax, m.r32(m.Rp + 4), m.r32(m.Rp + 8)];
    m.w32(m.Rp + 4, self);
    try { return m.callGuest(addr, args, 'stdcall'); }
    finally { m.eax = save[0]; m.w32(m.Rp + 4, save[1]); m.w32(m.Rp + 8, save[2]); }
  }

  /* ------------------------------------------------------------------ host */
  function readEntry(N) {
    const o = N.obj, ctrl = mp.animCtrl(o);
    const anim = ctrl && m.r32(ctrl) === mp.A.animCtrlVtbl ? m.r32(ctrl + 8) : 0;
    return [N.key, r1(rf(o + O.pos)), r1(rf(o + O.pos + 4)), r1(rf(o + O.pos + 8)), r3(rf(o + O.yaw)), anim > 200 ? 0 : anim,
      r1(rf(o + O.health)), hasShield(N) ? 1 : 0];
  }
  function tickHost(local, t) {
    if (t - E.lastSend < 1 / SEND_HZ) return;
    E.lastSend = t;
    const full = t - E.lastFull >= FULL_S;
    if (full) { E.lastFull = t; E.lastSent.clear(); }
    const n = [];
    for (const N of E.npcs.values()) {
      if (!synced(N, local.l)) continue;
      const e = readEntry(N), s = e.join(',');
      if (!full && E.lastSent.get(N.key) === s) continue;
      E.lastSent.set(N.key, s);
      n.push(e);
      if (n.length >= MAX_N) break;
    }
    if (!n.length && !full) return;
    mp.send({ t: 'e', l: local.l, n, full: full ? 1 : 0 });
    E.stats.sent++;
  }

  /* ------------------------------------------------------------------ follower */
  function onMessage(msg) {
    if (msg.t !== 'e') return;
    const local = mp.local;
    if (!local || E.role !== 'follow' || msg.id !== E.host || msg.l !== local.l || !Array.isArray(msg.n)) { if (local) E.stats.ignored++; return; }
    E.stats.recv++;
    const t = now();
    E.recvAt = t; E.bytes += JSON.stringify(msg).length;
    for (const e of msg.n) {
      if (!Array.isArray(e) || e.length < 7 || typeof e[0] !== 'string') continue;
      const p = [+e[1] || 0, +e[2] || 0, +e[3] || 0];
      if (p.some(v => !Number.isFinite(v) || Math.abs(v) > 1e5)) continue;
      const snap = { p, r: Number.isFinite(+e[4]) ? +e[4] : 0, a: Math.min(200, Math.max(0, e[5] | 0)), hp: Math.min(1e4, Math.max(0, +e[6] || 0)), sh: e[7] !== 0 };
      let R = E.remote.get(e[0]);
      if (!R) { R = { cur: null }; E.remote.set(e[0], R); }
      const far = !R.cur || Math.hypot(snap.p[0] - R.cur.p[0], snap.p[1] - R.cur.p[1], snap.p[2] - R.cur.p[2]) > SNAP_DIST;
      R.prev = far ? snap : { p: R.cur.p, r: R.cur.r };
      R.target = snap; R.t0 = t; R.have = true;
      if (far) R.cur = { p: snap.p, r: snap.r };
    }
  }
  function tickFollow(local, t) {
    const mask = maskFor(local.l);
    for (const N of E.npcs.values()) {
      if (!synced(N, local.l)) { restore(N); continue; }
      suppress(N, mask);
      const R = E.remote.get(N.key);
      if (!R || !R.have) continue;
      const k = Math.min(1, (t - R.t0) / LERP_S), a = R.prev, b = R.target;
      const x = a.p[0] + (b.p[0] - a.p[0]) * k, y = a.p[1] + (b.p[1] - a.p[1]) * k, z = a.p[2] + (b.p[2] - a.p[2]) * k;
      let dr = b.r - a.r; dr -= Math.round(dr / (2 * Math.PI)) * 2 * Math.PI;
      R.cur = { p: [x, y, z], r: a.r + dr * k };
      try {
        mp.setPos(N.obj, x, y, z);
        wf(N.obj + O.yaw, R.cur.r);
        wf(N.obj + O.health, b.hp);
        if (b.a > 0) { const before = mp.stats.animCalls; mp.setAnim(N.obj, b.a); E.stats.animCalls += mp.stats.animCalls - before; }
        if (!b.sh && hasShield(N)) { thiscall(SHATTER_SHIELD, N.obj); E.stats.shatters++; }   // host says the shield is gone (fires once: ShatterShield clears the GUID)
        E.stats.applied++;
      } catch (e) { E.stats.errors++; if (E.stats.errors < 5) log('[mp.enemies] apply error: ' + e.message); }
    }
  }

  /* ------------------------------------------------------------------ role */
  function levelHost(level) {            // lowest relay id among the players on this level, me included
    let best = mp.id;
    for (const P of mp.players.values()) if (P.level === level && P.id < best) best = P.id;
    return best;
  }
  function setRole(role, host) {
    if (role === E.role && host === E.host) return;
    const was = E.role;
    if (was === 'follow' && role !== 'follow') restoreAll();
    if (role !== 'follow') E.remote.clear();
    if (role === 'host') { E.lastFull = -1e9; E.lastSent.clear(); }
    E.role = role; E.host = host;
    const P = host != null && mp.players.get(host);
    log(`[mp.enemies] ${was} -> ${role}` + (role === 'follow' ? ` (host #${host}${P ? ' ' + P.name : ''})` : role === 'host' ? ` (${E.npcs.size} NPCs)` : ''));
  }
  function onLevel(local) {               // level / Bilbo pointer changed: the old objects are gone, nothing to restore
    E.npcs.clear(); E.remote.clear(); E.lastSent.clear(); E.lastScan = -1e9;
    E.role = 'off'; E.host = null;
  }
  function onFrame(local, t) {
    if (!local || !mp.online()) { if (E.role !== 'off') { setRole('off', null); } return; }
    if (t - E.lastScan > SCAN_S) scan(t);
    if (LEVEL_LOCAL_AI.has(local.l)) { setRole('local', null); return; }
    const host = levelHost(local.l);
    setRole(host === mp.id ? 'host' : 'follow', host);
    if (E.role === 'host') tickHost(local, t); else tickFollow(local, t);
    if (t - E.lastUi > 1) ui(local, t);
  }

  /* ------------------------------------------------------------------ panel */
  let line = null;
  function ui(local, t) {
    E.lastUi = t;
    if (!panel) return;
    if (!line) { line = document.createElement('div'); line.id = 'mpEnemies'; line.style.cssText = 'font-size:12px;opacity:.85;margin-top:4px'; panel.append(line); }
    E.kbps = E.bytesT ? Math.round(E.bytes / (t - E.bytesT) / 100) / 10 : 0; E.bytes = 0; E.bytesT = t;
    let n = 0, s = 0; for (const N of E.npcs.values()) { if (synced(N, local.l)) n++; if (N.supp) s++; }
    const P = E.host != null && mp.players.get(E.host);
    line.textContent = E.role === 'host' ? `enemies: host, ${n} synced, ${SEND_HZ} Hz`
      : E.role === 'follow' ? `enemies: following #${E.host}${P ? ' ' + P.name : ''}, ${n} synced, ${s} AI off, ${E.remote.size} received${t - E.recvAt > 3 ? ' (no data)' : ''}`
      : E.role === 'local' ? 'enemies: local AI on this level' : 'enemies: -';
  }

  mp.listeners.push(onMessage);
  mp.frameHooks.push(onFrame);
  mp.levelHooks.push(onLevel);
  // debugging surface (window.hobbit.mp.ext.enemies)
  E.list = () => [...E.npcs.values()].map(N => ({ key: N.key, obj: N.obj, ok: validNpc(N), active: validNpc(N) && activeNpc(N), team: validNpc(N) ? team(N) : -1,
    ai: validNpc(N) ? m.r32(N.obj + O.ai) : 0, supp: N.supp, pos: [rf(N.obj + O.pos), rf(N.obj + O.pos + 4), rf(N.obj + O.pos + 8)], yaw: rf(N.obj + O.yaw),
    anim: (c => c ? m.r32(c + 8) : -1)(mp.animCtrl(N.obj)), hp: rf(N.obj + O.health), shield: hasShield(N), synced: mp.local ? synced(N, mp.local.l) : false,
    remote: E.remote.get(N.key) || null }));
  E.rescan = () => scan(now());
  E.levelHost = levelHost;
  return E;
}
