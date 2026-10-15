// Developer mode for the web port (docs/DEVMODE.md). Ports the ideas of the native proxy's src/core/devmode.cpp to
// the JS host: guest memory writes + calls into the game between two frames (W.onPresent), and the game's OWN
// developer code, which the retail exe still contains behind the flag 0x007600E8 (Ctrl+F flight with A up / D down,
// F4 fast forward, F5 wireframe, the developer SysMenu).
//
// Multiplayer transparency: every switch and every dev action is announced to the relay (recomp/mp_relay.py, message
// {"t":"dev","a":...}); the relay logs it (time, room, player, IP) and sends it to everyone in the room. While online,
// dev mode only turns on after the relay confirmed it (the relay's state is what shows the DEV badge), and it is
// switched off again if the room owner forbids it (allowDev). The page also watches the game's own dev variables
// (flight state, time scale, wireframe, invulnerability, SysMenu) and reports their changes, so the game's native keys
// and SysMenu toggles are announced too.

// Game globals (Hobbit-RE-notes.md, PLAYTESTER_GUIDE.md section 3, disassembly of FUN_005009c0 menu callbacks)
const A = {
  devFlag: 0x007600E8,     // the game's developer flag (enables its debug keys + full SysMenu)
  sysMenu: 0x0075FB98,     // 1 = Game_LevelLoop opens the SysMenu next frame
  pBilbo: 0x0075BA3C, health: 0x0075BDBC, maxHealth: 0x0075C714,
  invuln: 0x0075FBF4,      // SysMenu "Invulnerability" toggle (LAB_00501840)
  timeScale: 0x007607F0,   // global time scale; logic_mgr copies it (clamped 0..10) every frame; F4 sets 30 / 1
  logicMgr: 0x00771D78,    // logic_mgr: +0x04 scale, +0x30 max elapsed per frame (ms) -> raised with the speed
  wire: 0x00777ADC,        // F5 render mode (wireframe) toggle
  level: 0x00762B5C,       // current level index; ending a level loads index + 1
  levelLoop: 0x00760354,   // Game_LevelLoop runs while != 0
  exitNoSummary: 0x0076200C, // cleared by SysMenu "Exit Level" (LAB_00501710) together with levelLoop: no summary
  loading: 0x0076035C,
};
const B = { pos: 0x14, state: 0x8D4, yaw: 0x7AC, vtbl_move: 0x14 };   // Bilbo fields; Move = vtable slot 5 (0x0041e0b0)
const STATES = ['NULL', 'IDLE', 'FLY', 'RUN', 'SNEAK', 'JUMP', 'FALL', 'LAND', 'CROUCH_SLIDE', 'CLIMB_WALL', 'WALL_PULLUP',
  'EDGE_MOUNT', 'EDGE_GRAB', 'EDGE_PULLUP', 'EDGE_DROP_OFF', 'POLEJUMP', 'CHAIN_ATTACK', 'TARG_IDLE', 'TARG_RUN', 'TARG_JUMP',
  'STONE_ATTACK', 'FIRST_PERSON_LOOK', 'TARG_STRAFE_ATTACK', 'FORWARD_INAIR_ATTACK', 'BACKWARD_BLOCK', 'KNOCKBACK', 'DEATH',
  'DEATH_FALL', 'CLIMB_LADDER', 'LADDER_PULLUP', 'MINE_CART_RIDE', 'MINE_CART_SWING', 'CONV_LISTEN', 'CONV_TALK', 'CINEMATIC',
  'ROPE_CLIMB', 'BLOCKED', 'PUSH_BLOCK', 'SLIDING', 'LAUNCHING', 'HOISTING', 'USE', 'FIDGET', 'DEATH_WATER'];
export const LEVELS = ['Dream World', 'An Unexpected Party', 'Roast Mutton', 'Troll-hole', 'Over Hill and Under Hill',
  'Riddles in the Dark', 'Flies and Spiders', 'Barrels out of Bond', 'A Warm Welcome', 'Inside Information',
  'The Gathering of the Clouds', 'The Clouds Burst'];
const SPEEDS = [0.25, 0.5, 1, 2, 3, 4];
const DIK = { LCONTROL: 29, F: 33 };

export function installDevMode({ m, W, mp = null, log = console.log, ui = {} }) {
  const dv = () => new DataView(m.mem.buffer);
  const rf = a => dv().getFloat32(a, true), wf = (a, v) => dv().setFloat32(a, v, true);
  const keys = W.input.keys;
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem('hobbit.dev.' + k); localStorage.setItem('hobbit.dev.' + k, v); } catch { return null; } };
  const vec = m.heap.alloc(16);         // scratch vec3 for bilbo::Move

  const dev = {
    on: false, pending: false, god: false, speed: 1, overlay: ls('overlay') !== '0', slot: 1,
    slots: (() => { try { return JSON.parse(ls('slots') || '{}'); } catch { return {}; } })(),
    queue: [],                          // functions run inside W.onPresent (between two game frames)
    seen: null,                         // last observed game dev variables (for change reports)
    baseMax: null, fps: 0, onChange: () => {},
  };
  const online = () => !!(mp && mp.online && mp.online());
  const bilbo = () => { const b = m.r32(A.pBilbo); return b && m.r32(A.levelLoop) ? b : 0; };
  const pos = b => [rf(b + B.pos), rf(b + B.pos + 4), rf(b + B.pos + 8)];
  const r1 = v => Math.round(v * 10) / 10;
  const levelName = l => (l >= 0 && l < LEVELS.length ? LEVELS[l] : 'level ' + l);

  /* ---------------------------------------------------------------- reporting */
  // Every dev action goes through here: to the relay when online (it logs + broadcasts it, and echoes it back, which
  // is what the event log shows), or to the local event log when playing alone.
  function report(a, detail = {}) {
    const txt = describe({ a, name: mp ? mp.name : 'you', ...detail });
    log('[dev] ' + txt);
    if (online()) mp.sendDev(a, detail);
    else if (ui.onEvent) ui.onEvent({ t: 'dev', ts: new Date().toISOString(), id: 0, name: 'you (offline)', a, dev: dev.on, ...detail, local: true });
  }

  /* ---------------------------------------------------------------- on / off */
  function setOn(want, why = 'toggle') {
    if (want === dev.on && !dev.pending) return;
    if (want) {
      if (online()) {                    // wait for the relay: it may refuse (room allowDev=false)
        dev.pending = true; mp.sendDev('on', { via: why });
        clearTimeout(dev.pendT); dev.pendT = setTimeout(() => { if (dev.pending) { dev.pending = false; toast('Developer mode: no answer from the relay, still off'); changed(); } }, 4000);
        changed(); return;
      }
      activate(); report('on', { via: why });
    } else {
      dev.pending = false;
      if (!dev.on) { changed(); return; }
      deactivate(); report('off', { via: why });
    }
  }
  function activate() {
    dev.on = true; dev.pending = false;
    m.w32(A.devFlag, 1);
    dev.seen = null;
    changed();
  }
  function deactivate() {
    // restore everything the dev features changed; flight is left through the game's own Ctrl+F, which needs the flag
    const b = bilbo();
    if (b && m.r8(b + B.state) === 2) pressFly();
    setSpeed(1, true); setGod(false, true);
    m.w32(A.wire, 0);
    dev.on = false;
    setTimeout(() => { if (!dev.on) m.w32(A.devFlag, 0); }, 900);
    dev.seen = null;
    changed();
  }

  /* ---------------------------------------------------------------- actions */
  // Flight: the game's own developer key Ctrl+F (state FLY = 2; A = up, D = down, arrows/WASD move). Writing the fly
  // flag 0x00720F84 / Bilbo+0x364 does NOT enter FLY (also seen in the native proxy), so the keys are injected.
  function pressFly() {
    keys[DIK.LCONTROL] = 0x80;
    setTimeout(() => { keys[DIK.F] = 0x80; }, 120);
    setTimeout(() => { keys[DIK.F] = 0; }, 300);
    setTimeout(() => { keys[DIK.LCONTROL] = 0; }, 380);
  }
  function toggleFly() { if (!need()) return; if (!bilbo()) return toast('Fly: not in a level'); pressFly(); }   // reported by the watcher
  function setSpeed(s, quiet) {
    s = Math.max(0.1, Math.min(10, +s || 1));
    const mx = A.logicMgr + 0x30;
    if (dev.baseMax === null) dev.baseMax = rf(mx) || 100;
    wf(A.timeScale, s);
    wf(mx, dev.baseMax * Math.max(1, s));        // otherwise the per-frame clamp eats the speed-up at low fps
    dev.speed = s;
    if (dev.seen) dev.seen.ts = s;
    if (!quiet) report('speed', { x: s });
    changed();
  }
  function setGod(on, quiet) {
    dev.god = !!on;
    m.w32(A.invuln, dev.god ? 1 : 0);
    if (dev.seen) dev.seen.inv = dev.god ? 1 : 0;
    if (dev.god) refill(true);
    if (!quiet) report('god', { on: dev.god });
    changed();
  }
  function refill(quiet) {
    const mx = rf(A.maxHealth);
    if (mx > 0) wf(A.health, mx);
    if (!quiet) report('health', { hp: Math.round(mx) });
  }
  function moveTo(p, why) {                       // bilbo::Move(vec3*, 0) = vtable slot 5, thiscall; run between frames
    dev.queue.push(() => {
      const b = bilbo(); if (!b) return;
      for (let i = 0; i < 3; i++) wf(vec + 4 * i, p[i]);
      const save = [m.eax, m.r32(m.Rp + 4), m.r32(m.Rp + 8)];
      m.w32(m.Rp + 4, b);
      try { m.callGuest(m.r32(m.r32(b) + B.vtbl_move), [vec, 0], 'stdcall'); }
      finally { m.eax = save[0]; m.w32(m.Rp + 4, save[1]); m.w32(m.Rp + 8, save[2]); }
      if (why) report('teleport', why);
    });
  }
  function saveSlot(k = dev.slot) {
    if (!need()) return; const b = bilbo(); if (!b) return toast('Save position: not in a level');
    const l = m.r32(A.level), p = pos(b).map(r1);
    dev.slots[k] = { l, p }; ls('slots', JSON.stringify(dev.slots));
    toast(`Position slot ${k} saved (${levelName(l)})`); changed();
  }
  function loadSlot(k = dev.slot) {
    if (!need()) return; const b = bilbo(), s = dev.slots[k]; if (!b) return toast('Teleport: not in a level');
    if (!s) return toast(`Slot ${k} is empty`);
    if (s.l !== m.r32(A.level)) return toast(`Slot ${k} is in ${levelName(s.l)}`);
    moveTo(s.p, { slot: k, from: pos(b).map(r1), to: s.p });
  }
  function toPlayer(id) {
    if (!need()) return; const b = bilbo(); if (!b) return toast('Teleport: not in a level');
    const P = mp && mp.players.get(+id);
    if (!P || !P.have || !P.target) return toast('That player has no position yet');
    if (P.level !== m.r32(A.level)) return toast(`${P.name} is in ${levelName(P.level)}`);
    const t = P.target.p, to = [t[0] + 60, t[1], t[2] + 60].map(r1);      // next to them, not inside them
    moveTo(to, { to, from: pos(b).map(r1), player: P.name, pid: P.id });
  }
  // Level warp through the game's own path: SysMenu "Exit Level" clears 0x00760354 + 0x0076200C (no summary/vendor
  // screens), and the level loop then loads (current index) + 1. Waits for normal play like devmode.cpp: ending a level
  // during a cutscene or while loading crashes the original too.
  let warpTo = -1, safe = 0;
  function warp(l) {
    if (!need()) return;
    l = Math.max(0, Math.min(LEVELS.length - 1, l | 0));
    warpTo = l; safe = 0;
    toast(`Warp to ${levelName(l)} requested (waits for normal play)`);
  }
  function tickWarp() {
    if (warpTo < 0) return;
    const b = bilbo(), st = b ? m.r8(b + B.state) : 0;
    const ok = b && m.r32(A.loading) === 0 && st !== 0 && st !== 34 && W.input.padMode() === 'game';
    safe = ok ? safe + 1 : 0;
    if (safe < 20) return;                    // ~20 frames of normal play
    const from = m.r32(A.level), l = warpTo; warpTo = -1;
    m.w32(A.level, l - 1);
    m.w32(A.levelLoop, 0); m.w32(A.exitNoSummary, 0);
    report('warp', { level: l, to: levelName(l), from: levelName(from) });
  }
  function need() { if (!dev.on) { toast('Turn developer mode on first (F10)'); return false; } return true; }

  /* ---------------------------------------------------------------- watcher (native dev keys / SysMenu) */
  function watch() {
    const b = bilbo();
    const cur = { fly: b ? m.r8(b + B.state) === 2 : false, ts: rf(A.timeScale), wire: m.r32(A.wire) ? 1 : 0, inv: m.r32(A.invuln) ? 1 : 0, sys: m.r32(A.sysMenu) ? 1 : 0 };
    const s = dev.seen; dev.seen = cur;
    if (!s) return;
    if (cur.fly !== s.fly && b) report('fly', { on: cur.fly });
    if (cur.ts !== s.ts) { report('speed', { x: Math.min(10, cur.ts), native: true }); }
    if (cur.wire !== s.wire) report('wire', { on: !!cur.wire });
    if (cur.inv !== s.inv) { dev.god = !!cur.inv; report('god', { on: !!cur.inv, native: true }); }
    if (cur.sys && !s.sys) report('sysmenu', { note: 'opened the developer SysMenu' });
  }

  /* ---------------------------------------------------------------- per frame */
  let fpsN = 0, fpsT = performance.now(), hpT = 0;
  const prev = W.onPresent;
  W.onPresent = n => {
    if (prev) prev(n);
    fpsN++; const now = performance.now();
    if (now - fpsT >= 1000) { dev.fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
    try {
      if (dev.on) {
        m.w32(A.devFlag, 1);
        while (dev.queue.length) dev.queue.shift()();
        watch();
        tickWarp();
        if (dev.god && now - hpT > 250) { hpT = now; refill(true); m.w32(A.invuln, 1); }
      } else dev.queue.length = 0;
      if (ui.overlay && (dev.on || dev.pending) && dev.overlay && n % 3 === 0) ui.overlay(overlayText());
    } catch (e) { log('[dev] ' + e.message); }
  };

  function overlayText() {
    const b = bilbo(), st = b ? m.r8(b + B.state) : -1;
    const l = m.r32(A.level);
    const lines = [`DEV MODE${dev.pending ? ' (waiting for relay)' : ''}   ${dev.fps.toFixed(1)} fps`];
    if (b) {
      const p = pos(b);
      lines.push(`pos ${p.map(v => v.toFixed(1)).join(', ')}  yaw ${rf(b + B.yaw).toFixed(2)}`);
      lines.push(`state ${st} ${STATES[st] || '?'}  hp ${rf(A.health).toFixed(0)}/${rf(A.maxHealth).toFixed(0)}`);
    } else lines.push('no Bilbo (menu / loading)');
    lines.push(`level ${l} ${levelName(l)}  FE ${m.r32(0x762B58)}  mode ${W.input.padMode()}`);
    lines.push(`speed x${Math.min(10, rf(A.timeScale)).toFixed(2)}  god ${dev.god ? 'on' : 'off'}  wire ${m.r32(A.wire) ? 'on' : 'off'}` + (warpTo >= 0 ? `  warp -> ${warpTo}` : ''));
    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- relay hooks */
  if (mp) {
    const prevDev = mp.onDev, prevWel = mp.onWelcome;
    mp.onDev = msg => {
      if (prevDev) prevDev(msg);
      if (msg.t === 'dev' && msg.id === mp.id) {
        if (msg.a === 'on' && msg.dev && (dev.pending || !dev.on)) { clearTimeout(dev.pendT); activate(); }
        else if (msg.a === 'denied') { dev.pending = false; if (dev.on) deactivate(); toast('Developer mode is not allowed in this room (room owner)'); changed(); }
        else if (msg.a === 'off' && msg.forced && dev.on) { deactivate(); toast(`Developer mode switched off by ${msg.by || 'the room owner'}`); }
      }
      if (ui.onEvent) ui.onEvent(msg);
    };
    mp.onWelcome = msg => {
      if (prevWel) prevWel(msg);
      if (dev.on) { dev.pending = true; mp.sendDev('on', { via: 'reconnect' }); }   // the new room learns it at once
      if (ui.onWelcome) ui.onWelcome(msg);
    };
  }

  /* ---------------------------------------------------------------- keys */
  // Capture phase on window: runs before web/game.mjs's handler, so the dev keys never reach the game. The game's own
  // dev keys (Ctrl+F, F4, F5) are passed through; they only work while the dev flag is set.
  const ours = {
    F10: () => setOn(!(dev.on || dev.pending), 'F10'),
    F2: () => { dev.overlay = !dev.overlay; ls('overlay', dev.overlay ? '1' : '0'); if (!dev.overlay && ui.overlay) ui.overlay(null); changed(); },
    F6: () => need() && setGod(!dev.god),
    F7: () => need() && refill(),
    F8: () => saveSlot(),
    F9: () => loadSlot(),
    BracketLeft: () => need() && setSpeed(SPEEDS[Math.max(0, SPEEDS.findIndex(s => s >= dev.speed) - 1)]),
    BracketRight: () => need() && setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.findIndex(s => s > dev.speed))] ?? SPEEDS[SPEEDS.length - 1]),
  };
  window.addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const f = ours[e.code];
    if (!f || (e.code !== 'F10' && !dev.on && !dev.pending)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) f();
  }, true);
  window.addEventListener('keyup', e => { if (ours[e.code] && (dev.on || e.code === 'F10')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);

  /* ---------------------------------------------------------------- misc */
  function toast(s) { log('[dev] ' + s); if (ui.toast) ui.toast(s); }
  function changed() { try { dev.onChange(dev); } catch { /* ui */ } }

  Object.assign(dev, { setOn, toggleFly, setSpeed, setGod, refill, saveSlot, loadSlot, toPlayer, warp, moveTo, report, SPEEDS,
    state: () => { const b = bilbo(); return b ? { st: m.r8(b + B.state), pos: pos(b).map(r1), level: m.r32(A.level), hp: rf(A.health) } : null; } });
  return dev;
}

/** One human-readable line for a dev event (relay message or local). */
export function describe(ev) {
  const n = ev.name || '?';
  const lv = l => (l >= 0 && l < LEVELS.length ? LEVELS[l] : 'level ' + l);
  switch (ev.a) {
    case 'on': return `${n} enabled developer mode`;
    case 'off': return `${n} disabled developer mode` + (ev.forced ? ` (forced by ${ev.by || 'room owner'})` : '');
    case 'denied': return `${n}: developer mode refused (room does not allow it)`;
    case 'fly': return `${n} turned flying ${ev.on ? 'on' : 'off'}`;
    case 'speed': return `${n} set game speed x${ev.x}` + (ev.native ? ' (game key / SysMenu)' : '');
    case 'god': return `${n} turned god mode ${ev.on ? 'on' : 'off'}`;
    case 'health': return `${n} refilled health`;
    case 'teleport': return ev.player ? `${n} teleported to ${ev.player}` : `${n} teleported` + (ev.slot ? ` to saved position ${ev.slot}` : '') + (ev.to ? ` (${ev.to.join(', ')})` : '');
    case 'warp': return `${n} warped to ${ev.to || lv(ev.level)}`;
    case 'wire': return `${n} turned wireframe ${ev.on ? 'on' : 'off'}`;
    case 'sysmenu': return `${n} opened the developer SysMenu`;
    case 'flag': return `relay flagged ${n}: ${ev.note || 'suspicious movement'}`;
    default: return `${n}: ${ev.a}` + (ev.note ? ` (${ev.note})` : '');
  }
}
