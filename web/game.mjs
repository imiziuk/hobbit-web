// Browser runner: the recompiled Meridian.exe (recomp/out/hobbit_flat.wasm) on JSPI, rendering through web/d3d8.
// Game files come read-only from recomp/serve_game.py (HTTP Range); settings live in memory.
import { Machine, RealClock, hex, Trap } from '../recomp/host/machine.mjs';
import { VFS, HttpBackend, MemBackend } from '../recomp/host/vfs.mjs';
import { Win32 } from '../recomp/host/win32.mjs';
import { installDirectInput, installDirectSound, installD3D8 } from '../recomp/host/dx.mjs';
import * as com from './d3d8/com.js';
import { installMultiplayer } from '../recomp/host/mp.mjs';
import { installTouch, mergePads } from './touch.mjs';

const q = new URLSearchParams(location.search);
// Where the game data and the relay are. ?data= / ?mp= always win. Otherwise:
// - single-origin server (start.py --single, the Docker default; needed behind Cloudflare Access): <repo>/__mode answers,
//   data = <repo>/data, relay = ws(s)://<repo>/relay, all on the page's own origin;
// - the 3-port layout: data on the page's port + 1 (127.0.0.1:5191), relay on port + 2;
//   over HTTPS (older Tailscale serve setup) 443 page / 8443 data / 10000 relay.
const HTTPS = location.protocol === 'https:';
const ROOT = new URL('..', location.href);            // the repo root (this page is <root>/web/game.html)
let DATA = q.get('data');
let MODE = null;                                       // /__mode answer in single-origin mode
async function resolveEndpoints() {
  try {
    const r = await fetch(new URL('__mode', ROOT), { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) MODE = await r.json();
  } catch { /* plain static server: no /__mode */ }
  if (!DATA) DATA = MODE && MODE.single ? new URL(MODE.data, ROOT).href.replace(/\/$/, '')
    : HTTPS ? `https://${location.hostname}:8443`
    : `${location.protocol}//${location.hostname || '127.0.0.1'}:${(+location.port || 80) + 1}`;
}
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

// Phone UI: "Phone controls" checkbox (URL ?touch=1|0, else remembered, else on for a coarse primary pointer), the touch
// overlay (web/touch.mjs), Fullscreen + landscape lock, and the panels drawer. Works before the game starts.
const phone = { mode: () => 'menu' };
function setupPhoneUI() {
  const box = $('touchOn'), stage = $('stage');
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };
  const qt = q.get('touch'), saved = ls('hobbit.touch');
  const coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const on0 = qt === '1' || qt === 'true' ? true : qt === '0' || qt === 'false' ? false : saved !== null ? saved === '1' : coarse;
  phone.touch = installTouch(stage, () => phone.mode());
  const apply = (on, remember) => {
    box.checked = on; phone.touch.setEnabled(on);
    document.body.classList.toggle('touch', on); if (!on) document.body.classList.remove('panels');
    if (remember) ls('hobbit.touch', on ? '1' : '0');
  };
  box.addEventListener('change', () => apply(box.checked, true));
  apply(on0, false);
  $('panelsBtn').onclick = () => document.body.classList.add('panels');
  $('panelsClose').onclick = () => document.body.classList.remove('panels');
  const fsBtn = $('fsBtn'), fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  fsBtn.onclick = async () => {
    try {
      if (fsEl()) { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      // phone mode: the whole page (so the panels drawer still opens); desktop: just the game
      const t = document.body.classList.contains('touch') ? document.documentElement : stage;
      await (t.requestFullscreen || t.webkitRequestFullscreen).call(t, { navigationUI: 'hide' });
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(() => {});
    } catch (e) { log('fullscreen: ' + e.message); }
  };
  const fsChange = () => { fsBtn.textContent = fsEl() ? 'Exit fullscreen' : 'Fullscreen'; };
  document.addEventListener('fullscreenchange', fsChange); document.addEventListener('webkitfullscreenchange', fsChange);
  if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) fsBtn.hidden = true;   // e.g. iPhone Safari
}

async function main() {
  setupPhoneUI();
  if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') {
    log('JSPI (WebAssembly.Suspending / promising) is not available in this browser. Chrome 137+ has it by default; ' +
      'older Chrome: enable chrome://flags/#enable-experimental-webassembly-jspi. Not falling back to Asyncify.');
    const nj = $('nojspi'); nj.hidden = false;
    nj.innerHTML = '<strong>This browser cannot run the game.</strong> It needs WebAssembly JSPI, which is in ' +
      '<strong>Chrome 137+ (or Edge 137+) on Android or desktop</strong>. iPhone and iPad browsers (Safari, and Chrome on iOS, ' +
      'which uses the same engine) do not support it yet.';
    document.body.classList.remove('touch'); if (phone.touch) phone.touch.setEnabled(false);
    statEl.textContent = 'no JSPI'; return;
  }
  const t0 = performance.now();
  statEl.textContent = 'loading...';
  await resolveEndpoints();
  log(`game data: ${DATA}` + (MODE && MODE.single ? ' (single-origin server)' : ''));
  // Meridian.exe is read through the HttpBackend like every other game file, so it comes from the persistent block
  // cache on later visits (recomp/host/vfs.mjs)
  const manifestP = fetch(DATA + '/__manifest').then(r => { if (!r.ok) throw new Error('game server: ' + r.status); return r.json(); });
  const httpBeP = manifestP.then(mf => new HttpBackend(DATA, mf));
  const [module, exe, manifest, httpBe, funcsTxt] = await Promise.all([
    WebAssembly.compileStreaming(fetch('../recomp/out/hobbit_flat.wasm')),
    httpBeP.then(be => {
      const f = be.open('Meridian.exe', {});
      if (!f) throw new Error('game server: no Meridian.exe in the game folder');
      return f.read(0, f.size());
    }),
    manifestP, httpBeP,
    fetch('../recomp/out/funcs.txt').then(r => r.text()),
  ]);
  log(`wasm compiled + data manifest (${manifest.files.length} files) in ${(performance.now() - t0).toFixed(0)} ms`);
  const canvas = $('screen');
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, alpha: false });
  if (!gl) { log('no WebGL2'); return; }

  const m = new Machine({ wasm: module, exe, clock: new RealClock(), log });
  await m.init();
  const vfs = new VFS(httpBe, new MemBackend());
  window.hobbit.http = httpBe;
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
      `http ${httpBe.fetches} req ${(httpBe.bytes / 1e6).toFixed(1)} MB` + (httpBe.storeHits ? ` (+${httpBe.storeHits} cached blocks)` : '') + ` | heap ${(m.heap.inuse / 1e6).toFixed(0)} MB`;
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
  // touch / pen on the canvas (phone menus: the overlay's drag areas are off there): a tap = move cursor + left click.
  // Like a real mouse, the cursor arrives first and the menu highlights the item before the button goes down: the
  // down is sent 120 ms after the move (a few frames), and the up at least 100 ms after the down, so the game's
  // per-frame polling cannot miss a quick tap.
  // preventDefault on pointerdown stops the browser's compatibility mouse events, so the mouse handlers don't double it.
  let touchId = null, touchXY = [0, 0], downAt = 0, downTimer = 0, upPending = false;
  const sendDown = () => {
    downTimer = 0; downAt = performance.now();
    W.input.mouse.b[0] = 1; (W.input.mouse.latch ||= [0, 0, 0, 0])[0] = 3;
    W.mouseEvent(0x201, touchXY[0], touchXY[1], 1);
    if (upPending) setTimeout(sendUp, 100);
  };
  const sendUp = () => { upPending = false; W.input.mouse.b[0] = 0; W.mouseEvent(0x202, touchXY[0], touchXY[1], 0); };
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || touchId !== null || downTimer || upPending) return;
    e.preventDefault(); canvas.focus({ preventScroll: true }); touchId = e.pointerId;
    touchXY = gameXY(e); W.mouseEvent(0x200, touchXY[0], touchXY[1], 0);
    downTimer = setTimeout(sendDown, 120);
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerId !== touchId) return;
    e.preventDefault(); touchXY = gameXY(e); W.mouseEvent(0x200, touchXY[0], touchXY[1], downTimer ? 0 : 1);
  });
  const touchUp = e => {
    if (e.pointerId !== touchId) return;
    touchId = null;
    if (downTimer) { upPending = true; return; }             // the down is still queued: sendDown schedules the up
    const wait = 100 - (performance.now() - downAt);
    if (wait > 0) { upPending = true; setTimeout(sendUp, wait); } else sendUp();
  };
  canvas.addEventListener('pointerup', touchUp); canvas.addEventListener('pointercancel', touchUp);
  window.addEventListener('mouseup', e => {
    W.input.mouse.b[e.button === 2 ? 1 : e.button === 1 ? 2 : 0] = 0;
    const [x, y] = gameXY(e), b = BTN[e.button]; if (b) W.mouseEvent(b[1], x, y, mk());
  });
  // gamepad: Gamepad API, read whenever the game polls its DirectInput joystick (recomp/host/dx.mjs padState)
  // + the phone overlay (web/touch.mjs), merged: buttons ORed, the larger-magnitude value per axis
  const physPad = () => {
    const g = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(p => p && p.connected);
    if (!g) return null;
    const val = i => (g.buttons[i] ? g.buttons[i].value : 0);
    return { axes: [g.axes[0] || 0, g.axes[1] || 0, g.axes[2] || 0, g.axes[3] || 0, val(6), val(7)],
             buttons: g.buttons.map(b => b.pressed || b.value > 0.5) };
  };
  W.input.readPad = () => mergePads(physPad(), phone.touch ? phone.touch.state() : null);
  // menus vs gameplay: gameplay = Game_LevelLoop running (0x760354), logic not paused (0x7600f4) and the in-game pause
  // menu closed (0x76321c: a field of the pause object, 0 -> 1 while it is open; found by diffing the globals)
  // cutscene = Bilbo's input disabled by a cinema (g_pBilbo 0x75ba3c, +0x44c set by 00422980 "CINEMA: Bilbo Input set FALSE")
  W.input.padMode = () => {
    if (!m.r32(0x760354) || m.r32(0x7600f4) || m.r32(0x76321c)) return 'menu';
    const b = m.r32(0x75ba3c);
    return b && m.r32(b + 0x44c) === 1 ? 'cutscene' : 'game';
  };
  phone.mode = W.input.padMode;   // the touch overlay switches its labels and drag areas with it
  // pad buttons that act as keys (held while the button is held). Gameplay: Start = Esc (pause). Cutscenes: Start = Enter
  // ("Press Enter to skip"). Menus and movies: Start = Enter (skips movies), B = Esc (back). Enter is not sent in gameplay
  // because it is bound to Use there. A timer, not rAF, so it keeps working in a background tab.
  // The key is chosen when the button goes down and kept until it is released: otherwise Start = Esc opened the pause
  // menu, the mode became 'menu' while Start was still held, and the same press turned into Enter = "Exit Game".
  const padHeld = { 1: false, 28: false };
  let startKey = 0, bKey = 0;
  setInterval(() => {
    const g = W.input.readPad(), mode = W.input.padMode(), menu = mode === 'menu', want = { 1: false, 28: false };
    const st = !!(g && g.buttons[9]), bb = !!(g && g.buttons[1]);
    if (!st) startKey = 0; else if (!startKey) startKey = mode === 'game' ? 1 : 28;
    if (!bb) bKey = 0; else if (!bKey) bKey = menu ? 1 : -1;      // -1: pressed outside a menu, sends nothing
    if (startKey) want[startKey] = true;
    if (bKey > 0) want[bKey] = true;
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
  const legacyHost = location.protocol === 'https:' ? `wss://${location.hostname}:10000`
    : `${location.hostname || '127.0.0.1'}:${(+location.port || 80) + 2}`;
  const singleRelay = MODE && MODE.single && MODE.relay;
  const defHost = singleRelay ? new URL(MODE.relay, ROOT).href.replace(/^http/, 'ws') : legacyHost;
  // a remembered server that was just the old default of this page becomes the new default (the relay moved to /relay)
  let saved = store('url');
  if (singleRelay && saved && saved.replace(/^wss?:\/\//, '') === legacyHost.replace(/^wss?:\/\//, '')) saved = null;
  nameEl.value = q.get('name') || store('name') || 'Hobbit';
  urlEl.value = q.get('mp') || saved || defHost;
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
  if (q.get('mp') || q.get('name') || q.get('room')) go();   // a link with mp=, name= or room= joins automatically
}

main().catch(e => { log('fatal: ' + e.message + '\n' + e.stack); });
