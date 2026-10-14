// Multiplayer for the web port: a JS port of the player sync of The Hobbit Synchrony v3
// (https://github.com/hobbit-kingdom/hobbit-synchrony-v3, BSD-3; Player.cpp, NPC.cpp, client.cpp readLocalPlayerState).
//
// Remote players are the level-authored "fake Bilbo" NPCs of the FAKE_HOBBITS layer (served by recomp/mp_assets.py),
// GUIDs 0D8AD910_E8851002..09, one per relay slot. Every frame (from W.onPresent, i.e. between two game frames, never
// inside the game's logic) this module:
//   1. reads the local Bilbo (g_pBilbo 0x0075BA3C: position +0x7C4, yaw +0x7AC, animation id [[+0x560]+8], frame +0x530,
//      weapon prop set 0x0075C738, level 0x00762B5C) and sends it to the relay at ~20 Hz;
//   2. for each remote player on the same level, finds its fake Bilbo by GUID in the object table (0x0076F648 = base,
//      0x0076F660 = count, 0x14-byte entries, object pointer first, GUID at object+8, type tag object+0x7C = 0x1C NPC)
//      and writes the interpolated position (+0x14, +0x20 and the animation root = anim+0x8-0xC4), yaw (+0x6C), health
//      (+0x290 pinned to 1000) and starts the animation through the engine's anim_track_controller::SetAnim 0x005434B0
//      (thiscall, (int anim, float blend=0.15), controller = [[[npc+0x304]+0x50]+0x10C], vtable 0x006F3C4C);
//   3. parks every fake Bilbo that no remote player drives at its authored spawn position (high above the level).
// Message format: docs/MULTIPLAYER.md.

export const FAKE_GUIDS = [...Array(8)].map((_, k) => [0x0D8AD910, (0xE8851002 + k) >>> 0]);
const WEAPON_GUIDS = [[2, 0xE885100D], [0, 0xE885100B], [1, 0xE885100A], [3, 0xE885100C]];   // Synchrony NPC::setWeapon
const A = {
  pBilbo: 0x0075BA3C, level: 0x00762B5C, levelLoop: 0x00760354, logicPaused: 0x007600F4, weapon: 0x0075C738,
  objTable: 0x0076F648, objCount: 0x0076F660, setAnim: 0x005434B0, animCtrlVtbl: 0x006F3C4C,
};
const SEND_HZ = 20, LERP_S = 1 / SEND_HZ, NPC_TYPE = 0x1C;
const Y_LIFT = new Set([21, 22, 36, 37, 38, 39]);   // Synchrony Player.cpp: these animations sit too low on the fake Bilbo

export function installMultiplayer({ m, W, log = console.log, onChange = () => {} }) {
  const dv = () => m._dv && m._dv.buffer === m.mem.buffer ? m._dv : new DataView(m.mem.buffer);
  const rf = a => dv().getFloat32(a, true), wf = (a, v) => dv().setFloat32(a, v, true);
  const f32bits = v => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return b.getUint32(0, true); };
  const now = () => performance.now() / 1000;

  const mp = {
    ws: null, status: 'offline', id: null, slot: null, name: 'Hobbit', room: 'main', url: '',
    players: new Map(),     // id -> {id, slot, name, level, have, prev, target, cur, t0, anim, weapon}
    npc: new Map(),         // slot -> {obj, spawn:[x,y,z], parked}
    local: null, lastSend: 0, lastKeep: 0, lastScan: -1e9, levelKey: 0, stats: { sent: 0, recv: 0, applied: 0, animCalls: 0, errors: 0 },
  };

  /* ------------------------------------------------------------------ game memory */
  const inLevel = () => m.r32(A.levelLoop) !== 0 && m.r32(A.pBilbo) !== 0;
  function findObjects(guids) {           // Synchrony HobbitProcessAnalyzer::findGameObjByGUID, many GUIDs in one pass
    const base = m.r32(A.objTable), n = m.r32(A.objCount), out = new Map();
    if (!base || n > 100000) return out;
    for (let i = 0; i < n; i++) {
      const o = m.r32(base + i * 0x14);
      if (!o) continue;
      const hi = m.r32(o + 12);
      if (hi !== 0x0D8AD910) continue;
      const lo = m.r32(o + 8);
      if (guids.has(lo)) out.set(lo, o);
    }
    return out;
  }
  const animCtrl = o => { const s1 = m.r32(o + 0x304), s2 = s1 && m.r32(s1 + 0x50); return s2 ? m.r32(s2 + 0x10C) : 0; };
  const validNpc = (o, lo) => o && m.r32(o + 8) === lo && m.r32(o + 12) === 0x0D8AD910 && m.r8(o + 0x7C) === NPC_TYPE;

  function scan() {
    const want = new Set(FAKE_GUIDS.map(g => g[1]));
    WEAPON_GUIDS.forEach(([, lo]) => want.add(lo));
    const found = findObjects(want);
    for (let k = 0; k < 8; k++) {
      const lo = FAKE_GUIDS[k][1], o = found.get(lo), old = mp.npc.get(k);
      if (!o) { mp.npc.delete(k); continue; }
      if (old && old.obj === o) continue;
      mp.npc.set(k, { obj: o, spawn: [rf(o + 0x14), rf(o + 0x18), rf(o + 0x1C)], anim: -1 });
    }
    mp.weaponSets = WEAPON_GUIDS.map(([id, lo]) => [id, found.has(lo) ? m.r32(found.get(lo) + 0x260) : 0]);
    mp.lastScan = now();
  }

  function readLocal() {
    const b = m.r32(A.pBilbo);
    const ap = m.r32(b + 0x560);
    let anim = ap ? m.r32(ap + 8) : 1;
    if (anim > 200) anim = 1;
    const raw = m.r32(A.weapon);
    let w = raw <= 3 ? raw : 2;
    for (const [id, set] of mp.weaponSets || []) if (set && set === raw) w = id;
    return { l: m.r32(A.level), p: [rf(b + 0x7C4), rf(b + 0x7C8), rf(b + 0x7CC)], r: rf(b + 0x7AC), a: anim, f: rf(b + 0x530), w };
  }

  function setPos(o, x, y, z) {
    const ctrl = animCtrl(o);
    for (const a of [o + 0x14, o + 0x20, ctrl ? ctrl + 8 - 0xC4 : 0]) if (a) { wf(a, x); wf(a + 4, y); wf(a + 8, z); }
  }
  function setAnim(o, anim) {             // NPC::setNPCAnim: engine call, only when the animation changes
    const ctrl = animCtrl(o);
    if (!ctrl || m.r32(ctrl) !== A.animCtrlVtbl) return false;
    if (m.r32(ctrl + 8) === anim) return true;
    const save = [m.eax, m.r32(m.Rp + 4), m.r32(m.Rp + 8)];
    m.w32(m.Rp + 4, ctrl);                 // ECX = this
    try { m.callGuest(A.setAnim, [anim, f32bits(0.15)], 'stdcall'); mp.stats.animCalls++; }
    finally { m.eax = save[0]; m.w32(m.Rp + 4, save[1]); m.w32(m.Rp + 8, save[2]); }
    return true;
  }
  function setWeapon(o, id) {              // NPC::setWeapon: copy the prop set pointer of the matching weapon NPC
    const set = (mp.weaponSets || []).find(([wid]) => wid === id);
    if (set && set[1]) m.w32(o + 0x260, set[1]);
  }

  /* ------------------------------------------------------------------ per frame */
  function tick() {
    if (!inLevel()) { mp.npc.clear(); mp.levelKey = 0; keepalive(); return; }
    const t = now();
    const key = m.r32(A.pBilbo) ^ m.r32(A.level) << 24;
    if (key !== mp.levelKey || t - mp.lastScan > (mp.npc.size ? 5 : 1)) { mp.levelKey = key; scan(); }
    const local = mp.local = readLocal();
    if (mp.status === 'online' && t - mp.lastSend >= 1 / SEND_HZ) {
      mp.lastSend = t; mp.lastKeep = t;
      send(Object.assign({ t: 's' }, local, { p: local.p.map(v => Math.round(v * 100) / 100), r: +local.r.toFixed(4), f: +local.f.toFixed(2) }));
    }
    const driven = new Set();
    for (const P of mp.players.values()) {
      const N = mp.npc.get(P.slot);
      if (!P.have || P.level !== local.l || !N) continue;
      if (!validNpc(N.obj, FAKE_GUIDS[P.slot][1])) { mp.lastScan = -1e9; continue; }
      driven.add(P.slot);
      const k = Math.min(1, (t - P.t0) / LERP_S), a = P.prev, b = P.target;
      const x = a.p[0] + (b.p[0] - a.p[0]) * k, y = a.p[1] + (b.p[1] - a.p[1]) * k, z = a.p[2] + (b.p[2] - a.p[2]) * k;
      let dr = b.r - a.r; dr -= Math.round(dr / (2 * Math.PI)) * 2 * Math.PI;
      P.cur = { p: [x, y, z], r: a.r + dr * k };
      try {
        setPos(N.obj, x, y + (Y_LIFT.has(b.a) ? 100 : 0), z);
        wf(N.obj + 0x6C, P.cur.r);
        wf(N.obj + 0x290, 1000);
        if (N.anim !== b.a && b.a > 0 && b.a <= 200 && setAnim(N.obj, b.a)) N.anim = b.a;
        if (N.weapon !== b.w) { setWeapon(N.obj, b.w); N.weapon = b.w; }
        mp.stats.applied++;
      } catch (e) { mp.stats.errors++; if (mp.stats.errors < 5) log('[mp] apply error: ' + e.message); }
    }
    for (const [slot, N] of mp.npc) {     // park the unused fake Bilbos where the level placed them
      if (driven.has(slot) || !validNpc(N.obj, FAKE_GUIDS[slot][1])) continue;
      setPos(N.obj, ...N.spawn);
      N.anim = -1;
    }
  }
  function keepalive() {
    const t = now();
    if (mp.status === 'online' && t - mp.lastKeep > 1) { mp.lastKeep = t; send({ t: 's', l: -1 }); }
  }

  /* ------------------------------------------------------------------ network */
  function send(o) { if (mp.ws && mp.ws.readyState === 1) { mp.ws.send(JSON.stringify(o)); mp.stats.sent++; } }
  function onMessage(msg) {
    mp.stats.recv++;
    const t = now();
    if (msg.t === 'welcome') {
      mp.id = msg.id; mp.slot = msg.slot; mp.status = 'online'; mp.players.clear();
      for (const p of msg.players) mp.players.set(p.id, { ...p, have: false });
      log(`[mp] connected as #${msg.id}, slot ${msg.slot} (${msg.guid}), room ${msg.room}, ${msg.players.length} other player(s)`);
    } else if (msg.t === 'join') {
      const P = mp.players.get(msg.id);
      if (P) Object.assign(P, { name: msg.name, slot: msg.slot }); else { mp.players.set(msg.id, { ...msg, have: false }); log(`[mp] ${msg.name} joined (slot ${msg.slot})`); }
    } else if (msg.t === 'leave') {
      const P = mp.players.get(msg.id); mp.players.delete(msg.id); if (P) log(`[mp] ${P.name} left`);
    } else if (msg.t === 's') {
      const P = mp.players.get(msg.id);
      if (!P) return;
      P.level = msg.l;
      if (msg.l < 0 || !msg.p) { P.have = false; return; }
      const snap = { p: msg.p, r: msg.r || 0, a: msg.a | 0, f: msg.f || 0, w: msg.w ?? 2 };
      const far = P.cur && Math.hypot(snap.p[0] - P.cur.p[0], snap.p[1] - P.cur.p[1], snap.p[2] - P.cur.p[2]) > 2000;
      P.prev = P.have && P.cur && !far ? { ...snap, p: P.cur.p, r: P.cur.r } : snap;   // Player::updateExistingPlayer
      P.target = snap; P.t0 = t; P.have = true; P.last = t;
      if (!P.cur || far) P.cur = { p: snap.p, r: snap.r };
    } else if (msg.t === 'full') {
      log('[mp] room is full (8 players)');
    }
    onChange(mp);
  }
  // Reconnect automatically when the connection drops (relay restart, Wi-Fi blip, a proxy closing an idle socket);
  // only Disconnect stops it. Backoff 1, 2, 4 ... 10 s.
  let retryTimer = null, retries = 0;
  const scheduleRetry = () => {
    if (!mp.want || retryTimer) return;
    const wait = Math.min(10000, 1000 * 2 ** retries++);
    mp.status = `reconnecting in ${Math.round(wait / 1000)} s`; onChange(mp);
    retryTimer = setTimeout(() => { retryTimer = null; if (mp.want) open(); }, wait);
  };
  const open = () => {
    const { url, room } = mp.want;
    mp.status = 'connecting'; onChange(mp);
    let ws;
    try { ws = new WebSocket(url); } catch (e) { mp.status = 'error: ' + e.message; onChange(mp); scheduleRetry(); return; }
    mp.ws = ws;
    ws.onopen = () => { retries = 0; ws.send(JSON.stringify({ t: 'hello', name: mp.name, room })); };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch (err) { log('[mp] bad message: ' + err.message); } };
    ws.onclose = () => { if (mp.ws === ws) { mp.ws = null; mp.id = 0; mp.status = 'offline'; mp.players.clear(); onChange(mp); log('[mp] disconnected'); scheduleRetry(); } };
    ws.onerror = () => { if (mp.ws === ws) { mp.status = 'error (is the relay running?)'; onChange(mp); } };
  };
  mp.connect = (url, name, room = 'main') => {
    mp.disconnect();
    mp.url = url; mp.name = name || 'Hobbit'; mp.room = room; mp.want = { url, room }; retries = 0;
    open();
  };
  mp.disconnect = () => {
    mp.want = null; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (mp.ws) { const ws = mp.ws; mp.ws = null; ws.close(); } mp.id = 0; mp.status = 'offline'; mp.players.clear(); onChange(mp);
  };
  mp.tick = () => { try { tick(); } catch (e) { mp.stats.errors++; if (mp.stats.errors < 5) log('[mp] tick error: ' + e.message); } };
  mp.findObjects = findObjects; mp.readLocal = () => inLevel() ? readLocal() : null; mp.scan = scan;

  const prev = W.onPresent;
  W.onPresent = n => { if (prev) prev(n); mp.tick(); };
  return mp;
}
