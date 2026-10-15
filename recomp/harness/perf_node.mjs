// Headless CPU profiler driver for the recompiled game (docs/PERF_2026-10-15.md). A trimmed copy of recomp/boot_node.mjs:
// null GL, virtual clock, same host shims, plus a scripted path menu -> New Game -> Dream World -> (warp) level L ->
// (teleport, fly, hold keys), and a V8 CPU profile (node:inspector) of a chosen range of frames. With a null GL and a
// virtual clock the wall time per frame is the CPU cost of the frame (wasm + host JS), no waiting.
//
// usage: node --experimental-wasm-jspi recomp/harness/perf_node.mjs [options]
//   --warp L            after Dream World runs normally for 20 frames, exit the level the way devmode warps (level = L-1,
//                       levelLoop = 0, exitNoSummary = 0) so the game loads level L
//   --pos x,y,z         teleport Bilbo there (bilbo::Move) once the target level runs (+20 frames)
//   --fly               Ctrl+F (the game's developer flight) after the teleport; --hold DIK[:frames] holds a key from then on
//   --profile load|play|all   which phase goes into the .cpuprofile: load = warp write -> level L running; play = the
//                       `--play N` frames after the teleport (default 300); all = the whole run
//   --out name          recomp/out/perf/<name>.cpuprofile (+ <name>.frames.json: wall ms per Present, phase marks)
//   --frames N --seconds S    hard stops (defaults 6000 / 900)
import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Machine, VirtualClock, hex, Trap } from '../host/machine.mjs';
import { VFS } from '../host/vfs.mjs';
import { NodeBackend } from '../host/node_fs.mjs';
import { Win32 } from '../host/win32.mjs';
import { installDirectInput, installDirectSound, installD3D8, nullGL } from '../host/dx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), RECOMP = path.dirname(HERE), ROOT = path.dirname(RECOMP);
const GAME = process.env.HOBBIT_GAME_DIR || path.join(ROOT, '..', 'The.Hobbit.-.Clean', 'The Hobbit - Clean');
const EXE = process.env.HOBBIT_EXE || path.join(ROOT, '..', 'The.Hobbit.-.Clean', 'The Hobbit - Reference', 'Meridian.exe');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const has = k => args.includes('--' + k);
const MAX_FRAMES = +opt('frames', 6000), MAX_SECONDS = +opt('seconds', 900);
const WARP = +opt('warp', -1), POS = opt('pos', '') ? opt('pos').split(',').map(Number) : null, FLY = has('fly');
const HOLD = (opt('hold', '') || '').split(',').filter(Boolean).map(s => s.split(':').map(Number));
const PROFILE = opt('profile', 'play'), PLAY = +opt('play', 300), NAME = opt('out', 'perf');
const OUT = path.join(RECOMP, 'out', 'perf'); fs.mkdirSync(OUT, { recursive: true });
const appdata = path.join(RECOMP, 'out', 'appdata'); fs.mkdirSync(appdata, { recursive: true });
const log = s => console.log(s);
globalThis.screen ||= { width: 1920, height: 1080 };
// game globals (web/devmode.mjs)
const A = { feState: 0x762b58, level: 0x00762B5C, levelLoop: 0x00760354, exitNoSummary: 0x0076200C, loading: 0x0076035C, pBilbo: 0x0075BA3C, logicPause: 0x7600f4, pauseMenu: 0x76321c };
const B = { state: 0x8D4, vtbl_move: 0x14, pos: 0x14 };
const DIK = { ENTER: 28, LCONTROL: 29, F: 33 };

class StopRun extends Error {}

async function main() {
  const t0 = Date.now();
  const m = new Machine({ wasm: fs.readFileSync(path.join(RECOMP, 'out', 'hobbit_flat.wasm')), exe: new Uint8Array(fs.readFileSync(EXE)), clock: new VirtualClock(), log });
  await m.init();
  const vfs = new VFS(new NodeBackend(GAME, false), new NodeBackend(appdata, true));
  const W = new Win32(m, vfs, { onDebug: s => { if (/RunLevel|Loading|level/i.test(s)) log('[dbg] ' + s.replace(/\s+$/, '')); }, knownDlls: ['shfolder.dll'] });
  const S = W.table();
  installDirectInput(m, W, S); installDirectSound(m, W, S, null);
  const com = await import(pathToFileURL(path.join(ROOT, 'web', 'd3d8', 'com.js')).href);
  await installD3D8(m, W, S, nullGL(640, 480), com);
  const missing = m.bindImports(S);
  if (missing.length) log('missing imports: ' + missing.join(' '));

  // profiler
  const session = new Session(); session.connect();
  // the in-process inspector answers synchronously, which matters: with a virtual clock the game never leaves the
  // microtask queue, so timers would not run between frames
  const post = (k, p = {}) => { let out, err; session.post(k, p, (e, r) => { err = e; out = r; }); if (err) throw err; return out; };
  post('Profiler.enable'); post('Profiler.setSamplingInterval', { interval: 200 });
  let profiling = false, profile = null;
  const startProf = why => { if (profiling) return; profiling = true; post('Profiler.start'); log(`== profile start (${why}) frame ${W.frames} wall ${((Date.now() - t0) / 1000).toFixed(1)} s`); };
  const stopProf = why => { if (!profiling) return; profiling = false; const r = post('Profiler.stop'); profile = r && r.profile; log(`== profile stop (${why}) frame ${W.frames}${profile ? '' : ' (no profile returned!)'}`); };
  if (PROFILE === 'all') startProf('all');

  // scripted path
  const frames = [], marks = [];   // [present#, wall ms since previous present], [present#, name]
  const mark = n => { marks.push([W.frames, n, Math.round(m.clock.now() - 100000)]); log(`== ${n} (frame ${W.frames}, virtual ${Math.round(m.clock.now() - 100000)} ms)`); };
  const keys = W.input.keys;
  let lastWall = Date.now(), phase = 'boot', pressed = 0, safe = 0, played = 0, keyUntil = new Map(), pumps = 0, lastStatus = Date.now();
  // keys are applied from the message pump (like boot_node.mjs): movies and loads pump without presenting
  const press = (k, n = 12) => { keyUntil.set(k, pumps + n); };
  W.pumpHook = () => {
    pumps++;
    for (const [k, until] of keyUntil) keys[k] = pumps < until ? 0x80 : 0;
    // movies: cut every Bink to 1 frame (HBINK +8 = Frames) so PlayMovie returns at once; the real clock is not here
    for (const [hb, b] of W.binks) if (m.r32(hb + 8) > 1) { m.w32(hb + 8, 1); b.frames = 1; log(`  movie ${b.name} cut to 1 frame`); }
    if ((phase === 'skip' || phase === 'load') && pumps >= pressed) { press(DIK.ENTER, 12); pressed = pumps + 150; }
    if (Date.now() - lastStatus > 5000) { lastStatus = Date.now(); log(`.. ${phase} frames ${W.frames} pumps ${pumps} virtual ${Math.round(m.clock.now() - 100000)} ms fe ${m.r32(A.feState)} level ${m.r32(A.level)} ip ${hex(m.lastIp)} thread ${m.cur && m.cur.name}`); }
  };
  const bilbo = () => { const b = m.r32(A.pBilbo); return b && m.r32(A.levelLoop) ? b : 0; };
  const rf = a => new DataView(m.mem.buffer).getFloat32(a, true), wf = (a, v) => new DataView(m.mem.buffer).setFloat32(a, v, true);
  const normal = () => { const b = bilbo(), st = b ? m.r8(b + B.state) : 0; return b && m.r32(A.loading) === 0 && st !== 0 && st !== 34 && !m.r32(A.logicPause) && !m.r32(A.pauseMenu); };
  const vec = m.heap.alloc(16);
  const moveTo = p => {
    const b = bilbo(); if (!b) return false;
    for (let i = 0; i < 3; i++) wf(vec + 4 * i, p[i]);
    const save = [m.eax, m.r32(m.Rp + 4), m.r32(m.Rp + 8)];
    m.w32(m.Rp + 4, b);
    try { m.callGuest(m.r32(m.r32(b) + B.vtbl_move), [vec, 0], 'stdcall'); } finally { m.eax = save[0]; m.w32(m.Rp + 4, save[1]); m.w32(m.Rp + 8, save[2]); }
    return true;
  };
  W.onPresent = n => {
    const now = Date.now(); frames.push([n, now - lastWall, phase]); lastWall = now;
    const fe = m.r32(A.feState);
    // menu: Enter (held 6 frames) every 60 frames until the front end leaves state 6, then Enter again (skips the intro
    // movie) until Bilbo exists (the browser's autoNewGame does the same with real-time waits)
    if (phase === 'boot' && fe === 6) { phase = 'menu'; mark('menu'); pressed = pumps + 60; }
    else if (phase === 'menu') { if (fe !== 6) { phase = 'skip'; mark('skip (fe ' + fe + ')'); pressed = pumps + 150; } else if (pumps >= pressed) { press(DIK.ENTER, 12); pressed = pumps + 120; log(`  Enter (menu, fe ${fe}, frame ${n})`); } }
    else if (phase === 'skip') { if (bilbo()) { phase = 'dream'; mark('dream world running'); safe = 0; } }
    else if (phase === 'dream') {
      safe = normal() ? safe + 1 : 0;
      if (safe >= 20) {
        if (WARP >= 0) {
          phase = 'load'; mark('warp write -> level ' + WARP);
          m.w32(A.level, WARP - 1); m.w32(A.levelLoop, 0); m.w32(A.exitNoSummary, 0);
          if (PROFILE === 'load') startProf('load');
        } else { phase = 'level'; safe = 0; }
      }
    } else if (phase === 'load') {
      if (m.r32(A.level) === WARP && bilbo() && m.r32(A.loading) === 0) { phase = 'level'; mark('level ' + WARP + ' running'); safe = 0; if (PROFILE === 'load') stopProf('level running'); }
    } else if (phase === 'level') {
      safe = normal() ? safe + 1 : 0;
      if (safe >= 20) {
        if (POS && moveTo(POS)) mark('teleport ' + POS.join(','));
        if (FLY) { press(DIK.LCONTROL, 40); pendingFly = n + 4; }      // Ctrl held 40 pumps, F pressed 4 frames in
        for (const [k, len = 1e9] of HOLD) keyUntil.set(k, pumps + 100 + len);
        phase = 'play'; played = n; mark('play');
      }
    } else if (phase === 'play') {
      if (pendingFly && n >= pendingFly) { press(DIK.F, 12); pendingFly = 0; }
      if (PROFILE === 'play' && n === played + 30) startProf('play');
      if (n === played + 30 + PLAY) { const b = bilbo(); if (b) mark(`end play at ${[0, 4, 8].map(o => rf(b + B.pos + o).toFixed(0)).join(',')} state ${m.r8(b + B.state)}`); stopProf('play done'); throw new StopRun('play done'); }
    }
    if (n % 100 === 0) log(`Present #${n} ${phase} level ${m.r32(A.level)} wall ${((now - t0) / 1000).toFixed(1)} s`);
    if (n >= MAX_FRAMES) throw new StopRun(`stopped after ${n} frames`);
    if ((now - t0) / 1000 > MAX_SECONDS) throw new StopRun(`stopped after ${MAX_SECONDS} s`);
  };
  let pendingFly = 0;

  let error;
  try { await m.startMain(m.pe.entry); } catch (e) { error = e; }
  stopProf('end');
  if (error && !(error instanceof StopRun)) {
    log(`*** stopped by error in thread ${error.thread || '?'}: ${error.message}`);
    if (!(error instanceof Trap)) log(String(error.stack).split('\n').slice(0, 6).join('\n'));
    log(`last_ip ${hex(m.lastIp)} esp ${hex(m.esp)}`);
  } else log(`*** run ended: ${error ? error.message : 'returned'}`);
  const secs = (Date.now() - t0) / 1000;
  if (profile) fs.writeFileSync(path.join(OUT, NAME + '.cpuprofile'), JSON.stringify(profile));
  const byPhase = {};
  for (const [, ms, ph] of frames) { const r = byPhase[ph] ||= { n: 0, ms: 0, max: 0 }; r.n++; r.ms += ms; r.max = Math.max(r.max, ms); }
  for (const r of Object.values(byPhase)) r.avg = +(r.ms / r.n).toFixed(1);
  fs.writeFileSync(path.join(OUT, NAME + '.frames.json'), JSON.stringify({ when: new Date().toISOString(), wall_s: secs, presents: W.frames, marks, byPhase, frames, heapMB: +(m.heap.inuse / 1e6).toFixed(1), memMB: +(m.mem.buffer.byteLength / 1e6).toFixed(1),
    hostCalls: Object.fromEntries([...m.stats.calls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) }, null, 1));
  log(`presents ${W.frames}, wall ${secs.toFixed(1)} s; per phase: ` + Object.entries(byPhase).map(([k, v]) => `${k} ${v.n}f avg ${v.avg} ms max ${v.max}`).join(' | '));
  log(`heap ${(m.heap.inuse / 1e6).toFixed(0)} MB, memory ${(m.mem.buffer.byteLength / 1e6).toFixed(0)} MB; profile ${profile ? path.join(OUT, NAME + '.cpuprofile') : 'none'}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
