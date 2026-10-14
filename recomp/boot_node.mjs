// Headless boot of the recompiled Meridian.exe in Node (flat build recomp/out/hobbit_flat.wasm).
// Real entry point 0x006C0C90 -> CRT -> WinMain -> EngineInit -> legal screen -> ... with the Win32 shims in recomp/host,
// a null WebGL device behind the real web/d3d8 ComBridge, and a virtual clock (deterministic, runs faster than real time).
//
// usage: node --experimental-wasm-jspi recomp/boot_node.mjs [--frames N] [--seconds S] [--trace N] [--keys f:KEY,...]
// The game folder is opened read-only. Settings files go to recomp/out/appdata.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Machine, VirtualClock, hex, Trap, SENTINEL } from './host/machine.mjs';
import { VFS } from './host/vfs.mjs';
import { NodeBackend } from './host/node_fs.mjs';
import { Win32 } from './host/win32.mjs';
import { installDirectInput, installDirectSound, installD3D8, nullGL } from './host/dx.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const GAME = process.env.HOBBIT_GAME_DIR || path.join(ROOT, '..', 'The.Hobbit.-.Clean', 'The Hobbit - Clean');
const EXE = process.env.HOBBIT_EXE || path.join(ROOT, '..', 'The.Hobbit.-.Clean', 'The Hobbit - Reference', 'Meridian.exe');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const MAX_FRAMES = +opt('frames', 400), MAX_SECONDS = +opt('seconds', 600), TRACE = +opt('trace', 0);
const OUT = path.join(HERE, 'out', 'boot');
fs.mkdirSync(OUT, { recursive: true });
const appdata = path.join(HERE, 'out', 'appdata');
fs.mkdirSync(appdata, { recursive: true });
const logf = fs.openSync(path.join(OUT, 'boot.log'), 'w');
const log = s => { fs.writeSync(logf, s + '\n'); if (!/^  \[/.test(s)) console.log(s); };

globalThis.screen ||= { width: 1920, height: 1080 };

class StopRun extends Error {}

async function main() {
  const t0 = Date.now();
  const m = new Machine({ wasm: fs.readFileSync(path.join(HERE, 'out', 'hobbit_flat.wasm')), exe: new Uint8Array(fs.readFileSync(EXE)),
    clock: new VirtualClock(), log, trace: TRACE, traceMax: TRACE });
  await m.init();
  log(`wasm ready (${Date.now() - t0} ms); image ${hex(m.pe.base)}..${hex(m.imageEnd)}, entry ${hex(m.pe.entry)}`);
  const vfs = new VFS(new NodeBackend(GAME, false), new NodeBackend(appdata, true));
  const files = [];
  const W = new Win32(m, vfs, { onDebug: s => log('[dbg] ' + s.replace(/\s+$/, '')), knownDlls: ['shfolder.dll'] });
  W.fileLog = (p, w, ok) => { files.push(`${ok ? 'ok ' : 'NO '}${w ? 'W' : 'R'} ${p}`); };
  const S = W.table();
  installDirectInput(m, W, S); installDirectSound(m, W, S);
  const com = await import(pathToFileURL(path.join(ROOT, 'web', 'd3d8', 'com.js')).href);
  await installD3D8(m, W, S, nullGL(640, 480), com);
  const missing = m.bindImports(S);
  log(`imports bound: ${m.pe.imports.length - missing.length}/${m.pe.imports.length}` + (missing.length ? ' missing: ' + missing.join(' ') : ''));

  // milestones by address: functions entered (VIS bitmap of the translated code)
  const order = fs.readFileSync(path.join(HERE, 'out', 'funcs.txt'), 'utf8').split(/\r?\n/).filter(Boolean).map(x => parseInt(x, 16));
  const ordinal = new Map(order.map((a, i) => [a, i]));
  const visAt = m.X.rt_vis();
  const entered = a => m.r8(visAt + ordinal.get(a)) !== 0;
  const MILESTONES = [[0x006c0c90, 'entry'], [0x006c09c5, '_cinit'], [0x004fd630, 'WinMain'], [0x004fd7c0, 'GameMain'], [0x004fdb90, 'EngineInit'],
    [0x0065f0c0, 'eng_Init'], [0x0065e0a0, 'eng_CreateWindowAndDevice'], [0x00670360, 'DirectInput init'], [0x00657e10, 'AudioMgr.Init'],
    [0x00677060, 'IoMgr.Init'], [0x00675910, 'io_fs::MountFileSystem'], [0x0069e460, 'UI init'], [0x004fe050, 'CoreSystemsInit'],
    [0x00644d50, 'vm_Init'], [0x004fb310, 'LegalScreen'], [0x0052ae30, 'PlayMovie'], [0x0052b120, 'MoviePlaceholder'],
    [0x004fe3e0, 'RunFrontEnd'], [0x0052b560, 'FrontEnd_Mgr::Update'], [0x0051e860, 'PressStart'], [0x004fe5a0, 'LoadLevel']];
  const reached = new Map();
  const visReset = parseInt(opt('vis-reset', '0'), 16);   // clear the entered bitmap when this milestone is reached
  const visBefore = new Set();
  const checkMilestones = (tag) => { for (const [a, n] of MILESTONES) if (!reached.has(a) && entered(a)) { reached.set(a, { name: n, frame: W.frames, vt: Math.round(m.clock.now() - 100000) }); log(`== reached ${n} ${hex(a)} (frame ${W.frames}, virtual ${Math.round(m.clock.now() - 100000)} ms, ${tag})`);
    if (a === visReset) { order.forEach((f, i) => { if (m.r8(visAt + i)) visBefore.add(f); }); m.bytes(visAt, order.length).fill(0); } } };

  const xlog = [];
  m.onProbe = a => {
    if (a === 0x00650010) {   // x_Log: a retail no-op; its address is shared with other "return 0" functions, so keep only string args
      const p = m.r32(m.esp + 4);
      if (p > 0x6e9000 && p < 0x818000) { const s = m.cstr(p, 200); if (/^[ -~]{4,}$/.test(s)) { xlog.push(s); log(`[x_Log] ${s} (frame ${W.frames})`); } }
    } else if (a === 0x004fe3e0) log(`== RunFrontEnd call (frame ${W.frames})`);
    else if (a === 0x004fe5a0) log(`== LoadLevel call (frame ${W.frames})`);
  };
  let lastReport = Date.now();
  W.onPresent = n => {
    checkMilestones('present');
    if (n <= 3 || n % 50 === 0) log(`Present #${n} (virtual ${Math.round(m.clock.now() - 100000)} ms, wall ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (n >= MAX_FRAMES) throw new StopRun(`stopped after ${n} frames`);
    if ((Date.now() - t0) / 1000 > MAX_SECONDS) throw new StopRun(`stopped after ${MAX_SECONDS} s`);
  };
  // keyboard script: --keys frame:DIK[:frames],...  (e.g. 300:28 = Enter at frame 300)
  const keyScript = (opt('keys', '') || '').split(',').filter(Boolean).map(s => s.split(':').map(Number));
  W.pumpHook = () => {
    for (const [f, k, len = 3] of keyScript) W.input.keys[k] = (W.frames >= f && W.frames < f + len) ? 0x80 : 0;
    if (Date.now() - lastReport > 5000) { lastReport = Date.now(); checkMilestones('timer'); log(`.. frames ${W.frames}, virtual ${Math.round(m.clock.now() - 100000)} ms, host calls ${[...m.stats.calls.values()].reduce((a, b) => a + b, 0)}`); }
  };

  let result, error;
  try { result = await m.startMain(m.pe.entry); }
  catch (e) { error = e; }
  checkMilestones('end');
  const secs = (Date.now() - t0) / 1000;
  if (error && !(error instanceof StopRun)) {
    log(`\n*** stopped by error in thread ${error.thread || '?'}: ${error.message}`);
    if (!(error instanceof Trap)) log(error.stack.split('\n').slice(0, 6).join('\n'));
    log(`last_ip ${hex(m.lastIp)} esp ${hex(m.esp)}`);
    stackDump(m, log);
  } else log(`\n*** run ended: ${error ? error.message : JSON.stringify(result)}`);

  // report
  const calls = [...m.stats.calls.entries()].sort((a, b) => b[1] - a[1]);
  const d3d = calls.filter(([k]) => k.startsWith('IDirect3D'));
  const summary = {
    when: new Date().toISOString(), wall_s: secs, virtual_ms: Math.round(m.clock.now() - 100000), presents: W.frames,
    milestones: [...reached.values()], error: error && !(error instanceof StopRun) ? String(error.message) : null,
    debug_log_tail: W.debugLog.slice(-40), threads: m.threads.map(T => ({ name: T.name, state: T.state, prio: T.prio, wait: T.waitName })),
    d3d_calls: Object.fromEntries(d3d), host_calls: Object.fromEntries(calls.filter(([k]) => !k.startsWith('IDirect3D')).slice(0, 120)),
    switches: m.stats.switches, waits: m.stats.waits, heap_bytes: m.heap.inuse, exceptions: W.exceptions || 0, message_boxes: W.messageBoxes || 0,
    funcs_entered: order.filter((a, i) => m.r8(visAt + i)).length, x_log: xlog, fe_state: m.r32(0x762b58),
    movies_opened: W.moviesOpened || 0, threads_created: m.threads.length,
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(OUT, 'files.txt'), files.join('\n') + '\n');
  if (visReset) fs.writeFileSync(path.join(OUT, 'entered_after_reset.txt'), order.filter((a, i) => m.r8(visAt + i)).map(a => a.toString(16).padStart(8, '0') + (visBefore.has(a) ? '' : ' new')).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'entered.txt'), order.filter((a, i) => m.r8(visAt + i)).map(a => a.toString(16).padStart(8, '0')).join('\n') + '\n');
  for (const a of (opt('peek', '') || '').split(',').filter(Boolean)) log(`peek ${a}: ` + [...Array(8)].map((_, i) => hex(m.r32(parseInt(a, 16) + 4 * i))).join(' '));
  log(`presents ${W.frames}, functions entered ${summary.funcs_entered}, host calls ${calls.reduce((a, b) => a + b[1], 0)}, wall ${secs.toFixed(1)} s`);
  log('D3D calls: ' + d3d.map(([k, v]) => `${k.replace(/^IDirect3D(Device)?8::/, '')}=${v}`).join(' '));
  process.exit(0);
}

function stackDump(m, log) {
  // return addresses on the guest stack (words that point just after a call instruction in .text)
  const esp = m.esp, out = [];
  for (let a = esp; a < esp + 0x2000 && out.length < 40; a += 4) {
    const v = m.r32(a);
    if (v > 0x401000 && v < 0x6e9000) {
      const b1 = m.r8(v - 5), b2 = m.r8(v - 6), b3 = m.r8(v - 2), b4 = m.r8(v - 3);
      if (b1 === 0xe8 || b2 === 0xff || b3 === 0xff || b4 === 0xff) out.push(`${hex(a)}: ${hex(v)}`);
    }
  }
  log('guest stack return addresses:\n  ' + out.join('\n  '));
}

main().catch(e => { console.error(e); process.exit(1); });
