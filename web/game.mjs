// Browser runner: the recompiled Meridian.exe (recomp/out/hobbit_flat.wasm) on JSPI, rendering through web/d3d8.
// Game files come read-only from recomp/serve_game.py (HTTP Range); settings live in memory.
import { Machine, RealClock, hex, Trap } from '../recomp/host/machine.mjs';
import { VFS, HttpBackend, MemBackend } from '../recomp/host/vfs.mjs';
import { Win32 } from '../recomp/host/win32.mjs';
import { installDirectInput, installDirectSound, installD3D8 } from '../recomp/host/dx.mjs';
import * as com from './d3d8/com.js';
import { installMultiplayer } from '../recomp/host/mp.mjs';
import { installSkins } from '../recomp/host/mp_skins.mjs';
import { installEnemies } from '../recomp/host/mp_enemies.mjs';
import { installWorld } from '../recomp/host/mp_world.mjs';
import { installTouch, mergePads } from './touch.mjs';
import { createAudio } from './audio.mjs';
import { createPrefetch } from './prefetch.mjs';
import { installDevMode, describe as describeDev, LEVELS as DEV_LEVELS } from './devmode.mjs';
import { installPerf } from './perf.mjs';   // ?perf=1|2: run-time profiler (docs/PERF_2026-10-15.md), off by default

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
// The log DOM is rebuilt at most once per 50 ms, not per line: OutputDebugStringA cost 0.5 ms per call through here
// (a level load prints 50+ lines inside one frame = 25 ms). A timer, not rAF, so it also flushes in a hidden tab.
let logTimer = 0;
const flushLog = () => { logTimer = 0; logEl.textContent = lines.slice(-60).join('\n'); logEl.scrollTop = 1e9; };
const log = s => { lines.push(s); if (lines.length > 400) lines.shift(); if (!logTimer) logTimer = setTimeout(flushLog, 50); };
window.hobbit = { lines, flushLog };

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

// Sound: volume slider + mute (remembered); the AudioContext starts on the first click / key / touch (autoplay policy)
const audio = createAudio({ log: s => log(s) });
function setupAudioUI() {
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };
  const vol = $('vol'), on = $('sndOn');
  const v0 = ls('hobbit.vol'), m0 = ls('hobbit.mute');
  if (v0 !== null && !isNaN(+v0)) vol.value = Math.max(0, Math.min(100, +v0));
  on.checked = m0 !== '1';
  audio.setVolume(vol.value / 100); audio.setMute(!on.checked);
  vol.addEventListener('input', () => { audio.setVolume(vol.value / 100); ls('hobbit.vol', vol.value); });
  on.addEventListener('change', () => { audio.setMute(!on.checked); ls('hobbit.mute', on.checked ? '0' : '1'); });
  for (const el of [vol, on]) el.addEventListener('keydown', e => e.stopPropagation());   // arrow keys on the slider are not game input
  window.hobbit.audio = audio;
}

async function main() {
  setupPhoneUI();
  const audioReady = audio.init().then(setupAudioUI).catch(e => log('audio: ' + e.message));
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
  // ?readahead=N (blocks, 0 = off) and ?prefetch=0|bg|all are for tests; the page setting is remembered otherwise
  const ra = q.get('readahead');
  const httpBeP = manifestP.then(mf => new HttpBackend(DATA, mf, ra !== null ? { readAhead: +ra } : {}));
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
  window.hobbit.http = httpBe; httpBe.who = () => (m.cur ? m.cur.name : '');
  const W = new Win32(m, vfs, { onDebug: s => log('[dbg] ' + s.replace(/\s+$/, '')), knownDlls: ['shfolder.dll'] });
  const S = W.table();
  installDirectInput(m, W, S); installDirectSound(m, W, S, audio.backend); audio.attach(W.ds);
  await audioReady;
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
  // diagnostics (hobbit.diag()): frame times, blocking reads (vfs.mjs), stream underruns (dx.mjs DS.diag), late mixer commands
  const D = window.hobbit.D = { t0: performance.now(), lastP: 0, long: [], frames: [], marks: [] };
  setInterval(() => W.ds && W.ds.check(), 20);
  window.hobbit.mark = name => D.marks.push([+((performance.now() - D.t0) / 1000).toFixed(2), name]);
  window.hobbit.diag = (since = 0) => {
    const ds = W.ds.diag, sec = t => +((t - D.t0) / 1000).toFixed(2);
    const fr = D.frames.filter(f => f[0] >= since), iv = fr.map(f => f[1]).sort((a, b) => a - b);
    const tr = httpBe.trace.filter(r => r[0] >= since);
    return {
      now: sec(performance.now()), presents: W.frames, marks: D.marks,
      frames: fr.length, p50: iv[iv.length >> 1] | 0, p95: iv[Math.floor(iv.length * 0.95)] | 0, max: iv[iv.length - 1] | 0,
      longFrames: D.long.filter(f => f[0] >= since).slice(0, 40),
      http: { req: httpBe.fetches, MB: +(httpBe.bytes / 1e6).toFixed(1), storeHits: httpBe.storeHits, waits: tr.length,
        netWaits: tr.filter(r => r[5]).length, waitMs: Math.round(tr.reduce((a, r) => a + r[4], 0)),
        slow: tr.filter(r => r[4] > 50).slice(0, 30) },
      audio: { state: audio.state, kind: audio.kind, plays: W.ds.plays, short: ds.short || 0, stale: ds.stale, torn: ds.torn, staleEv: ds.events.filter(e => e[0] >= 0).slice(-30),
        late: audio.stats.late, lateMs: audio.stats.lateMs, playback: (ps => ps ? Object.fromEntries(['underrunEvents', 'underrunDuration', 'totalDuration', 'averageLatency', 'maximumLatency'].map(k => [k, ps[k]])) : null)(audio.ctx && audio.ctx.playbackStats) },
    };
  };
  // test driver: menu -> New Game -> skip the movie -> mark 'runlevel' when the level starts (needs the menu to come up)
  window.hobbit.autoNewGame = async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    while (window.hobbit.feState !== 6) await w(200);
    window.hobbit.mark('menu'); await w(1500);
    window.hobbit.press('Enter'); await w(4000);
    window.hobbit.press('Enter'); window.hobbit.mark('skip');
    while (!lines.some(l => l.includes('Calling RunLevel'))) await w(100);
    window.hobbit.mark('runlevel');
  };
  // summary of the first `sec` seconds after the level started (or after `from`)
  window.hobbit.report = (sec = 20, from) => {
    const mk = n => (D.marks.find(x => x[1] === n) || [])[0];
    const R = from !== undefined ? from : mk('runlevel'), fr = D.frames.filter(f => f[0] >= R && f[0] <= R + sec);
    const ms = fr.map(f => f[1]).sort((a, b) => a - b), tr = httpBe.trace.filter(r => r[0] >= R && r[0] <= R + sec), d = window.hobbit.diag(R);
    return { load: +(R - mk('skip')).toFixed(1), fps: +(fr.length / sec).toFixed(1), p95: ms[Math.floor(ms.length * 0.95)], maxFrame: ms[ms.length - 1],
      frozenMs: fr.filter(f => f[1] > 100).reduce((a, f) => a + f[1], 0), gameWaits: tr.length, gameWaitMs: Math.round(tr.reduce((a, r) => a + r[4], 0)),
      netWaits: tr.filter(r => r[5]).length, audio: d.audio, http: { req: httpBe.fetches, MB: +(httpBe.bytes / 1e6).toFixed(1), storeHits: httpBe.storeHits } };
  };
  W.onPresent = n => {
    { const now = performance.now(), dt = D.lastP ? now - D.lastP : 0; D.lastP = now;
      const t = +((now - D.t0) / 1000).toFixed(2);
      if (D.frames.length < 100000) D.frames.push([t, Math.round(dt)]);
      if (dt > 100 && D.long.length < 2000) D.long.push([t, Math.round(dt), n]); }
    for (const [a, name] of MS) if (!reached.has(a) && m.r8(visAt + ordinal.get(a))) { reached.add(a); log(`== reached ${name} at Present ${n}`); }
    fpsN++; const now = performance.now(); if (now - fpsT > 1000) { fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
    if (n % 10 === 0) statEl.textContent = `Present ${n} | ${fps.toFixed(1)} fps | FE state ${m.r32(0x762b58)} | ` +
      `http ${httpBe.fetches} req ${(httpBe.bytes / 1e6).toFixed(1)} MB` + (httpBe.storeHits ? ` (+${httpBe.storeHits} cached blocks)` : '') + ` | heap ${(m.heap.inuse / 1e6).toFixed(0)} MB` +
      ` | sound ${audio.state === 'running' ? `${audio.stats.voices} voices ${audio.stats.rms > 1e-5 ? (20 * Math.log10(audio.stats.rms)).toFixed(0) + ' dB' : 'silent'}` : audio.ctx ? 'click to start' : 'off'}`;
    window.hobbit.presents = n; window.hobbit.feState = m.r32(0x762b58);
    if (snaps.includes(n)) {   // ?snap=N,M: keep a copy of those frames under the canvas (proof screenshots)
      const img = new Image(); img.src = canvas.toDataURL('image/png'); img.title = 'Present ' + n; img.width = 320;
      $('snaps').append(img); window.hobbit.snaps = (window.hobbit.snaps || []).concat([[n, img.src]]);
    }
  };

  const mpObj = setupMultiplayer(m, W);
  setupDevMode(m, W, mpObj);

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

  if (q.get('perf')) window.hobbit.perf = installPerf({ m, W, httpBe, gl, log }, { glWrap: q.get('perf') === '2' });
  setupPrefetch(httpBe);
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
// "Game data" panel: background download into the block store (web/prefetch.mjs). localStorage hobbit.prefetch =
// '1' (default) | '0'; hobbit.offline = '1' while "Download everything" has not finished (it resumes on the next visit).
function setupPrefetch(be) {
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };
  const bg = $('dlBg'), bar = $('dlBar'), txt = $('dlText'), all = $('dlAll'), clr = $('dlClear');
  const mb = n => (n / 1e6).toFixed(0);
  const render = P => {
    const off = P.mode === 'all' || ls('hobbit.offline') === '1';
    const d = off ? P.done : P.bgDone, t = off ? P.total : P.bgTotal;
    bar.max = Math.max(1, t); bar.value = d;
    txt.textContent = `${mb(d)} / ${mb(t)} MB ${off ? '(everything)' : '(current + next level, sound)'}` +
      (P.state === 'downloading' ? ` | ${(P.rate * 8 / 1e6).toFixed(1)} Mbit/s` : P.state !== 'idle' ? ` | ${P.state}` : '') +
      (P.reason ? ` (${P.reason})` : '') + (off ? '' : ` | all: ${mb(P.done)} / ${mb(P.total)} MB`);
    all.disabled = P.mode === 'all';
    if (P.mode === 'all' && P.state === 'complete') { ls('hobbit.offline', '0'); P.setMode(bg.checked ? 'bg' : 'off'); }
  };
  let last = 0;
  const P = createPrefetch(be, { log, playing: () => !!(window.hobbit.W && window.hobbit.W.input.padMode && window.hobbit.W.input.padMode() !== 'menu'), onChange: p => { const now = performance.now(); if (now - last > 250 || p.state !== 'downloading') { last = now; render(p); } } });
  window.hobbit.prefetch = P;
  const qp = q.get('prefetch');
  const saved = ls('hobbit.prefetch');
  bg.checked = qp ? qp !== '0' : saved !== '0';
  const mode = () => (ls('hobbit.offline') === '1' ? 'all' : bg.checked ? 'bg' : 'off');
  bg.addEventListener('change', () => { ls('hobbit.prefetch', bg.checked ? '1' : '0'); if (P.mode !== 'all') P.setMode(mode()); });
  all.onclick = () => { ls('hobbit.offline', '1'); P.setMode('all'); };
  clr.onclick = () => { if (confirm('Delete the downloaded game data from this browser? It is downloaded again when needed.')) { ls('hobbit.offline', '0'); P.clear(); } };
  P.setMode(qp === 'all' ? 'all' : qp === '0' ? 'off' : mode());
  if (P.mode === 'off') P.scan();
  setInterval(() => render(P), 1000);
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
    statusEl.textContent = `${mp.status}` + (mp.room ? ` | room "${mp.room}"` : '') + (mp.id ? ` | you: #${mp.id} slot ${mp.slot} (${me})` : '') +
      ` | fake Bilbos found ${mp.npc.size}/8 | sent ${mp.stats.sent} recv ${mp.stats.recv}`;
    // the DEV badge comes from the relay's state (welcome/join/dev messages), not from what a client claims locally
    const badge = () => { const b = document.createElement('span'); b.className = 'devbadge'; b.textContent = 'DEV'; b.title = 'developer mode on (reported by the relay)'; return b; };
    const items = [...mp.players.values()].map(p => {
      const li = document.createElement('li');
      const same = mp.local && p.level === mp.local.l;
      li.textContent = `${p.name} (slot ${p.slot}) - ${levelName(p.level)}` + (same && p.have ? ' - here' : '') + (p.id === mp.owner ? ' - room owner' : '');
      if (p.dev) li.append(badge());
      return li;
    });
    if (mp.id) {
      const li = document.createElement('li');
      li.textContent = `${mp.name} (you, slot ${mp.slot})` + (mp.owner === mp.id ? ' - room owner' : '');
      if (mp.devSelf) li.append(badge());
      items.unshift(li);
    }
    listEl.replaceChildren(...items);
    allowEl.disabled = !!mp.id && mp.owner !== mp.id;
    allowEl.checked = mp.id ? mp.allowDev : mp.allowDevWanted;
    const P = mp.players.get(mp.owner);
    ownerEl.textContent = !mp.id ? '(applies when you create a room)' : mp.owner === mp.id ? '(you own this room)'
      : `(set by the room owner ${P ? P.name : '#' + mp.owner})`;
  };
  const allowEl = $('mpAllowDev'), ownerEl = $('mpOwner');
  const mp = installMultiplayer({ m, W, log, onChange: render });
  window.hobbit.mp = mp;
  // extension modules: each one registers mp.listeners / frameHooks / levelHooks and may add its own UI under #mpExt
  for (const [name, install] of [['skins', installSkins], ['enemies', installEnemies], ['world', installWorld]])
    try { mp.ext[name] = install({ mp, m, W, log, panel: $('mpExt') }); } catch (e) { log(`[mp] ${name} module: ${e.message}`); }
  mp.allowDevWanted = store('allowDev') !== '0';
  allowEl.addEventListener('change', () => {
    if (mp.id) { if (mp.owner === mp.id) mp.setAllowDev(allowEl.checked); }
    else { mp.allowDevWanted = allowEl.checked; store('allowDev', allowEl.checked ? '1' : '0'); }
  });
  setInterval(() => render(mp), 1000);
  const wsUrl = v => /^wss?:\/\//.test(v) ? v : (location.protocol === 'https:' ? 'wss://' : 'ws://') + v;
  const go = () => { store('name', nameEl.value); store('url', urlEl.value); store('room', roomEl.value); mp.connect(wsUrl(urlEl.value.trim()), nameEl.value.trim(), roomEl.value.trim() || 'main'); };
  $('mpConnect').onclick = go;
  $('mpDisconnect').onclick = () => mp.disconnect();
  for (const el of [nameEl, urlEl, roomEl]) el.addEventListener('keydown', e => {   // typing is not game input
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); go(); }            // Enter in Name/Server/Room = (re)connect
  });
  if (q.get('mp') || q.get('name') || q.get('room')) go();   // a link with mp=, name= or room= joins automatically
  return mp;
}

// Developer panel + overlay + toasts + the room's developer-mode log (web/devmode.mjs, docs/DEVMODE.md)
function setupDevMode(m, W, mp) {
  const evEl = $('mpEvents'), toastsEl = $('toasts'), ovEl = $('devOverlay');
  const toast = (s, sus) => {
    const d = document.createElement('div'); d.textContent = s; if (sus) d.className = 'sus';
    toastsEl.append(d); while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
    setTimeout(() => d.remove(), 6000);
  };
  const who = id => id === mp.id ? 'you' : (mp.players.get(id) || {}).name || '#' + id;
  const line = ev => ev.t === 'room'
    ? `room setting: developer mode ${ev.allowDev ? 'allowed' : 'NOT allowed'}` + (ev.by ? ` (by ${who(ev.by)})` : ' (new room owner)')
    : describeDev(ev);
  const addEvent = (ev, quiet) => {
    const li = document.createElement('li');
    li.textContent = `${(ev.ts ? new Date(ev.ts) : new Date()).toLocaleTimeString()} ${line(ev)}`;
    if (ev.suspicious) li.className = 'sus';
    evEl.append(li); while (evEl.children.length > 200) evEl.firstChild.remove();
    evEl.scrollTop = 1e9;
    if (!quiet) toast(line(ev), ev.suspicious);
  };
  const dev = installDevMode({ m, W, mp, log, ui: {
    toast,
    overlay: txt => { if (txt === null) { ovEl.hidden = true; return; } ovEl.hidden = false; ovEl.textContent = txt; },
    onEvent: ev => addEvent(ev),
    onWelcome: msg => { evEl.replaceChildren(); for (const ev of msg.events || []) addEvent(ev, true); },
  } });
  window.hobbit.dev = dev;
  const box = $('devOn'), panel = $('dev'), st = $('devStatus');
  const speed = $('devSpeed'), level = $('devLevel'), player = $('devPlayer'), god = $('devGod'), wire = $('devWire'), ov = $('devOverlayOn');
  speed.replaceChildren(...dev.SPEEDS.map(s => new Option('x' + s, s)));
  level.replaceChildren(...DEV_LEVELS.map((n, i) => new Option(`${i} ${n}`, i)));
  const ctl = ['devFly', 'devGod', 'devHeal', 'devWire', 'devSpeed', 'devSlot', 'devSave', 'devLoad', 'devPlayer', 'devToPlayer', 'devLevel', 'devWarp'].map($);
  const sync = () => {
    box.checked = dev.on || dev.pending; panel.classList.toggle('on', dev.on);
    for (const el of ctl) el.disabled = !dev.on;
    god.checked = dev.god; wire.checked = !!m.r32(0x00777ADC); ov.checked = dev.overlay;
    if (document.activeElement !== speed) speed.value = String(dev.SPEEDS.includes(dev.speed) ? dev.speed : 1);
    const s = dev.state();
    st.textContent = dev.pending ? 'waiting for the relay...' : !dev.on ? 'off'
      : 'ON' + (mp.online() ? ' (announced to the room)' : ' (offline)') + (s ? ` | state ${s.st} | ${s.pos.join(', ')}` : '');
    if (!dev.on && !dev.pending) ovEl.hidden = true;
    const want = [...mp.players.values()].filter(p => p.have).map(p => [String(p.id), `${p.name} (${DEV_LEVELS[p.level] || p.level})`]);
    const have = [...player.options].slice(1).map(o => [o.value, o.textContent]);
    if (JSON.stringify(want) !== JSON.stringify(have)) { const v = player.value; player.replaceChildren(new Option('(player)', ''), ...want.map(([a, b]) => new Option(b, a))); player.value = v; }
  };
  dev.onChange = sync; setInterval(sync, 500);
  box.addEventListener('change', () => dev.setOn(box.checked, 'panel'));
  ov.addEventListener('change', () => { dev.overlay = ov.checked; try { localStorage.setItem('hobbit.dev.overlay', ov.checked ? '1' : '0'); } catch { /* private mode */ } if (!ov.checked) ovEl.hidden = true; });
  $('devFly').onclick = () => dev.toggleFly();
  god.addEventListener('change', () => dev.setGod(god.checked));
  $('devHeal').onclick = () => dev.refill();
  wire.addEventListener('change', () => m.w32(0x00777ADC, wire.checked ? 1 : 0));   // announced by the watcher
  speed.addEventListener('change', () => dev.setSpeed(+speed.value));
  $('devSlot').addEventListener('change', e => { dev.slot = +e.target.value; });
  $('devSave').onclick = () => dev.saveSlot();
  $('devLoad').onclick = () => dev.loadSlot();
  $('devToPlayer').onclick = () => player.value && dev.toPlayer(player.value);
  $('devWarp').onclick = () => dev.warp(+level.value);
  for (const el of [speed, level, player, $('devSlot')]) el.addEventListener('keydown', e => e.stopPropagation());
  sync();
}

main().catch(e => { log('fatal: ' + e.message + '\n' + e.stack); });
