// Browser runner: the recompiled Meridian.exe (recomp/out/hobbit_flat.wasm) on JSPI, rendering through web/d3d8.
// Game files come read-only from recomp/serve_game.py (HTTP Range); settings live in memory.
import { Machine, RealClock, hex, Trap } from '../recomp/host/machine.mjs';
import { VFS, HttpBackend, MemBackend } from '../recomp/host/vfs.mjs';
import { Win32 } from '../recomp/host/win32.mjs';
import { installDirectInput, installDirectSound, installD3D8 } from '../recomp/host/dx.mjs';
import * as com from './d3d8/com.js';
import { installMultiplayer } from '../recomp/host/mp.mjs';

const q = new URLSearchParams(location.search);
// game data server: ?data=..., else the host this page was opened from, on the next port (on this machine that is
// 127.0.0.1:5191 as before)
// Over HTTPS (Tailscale serve in docker-compose.yml) the ports are 443 page / 8443 data / 10000 relay.
const HTTPS = location.protocol === 'https:';
const DATA = q.get('data') || (HTTPS ? `https://${location.hostname}:8443`
  : `${location.protocol}//${location.hostname || '127.0.0.1'}:${(+location.port || 80) + 1}`);
const snaps = (q.get('snap') || '').split(',').filter(Boolean).map(Number);
const $ = id => document.getElementById(id);
const logEl = $('log'), statEl = $('stat');
const lines = [];
const log = s => { lines.push(s); if (lines.length > 400) lines.shift(); logEl.textContent = lines.slice(-60).join('\n'); logEl.scrollTop = 1e9; };
window.hobbit = { lines };

// KeyboardEvent.code -> DirectInput scan code (DIK_*)
const DIK = { Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24,
  KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29, KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35,
  KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43, KeyZ: 44, KeyX: 45, KeyC: 46,
  KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57,
  CapsLock: 58, F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88, NumpadEnter: 156,
  ControlRight: 157, NumpadDivide: 181, AltRight: 184, Home: 199, ArrowUp: 200, PageUp: 201, ArrowLeft: 203, ArrowRight: 205, End: 207,
  ArrowDown: 208, PageDown: 209, Insert: 210, Delete: 211, Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75, Numpad5: 76,
  Numpad6: 77, Numpad7: 71, Numpad8: 72, Numpad9: 73 };

async function main() {
  if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') {
    log('JSPI (WebAssembly.Suspending / promising) is not available in this browser. Chrome 137+ has it by default; ' +
      'older Chrome: enable chrome://flags/#enable-experimental-webassembly-jspi. Not falling back to Asyncify.');
    statEl.textContent = 'no JSPI'; return;
  }
  const t0 = performance.now();
  statEl.textContent = 'loading...';
  const [module, exe, manifest, funcsTxt] = await Promise.all([
    WebAssembly.compileStreaming(fetch('../recomp/out/hobbit_flat.wasm')),
    fetch(DATA + '/Meridian.exe').then(r => { if (!r.ok) throw new Error('game server: ' + r.status); return r.arrayBuffer(); }).then(b => new Uint8Array(b)),
    fetch(DATA + '/__manifest').then(r => r.json()),
    fetch('../recomp/out/funcs.txt').then(r => r.text()),
  ]);
  log(`wasm compiled + data manifest (${manifest.files.length} files) in ${(performance.now() - t0).toFixed(0)} ms`);
  const canvas = $('screen');
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, alpha: false });
  if (!gl) { log('no WebGL2'); return; }

  const m = new Machine({ wasm: module, exe, clock: new RealClock(), log });
  await m.init();
  const httpBe = new HttpBackend(DATA, manifest);
  const vfs = new VFS(httpBe, new MemBackend());
  const W = new Win32(m, vfs, { onDebug: s => log('[dbg] ' + s.replace(/\s+$/, '')), knownDlls: ['shfolder.dll'] });
  const S = W.table();
  installDirectInput(m, W, S); installDirectSound(m, W, S);
  await installD3D8(m, W, S, gl, com);
  const missing = m.bindImports(S);
  log(`imports bound ${m.pe.imports.length - missing.length}/${m.pe.imports.length}`);
  m.onProbe = a => {
    if (a === 0x00650010) { const p = m.r32(m.esp + 4); if (p > 0x6e9000 && p < 0x818000) { const s = m.cstr(p, 200); if (/^[\x20-\x7e]{4,}/.test(s)) log('[x_Log] ' + s); } }
    else if (a === 0x004fe3e0) log('== RunFrontEnd');
    else if (a === 0x004fe5a0) log('== LoadLevel');
  };

  // milestones from the entered-function bitmap
  const order = funcsTxt.split(/\r?\n/).filter(Boolean).map(x => parseInt(x, 16));
  const ordinal = new Map(order.map((a, i) => [a, i])), visAt = m.X.rt_vis();
  const MS = [[0x004fd630, 'WinMain'], [0x004fdb90, 'EngineInit'], [0x004fb310, 'LegalScreen'], [0x0052ae30, 'PlayMovie'], [0x004fe3e0, 'RunFrontEnd'], [0x0051e860, 'PressStart']];
  const reached = new Set();
  let fpsT = performance.now(), fpsN = 0, fps = 0;
  W.onPresent = n => {
    for (const [a, name] of MS) if (!reached.has(a) && m.r8(visAt + ordinal.get(a))) { reached.add(a); log(`== reached ${name} at Present ${n}`); }
    fpsN++; const now = performance.now(); if (now - fpsT > 1000) { fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
    if (n % 10 === 0) statEl.textContent = `Present ${n} | ${fps.toFixed(1)} fps | FE state ${m.r32(0x762b58)} | ` +
      `http ${httpBe.fetches} req ${(httpBe.bytes / 1e6).toFixed(1)} MB | heap ${(m.heap.inuse / 1e6).toFixed(0)} MB`;
    window.hobbit.presents = n; window.hobbit.feState = m.r32(0x762b58);
    if (snaps.includes(n)) {   // ?snap=N,M: keep a copy of those frames under the canvas (proof screenshots)
      const img = new Image(); img.src = canvas.toDataURL('image/png'); img.title = 'Present ' + n; img.width = 320;
      $('snaps').append(img); window.hobbit.snaps = (window.hobbit.snaps || []).concat([[n, img.src]]);
    }
  };

  setupMultiplayer(m, W);

  // input -> DirectInput state
  const keys = W.input.keys;
  window.addEventListener('keydown', e => { const k = DIK[e.code]; if (k) { keys[k] = 0x80; e.preventDefault(); } });
  window.addEventListener('keyup', e => { const k = DIK[e.code]; if (k) { keys[k] = 0; e.preventDefault(); } });
  // mouse: DirectInput deltas (camera) + window messages and GetCursorPos (the menus read the cursor from the window)
  const gameXY = e => {
    const r = canvas.getBoundingClientRect(), win = W.windows.get(W.mainHwnd) || {};
    const gw = win.w || canvas.width, gh = win.h || canvas.height;
    return [Math.max(0, Math.min(gw - 1, Math.round((e.clientX - r.left) * gw / r.width))),
            Math.max(0, Math.min(gh - 1, Math.round((e.clientY - r.top) * gh / r.height)))];
  };
  const BTN = [[0x201, 0x202], [0x207, 0x208], [0x204, 0x205]];   // left, middle, right: WM_xBUTTONDOWN / UP
  const mk = () => (W.input.mouse.b[0] ? 1 : 0) | (W.input.mouse.b[1] ? 2 : 0) | (W.input.mouse.b[2] ? 0x10 : 0);
  canvas.addEventListener('mousemove', e => {
    W.input.mouse.dx += e.movementX; W.input.mouse.dy += e.movementY;
    const [x, y] = gameXY(e); W.mouseEvent(0x200, x, y, mk());
  });
  canvas.addEventListener('mousedown', e => {
    canvas.focus(); const bi = e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
    W.input.mouse.b[bi] = 1; (W.input.mouse.latch ||= [0, 0, 0, 0])[bi] = 3;
    const [x, y] = gameXY(e), b = BTN[e.button]; if (b) W.mouseEvent(b[0], x, y, mk());
  });
  window.addEventListener('mouseup', e => {
    W.input.mouse.b[e.button === 2 ? 1 : e.button === 1 ? 2 : 0] = 0;
    const [x, y] = gameXY(e), b = BTN[e.button]; if (b) W.mouseEvent(b[1], x, y, mk());
  });
  // gamepad: Gamepad API, read whenever the game polls its DirectInput joystick (recomp/host/dx.mjs padState)
  W.input.readPad = () => {
    const g = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(p => p && p.connected);
    if (!g) return null;
    const val = i => (g.buttons[i] ? g.buttons[i].value : 0);
    return { axes: [g.axes[0] || 0, g.axes[1] || 0, g.axes[2] || 0, g.axes[3] || 0, val(6), val(7)],
             buttons: g.buttons.map(b => b.pressed || b.value > 0.5) };
  };
  // menus vs gameplay: gameplay = Game_LevelLoop running (0x760354), logic not paused (0x7600f4) and the in-game pause
  // menu closed (0x76321c: a field of the pause object, 0 -> 1 while it is open; found by diffing the globals)
  // cutscene = Bilbo's input disabled by a cinema (g_pBilbo 0x75ba3c, +0x44c set by 00422980 "CINEMA: Bilbo Input set FALSE")
  W.input.padMode = () => {
    if (!m.r32(0x760354) || m.r32(0x7600f4) || m.r32(0x76321c)) return 'menu';
    const b = m.r32(0x75ba3c);
    return b && m.r32(b + 0x44c) === 1 ? 'cutscene' : 'game';
  };
  // pad buttons that act as keys (held while the button is held). Gameplay: Start = Esc (pause). Cutscenes: Start = Enter
  // ("Press Enter to skip"). Menus and movies: Start = Enter (skips movies), B = Esc (back). Enter is not sent in gameplay
  // because it is bound to Use there. A timer, not rAF, so it keeps working in a background tab.
  const padHeld = { 1: false, 28: false };
  setInterval(() => {
    const g = W.input.readPad(), mode = W.input.padMode(), menu = mode === 'menu', want = { 1: false, 28: false };
    if (g) { if (g.buttons[9]) want[mode === 'game' ? 1 : 28] = true; if (menu && g.buttons[1]) want[1] = true; }
    for (const k of [1, 28]) if (want[k] !== padHeld[k]) { padHeld[k] = want[k]; keys[k] = want[k] ? 0x80 : 0; }
  }, 16);
  const padEl = $('pad');
  const padName = e => { if (padEl) padEl.textContent = e.type === 'gamepadconnected' ? 'Gamepad: ' + e.gamepad.id.replace(/\s*\(.*$/, '') : ''; log((e.type === 'gamepadconnected' ? 'gamepad connected: ' : 'gamepad disconnected: ') + e.gamepad.id); };
  window.addEventListener('gamepadconnected', padName); window.addEventListener('gamepaddisconnected', padName);
  canvas.addEventListener('wheel', e => { W.input.mouse.dz -= Math.sign(e.deltaY) * 120; e.preventDefault(); }, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.hobbit.press = (code, ms = 150) => { const k = DIK[code]; keys[k] = 0x80; setTimeout(() => { keys[k] = 0; }, ms); };
  window.hobbit.m = m; window.hobbit.W = W;

  log(`starting at entry ${hex(m.pe.entry)}`);
  try {
    const r = await m.startMain(m.pe.entry);
    log('process ended: ' + JSON.stringify(r));
  } catch (e) {
    log(`*** stopped: ${e.message} (thread ${e.thread || '?'})`);
    if (!(e instanceof Trap)) log(String(e.stack).split('\n').slice(0, 5).join('\n'));
    log(`last_ip ${hex(m.lastIp)} esp ${hex(m.esp)} [esp] ${hex(m.r32(m.esp))}`);
    statEl.textContent += ' | STOPPED';
  }
}
// multiplayer panel (recomp/host/mp.mjs; relay = recomp/mp_relay.py, default port = this page's port + 2)
// URL: ?mp=host:port&name=Bilbo&room=main connects automatically.
function setupMultiplayer(m, W) {
  const LEVELS = ['Dream World', 'An Unexpected Party', 'Roast Mutton', 'Troll-hole', 'Over Hill and Under Hill', 'Riddles in the Dark',
    'Flies and Spiders', 'Barrels out of Bond', 'A Warm Welcome', 'Inside Information', 'The Gathering of the Clouds', 'The Clouds Burst'];
  const levelName = l => l === undefined || l < 0 ? 'menu' : (LEVELS[l] || 'level ' + l);
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem('hobbit.mp.' + k); localStorage.setItem('hobbit.mp.' + k, v); } catch { return null; } };
  const nameEl = $('mpName'), urlEl = $('mpUrl'), roomEl = $('mpRoom'), statusEl = $('mpStatus'), listEl = $('mpPlayers');
  const defHost = location.protocol === 'https:' ? `wss://${location.hostname}:10000`
    : `${location.hostname || '127.0.0.1'}:${(+location.port || 80) + 2}`;
  nameEl.value = q.get('name') || store('name') || 'Hobbit';
  urlEl.value = q.get('mp') || store('url') || defHost;
  roomEl.value = q.get('room') || store('room') || 'main';
  const render = mp => {
    const me = mp.local ? levelName(mp.local.l) : 'menu';
    statusEl.textContent = `${mp.status}` + (mp.id ? ` | you: #${mp.id} slot ${mp.slot} (${me})` : '') +
      ` | fake Bilbos found ${mp.npc.size}/8 | sent ${mp.stats.sent} recv ${mp.stats.recv}`;
    listEl.replaceChildren(...[...mp.players.values()].map(p => {
      const li = document.createElement('li');
      const same = mp.local && p.level === mp.local.l;
      li.textContent = `${p.name} (slot ${p.slot}) - ${levelName(p.level)}` + (same && p.have ? ' - here' : '');
      return li;
    }));
  };
  const mp = installMultiplayer({ m, W, log, onChange: render });
  window.hobbit.mp = mp;
  setInterval(() => render(mp), 1000);
  const wsUrl = v => /^wss?:\/\//.test(v) ? v : (location.protocol === 'https:' ? 'wss://' : 'ws://') + v;
  const go = () => { store('name', nameEl.value); store('url', urlEl.value); store('room', roomEl.value); mp.connect(wsUrl(urlEl.value.trim()), nameEl.value.trim(), roomEl.value.trim() || 'main'); };
  $('mpConnect').onclick = go;
  $('mpDisconnect').onclick = () => mp.disconnect();
  for (const el of [nameEl, urlEl, roomEl]) el.addEventListener('keydown', e => e.stopPropagation());   // typing is not game input
  if (q.get('mp')) go();
}

main().catch(e => { log('fatal: ' + e.message + '\n' + e.stack); });
