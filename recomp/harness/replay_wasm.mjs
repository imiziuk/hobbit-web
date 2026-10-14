// Capsule replay of the recompiled wasm (recomp/out/hobbit.wasm) against the real-game recordings.
// Same capsule format and the same PASS rules as tools/replay.py (check_outputs), with the NaN fix of
// tools/replay_exe.py (bit-identical / both-NaN ST0 accepted). The determinism gate (run A) is the Unicorn baseline:
// the original replays 22,227/22,227 (docs/REPLAY_EXE.md), so every capsule is usable.
//
// usage: node recomp/harness/replay_wasm.mjs <capdir> [--wasm f] [--jobs N] [--only a,b] [--max-per-func N]
//        [--out auto/wasm_replay_results.tsv] [--caps-out recomp/out/wasm_replay_caps.tsv]
//        [--all-regs]  also compare EAX/ECX/EDX exactly (instruction tests)
//        [--mutate N]  negative controls: 1 = ignore x87 precision control, 2 = ignore x87 rounding control,
//                      4 = corrupt 32-bit stores at page offset 0x100
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECOMP = path.dirname(HERE);
const ROOT = path.dirname(RECOMP);
const EXE = path.join(ROOT, '..', 'The.Hobbit.-.Clean', 'The Hobbit - Reference', 'Meridian.exe');
const SENT = 0xBADC0000;
const MAX_INSNS = 3_000_000;
const RET = { 0: 'Void', 1: 'Int32', 2: 'Int64', 3: 'Float', 4: 'VoidPass' };
const TRAPS = { 1: 'read', 2: 'write', 3: 'write-ro', 4: 'ext', 5: 'unsupported', 6: 'bad-return', 7: 'limit',
  8: 'divide-error', 9: 'int', 10: 'undecodable', 11: 'x87' };

// ------------------------------------------------------------------ capsules (tools/replay.py parse_caps)
function parseCaps(file) {
  const data = fs.readFileSync(file);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = [];
  let i = 0;
  while (i + 12 <= data.length) {
    const magic = dv.getUint32(i, true), ln = dv.getUint32(i + 8, true);
    if (magic !== 0x53504143) break;
    const b = i + 12;
    i += 12 + ln;
    if (i > data.length) break;
    let o = b;
    const u = () => { const v = dv.getUint32(o, true); o += 4; return v; };
    const c = { func: u(), caller: u(), ret: u(), nb: u(), teb: u(), flo: u(), fhi: u() };
    c.regs = []; for (let k = 0; k < 10; k++) c.regs.push(u());
    c.cw = dv.getUint16(o, true); o += 112;
    c.out = []; for (let k = 0; k < 9; k++) c.out.push(u());
    c.sw = dv.getUint16(o, true); o += 4;
    c.st0 = data.subarray(o, o + 10); o += 10;
    const np = u();
    c.pages = [];
    for (let k = 0; k < np; k++) { const a = dv.getUint32(o, true); const hh = dv.getBigUint64(o + 4, true); o += 12; c.pages.push([a, hh]); }
    const nw = u();
    c.written = new Map();
    for (let k = 0; k < nw; k++) { c.written.set(dv.getUint32(o, true), data[o + 4]); o += 5; }
    out.push(c);
  }
  return out;
}

function pageIndex(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const idx = new Map();
  const CH = 4104 * 2048;
  const buf = Buffer.alloc(CH);
  for (let base = 0; base + 4104 <= size; base += CH) {
    const n = fs.readSync(fd, buf, 0, Math.min(CH, size - base), base);
    for (let off = 0; off + 4104 <= n; off += 4104) idx.set(buf.readBigUInt64LE(off), base + off + 8);
  }
  fs.closeSync(fd);
  return { fd: fs.openSync(file, 'r'), idx };
}

// ------------------------------------------------------------------ exe executable pages (replay.py Images.exe_code)
function exeCodePages() {
  const f = fs.readFileSync(EXE);
  const pe = f.readUInt32LE(0x3c);
  const nsec = f.readUInt16LE(pe + 6), optsz = f.readUInt16LE(pe + 20);
  const base = f.readUInt32LE(pe + 24 + 28);
  const pages = new Map();
  for (let s = 0; s < nsec; s++) {
    const o = pe + 24 + optsz + 40 * s;
    const vsize = f.readUInt32LE(o + 8), va = f.readUInt32LE(o + 12), rsize = f.readUInt32LE(o + 16),
      raw = f.readUInt32LE(o + 20), ch = f.readUInt32LE(o + 36);
    if (!(ch & 0x20000000)) continue;
    const lo = base + va, hi = lo + vsize;
    for (let p = lo & ~0xFFF; p < hi; p += 0x1000) {
      if (p < lo) continue;
      const pg = Buffer.alloc(4096);
      const off = p - lo;
      if (off < rsize) f.copy(pg, 0, raw + off, raw + Math.min(rsize, off + 4096));
      pages.set(p >>> 0, pg);
    }
  }
  return { base, pages };
}

function ext80ToFloat(b) {
  const mant = b.readBigUInt64LE(0), ex = b.readUInt16LE(8);
  if ((ex & 0x7FFF) === 0 && mant === 0n) return 0.0;
  if ((ex & 0x7FFF) === 0x7FFF) return NaN;
  const v = Number(mant) / 2 ** 63 * 2 ** ((ex & 0x7FFF) - 16383);
  return ex & 0x8000 ? -v : v;
}
const f32 = new Float32Array(1), u8f = new Uint8Array(f32.buffer);
function bytesToF32(arr) { for (let k = 0; k < 4; k++) u8f[k] = arr[k]; return f32[0]; }
const hex = (v) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

let MUTATE = 0, ALLREGS = false, tolUsed = false;
class Trap extends Error { constructor(code, a, b) { super('trap'); this.code = code; this.a = a >>> 0; this.b = b >>> 0; } }

// ------------------------------------------------------------------ worker
async function worker() {
  const { wasmModule, capdir, indices, mutate, allRegs } = workerData;
  MUTATE = mutate | 0; ALLREGS = !!allRegs;
  const caps = parseCaps(path.join(capdir, 'caps.bin'));
  const { fd, idx } = pageIndex(path.join(capdir, 'pages.bin'));
  const exe = exeCodePages();
  const imports = {};
  for (const im of WebAssembly.Module.imports(wasmModule)) {
    imports[im.module] ??= {};
    if (im.module === 'env' && im.name === 'trap') imports.env.trap = (c, a, b) => { throw new Trap(c, a, b); };
    else if (im.kind === 'function') imports[im.module][im.name] = () => { throw new Error('import ' + im.module + '.' + im.name); };
  }
  const inst = await WebAssembly.instantiate(wasmModule, imports);
  const X = inst.exports;
  const mem = X.memory;
  const sp = X.__stack_pointer;
  const pR = X.rt_cpu(), pF = X.rt_fpu(), pPT = X.rt_pt(), pPool = X.rt_pool(), nPool = X.rt_pool_pages();
  let M8 = new Uint8Array(mem.buffer), DV = new DataView(mem.buffer);
  const refresh = () => { if (M8.buffer !== mem.buffer) { M8 = new Uint8Array(mem.buffer); DV = new DataView(mem.buffer); } };
  const PT = (p) => DV.getUint32(pPT + (p >>> 12) * 4, true);
  const setPT = (p, v) => DV.setUint32(pPT + (p >>> 12) * 4, v >>> 0, true);
  // executable image pages: read-only, permanent
  let slot = 0;
  const codeEntry = new Map();
  for (const [p, pg] of exe.pages) {
    const host = pPool + slot * 4096; slot++;
    M8.set(pg, host);
    setPT(p, host | 1);
    codeEntry.set(p, host | 1);
  }
  const firstFree = slot;
  const saveSp = sp.value;
  let lastMapped = [];
  const pbuf = Buffer.alloc(4096);
  const results = [];
  const rd = (x) => { const e = PT(x & ~0xFFF); if (!e) return undefined; return M8[(e & ~0xFFF) + (x & 0xFFF)]; };

  for (const ci of indices) {
    const cap = caps[ci];
    let verdict, detail, strict = '';
    try {
      // unmap previous capsule
      for (const p of lastMapped) setPT(p, codeEntry.get(p) ?? 0);
      lastMapped = [];
      const pages = new Map();
      let missing = false;
      for (const [a, hh] of cap.pages) {
        const off = idx.get(hh);
        if (off === undefined) { missing = true; break; }
        const pg = Buffer.alloc(4096);
        fs.readSync(fd, pg, 0, 4096, off);
        pages.set(a >>> 0, pg);
      }
      if (missing) { results.push([ci, 'INCONCLUSIVE', 'page missing from store', '']); continue; }
      if (firstFree + pages.size > nPool) { results.push([ci, 'INCONCLUSIVE', 'pool too small', '']); continue; }
      let s = firstFree;
      const hostOf = new Map();
      for (const [a, pg] of pages) {
        const host = pPool + s * 4096; s++;
        M8.set(pg, host);
        setPT(a, host);
        hostOf.set(a, host);
        lastMapped.push(a);
      }
      const esp = cap.regs[7] >>> 0;
      if (!pages.has(esp & ~0xFFF)) { results.push([ci, 'INCONCLUSIVE', 'B: stack page missing', '']); continue; }
      // sentinel return address (written by the harness, not by the code)
      for (let k = 0; k < 4; k++) {
        const x = esp + k, e = PT(x & ~0xFFF);
        if (!e) throw new Trap(1, x, 0);
        M8[(e & ~0xFFF) + (x & 0xFFF)] = (SENT >>> (8 * k)) & 0xFF;
      }
      const snap = new Map();
      for (const [a, host] of hostOf) snap.set(a, M8.slice(host, host + 4096));
      // registers: capsule order eax ebx ecx edx esi edi ebp esp; CPU struct order eax ecx edx ebx esp ebp esi edi
      const r = cap.regs;
      const set = (off, v) => DV.setUint32(pR + off, v >>> 0, true);
      set(0, r[0]); set(4, r[2]); set(8, r[3]); set(12, r[1]); set(16, r[7]); set(20, r[6]); set(24, r[4]); set(28, r[5]);
      set(32, 0); set(36, (r[9] >>> 10) & 1); set(40, cap.teb); set(44, 0); set(48, MAX_INSNS); set(52, r[9]); set(56, 0); set(60, MUTATE);
      for (let k = 0; k < 8; k++) { DV.setFloat64(pF + 8 * k, 0, true); DV.setUint32(pF + 76 + 4 * k, 3, true); }
      DV.setUint32(pF + 64, 0, true); DV.setUint32(pF + 68, cap.cw || 0x027F, true); DV.setUint32(pF + 72, 0, true);
      let why = null, kindWhy = null;
      try {
        X.rt_run(cap.func);
      } catch (e) {
        sp.value = saveSp;
        if (e instanceof Trap) { why = e; }
        else if (e instanceof RangeError) { kindWhy = 'host stack overflow'; }
        else { kindWhy = 'error ' + (e && e.message); }
      }
      refresh();
      if (kindWhy) { verdict = 'FAIL'; detail = 'ours: ' + kindWhy; }
      else if (why) {
        const t = TRAPS[why.code] || why.code;
        if (why.code === 1 || why.code === 2) { verdict = 'INCONCLUSIVE'; detail = `B: memory outside the capsule ${hex(why.a)} (${t})`; }
        else if (why.code === 4) {
          const inImage = why.a >= 0x400000 && why.a < 0x830000;
          verdict = inImage ? 'FAIL' : 'INCONCLUSIVE';
          detail = inImage ? `ours: untranslated target ${hex(why.a)}` : `B: external code ${hex(why.a)}`;
        } else if (why.code === 6) { verdict = 'FAIL'; detail = `ours: bad return: expected ${hex(why.a)} got ${hex(why.b)}`; }
        else if (why.code === 7) { verdict = 'FAIL'; detail = 'ours: instruction limit'; }
        else { verdict = 'FAIL'; detail = `ours: ${t} at ${hex(why.a)}`; }
      } else {
        const retaddr = DV.getUint32(pR + 32, true);
        if (retaddr !== SENT) { verdict = 'FAIL'; detail = `ours: returned to ${hex(retaddr)}`; }
        else {
          tolUsed = false;
          const d = check(cap, pages, snap, hostOf);
          if (d) { verdict = 'FAIL'; detail = d; } else { verdict = 'PASS'; detail = ''; }
          // strict: all of EAX/ECX/EDX exact (beyond the replay.py rules)
          const g = (o) => DV.getUint32(pR + o, true);
          const o = cap.out;
          strict = (g(0) === o[0] && g(4) === o[2] && g(8) === o[3]) ? (tolUsed ? 'float-tol' : 'exact') : 'regdiff';
        }
      }
    } catch (e) {
      sp.value = saveSp;
      verdict = 'INCONCLUSIVE'; detail = 'harness error ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e);
    }
    results.push([ci, verdict, detail, strict, DV.getUint32(pR + 44, true)]);
  }
  const vis = X.rt_vis ? Array.from(new Uint8Array(mem.buffer, X.rt_vis(), X.rt_nfunc())) : [];
  parentPort.postMessage({ results, vis });

  function check(cap, pages, snap, hostOf) {
    const o = cap.out; // eax ebx ecx edx esi edi ebp esp eflags
    const g = (off) => DV.getUint32(pR + off, true);
    if (g(16) !== o[7]) return `esp after return ${hex(g(16))} vs ${hex(o[7])}`;
    for (const [off, v, n] of [[12, o[1], 'ebx'], [24, o[4], 'esi'], [28, o[5], 'edi'], [20, o[6], 'ebp'], ...(ALLREGS ? [[0, o[0], 'eax'], [4, o[2], 'ecx'], [8, o[3], 'edx']] : [])])
      if (g(off) !== v) return `${n} ${hex(g(off))} vs ${hex(v)}`;
    const top = DV.getUint32(pF + 64, true) & 7;
    if (top !== ((cap.sw >> 11) & 7)) return `x87 depth ${top} vs ${(cap.sw >> 11) & 7}`;
    const kind = RET[cap.ret] || 'Void';
    if (kind === 'Int32' || kind === 'Int64') {
      const a = g(0), b = o[0];
      if (a !== b && !(kind === 'Int32' && (a & 0xFF) === (b & 0xFF))) return `eax ${hex(a)} vs ${hex(b)}`;
      if (kind === 'Int64' && g(8) !== o[3]) return `edx ${hex(g(8))} vs ${hex(o[3])}`;
    }
    if (kind === 'Float') {
      const x = DV.getFloat64(pF + 8 * top, true), y = ext80ToFloat(Buffer.from(cap.st0));
      const ok = x === y || (Number.isNaN(x) && Number.isNaN(y)) ||
        (!Number.isNaN(x) && !Number.isNaN(y) && Math.abs(x - y) <= 1e-5 * Math.max(1, Math.abs(x), Math.abs(y)));
      if (!ok) return `st0 ${x} vs ${y}`;
      if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) tolUsed = true;
    }
    const excluded = (x) => (cap.flo <= x && x < cap.fhi) || (cap.teb <= x && x < cap.teb + 0x1000) || x >= 0xBAD00000;
    const rec = cap.written;
    const mine = new Set();
    for (const [a, host] of hostOf) {
      const sn = snap.get(a);
      for (let k = 0; k < 4096; k++) if (M8[host + k] !== sn[k]) { const x = (a + k) >>> 0; if (!excluded(x)) mine.add(x); }
    }
    const all = new Set([...rec.keys(), ...mine]);
    for (const x of [...all].sort((p, q) => p - q)) {
      const got = rd(x);
      if (got === undefined) return `memory ${hex(x)} unreadable`;
      let want = rec.get(x);
      if (want === undefined) {
        const pg = pages.get((x & ~0xFFF) >>> 0);
        want = pg ? pg[x & 0xFFF] : undefined;
        if (want === undefined) continue;
      }
      if (got !== want) {
        const al = (x & ~3) >>> 0;
        const g4b = [0, 1, 2, 3].map((k) => rd(al + k));
        if (!g4b.includes(undefined)) {
          const pgw = pages.get((al & ~0xFFF) >>> 0) || Buffer.alloc(4096);
          const w4b = [0, 1, 2, 3].map((k) => rec.has(al + k) ? rec.get(al + k) : pgw[(al + k) & 0xFFF]);
          const g4 = bytesToF32(g4b), w4 = bytesToF32(w4b);
          if (g4 === g4 && w4 === w4 && Math.abs(g4 - w4) <= 1e-5 * Math.max(1, Math.abs(g4), Math.abs(w4))) { tolUsed = true; continue; }
        }
        return `memory ${hex(x)} ${got.toString(16).toUpperCase().padStart(2, '0')} vs ${want.toString(16).toUpperCase().padStart(2, '0')} (${rec.size} bytes written by the original)`;
      }
    }
    return null;
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = { wasm: path.join(RECOMP, 'out', 'hobbit.wasm'), jobs: Math.max(1, os.cpus().length - 1), only: '',
    maxPerFunc: 0, out: path.join(ROOT, 'auto', 'wasm_replay_results.tsv'), capsOut: path.join(RECOMP, 'out', 'wasm_replay_caps.tsv') };
  let capdir = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--wasm') opt.wasm = args[++k];
    else if (a === '--jobs') opt.jobs = +args[++k];
    else if (a === '--only') opt.only = args[++k];
    else if (a === '--max-per-func') opt.maxPerFunc = +args[++k];
    else if (a === '--out') opt.out = args[++k];
    else if (a === '--mutate') opt.mutate = +args[++k];
    else if (a === '--all-regs') opt.allRegs = true;
    else if (a === '--caps-out') opt.capsOut = args[++k];
    else capdir = a;
  }
  const t0 = Date.now();
  const caps = parseCaps(path.join(capdir, 'caps.bin'));
  let sel = caps.map((c, k) => k);
  if (opt.only) { const want = new Set(opt.only.split(',').map((x) => parseInt(x, 16))); sel = sel.filter((k) => want.has(caps[k].func)); }
  if (opt.maxPerFunc) { const seen = new Map(); sel = sel.filter((k) => { const n = (seen.get(caps[k].func) || 0) + 1; seen.set(caps[k].func, n); return n <= opt.maxPerFunc; }); }
  console.log(`${sel.length} capsules for ${new Set(sel.map((k) => caps[k].func)).size} functions`);
  const wasmModule = await WebAssembly.compile(fs.readFileSync(opt.wasm));
  console.log(`wasm compiled (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const parts = Array.from({ length: opt.jobs }, () => []);
  sel.forEach((k, j) => parts[j % opt.jobs].push(k));
  const all = [];
  let visAll = null;
  await Promise.all(parts.filter((p) => p.length).map((indices) => new Promise((res, rej) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { wasmModule, capdir, indices, mutate: opt.mutate, allRegs: opt.allRegs }, resourceLimits: { stackSizeMb: 256, maxOldGenerationSizeMb: 2048 } });
    w.on('message', (m) => { all.push(...m.results); if (!visAll) visAll = m.vis; else m.vis.forEach((v, k) => { if (v) visAll[k] = 1; }); res(); });
    w.on('error', rej);
  })));
  // names
  const names = new Map();
  for (const l of fs.readFileSync(path.join(ROOT, 'auto', 'abi.tsv'), 'utf8').split('\n').slice(1)) {
    const p = l.split('\t'); if (p.length > 1) names.set(parseInt(p[0], 16), p[1]);
  }
  all.sort((a, b) => a[0] - b[0]);
  const per = new Map();
  const tot = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 }, strictTot = { exact: 0, 'float-tol': 0, regdiff: 0 };
  const capLines = ['capsule	func	name	verdict	strict	insns	detail'];
  let insnTot = 0;
  for (const [ci, v, d, st, ic] of all) {
    insnTot += ic || 0;
    const f = caps[ci].func;
    tot[v]++;
    if (v === 'PASS' && st) strictTot[st]++;
    capLines.push(`${ci}\t${f.toString(16).padStart(8, '0')}\t${names.get(f) || '?'}\t${v}\t${st}\t${ic ?? ''}\t${d}`);
    if (!per.has(f)) per.set(f, { n: 0, PASS: 0, FAIL: 0, INCONCLUSIVE: 0, fail: '', inc: '' });
    const r = per.get(f);
    r.n++; r[v]++;
    if (v === 'FAIL' && !r.fail) r.fail = d;
    if (v === 'INCONCLUSIVE' && !r.inc) r.inc = d;
  }
  const lines = ['addr\tname\tcaps\tpass\tfail\tinconclusive\tverdict\tdetail'];
  const ftot = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (const f of [...per.keys()].sort((a, b) => a - b)) {
    const r = per.get(f);
    const v = r.FAIL ? 'FAIL' : r.PASS ? 'PASS' : 'INCONCLUSIVE';
    ftot[v]++;
    lines.push(`${f.toString(16).padStart(8, '0')}\t${names.get(f) || '?'}\t${r.n}\t${r.PASS}\t${r.FAIL}\t${r.INCONCLUSIVE}\t${v}\t${v === 'FAIL' ? r.fail : v === 'INCONCLUSIVE' ? r.inc : ''}`);
  }
  fs.writeFileSync(opt.out, lines.join('\n') + '\n');
  // functions entered during the replay (tested function + every translated callee), by abi.tsv kind
  const flist = path.join(path.dirname(opt.wasm), 'funcs.txt');
  if (visAll && fs.existsSync(flist)) {
    const kinds = new Map();
    for (const l of fs.readFileSync(path.join(ROOT, 'auto', 'abi.tsv'), 'utf8').split('\n').slice(1)) {
      const p = l.split('\t'); if (p.length > 22) kinds.set(parseInt(p[0], 16), p[22]);
    }
    const addrs = fs.readFileSync(flist, 'utf8').trim().split('\n').map((x) => parseInt(x, 16));
    const byKind = {};
    addrs.forEach((a, k) => { if (visAll[k]) { const kd = kinds.get(a) || 'other'; byKind[kd] = (byKind[kd] || 0) + 1; } });
    const n = visAll.reduce((x, y) => x + (y ? 1 : 0), 0);
    console.log(`translated functions entered during the replay: ${n} ${JSON.stringify(byKind)}`);
    fs.writeFileSync(path.join(path.dirname(opt.capsOut), 'wasm_replay_entered.txt'),
      addrs.filter((a, k) => visAll[k]).map((a) => a.toString(16).padStart(8, '0')).join('\n') + '\n');
  }
  fs.mkdirSync(path.dirname(opt.capsOut), { recursive: true });
  fs.writeFileSync(opt.capsOut, capLines.join('\n') + '\n');
  console.log('capsules:', JSON.stringify(tot), 'x86 insns executed:', insnTot, 'PASS capsules by strictness (exact = EAX/ECX/EDX equal and no float tolerance used):', JSON.stringify(strictTot));
  console.log('functions:', JSON.stringify(ftot), '->', opt.out, `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

if (isMainThread) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
else worker().catch((e) => { console.error(e); process.exit(1); });
