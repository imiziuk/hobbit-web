// Browser runner: the recompiled Meridian.exe (recomp/out/hobbit_flat.wasm) on JSPI, rendering through web/d3d8.
// Game files come read-only from recomp/serve_game.py (HTTP Range); settings live in memory.
import { Machine, RealClock, hex, Trap } from '../recomp/host/machine.mjs';
import { VFS, HttpBackend, MemBackend } from '../recomp/host/vfs.mjs';
import { Win32 } from '../recomp/host/win32.mjs';
import { installDirectInput, installDirectSound, installD3D8 } from '../recomp/host/dx.mjs';
import * as com from './d3d8/com.js';

const q = new URLSearchParams(location.search);
const DATA = q.get('data') || 'http://127.0.0.1:5191';
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

  // input -> DirectInput state
  const keys = W.input.keys;
  window.addEventListener('keydown', e => { const k = DIK[e.code]; if (k) { keys[k] = 0x80; e.preventDefault(); } });
  window.addEventListener('keyup', e => { const k = DIK[e.code]; if (k) { keys[k] = 0; e.preventDefault(); } });
  canvas.addEventListener('mousemove', e => { W.input.mouse.dx += e.movementX; W.input.mouse.dy += e.movementY; });
  canvas.addEventListener('mousedown', e => { W.input.mouse.b[e.button === 2 ? 1 : e.button === 1 ? 2 : 0] = 1; });
  window.addEventListener('mouseup', e => { W.input.mouse.b[e.button === 2 ? 1 : e.button === 1 ? 2 : 0] = 0; });
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
main().catch(e => { log('fatal: ' + e.message + '\n' + e.stack); });
