// Host side of the flat game build (recomp/out/hobbit_flat.wasm): guest memory, CPU state, host-call protocol,
// guest heap, TEB/FS, and cooperative green threads on JSPI.
//
// Protocol (runtime/rt.c, RT_FLAT): a call/jmp to an address in [0x7F000000, 0x80000000) that is not a translated
// function goes to env.host_call(t). The host reads the stdcall arguments at [R.esp+4..], runs the stub, pops the
// return address (+ arguments for stdcall), stores it in R.retaddr (the translated caller checks it, CALLCHK) and sets
// R.eax/R.edx. If the stub has to block (Sleep, WaitForSingleObject, an async file read, a frame yield) host_call
// returns 1 and the wasm side calls env.host_wait(), a JSPI suspending import: the scheduler saves this thread's
// state and resumes another green thread (or waits for time / I/O).
import { parsePE } from './pe.mjs';

export const IMP_BASE = 0x7F000000;   // import / HLE thunk addresses (IMP_BASE + 4*k)
export const COM_BASE = 0x7FFE0000;   // web/d3d8/com.js THUNK_BASE (ComBridge thunks)
export const SENTINEL = 0x7FFFFF00;   // return address of host->guest calls (never executed)
/** Thunk addresses with a guest-side fast path in runtime/rt.c (rt_ext): the recompiled code handles the uncontended
 *  EnterCriticalSection / LeaveCriticalSection / GetCurrentThreadId itself and only calls the host when it cannot.
 *  The state lives in the CRITICAL_SECTION itself (Win32 layout: +8 RecursionCount, +12 OwningThread), so the JS
 *  shims in win32.mjs and the C fast path share it. The thread id comes from the TEB (FS:[0x24]). */
export const FAST_BASE = 0x7F00F000;
export const FAST = { EnterCriticalSection: FAST_BASE, LeaveCriticalSection: FAST_BASE + 4, GetCurrentThreadId: FAST_BASE + 8 };
export const HEAP_LO = 0x01000000, HEAP_HI = 0x70000000;
const R_SIZE = 64, F_SIZE = 112, XM_SIZE = 128, MM_SIZE = 64;
const TRAPS = { 1: 'read', 2: 'write', 3: 'write-ro', 4: 'ext', 5: 'unsupported', 6: 'bad-return', 7: 'limit',
  8: 'divide-error', 9: 'int', 10: 'undecodable', 11: 'x87' };
export const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

export class Trap extends Error {
  constructor(code, a, b) { super(`trap ${TRAPS[code] || code} a=${hex(a)} b=${hex(b)}`); this.code = code; this.a = a >>> 0; this.b = b >>> 0; }
}
export class GuestExit extends Error { constructor(code) { super('ExitProcess(' + code + ')'); this.exitCode = code; } }
export class ThreadExit extends Error { constructor(code) { super('ExitThread(' + code + ')'); this.exitCode = code; } }

/** A blocking stub result. check() -> undefined while blocked, else the EAX value (it may consume the object).
 *  deadline: absolute ms (clock.now()), then EAX = timeout. promise: something to await when nothing can run. */
export class Wait {
  constructor({ check = () => undefined, deadline = Infinity, timeout = 0x102, promise = null, what = '' }) {
    Object.assign(this, { check, deadline, timeout, promise, what });
    if (promise) promise.then(() => { this.promiseDone = true; }, e => { this.promiseDone = true; this.error = e; });
  }
}
/** Stub result that completes now (EAX = value) but lets higher-priority ready threads run first (preemption). */
export class Yield { constructor(value) { this.value = value; } }

/* ------------------------------------------------------------------ clocks */
export class VirtualClock {
  constructor(t0 = 100000) { this.t = t0; this.virtual = true; }
  now() { return this.t; }
  advanceTo(t) { if (t > this.t) this.t = t; }
}
export class RealClock {
  constructor() { this.bias = 100000 - performance.now(); this.virtual = false; }
  now() { return performance.now() + this.bias; }
  advanceTo() {}
}

/* ------------------------------------------------------------------ guest heap (JS-managed, in linear memory)
 * Size classes: 16-byte steps up to 4 KB, then 4 KB pages (page-aligned blocks). Every block has a 16-byte header in
 * guest memory just below it: [size, size ^ MAGIC, 0, 0]; a released block's second word becomes FREED. So alloc /
 * release / sizeOf touch no JS Map (HeapAlloc was 6-13 us with two Map writes + an unconditional zero fill). Fresh
 * memory above `top` has never been written, so a fresh block is zero without filling it; only a block reused from
 * a free list is filled when `zero` is requested. */
const HDR = 16, MAGIC = 0x48454150, FREED = 0x46524545;
export class GuestHeap {
  constructor(m, lo = HEAP_LO, hi = HEAP_HI) {
    this.m = m; this.top = lo; this.lo = lo; this.hi = hi; this.inuse = 0; this.allocs = 0;
    this.bins = new Array(257).fill(null);  // size class (sz >> 4) -> free addresses, sz <= 4096
    this.big = new Map();                   // sz (multiple of 4096) -> free addresses
  }
  static round(n) { n = Math.max(16, n >>> 0); return n <= 4096 ? (n + 15) & ~15 : (n + 4095) & ~4095; }
  alloc(n, zero = true) {
    const sz = GuestHeap.round(n);
    let a, lst;
    if (sz <= 4096) lst = this.bins[sz >> 4]; else lst = this.big.get(sz);
    if (lst !== undefined && lst !== null && lst.length > 0) {
      a = lst.pop();
      this.m.dv.setUint32(a - 12, (sz ^ MAGIC) >>> 0, true);
      if (zero) this.m.u8.fill(0, a, a + sz);
    } else {
      a = this.top + HDR;
      if (sz >= 4096) a = (a + 4095) & ~4095;
      this.top = a + sz;
      if (this.top > this.hi) throw new Error('guest heap exhausted');
      this.m.ensure(this.top);
      const dv = this.m.dv;
      dv.setUint32(a - 16, sz, true); dv.setUint32(a - 12, (sz ^ MAGIC) >>> 0, true);
    }
    this.inuse += sz; this.allocs++;
    return a;
  }
  /** size of a live block at a, or undefined (unknown / already released) */
  sizeOf(a) {
    a >>>= 0;
    if (a < this.lo + HDR || a >= this.top || (a & 15)) return undefined;
    const dv = this.m.dv, sz = dv.getUint32(a - 16, true);
    return dv.getUint32(a - 12, true) === ((sz ^ MAGIC) >>> 0) && sz >= 16 ? sz : undefined;
  }
  release(a) {
    const sz = this.sizeOf(a); if (sz === undefined) return false;
    a >>>= 0;
    this.m.dv.setUint32(a - 12, FREED, true);
    this.inuse -= sz;
    if (sz <= 4096) { let lst = this.bins[sz >> 4]; if (lst === null) lst = this.bins[sz >> 4] = []; lst.push(a); }
    else { let lst = this.big.get(sz); if (!lst) this.big.set(sz, lst = []); lst.push(a); }
    return true;
  }
  /** com.js Heap-compatible adapter: alloc(n) -> {ptr, u8, free()}. The u8 view is cached and re-made only after a
   *  memory growth (it used to be a new Uint8Array per access: one per buffer flush / texture upload). */
  comAdapter() {
    const h = this, m = this.m;
    return { alloc(n) { const p = h.alloc(n); let v = null;
        return { ptr: p, get u8() { if (v === null || v.length === 0) v = new Uint8Array(m.u8.buffer, p, n); return v; }, free() { h.release(p); } }; },
      release(p) { h.release(p); } };
  }
}

/* ------------------------------------------------------------------ green thread */
let nextTid = 1000;
class Thread {
  constructor(m, name, prio = 0) {
    this.m = m; this.name = name; this.prio = prio; this.tid = (nextTid += 4);
    this.state = 'new'; this.wait = null; this.resolve = null; this.snap = null; this.sp = 0;
    this.tls = []; this.lastError = 0; this.exitCode = 0x103; this.waiters = 0; this.done = false;
  }
}

/* ------------------------------------------------------------------ machine */
export class Machine {
  /** opts: {wasm: BufferSource|Module, exe: Uint8Array, clock, log(line), jspi: true} */
  constructor(opts) {
    this.opts = opts; this.log = opts.log || (s => console.log(s));
    this.clock = opts.clock || new VirtualClock();
    this.hle = new Map(); this.hleByName = new Map(); this.nextHle = IMP_BASE;
    this.hleArr = [];                 // (addr - IMP_BASE) >> 2 -> entry: the hot-path lookup (the Map is for tools)
    this.handles = new Map(); this.nextHandle = 0x1000;
    this.threads = []; this.cur = null; this.nested = 0;
    // stats.calls (Map name -> count) is built on demand from the per-entry counters: nothing is counted by name on
    // the hot path (that was 13-22 % of all CPU: a string built + two Map operations per host call)
    this.stats = { waits: 0, switches: 0 };
    Object.defineProperty(this.stats, 'calls', { get: () => this.callCounts(), enumerable: true });
    this.trace = opts.trace || 0; this.traceLeft = opts.traceMax ?? 2000;
    this.events = [];
    this.argPool = [];                // [nested depth][nargs] -> reused argument array (no per-call allocation)
    this.comHook = [];                // COM thunk index -> (r, esp) => r' | Wait (dx.mjs: CreateDevice, Present)
    this.comFast = [];                // COM thunk index -> impl(self, args) called without ComBridge.dispatch
    this.comName = [];                // COM thunk index -> 'Iface::Method' (built once per index)
  }
  async init() {
    const imports = { env: {
      trap: (c, a, b) => { throw new Trap(c, a, b); },
      host_call: t => this.hostCall(t >>> 0),
      host_wait: new WebAssembly.Suspending(() => this.hostWait()),
      host_probe: t => { if (this.onProbe) this.onProbe(t >>> 0); },
    } };
    const mod = this.opts.wasm instanceof WebAssembly.Module ? this.opts.wasm : await WebAssembly.compile(this.opts.wasm);
    this.inst = await WebAssembly.instantiate(mod, imports);
    const X = this.X = this.inst.exports;
    this.mem = X.memory;
    this.Rp = X.rt_cpu(); this.Fp = X.rt_fpu(); this.XMp = X.rt_xm(); this.MMp = X.rt_mm();
    this.callAsync = WebAssembly.promising(X.rt_call);
    this.refresh();
    // guest-side fast path for the hottest imports (runtime/rt.c): off while tracing so every call is logged
    if (X.rt_set_fast) X.rt_set_fast(this.trace ? 0 : 1);
    this.fastCnt = X.rt_fastcnt ? X.rt_fastcnt() : 0;
    this.heap = new GuestHeap(this);
    this.loadImage(this.opts.exe);
    this.w32(this.Rp + 48, 0xFFFFFFFF);            // R.ilimit: no instruction limit in the game build
    this.w32(this.Fp + 68, 0x027F);                // FPU CW: Windows process default (PC=53, all masked)
    for (let i = 0; i < 8; i++) this.w32(this.Fp + 76 + 4 * i, 3);
  }

  /* ---------------------------------------------------------------- memory */
  ensure(top) {
    const need = top + 0x10000;
    const cur = this.u8.length;
    if (need > cur) { this.mem.grow(Math.ceil((need - cur) / 65536) + 256); this.refresh(); }   // + 16 MB slack
  }
  // Cached views. `WebAssembly.Memory.buffer` is a slow runtime getter (5-8 % of all CPU when read per access); a
  // growth detaches the old ArrayBuffer, which makes the cached Uint8Array's length 0, so that one plain property read
  // is the staleness check. (DataView.byteLength would throw on a detached buffer, hence the u8 check for both.)
  get u8() { const u = this._u8; return u.length !== 0 ? u : this.refresh(); }
  get dv() { if (this._u8.length === 0) this.refresh(); return this._dv; }
  refresh() { this._b = this.mem.buffer; this._u8 = new Uint8Array(this._b); this._dv = new DataView(this._b); return this._u8; }
  r8(a) { return this.u8[a >>> 0]; }
  r16(a) { return this.dv.getUint16(a >>> 0, true); }
  r32(a) { return this.dv.getUint32(a >>> 0, true); }
  w8(a, v) { this.u8[a >>> 0] = v; }
  w16(a, v) { this.dv.setUint16(a >>> 0, v, true); }
  w32(a, v) { this.dv.setUint32(a >>> 0, v >>> 0, true); }
  f32(a) { return this.dv.getFloat32(a >>> 0, true); }
  bytes(a, n) { return this.u8.subarray(a >>> 0, (a >>> 0) + n); }
  cstr(a, max = 1 << 20) { if (!a) return null; const u = this.u8; let s = ''; for (let i = a >>> 0; u[i] && s.length < max; i++) s += String.fromCharCode(u[i]); return s; }
  wstr(a, n = -1) { if (!a) return null; let s = ''; for (let i = 0; n < 0 ? this.r16(a + 2 * i) : i < n; i++) s += String.fromCharCode(this.r16(a + 2 * i)); return s; }
  putCStr(a, s, cap = Infinity) { if (!a) return 0; const n = Math.min(s.length, cap - 1); for (let i = 0; i < n; i++) this.u8[a + i] = s.charCodeAt(i) & 255; this.u8[a + n] = 0; return n; }
  putWStr(a, s, cap = Infinity) { const n = Math.min(s.length, cap - 1); for (let i = 0; i < n; i++) this.w16(a + 2 * i, s.charCodeAt(i)); this.w16(a + 2 * n, 0); return n; }
  allocCStr(s) { const a = this.heap.alloc(s.length + 1); this.putCStr(a, s); return a; }

  /* ---------------------------------------------------------------- registers */
  reg(i) { return this.r32(this.Rp + 4 * i); }
  setReg(i, v) { this.w32(this.Rp + 4 * i, v); }
  get esp() { return this.r32(this.Rp + 16); } set esp(v) { this.w32(this.Rp + 16, v); }
  get eax() { return this.r32(this.Rp); } set eax(v) { this.w32(this.Rp, v); }
  set edx(v) { this.w32(this.Rp + 8, v); }
  get retaddr() { return this.r32(this.Rp + 32); } set retaddr(v) { this.w32(this.Rp + 32, v); }
  get fsBase() { return this.r32(this.Rp + 40); } set fsBase(v) { this.w32(this.Rp + 40, v); }
  get lastIp() { return this.r32(this.Rp + 56); }
  get icount() { return this.r32(this.Rp + 44); }
  push(v) { this.esp = this.esp - 4; this.w32(this.esp, v); }
  get fpucw() { return this.r32(this.Fp + 68); } set fpucw(v) { this.w32(this.Fp + 68, v); }

  /* ---------------------------------------------------------------- image */
  loadImage(exe) {
    const pe = this.pe = parsePE(exe);
    this.ensure(pe.base + pe.sizeOfImage);
    const u8 = this.u8;
    u8.set(exe.subarray(0, 0x1000), pe.base);                        // headers
    for (const s of pe.sections) u8.set(exe.subarray(s.raw, s.raw + Math.min(s.rawSize, s.vsize || s.rawSize)), s.va);
    this.imageEnd = pe.base + pe.sizeOfImage;
  }
  /** Patch every IAT slot with a host thunk. shims: Map "dll!name" (lower-case dll) -> {nargs, fn, conv, addr?}. */
  bindImports(shims) {
    const missing = [];
    for (const im of this.pe.imports) {
      const key = im.dll.toLowerCase() + '!' + im.name;
      const s = shims.get(key);
      let a;
      if (s) a = this.defineHle(key, s.nargs, s.fn, s.conv, s.addr);
      else { missing.push(key); a = this.defineHle(key, 0, () => { throw new Error('unimplemented import ' + key); }); }
      this.w32(im.slot, a);
    }
    return missing;
  }
  /** Allocate a host thunk address. fn(args, m, esp) -> number | {eax, edx} | Wait | Yield.
   *  addr: a fixed thunk address (FAST.*: the C runtime recognises it) instead of the next free one. */
  defineHle(name, nargs, fn, conv = 'stdcall', addr = 0) {
    if (!addr) { addr = this.nextHle; this.nextHle += 4; }
    addr >>>= 0;
    const e = { name, nargs, fn, conv, addr, n: 0, pop: 4 + (conv === 'stdcall' ? 4 * nargs : 0) };
    this.hle.set(addr, e); this.hleByName.set(name, e); this.hleArr[(addr - IMP_BASE) >> 2] = e;
    return addr;
  }
  /** Map name -> number of calls (imports by 'dll!name', COM thunks by 'Iface::Method', + the C fast path). */
  callCounts() {
    const out = new Map();
    for (const e of this.hle.values()) if (e.n) out.set(e.name, (out.get(e.name) || 0) + e.n);
    if (this.com) this.com.thunks.forEach((th, i) => { if (th.n) out.set(this.comName[i] || (th.iface + '::' + th.name), th.n); });
    if (this.fastCnt) for (const [k, i] of [['EnterCriticalSection', 0], ['LeaveCriticalSection', 1], ['GetCurrentThreadId', 2]]) {
      const n = this.r32(this.fastCnt + 4 * i); if (n) out.set('kernel32.dll!' + k + ' (wasm)', n);
    }
    return out;
  }
  argsFor(n) {
    let lvl = this.argPool[this.nested]; if (lvl === undefined) lvl = this.argPool[this.nested] = [];
    let a = lvl[n]; if (a === undefined) { a = lvl[n] = new Array(n); a.fill(0); }
    return a;
  }

  /* ---------------------------------------------------------------- host calls
   * One monomorphic path per thunk kind. Nothing here allocates on a trivial call: the argument array is pooled per
   * (nesting depth, nargs), there is no name string and no Map; the memory views are the cached ones. Memory may grow
   * inside the stub (HeapAlloc), so the registers are written through the getters after it. */
  hostCall(t) {
    const dv = this.dv, Rp = this.Rp;
    const esp = dv.getUint32(Rp + 16, true), ret = dv.getUint32(esp, true);
    if (t < COM_BASE) {
      const e = this.hleArr[(t - IMP_BASE) >> 2];
      if (e === undefined) throw new Error('call to unknown host address ' + hex(t) + ' from ' + hex(ret));
      e.n++;
      const n = e.nargs, args = this.argsFor(n);
      for (let i = 0; i < n; i++) args[i] = dv.getUint32(esp + 4 + 4 * i, true);
      if (this.trace !== 0 && this.traceLeft > 0) { this.traceLeft--; this.log(`  [${this.cur?.name}] ${e.name}(${args.map(hex).join(', ')}) <- ${hex(ret)}`); }
      this.callerRet = ret;
      const r = e.fn(args, this, esp);
      const dv2 = this.dv;
      dv2.setUint32(Rp + 16, esp + e.pop, true); dv2.setUint32(Rp + 32, ret, true);
      return this.finish(r, e.name);
    }
    const com = this.com, idx = (t - COM_BASE) >> 2, th = com ? com.thunks[idx] : undefined;   // web/d3d8 ComBridge thunk
    if (th === undefined) throw new Error('call to unknown host address ' + hex(t) + ' from ' + hex(ret));
    th.n = (th.n | 0) + 1;
    let r;
    const f = this.comFast[idx];
    if (f !== undefined) {
      // hot device methods: the thunk's impl(self, args) is called straight from here (no ComBridge.dispatch: that one
      // reads `this` + every argument through its own memory getter and builds an array per call)
      const n = th.nargs, args = this.argsFor(n), p = dv.getUint32(esp + 4, true);
      const self = p !== 0 ? com.objs.get(p) : null;
      for (let i = 0; i < n; i++) args[i] = dv.getUint32(esp + 8 + 4 * i, true);
      r = f(self, args);
      r = (r === undefined ? 0 : r) | 0;
      const dv2 = this.dv;
      dv2.setUint32(Rp + 16, esp + 8 + 4 * n, true); dv2.setUint32(Rp + 32, ret, true); dv2.setUint32(Rp, r >>> 0, true);
      return 0;
    }
    r = com.dispatch(idx, esp);
    const pop = 4 + com.popBytes;                                    // popBytes = the stdcall "ret N" (this + args)
    const hook = this.comHook[idx];
    if (hook !== undefined) { const r2 = hook(r, esp); if (r2 !== undefined) r = r2; }
    else if (this.onCom) { const r2 = this.onCom(this.comNameOf(idx), r, esp); if (r2 !== undefined) r = r2; }
    const dv2 = this.dv;
    dv2.setUint32(Rp + 16, esp + pop, true); dv2.setUint32(Rp + 32, ret, true);
    return this.finish(r, this.comNameOf(idx));
  }
  comNameOf(idx) { let s = this.comName[idx]; if (s === undefined) { const th = this.com.thunks[idx]; s = this.comName[idx] = th.iface + '::' + th.name; } return s; }
  /** Resolve a COM thunk index by 'Iface::Method' (web/d3d8/com.js VTBL order). */
  comIndex(iface, name) { return this.com ? this.com.thunks.findIndex(th => th.iface === iface && th.name === name) : -1; }
  finish(r, name) {
    if (typeof r === 'number') { this.dv.setUint32(this.Rp, r >>> 0, true); return 0; }
    if (r === undefined) { this.dv.setUint32(this.Rp, 0, true); return 0; }
    if (r instanceof Wait) return this.block(r, name);
    if (r instanceof Yield) { this.eax = r.value; return this.block(null, name); }
    if (r !== null && typeof r === 'object') { this.eax = r.eax ?? 0; if (r.edx !== undefined) this.edx = r.edx; return 0; }
    this.eax = r === true ? 1 : r === false ? 0 : r;
    return 0;
  }

  /** Call guest code from a stub (nested; the callee must not block). Returns EAX. */
  callGuest(addr, args = [], conv = 'stdcall') {
    const esp0 = this.esp;
    for (let i = args.length - 1; i >= 0; i--) this.push(args[i]);
    this.push(SENTINEL);
    this.nested++;
    try { this.X.rt_call(addr); } finally { this.nested--; }
    if (this.retaddr !== SENTINEL) throw new Error(`guest call ${hex(addr)} returned to ${hex(this.retaddr)}`);
    if (conv === 'cdecl') this.esp = this.esp + 4 * args.length;
    if (this.esp !== esp0) this.log(`warning: guest call ${hex(addr)} left esp ${hex(this.esp)} != ${hex(esp0)}`);
    return this.eax;
  }

  /* ---------------------------------------------------------------- handles */
  newHandle(obj) { const h = this.nextHandle; this.nextHandle += 4; this.handles.set(h, obj); return h; }

  /* ---------------------------------------------------------------- threads */
  saveState(T) {
    const u8 = this.u8, s = T.snap;
    // the snapshot buffers are made once per thread and reused (a switch used to allocate four new arrays)
    if (s === null) T.snap = [u8.slice(this.Rp, this.Rp + R_SIZE), u8.slice(this.Fp, this.Fp + F_SIZE), u8.slice(this.XMp, this.XMp + XM_SIZE), u8.slice(this.MMp, this.MMp + MM_SIZE)];
    else { s[0].set(u8.subarray(this.Rp, this.Rp + R_SIZE)); s[1].set(u8.subarray(this.Fp, this.Fp + F_SIZE)); s[2].set(u8.subarray(this.XMp, this.XMp + XM_SIZE)); s[3].set(u8.subarray(this.MMp, this.MMp + MM_SIZE)); }
    T.sp = this.X.__stack_pointer.value;
  }
  restoreState(T) {
    const u8 = this.u8;
    u8.set(T.snap[0], this.Rp); u8.set(T.snap[1], this.Fp); u8.set(T.snap[2], this.XMp); u8.set(T.snap[3], this.MMp);
    this.X.__stack_pointer.value = T.sp;
  }
  makeTeb(T, stackSize) {
    const stack = this.heap.alloc(stackSize, false);
    const teb = this.heap.alloc(0x1000);
    T.stackLo = stack; T.stackHi = stack + stackSize; T.teb = teb;
    this.w32(teb + 0x00, 0xFFFFFFFF);               // SEH chain end
    this.w32(teb + 0x04, T.stackHi); this.w32(teb + 0x08, T.stackLo);
    this.w32(teb + 0x18, teb);                      // self
    this.w32(teb + 0x20, 0x100); this.w32(teb + 0x24, T.tid);
    this.w32(teb + 0x30, this.peb || 0);
    this.w32(teb + 0x2c, teb + 0xE10);              // TLS slot array (unused by our TlsGetValue)
  }
  /** Main thread: run entry from a fresh stack. Returns a promise that settles when the process ends. */
  startMain(entry, stackSize = 0x100000) {
    this.peb = this.heap.alloc(0x1000);
    const T = new Thread(this, 'main', 0);
    this.makeTeb(T, stackSize);
    this.threads.push(T); T.handle = this.newHandle({ type: 'thread', T });
    // initial state = current wasm state with a new stack
    this.esp = T.stackHi - 64; this.fsBase = T.teb;
    for (let i = 0; i < 8; i++) if (i !== 4) this.setReg(i, 0);
    this.saveState(T);
    T.entry = entry; T.param = null;
    this.mainThread = T;
    return new Promise((resolve, reject) => { this.processDone = { resolve, reject }; this.switchTo(T); });
  }
  createThread(entry, param, stackSize, prio = 0, name = 'thread') {
    const T = new Thread(this, name, prio);
    this.makeTeb(T, Math.max(stackSize || 0, 0x40000));
    T.cstack = this.heap.alloc(0x20000, false);       // C shadow stack of this green thread
    T.entry = entry; T.param = param;
    // initial register state: copy of the creator's FPU/SSE state, clean GPRs
    this.saveState(T);
    const R = new DataView(T.snap[0].buffer);
    for (let i = 0; i < 8; i++) R.setUint32(4 * i, 0, true);
    R.setUint32(16, T.stackHi - 64, true); R.setUint32(40, T.teb, true);
    new DataView(T.snap[1].buffer).setUint32(68, 0x027F, true);
    T.sp = T.cstack + 0x20000 - 16;
    T.state = 'new';
    this.threads.push(T); T.handle = this.newHandle({ type: 'thread', T });
    this.log(`thread created: ${name} entry=${hex(entry)} param=${hex(param)} tid=${T.tid}`);
    return T;
  }
  /** called from host_call when a stub blocks (w = Wait) or yields (w = null). Returns 1 if the wasm side must suspend. */
  block(w, name) {
    const T = this.cur;
    T.wait = w; T.state = w ? 'blocked' : 'ready'; T.waitName = name;
    this.stats.waits++;
    const next = this.pickSync();
    if (next === T) { this.resumeResult(T); T.state = 'running'; return 0; }
    if (this.nested) {
      if (!next && w && w.promise) throw new Error(`async wait (${name}) inside a nested guest call`);
      throw new Error(`blocking call ${name} inside a nested host->guest call (thread switch needed)`);
    }
    this.pending = next;
    return 1;
  }
  resumeResult(T) {
    const w = T.wait; T.wait = null;
    if (w && T.waitValue !== undefined) { this.eax = T.waitValue; }
    T.waitValue = undefined;
  }
  /** choose the next thread to run now (synchronously): may advance the virtual clock. null = must wait (I/O, real time). */
  pickSync() {
    for (let guard = 0; guard < 4; guard++) {
      const now = this.clock.now();
      const order = this.runOrder();
      for (const T of order) {
        if (T.state === 'ready' || T.state === 'new') return T;
        if (T.state === 'blocked') {
          const v = T.wait.check();
          if (v !== undefined) { T.waitValue = v; return T; }
          if (T.wait.deadline <= now) { T.waitValue = T.wait.timeout; return T; }
        }
      }
      if (!this.clock.virtual) return null;
      // virtual time: jump to the earliest deadline unless some thread waits on I/O
      let dl = Infinity;
      for (const T of this.threads) {
        if (T.state !== 'blocked') continue;
        if (T.wait.promise && !T.wait.promiseDone) return null;
        if (T.wait.deadline < dl) dl = T.wait.deadline;
      }
      if (!isFinite(dl)) return null;
      this.clock.advanceTo(dl);
    }
    return null;
  }
  runOrder() {
    // highest priority first; round robin among equal priorities starting after the current thread.
    // One reused array + a stable insertion sort (this runs on every block/yield; it used to allocate 3 arrays).
    const th = this.threads, n = th.length, k = Math.max(0, th.indexOf(this.cur));
    const out = this.order || (this.order = []);
    out.length = 0;
    for (let i = 1; i <= n; i++) {
      const T = th[(k + i) % n]; if (T.done) continue;
      let j = out.length; out.push(T);
      while (j > 0 && out[j - 1].prio < T.prio) { out[j] = out[j - 1]; j--; }
      out[j] = T;
    }
    return out;
  }
  hostWait() {
    const T = this.cur;
    this.saveState(T);
    return new Promise(resolve => {
      T.resolve = resolve;
      const next = this.pending; this.pending = null;
      queueMicrotask(() => next ? this.switchTo(next) : this.idle());
    });
  }
  async idle() {
    // nothing can run now: wait for I/O, real time, or a frame
    for (;;) {
      const next = this.pickSync();
      if (next) return this.switchTo(next);
      const proms = this.threads.filter(T => T.state === 'blocked' && T.wait.promise && !T.wait.promiseDone).map(T => T.wait.promise);
      const dls = this.threads.filter(T => T.state === 'blocked').map(T => T.wait.deadline);
      const dl = Math.min(...dls);
      if (!proms.length && !isFinite(dl)) return this.deadlock();
      const waits = [...proms];
      if (isFinite(dl) && !this.clock.virtual) waits.push(new Promise(r => setTimeout(r, Math.max(0, dl - this.clock.now()))));
      await Promise.race(waits);
    }
  }
  deadlock() {
    const s = this.threads.filter(T => !T.done).map(T => `${T.name}:${T.state}:${T.waitName || ''}`).join(', ');
    this.processDone.reject(new Error('deadlock: ' + s));
  }
  switchTo(T) {
    if (this.cur && this.cur !== T) this.stats.switches++;
    const prev = this.cur;
    this.cur = T;
    if (T.state === 'new') {
      T.state = 'running';
      this.restoreState(T);
      if (T === this.mainThread) {
        this.push(SENTINEL);
      } else {
        this.push(T.param >>> 0); this.push(SENTINEL);
      }
      this.callAsync(T.entry).then(() => this.threadReturned(T), err => this.threadFailed(T, err));
      return;
    }
    this.restoreState(T);
    this.resumeResult(T);
    T.state = 'running';
    const r = T.resolve; T.resolve = null;
    r();
  }
  threadReturned(T) {
    if (T === this.mainThread) { this.processDone.resolve({ returned: this.eax }); return; }
    this.endThread(T, this.eax);
  }
  threadFailed(T, err) {
    if (err instanceof ThreadExit) return this.endThread(T, err.exitCode);
    if (err instanceof GuestExit) { this.processDone.resolve({ exit: err.exitCode }); return; }
    err.thread = T.name;
    this.processDone.reject(err);
  }
  endThread(T, code) {
    T.done = true; T.state = 'done'; T.exitCode = code >>> 0;
    this.log(`thread ${T.name} exited (${code})`);
    const next = this.pickSync();
    if (next) this.switchTo(next); else this.idle();
  }
}
