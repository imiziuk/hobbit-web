// Run-time profiler of the browser port (docs/PERF_2026-10-15.md). Off by default: web/game.mjs installs it only with
// ?perf=1 (host-call + device + scheduler hooks) or ?perf=2 (also every WebGL2 call timed by name).
// It edits nothing in web/d3d8: everything is wrapped on the live objects (Machine.hostCall / hostWait / switchTo,
// the ComBridge device, the Texture / Buffer prototypes taken from the first created objects, the gl context).
//
// Where a frame's time goes (between two IDirect3DDevice8::Present calls):
//   wasm  = frame - host - idle            recompiled game code (all green threads)
//   host  = time inside host calls, by group: d3d:draw / d3d:state / d3d:lock / d3d:create / d3d:present / d3d:other,
//           file (ReadFile ...), sync (waits, critical sections, Sleep), dsound, dinput, win:other, present:hooks
//   idle  = the main JS thread had nothing of the game to run: by wait kind (Present = frame cap / rAF, pump, io
//           = a ReadFile promise, event / semaphore waits, Sleep). Other page code (prefetch, audio timers, GC) runs there.
// window.hobbit.perf: report(sec, from), long (frames > 100 ms with their breakdown), frames (ring), mode (A/B switches:
// 'full' | 'nogldraw' (gl.drawElements/drawArrays skipped) | 'nodraw' (device Draw* return at once) | 'noupload'
// (Texture.upload skipped)), gl (per-name counts/ms when ?perf=2), mem (samples), longTasks (PerformanceObserver).
const COM_BASE = 0x7FFE0000;
const GROUPS = ['d3d:draw', 'd3d:state', 'd3d:lock', 'd3d:create', 'd3d:present', 'd3d:other', 'file', 'sync', 'dsound', 'dinput', 'win:other', 'present:hooks'];
const GI = Object.fromEntries(GROUPS.map((g, i) => [g, i]));
const D3D_GROUP = {
  DrawPrimitive: 'd3d:draw', DrawIndexedPrimitive: 'd3d:draw', DrawPrimitiveUP: 'd3d:draw', DrawIndexedPrimitiveUP: 'd3d:draw',
  SetRenderState: 'd3d:state', SetTextureStageState: 'd3d:state', SetTexture: 'd3d:state', SetTransform: 'd3d:state', SetVertexShader: 'd3d:state',
  SetStreamSource: 'd3d:state', SetIndices: 'd3d:state', SetMaterial: 'd3d:state', SetLight: 'd3d:state', LightEnable: 'd3d:state', SetViewport: 'd3d:state',
  ApplyStateBlock: 'd3d:state', BeginStateBlock: 'd3d:state', EndStateBlock: 'd3d:state', MultiplyTransform: 'd3d:state',
  Lock: 'd3d:lock', Unlock: 'd3d:lock', LockRect: 'd3d:lock', UnlockRect: 'd3d:lock',
  CreateTexture: 'd3d:create', CreateVertexBuffer: 'd3d:create', CreateIndexBuffer: 'd3d:create', Release: 'd3d:create', AddRef: 'd3d:create', GetSurfaceLevel: 'd3d:create',
  Present: 'd3d:present', Clear: 'd3d:present', BeginScene: 'd3d:present', EndScene: 'd3d:present',
};
const WIN_GROUP = name => {
  const n = name.replace(/^[a-z0-9]+!/, '');
  if (/^IDirectSound/.test(n)) return 'dsound';          // recomp/host/dx.mjs names its COM HLE entries Iface::Method
  if (/^IDirectInput/.test(n)) return 'dinput';
  if (/^(ReadFile|WriteFile|CreateFile[AW]|SetFilePointer|GetFileSize|CloseHandle|FindFirstFile|FindNextFile|GetFileAttributes|SetEndOfFile|FlushFileBuffers)/.test(n)) return 'file';
  if (/^(WaitForSingleObject|WaitForMultipleObjects|EnterCriticalSection|LeaveCriticalSection|TryEnterCriticalSection|ReleaseSemaphore|SetEvent|ResetEvent|Sleep|CreateEvent|CreateSemaphore|InterlockedExchange|InterlockedIncrement|InterlockedDecrement|InterlockedCompareExchange|GetTickCount|QueryPerformanceCounter|timeGetTime)/.test(n)) return 'sync';
  return 'win:other';
};
const nowMs = () => performance.now();

export function installPerf({ m, W, httpBe = null, gl = null, log = console.log }, { glWrap = false } = {}) {
  const P = {
    on: true, glWrap, mode: 'full', t0: performance.now(),
    frames: [], long: [], longTasks: [], mem: [], grows: [], ring: 20000, longMs: 100,
    gl: new Map(),                          // gl function name -> {n, ms, bytes}
    names: new Map(),                       // host call name -> entry {n, ms, g}
    stats: { tex: { uploads: 0, bytes: 0, levels: 0, createN: 0, createBytes: 0, lockN: 0 }, buf: { flushN: 0, flushBytes: 0, createN: 0, createBytes: 0, lockN: 0 }, up: { n: 0, bytes: 0 }, draws: 0, prims: 0, progLinks: 0 },
    overheadNs: 0,
  };
  const cur = {                              // accumulators of the frame being rendered
    start: nowMs(), host: new Float64Array(GROUPS.length), hostN: new Uint32Array(GROUPS.length), idle: new Map(), run: new Map(),
    tex: { uploads: 0, bytes: 0, levels: 0, createN: 0, createBytes: 0 }, buf: { flushN: 0, flushBytes: 0, createN: 0, createBytes: 0 },
    up: { n: 0, bytes: 0 }, draws: 0, prims: 0, progLinks: 0, growPages: 0, growMs: 0, gcHint: 0, glMs: 0, glN: 0,
    names: new Map(),                        // name -> [n, ms] for the frame (used for long frames + windows)
  };
  const resetCur = t => {
    cur.start = t; cur.host.fill(0); cur.hostN.fill(0); cur.idle.clear(); cur.run.clear(); cur.names.clear();
    cur.tex = { uploads: 0, bytes: 0, levels: 0, createN: 0, createBytes: 0 }; cur.buf = { flushN: 0, flushBytes: 0, createN: 0, createBytes: 0 };
    cur.up = { n: 0, bytes: 0 }; cur.draws = 0; cur.prims = 0; cur.progLinks = 0; cur.growPages = 0; cur.growMs = 0; cur.glMs = 0; cur.glN = 0;
  };
  const sec = t => +((t - P.t0) / 1000).toFixed(3);

  /* ---------------------------------------------------------------- host calls */
  const entryFor = t => {
    let e = m.hle.get(t);
    if (e) { if (e.pg === undefined) { e.pg = GI[WIN_GROUP(e.name)]; e.pname = e.name; } return e; }
    if (t >= COM_BASE && m.com) {
      const th = m.com.thunks[(t - COM_BASE) >> 2];
      if (th) {
        if (th.pg === undefined) {
          const g = th.iface.startsWith('IDirect3D') ? (D3D_GROUP[th.name] || 'd3d:other') : th.iface.startsWith('IDirectSound') ? 'dsound' : th.iface.startsWith('IDirectInput') ? 'dinput' : 'win:other';
          th.pg = GI[g]; th.pname = th.iface + '::' + th.name;
        }
        return th;
      }
    }
    return null;
  };
  const hostCall0 = m.hostCall.bind(m);
  let inHost = 0;
  m.hostCall = function (t) {
    const e = entryFor(t >>> 0);
    if (!e || inHost) return hostCall0(t);         // nested (host -> guest -> host): counted in the outer call
    inHost = 1;
    const a = nowMs();
    try { return hostCall0(t); }
    finally {
      const dt = nowMs() - a;
      inHost = 0;
      cur.host[e.pg] += dt; cur.hostN[e.pg]++;
      let r = cur.names.get(e.pname); if (!r) cur.names.set(e.pname, r = [0, 0]); r[0]++; r[1] += dt;
      let g = P.names.get(e.pname); if (!g) P.names.set(e.pname, g = { n: 0, ms: 0, g: GROUPS[e.pg] }); g.n++; g.ms += dt;
    }
  };
  /* ---------------------------------------------------------------- scheduler: idle gaps + per-thread run time */
  let suspendT = 0, suspendWhy = '', runT = nowMs(), runThread = 'main';
  const hostWait0 = m.hostWait.bind(m);
  m.hostWait = function () {
    const T = this.cur, t = nowMs();
    suspendT = t; suspendWhy = (T && T.waitName) || '?';
    const r = cur.run.get(runThread) || 0; cur.run.set(runThread, r + (t - runT));
    return hostWait0();
  };
  const switchTo0 = m.switchTo.bind(m);
  m.switchTo = function (T) {
    const t = nowMs();
    if (suspendT) {
      const k = suspendWhy.replace(/^[a-z0-9]+!/, '');
      cur.idle.set(k, (cur.idle.get(k) || 0) + (t - suspendT)); suspendT = 0;
    }
    runT = t; runThread = T.name;
    return switchTo0(T);
  };
  /* ---------------------------------------------------------------- device + resources (wrapped when the device exists) */
  let dev = null, texProto = null, bufProto = null;
  const wrapDevice = () => {
    const d = m.com && m.com.device; if (!d || dev) return; dev = d; P.device = d;
    const wrapDraw = name => {
      const o = d[name];
      d[name] = function (...a) {
        if (P.mode === 'nodraw') { this.stats.draws++; return 0; }
        return o.apply(this, a);
      };
    };
    for (const n of ['DrawPrimitive', 'DrawIndexedPrimitive']) wrapDraw(n);
    for (const n of ['DrawPrimitiveUP', 'DrawIndexedPrimitiveUP']) {
      const o = d[n];
      d[n] = function (...a) {
        const vd = n === 'DrawPrimitiveUP' ? a[2] : a[6]; cur.up.n++; cur.up.bytes += vd ? vd.length : 0;
        if (P.mode === 'nodraw') { this.stats.draws++; return 0; }
        return o.apply(this, a);
      };
    }
    const ct = d.CreateTexture;
    d.CreateTexture = function (w, h, lv, usage, fmt, pool) {
      const t = ct.call(this, w, h, lv, usage, fmt, pool);
      cur.tex.createN++; const b = t.lv.reduce((s, v) => s + v.size, 0); cur.tex.createBytes += b; P.stats.tex.createN++; P.stats.tex.createBytes += b;
      if (!texProto) wrapTexture(Object.getPrototypeOf(t));
      return t;
    };
    const cb = (name, kind) => {
      const o = d[name];
      d[name] = function (...a) { const b = o.apply(this, a); cur.buf.createN++; cur.buf.createBytes += b.length; P.stats.buf.createN++; P.stats.buf.createBytes += b.length; if (!bufProto) wrapBuffer(Object.getPrototypeOf(b)); return b; };
    };
    cb('CreateVertexBuffer'); cb('CreateIndexBuffer');
    const prog = d.program;
    d.program = function (L) { const before = this.stats.programs; const p = prog.call(this, L); if (this.stats.programs !== before) { cur.progLinks++; P.stats.progLinks++; } return p; };
    log('[perf] device hooks installed');
  };
  const wrapTexture = proto => {
    texProto = proto;
    const up = proto.upload;
    proto.upload = function () {
      if (P.mode === 'noupload') { for (const v of this.lv) v.dirty = false; return; }
      let bytes = 0, levels = 0; for (const v of this.lv) if (v.dirty) { bytes += v.size; levels++; }
      const a = nowMs(); const r = up.call(this); const dt = nowMs() - a;
      cur.tex.uploads++; cur.tex.bytes += bytes; cur.tex.levels += levels; cur.tex.ms = (cur.tex.ms || 0) + dt;
      P.stats.tex.uploads++; P.stats.tex.bytes += bytes; P.stats.tex.levels += levels; P.stats.tex.ms = (P.stats.tex.ms || 0) + dt;
      return r;
    };
    const lr = proto.LockRect; proto.LockRect = function (...a) { P.stats.tex.lockN++; return lr.apply(this, a); };
  };
  const wrapBuffer = proto => {
    bufProto = proto;
    const fl = proto.flush;
    proto.flush = function () {
      if (this.dirtyHi <= this.dirtyLo) return;
      const n = this.dirtyHi - this.dirtyLo; cur.buf.flushN++; cur.buf.flushBytes += n; P.stats.buf.flushN++; P.stats.buf.flushBytes += n;
      return fl.call(this);
    };
    const lk = proto.Lock; proto.Lock = function (...a) { P.stats.buf.lockN++; return lk.apply(this, a); };
  };
  /* ---------------------------------------------------------------- WebGL (optional, ?perf=2) */
  if (gl && glWrap) {
    const proto = Object.getPrototypeOf(gl), heavy = /^(texImage2D|compressedTexImage2D|bufferData|bufferSubData|drawElements|drawArrays|linkProgram|compileShader|getUniformLocation|readPixels|finish|getError|clear|getProgramParameter|getShaderParameter|createSampler|texParameteri|samplerParameteri|getActiveUniform)$/;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const desc = Object.getOwnPropertyDescriptor(proto, name), f = desc && desc.value;   // getters (canvas, drawingBufferWidth) throw when read on the prototype
      if (typeof f !== 'function' || name === 'constructor') continue;
      const rec = { n: 0, ms: 0, bytes: 0 }; P.gl.set(name, rec);
      const isDraw = name === 'drawElements' || name === 'drawArrays';
      const bytesOf = name === 'bufferData' ? a => (typeof a[1] === 'number' ? a[1] : a[1] ? a[1].byteLength : 0) : name === 'bufferSubData' ? a => (a[4] !== undefined ? a[4] : a[2] ? a[2].byteLength : 0)
        : name === 'texImage2D' ? a => (a[8] && a[8].byteLength) || 0 : name === 'compressedTexImage2D' ? a => (a[6] && a[6].byteLength) || 0 : null;
      gl[name] = function (...a) {
        rec.n++; cur.glN++; if (bytesOf) rec.bytes += bytesOf(a);
        if (isDraw && P.mode === 'nogldraw') return undefined;
        const t = nowMs(); const r = f.apply(this, a); const dt = nowMs() - t; rec.ms += dt; cur.glMs += dt; return r;
      };
    }
    log('[perf] WebGL calls wrapped (' + P.gl.size + ' functions)');
  } else if (gl) {
    // the A/B switch 'nogldraw' only, no timing
    for (const name of ['drawElements', 'drawArrays']) { const f = gl[name].bind(gl); gl[name] = (...a) => (P.mode === 'nogldraw' ? undefined : f(...a)); }
  }
  /* ---------------------------------------------------------------- memory + long tasks */
  const grow0 = m.mem.grow.bind(m.mem);
  m.mem.grow = function (pages) { const t = nowMs(); const r = grow0(pages); const dt = nowMs() - t; cur.growPages += pages; cur.growMs += dt; P.grows.push([sec(t), pages, +dt.toFixed(1), m.mem.buffer.byteLength]); return r; };
  try {
    const po = new PerformanceObserver(list => { for (const e of list.getEntries()) if (P.longTasks.length < 5000) P.longTasks.push([sec(e.startTime), Math.round(e.duration), e.name]); });
    po.observe({ entryTypes: ['longtask'] });
  } catch { /* no longtask support */ }
  let lastGC = performance.memory ? performance.memory.usedJSHeapSize : 0;
  setInterval(() => {
    const pm = performance.memory;
    P.mem.push([sec(nowMs()), pm ? Math.round(pm.usedJSHeapSize / 1e6) : -1, Math.round(m.mem.buffer.byteLength / 1e6), Math.round(m.heap.inuse / 1e6), m.com && m.com.objs ? m.com.objs.size : 0]);
    if (P.mem.length > 36000) P.mem.shift();
  }, 1000);

  /* ---------------------------------------------------------------- frame boundary (Present) */
  const onPresent0 = W.onPresent;
  W.onPresent = n => {
    const t = nowMs();
    const a = nowMs(); if (onPresent0) onPresent0(n); const hooks = nowMs() - a;
    cur.host[GI['present:hooks']] += hooks;
    wrapDevice();
    const frame = t - cur.start;
    let host = 0; for (let i = 0; i < GROUPS.length; i++) host += cur.host[i];
    let idle = 0; for (const v of cur.idle.values()) idle += v;
    const pm = performance.memory, heap = pm ? pm.usedJSHeapSize : 0, gc = heap < lastGC ? lastGC - heap : 0; lastGC = heap;
    const st = dev ? dev.stats : { draws: 0, prims: 0 };
    const rec = {
      t: sec(t), n, ms: +frame.toFixed(2), wasm: +(frame - host - idle).toFixed(2), host: +host.toFixed(2), idle: +idle.toFixed(2),
      hg: Array.from(cur.host, x => +x.toFixed(2)), hn: Array.from(cur.hostN), idleBy: Object.fromEntries([...cur.idle].map(([k, v]) => [k, +v.toFixed(2)])),
      run: Object.fromEntries([...cur.run].map(([k, v]) => [k, +v.toFixed(2)])),
      draws: st.draws - (P._draws || 0), prims: st.prims - (P._prims || 0), up: { ...cur.up }, tex: { ...cur.tex, ms: +(cur.tex.ms || 0).toFixed(2) }, buf: { ...cur.buf },
      progLinks: cur.progLinks, grow: cur.growPages ? [cur.growPages, +cur.growMs.toFixed(1)] : null, gcMB: gc ? +(gc / 1e6).toFixed(1) : 0,
      glMs: +cur.glMs.toFixed(2), glN: cur.glN, heapMB: pm ? +(heap / 1e6).toFixed(0) : -1,
    };
    P._draws = st.draws; P._prims = st.prims;
    // a long frame = more than P.longMs of time NOT spent waiting for the frame cap (rAF / the hidden-tab timer fallback)
    rec.busy = +(frame - (cur.idle.get('IDirect3DDevice8::Present') || 0) - (cur.idle.get('user32.dll!PeekMessageA') || 0)).toFixed(2);
    if (rec.busy > P.longMs && P.long.length < 2000) {
      rec.names = [...cur.names].sort((x, y) => y[1][1] - x[1][1]).slice(0, 15).map(([k, v]) => [k, v[0], +v[1].toFixed(2)]);
      rec.reads = httpBe ? httpBe.trace.filter(r => r[0] >= sec(cur.start) - 0.001 && r[0] <= rec.t + 0.001).map(r => [r[1].split('/').pop(), r[2], r[3], r[4], r[5]]) : [];
      P.long.push(rec);
    }
    P.frames.push(rec); if (P.frames.length > P.ring) P.frames.splice(0, 1000);
    resetCur(t);
  };

  /* ---------------------------------------------------------------- reports */
  const avg = (arr, f) => arr.length ? arr.reduce((s, r) => s + f(r), 0) / arr.length : 0;
  const pct = (x, tot) => tot ? +(100 * x / tot).toFixed(1) : 0;
  P.window = (sec = 10, from) => {
    const end = from !== undefined ? from + sec : P.frames.length ? P.frames[P.frames.length - 1].t : 0, start = end - sec;
    return P.frames.filter(r => r.t > start && r.t <= end);
  };
  /** Breakdown of the last `sec` seconds (or [from, from+sec]): ms per frame by bucket, fps, period histogram, top host calls. */
  P.report = (sec = 10, from) => {
    const fr = P.window(sec, from); if (!fr.length) return { frames: 0 };
    const tot = avg(fr, r => r.ms), host = avg(fr, r => r.host), idle = avg(fr, r => r.idle), wasm = avg(fr, r => r.wasm);
    const hg = GROUPS.map((g, i) => [g, +avg(fr, r => r.hg[i]).toFixed(2), Math.round(avg(fr, r => r.hn[i]))]).filter(x => x[1] > 0.005 || x[2] > 0).sort((a, b) => b[1] - a[1]);
    const idleKeys = new Set(); fr.forEach(r => Object.keys(r.idleBy).forEach(k => idleKeys.add(k)));
    const idleBy = [...idleKeys].map(k => [k, +avg(fr, r => r.idleBy[k] || 0).toFixed(2)]).sort((a, b) => b[1] - a[1]);
    const runKeys = new Set(); fr.forEach(r => Object.keys(r.run).forEach(k => runKeys.add(k)));
    const run = [...runKeys].map(k => [k, +avg(fr, r => r.run[k] || 0).toFixed(2)]).sort((a, b) => b[1] - a[1]);
    const hist = {}; for (const r of fr) { const b = r.ms < 20 ? '<20' : r.ms < 40 ? '20-40' : r.ms < 55 ? '40-55' : r.ms < 72 ? '55-72' : r.ms < 100 ? '72-100' : r.ms < 300 ? '100-300' : '>300'; hist[b] = (hist[b] || 0) + 1; }
    const ms = fr.map(r => r.ms).sort((a, b) => a - b);
    const span = fr[fr.length - 1].t - fr[0].t + fr[0].ms / 1000;
    const busy = avg(fr, r => r.ms - (r.idleBy.Present || r.idleBy["IDirect3DDevice8::Present"] || 0));
    return {
      frames: fr.length, fps: +(fr.length / span).toFixed(1), span: +span.toFixed(1), msPerFrame: +tot.toFixed(1), p50: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1],
      busyMs: +busy.toFixed(1), split: { wasm: [+wasm.toFixed(2), pct(wasm, tot)], host: [+host.toFixed(2), pct(host, tot)], idle: [+idle.toFixed(2), pct(idle, tot)] },
      hostGroups: hg, idleBy, runByThread: run, hist,
      perFrame: { draws: Math.round(avg(fr, r => r.draws)), prims: Math.round(avg(fr, r => r.prims)), upDraws: Math.round(avg(fr, r => r.up.n)), upKB: Math.round(avg(fr, r => r.up.bytes) / 1024),
        texUploads: +avg(fr, r => r.tex.uploads).toFixed(2), texKB: Math.round(avg(fr, r => r.tex.bytes) / 1024), texMs: +avg(fr, r => r.tex.ms).toFixed(2), texCreates: +avg(fr, r => r.tex.createN).toFixed(2),
        bufFlushes: +avg(fr, r => r.buf.flushN).toFixed(1), bufKB: Math.round(avg(fr, r => r.buf.flushBytes) / 1024), bufCreates: +avg(fr, r => r.buf.createN).toFixed(2),
        progLinks: +avg(fr, r => r.progLinks).toFixed(3), glMs: +avg(fr, r => r.glMs).toFixed(2), glCalls: Math.round(avg(fr, r => r.glN)), gcMB: +avg(fr, r => r.gcMB).toFixed(2),
        hostCalls: Math.round(avg(fr, r => r.hn.reduce((a, b) => a + b, 0))) },
      heapMB: fr[fr.length - 1].heapMB, wasmMemMB: Math.round(m.mem.buffer.byteLength / 1e6), longFrames: fr.filter(r => r.ms > 100).length,
      topCalls: P.topCalls(20, fr),
    };
  };
  /** Top host calls by total ms inside the frames `fr` (per-frame name maps are only kept for long frames, so this uses the global
   *  counters: call it as topCalls(k) for the whole run, or diff two snapshots with P.snapshot()). */
  P.snapshot = () => new Map([...P.names].map(([k, v]) => [k, { n: v.n, ms: v.ms, g: v.g }]));
  P.diff = (a, b = P.snapshot()) => [...b].map(([k, v]) => { const o = a.get(k) || { n: 0, ms: 0 }; return { name: k, g: v.g, n: v.n - o.n, ms: +(v.ms - o.ms).toFixed(1) }; }).filter(x => x.n > 0).sort((x, y) => y.ms - x.ms);
  P.topCalls = (k = 20) => [...P.names].map(([name, v]) => ({ name, g: v.g, n: v.n, ms: +v.ms.toFixed(1), us: +(1000 * v.ms / v.n).toFixed(1) })).sort((a, b) => b.ms - a.ms).slice(0, k);
  P.glTop = (k = 25) => [...P.gl].filter(([, v]) => v.n).map(([name, v]) => ({ name, n: v.n, ms: +v.ms.toFixed(1), us: +(1000 * v.ms / v.n).toFixed(2), MB: +(v.bytes / 1e6).toFixed(1) })).sort((a, b) => b.ms - a.ms).slice(0, k);
  /** A measured A/B: run `secs` in each mode back to back, same spot. Returns {mode: report}. */
  P.ab = async (modes = ['full', 'nogldraw', 'nodraw'], secs = 6) => {
    const out = {}; const w = ms => new Promise(r => setTimeout(r, ms));
    for (const md of modes) { P.mode = md; await w(1000); const t = sec(nowMs()); await w(secs * 1000); out[md] = P.report(secs, t); }
    P.mode = 'full'; return out;
  };
  P.longSummary = () => P.long.map(r => ({ t: r.t, ms: r.ms, busy: r.busy, wasm: r.wasm, host: r.host, idle: r.idle, idleBy: r.idleBy, top: r.names.slice(0, 6), tex: r.tex, buf: r.buf, grow: r.grow, gcMB: r.gcMB, reads: r.reads.length, readMs: Math.round(r.reads.reduce((a, x) => a + x[3], 0)), progLinks: r.progLinks }));
  P.GROUPS = GROUPS;
  log(`[perf] profiler on (${glWrap ? 'host + device + WebGL' : 'host + device'}); hobbit.perf.report(sec)`);
  return P;
}
