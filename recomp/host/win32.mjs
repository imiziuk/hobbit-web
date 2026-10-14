// Win32 shim layer for the recompiled Meridian.exe (KERNEL32, USER32, GDI32, SHELL32, WINMM, binkw32, shfolder, and the
// MSLU ("unicows") W functions that the exe resolves at run time by walking the export table of the module that
// GetModuleHandleA/LoadLibraryA returns: those modules are fake PE images built in guest memory).
//
// Every stub: [nargs, fn(args, m, esp)] (stdcall; 'cdecl' entries pop nothing). fn returns EAX, {eax, edx}, a Wait
// (blocking) or a Yield. Paths go through vfs.mjs (game folder read-only).
import { Wait, Yield, GuestExit, ThreadExit, hex, SENTINEL } from './machine.mjs';
import { GAME_ROOT, APPDATA_ROOT } from './vfs.mjs';

const INFINITE = 0xFFFFFFFF, WAIT_TIMEOUT = 0x102, INVALID = 0xFFFFFFFF;
const ERR = { FILE_NOT_FOUND: 2, PATH_NOT_FOUND: 3, ACCESS_DENIED: 5, INVALID_HANDLE: 6, NO_MORE_FILES: 18, ALREADY_EXISTS: 183,
  INVALID_NAME: 123, INSUFFICIENT_BUFFER: 122, HANDLE_EOF: 38 };
const isPromise = v => v && typeof v.then === 'function';

export class Win32 {
  constructor(m, vfs, opts = {}) {
    this.m = m; this.vfs = vfs; this.opts = opts;
    this.cs = new Map();            // CRITICAL_SECTION address -> {owner, rec}
    this.tlsNext = 0;
    this.msgq = [];                 // posted messages {hwnd, msg, w, l}
    this.classes = new Map(); this.windows = new Map(); this.nextHwnd = 0x10010;
    this.gdi = new Map(); this.nextGdi = 0x50000;
    this.modules = new Map();       // lower-case dll name -> fake module base
    this.debugLog = [];             // OutputDebugString lines
    this.unhandledFilter = 0;
    this.lastFrame = 0; this.frames = 0; this.presentedSincePump = false; this.lastPumpYield = 0;
    this.input = { keys: new Uint8Array(256), mouse: { dx: 0, dy: 0, dz: 0, b: [0, 0, 0, 0] },
      cursor: { x: 320, y: 240 },     // main-window client coordinates (GetCursorPos, MSG.pt)
      readPad: null };                // () => {axes:[lx,ly,rx,ry,lt,rt], buttons:[bool]} | null (Gamepad API, set by the page)
    this.cmdline = opts.cmdline || 'C:\\HOBBIT\\Meridian.exe';
    this.onMessageBox = opts.onMessageBox || null;
  }
  get T() { return this.m.cur; }
  setErr(e) { this.m.cur.lastError = e; }

  /* ---------------------------------------------------------------- helpers */
  file(h) { const o = this.m.handles.get(h); return o && o.type === 'file' ? o : null; }
  asyncOr(v, finish) {
    if (!isPromise(v)) return finish(v);
    let res; v.then(d => { res = finish(d); });
    return new Wait({ promise: v, check: () => res, what: 'io' });
  }
  /** whole small file (INI) -> Uint8Array | Promise | null */
  readWhole(path) {
    const { be, rel } = this.vfs.split(path);
    if (!be || rel === null) return null;
    const f = be.open(rel, {}); if (!f) return null;
    const d = f.read(0, f.size()); f.close?.(); return d;
  }
  /** frame pacing: wait until `gap` ms after the previous frame (virtual: jump; real: next animation frame(s)) */
  frameWait(gap, kind) {
    const m = this.m, clk = m.clock;
    const target = this.lastFrame + gap;
    const done = () => { this.lastFrame = Math.max(clk.now(), clk.virtual ? target : 0); };
    if (clk.virtual) {
      return new Wait({ deadline: target, timeout: 0, what: kind, check: () => (clk.now() >= target ? (done(), 0) : undefined) });
    }
    let ok = false;
    const p = new Promise(res => {
      // rAF normally; a timer fallback keeps the game running when rAF is throttled (hidden pane, background tab)
      let fin = false;
      const finish = () => { if (fin) return; fin = true; ok = true; done(); res(); };
      const tick = () => { if (fin) return; if (clk.now() >= target - 2) finish(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      setTimeout(finish, Math.max(0, target - clk.now()) + 50);
    });
    return new Wait({ promise: p, what: kind, check: () => (ok ? 0 : undefined) });
  }

  /* ---------------------------------------------------------------- fake DLL images for GetModuleHandleA / LoadLibraryA */
  moduleFor(name, shims) {
    const key = name.toLowerCase().replace(/^.*[\\/]/, '').replace(/(\.dll)?$/, '.dll');
    if (this.modules.has(key)) return this.modules.get(key);
    const exps = [];
    for (const [k, s] of shims) { const [dll, fn] = k.split('!'); if (dll === key && !fn.startsWith('#')) exps.push([fn, s]); }
    if (!exps.length && !this.opts.knownDlls?.includes(key)) return 0;
    exps.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const m = this.m;
    let size = 0x200 + exps.length * 10; for (const [n] of exps) size += n.length + 1;
    const base = m.heap.alloc((size + 0xFFFF) & ~0xFFFF);
    m.w16(base, 0x5A4D); m.w32(base + 0x3C, 0x80);
    const pe = base + 0x80;
    m.w32(pe, 0x4550); m.w16(pe + 4, 0x14c); m.w32(pe + 0x74, 16);
    const ed = 0x180, nf = exps.length, aof = 0x200, aon = aof + 4 * nf, aoo = aon + 4 * nf; let strs = aoo + 2 * nf;
    m.w32(pe + 0x78, ed); m.w32(pe + 0x7C, 0x28);
    m.w32(base + ed + 0x14, nf); m.w32(base + ed + 0x18, nf);
    m.w32(base + ed + 0x1C, aof); m.w32(base + ed + 0x20, aon); m.w32(base + ed + 0x24, aoo);
    exps.forEach(([n, s], i) => {
      const addr = this.thunkFor(key + '!' + n, s);
      m.w32(base + aof + 4 * i, (addr - base) >>> 0);
      m.w32(base + aon + 4 * i, strs); m.w16(base + aoo + 2 * i, i);
      m.putCStr(base + strs, n); strs += n.length + 1;
    });
    this.modules.set(key, base); this.moduleNames = this.moduleNames || new Map(); this.moduleNames.set(base, key);
    return base;
  }
  thunkFor(key, s) { const e = this.m.hleByName.get(key); return e ? e.addr : this.m.defineHle(key, s.nargs, s.fn, s.conv); }

  /* ---------------------------------------------------------------- window messages */
  wndproc(hwnd) { const w = this.windows.get(hwnd); return w ? w.proc : 0; }
  sendMessage(hwnd, msg, w, l) {
    const proc = this.wndproc(hwnd); if (!proc) return 0;
    return this.m.callGuest(proc, [hwnd, msg, w >>> 0, l >>> 0]);
  }
  writeMsg(p, q) { const m = this.m; m.w32(p, q.hwnd); m.w32(p + 4, q.msg); m.w32(p + 8, q.w); m.w32(p + 12, q.l); m.w32(p + 16, m.clock.now() >>> 0); m.w32(p + 20, this.input.cursor.x); m.w32(p + 24, this.input.cursor.y); }
  postMessage(hwnd, msg, w = 0, l = 0) { this.msgq.push({ hwnd, msg, w: w >>> 0, l: l >>> 0 }); }
  /** Mouse input from the page, in main-window client coordinates. The game reads the menu cursor with GetCursorPos
   *  (00660420 -> 006603b0, called by the pump) and button state from WM_xBUTTONDOWN/UP in its WndProc (0065d860:
   *  0x7effd4/d8/dc). WM_MOUSEMOVE is coalesced like Windows does. */
  mouseEvent(msg, x, y, flags) {
    this.input.cursor.x = x | 0; this.input.cursor.y = y | 0;
    const hwnd = this.mainHwnd || 0, l = ((y & 0xffff) << 16) | (x & 0xffff);
    const last = this.msgq[this.msgq.length - 1];
    if (msg === 0x200 && last && last.msg === 0x200) { last.l = l >>> 0; last.w = flags >>> 0; return; }
    this.postMessage(hwnd, msg, flags, l);
    // button-up: hold it back 3 pumps (= 3 game frames) so the menus see the button down. They poll the state that the
    // WndProc sets, so a down + up dispatched in the same pump was invisible and a quick click did nothing.
    if (msg === 0x202 || msg === 0x205 || msg === 0x208) this.msgq[this.msgq.length - 1].hold = 3;
  }

  /* ---------------------------------------------------------------- the shim table */
  table() {
    const m = this.m, vfs = this.vfs, W = this;
    const S = new Map();
    const def = (dll, name, nargs, fn, conv) => S.set(dll + '!' + name, { nargs, fn, conv });
    const K = (n, a, f) => def('kernel32.dll', n, a, f), U = (n, a, f) => def('user32.dll', n, a, f), G = (n, a, f) => def('gdi32.dll', n, a, f);
    const ok = () => 1, zero = () => 0;

    // ---- process / module / version
    K('GetVersion', 0, () => 0x0A280105);
    K('GetVersionExA', 1, ([p]) => { m.w32(p + 4, 5); m.w32(p + 8, 1); m.w32(p + 12, 2600); m.w32(p + 16, 2); m.putCStr(p + 20, 'Service Pack 2'); return 1; });
    K('GetModuleHandleA', 1, ([p]) => { if (!p) return m.pe.base; const n = m.cstr(p); if (/meridian/i.test(n)) return m.pe.base; return W.moduleFor(n, S) || (W.setErr(126), 0); });
    K('LoadLibraryA', 1, ([p]) => { const n = m.cstr(p); const b = W.moduleFor(n, S); m.log(`LoadLibraryA("${n}") -> ${hex(b)}`); if (!b) W.setErr(126); return b; });
    K('FreeLibrary', 1, ok);
    K('GetProcAddress', 2, ([h, p]) => {
      const key = (W.moduleNames?.get(h) || '?') + '!' + (p < 0x10000 ? '#' + p : m.cstr(p));
      const s = S.get(key); m.log(`GetProcAddress(${key}) -> ${s ? 'ok' : 'missing'}`);
      return s ? W.thunkFor(key, s) : 0;
    });
    K('GetModuleFileNameA', 3, ([h, buf, n]) => m.putCStr(buf, GAME_ROOT + '\\Meridian.exe', n));
    K('GetCommandLineA', 0, () => (W.cmdlineA ||= m.allocCStr(W.cmdline)));
    K('GetStartupInfoA', 1, ([p]) => { m.bytes(p, 68).fill(0); m.w32(p, 68); return 0; });
    K('GetEnvironmentStrings', 0, () => (W.envA ||= (() => { const s = 'PATH=C:\\WINDOWS\0WINDIR=C:\\WINDOWS\0\0'; const a = m.heap.alloc(s.length + 1); for (let i = 0; i < s.length; i++) m.w8(a + i, s.charCodeAt(i)); return a; })()));
    K('GetEnvironmentStringsW', 0, () => (W.envW ||= (() => { const s = 'PATH=C:\\WINDOWS\0WINDIR=C:\\WINDOWS\0\0'; const a = m.heap.alloc(2 * s.length + 2); for (let i = 0; i < s.length; i++) m.w16(a + 2 * i, s.charCodeAt(i)); return a; })()));
    K('FreeEnvironmentStringsA', 1, ok); K('FreeEnvironmentStringsW', 1, ok);
    K('GetEnvironmentVariableA', 3, () => (W.setErr(203), 0));
    K('SetEnvironmentVariableA', 2, ok);
    K('GetCurrentProcess', 0, () => 0xFFFFFFFF); K('GetCurrentProcessId', 0, () => 0x100);
    K('ExitProcess', 1, ([c]) => { throw new GuestExit(c); });
    K('TerminateProcess', 2, ([h, c]) => { throw new GuestExit(c); });
    K('SetUnhandledExceptionFilter', 1, ([f]) => { const o = W.unhandledFilter; W.unhandledFilter = f; return o; });
    K('UnhandledExceptionFilter', 1, () => { m.log('UnhandledExceptionFilter called'); return 1; });
    K('GetLastError', 0, () => m.cur.lastError); K('SetLastError', 1, ([e]) => { m.cur.lastError = e; });
    K('FormatMessageA', 7, zero);
    K('OutputDebugStringA', 1, ([p]) => { const s = m.cstr(p, 4096); W.debugLog.push(s); if (W.opts.onDebug) W.opts.onDebug(s); });
    K('SetHandleCount', 1, ([n]) => n);
    K('GetStdHandle', 1, zero); K('SetStdHandle', 2, ok);
    K('GetFileType', 1, ([h]) => (W.file(h) ? 1 : 0));
    K('SetConsoleCursorPosition', 2, zero); K('GetConsoleScreenBufferInfo', 2, zero);
    K('IsBadWritePtr', 2, zero); K('IsBadReadPtr', 2, zero); K('IsBadCodePtr', 1, zero);
    K('GetUserDefaultLangID', 0, () => 0x409);
    K('GetACP', 0, () => 1252); K('GetOEMCP', 0, () => 437); K('IsValidCodePage', 1, ([c]) => (c === 1252 || c === 437 || c === 0 ? 1 : 0));
    K('GetCPInfo', 2, ([cp, p]) => { m.bytes(p, 20).fill(0); m.w32(p, 1); m.w8(p + 4, 0x3f); return 1; });
    K('GetLocaleInfoW', 4, ([lcid, type, buf, n]) => { const v = { 0x1004: '1252', 0xB: '437' }[type & 0xffff] ?? ''; if (!n) return v.length + 1; m.putWStr(buf, v, n); return v.length + 1; });
    K('GetWindowsDirectoryA', 2, ([b, n]) => m.putCStr(b, 'C:\\WINDOWS', n));
    K('GetSystemDirectoryA', 2, ([b, n]) => m.putCStr(b, 'C:\\WINDOWS\\SYSTEM32', n));
    K('FindResourceW', 3, zero);

    // ---- time
    const sysTime = (p) => {
      const d = new Date(Date.UTC(2026, 9, 14, 12, 0, 0) + (m.clock.now() - 100000));
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
        .forEach((v, i) => m.w16(p + 2 * i, v));
    };
    K('GetSystemTime', 1, ([p]) => sysTime(p)); K('GetLocalTime', 1, ([p]) => sysTime(p));
    K('GetSystemTimeAsFileTime', 1, ([p]) => { const t = BigInt(Math.floor((Date.UTC(2026, 9, 14, 12) + m.clock.now() - 100000) * 10000)) + 116444736000000000n; m.w32(p, Number(t & 0xFFFFFFFFn)); m.w32(p + 4, Number(t >> 32n)); });
    K('GetTimeZoneInformation', 1, ([p]) => { m.bytes(p, 172).fill(0); return 0; });
    def('winmm.dll', 'timeGetTime', 0, () => Math.floor(m.clock.now()) >>> 0);
    def('winmm.dll', 'timeBeginPeriod', 1, zero);
    K('Sleep', 1, ([ms]) => {
      if (ms === 0) return new Yield(0);
      const dl = m.clock.now() + ms;
      return new Wait({ deadline: dl, timeout: 0, what: 'Sleep' });
    });

    // ---- heap / memory
    K('HeapCreate', 3, () => m.newHandle({ type: 'heap' }));
    K('HeapDestroy', 1, ok);
    K('HeapAlloc', 3, ([h, fl, n]) => m.heap.alloc(n, !!(fl & 8) || true));
    K('HeapFree', 3, ([h, fl, p]) => (p ? m.heap.release(p) : 1));
    K('HeapSize', 3, ([h, fl, p]) => m.heap.sizeOf(p) ?? 0xFFFFFFFF);
    K('HeapReAlloc', 4, ([h, fl, p, n]) => {
      const old = m.heap.sizeOf(p); if (old === undefined) return 0;
      if (n <= old) return p;
      if (fl & 0x10) return 0;                                       // HEAP_REALLOC_IN_PLACE_ONLY
      const q = m.heap.alloc(n, true); m.u8.copyWithin(q, p, p + old); m.heap.release(p); return q;
    });
    W.vregions = new Map();
    K('VirtualAlloc', 4, ([a, n, type, prot]) => {
      if (a) { for (const [b, sz] of W.vregions) if (a >= b && a + n <= b + sz) return a; m.log(`VirtualAlloc at ${hex(a)} not reserved`); return 0; }
      const p = m.heap.alloc((n + 0xFFFF) & ~0xFFFF, true); W.vregions.set(p, (n + 0xFFFF) & ~0xFFFF); return p;
    });
    K('VirtualFree', 3, ([a, n, type]) => { if (type & 0x8000) { W.vregions.delete(a); m.heap.release(a); } return 1; });
    K('InterlockedExchange', 2, ([p, v]) => { const o = m.r32(p); m.w32(p, v); return o; });
    K('InterlockedIncrement', 1, ([p]) => { const v = (m.r32(p) + 1) >>> 0; m.w32(p, v); return v; });
    K('InterlockedDecrement', 1, ([p]) => { const v = (m.r32(p) - 1) >>> 0; m.w32(p, v); return v; });

    // ---- TLS
    K('TlsAlloc', 0, () => W.tlsNext++);
    K('TlsSetValue', 2, ([i, v]) => { m.cur.tls[i] = v; return 1; });
    K('TlsGetValue', 1, ([i]) => { m.cur.lastError = 0; return m.cur.tls[i] || 0; });

    // ---- threads and synchronisation (cooperative green threads, machine.mjs)
    K('GetCurrentThread', 0, () => 0xFFFFFFFE);
    K('GetCurrentThreadId', 0, () => m.cur.tid);
    const thr = h => (h === 0xFFFFFFFE ? m.cur : (m.handles.get(h)?.T));
    K('SetThreadPriority', 2, ([h, p]) => { const T = thr(h); if (T) T.prio = p | 0; return 1; });
    K('SetThreadAffinityMask', 2, () => 1);
    K('CreateThread', 6, ([sa, stack, start, param, flags, ptid]) => {
      const T = m.createThread(start, param, stack, 0, 'thread@' + hex(start).slice(2));
      if (flags & 4) T.suspended = 1;
      if (ptid) m.w32(ptid, T.tid);
      if (T.suspended) T.state = 'suspended';
      return T.handle;
    });
    K('ResumeThread', 1, ([h]) => { const T = thr(h); if (!T) return INVALID; const c = T.suspended || 0; if (c) { T.suspended = 0; if (T.state === 'suspended') T.state = 'new'; } return c; });
    K('ExitThread', 1, ([c]) => { throw new ThreadExit(c); });
    K('CloseHandle', 1, ([h]) => { const o = m.handles.get(h); if (o && o.type === 'file') o.f.close?.(); if (o && o.type !== 'thread') m.handles.delete(h); return 1; });
    K('CreateSemaphoreA', 4, ([sa, init, max]) => m.newHandle({ type: 'sem', count: init | 0, max: max | 0 }));
    K('ReleaseSemaphore', 3, ([h, n, prev]) => {
      const o = m.handles.get(h); if (!o || o.type !== 'sem') return 0;
      if (prev) m.w32(prev, o.count);
      if (o.count + n > o.max) return 0;
      o.count += n;
      return new Yield(1);                                          // a higher-priority waiter preempts us (single CPU)
    });
    K('CreateEventA', 4, ([sa, manual, init]) => m.newHandle({ type: 'event', manual: !!manual, signaled: !!init }));
    const trySignal = o => {
      if (!o) return true;
      if (o.type === 'sem') { if (o.count > 0) { o.count--; return true; } return false; }
      if (o.type === 'event') { if (o.signaled) { if (!o.manual) o.signaled = false; return true; } return false; }
      if (o.type === 'thread') return o.T.done;
      return true;
    };
    K('WaitForSingleObject', 2, ([h, ms]) => {
      const o = m.handles.get(h);
      if (trySignal(o)) return 0;
      if (ms === 0) return WAIT_TIMEOUT;
      return new Wait({ check: () => (trySignal(o) ? 0 : undefined), deadline: ms === INFINITE ? Infinity : m.clock.now() + ms, timeout: WAIT_TIMEOUT, what: 'WaitForSingleObject' });
    });
    K('InitializeCriticalSection', 1, ([p]) => { W.cs.set(p, { owner: null, rec: 0 }); m.bytes(p, 24).fill(0); });
    K('DeleteCriticalSection', 1, ([p]) => { W.cs.delete(p); });
    K('EnterCriticalSection', 1, ([p]) => {
      let c = W.cs.get(p); if (!c) W.cs.set(p, c = { owner: null, rec: 0 });
      const T = m.cur;
      if (!c.owner || c.owner === T) { c.owner = T; c.rec++; return 0; }
      return new Wait({ check: () => (!c.owner ? (c.owner = T, c.rec = 1, 0) : undefined), what: 'EnterCriticalSection' });
    });
    K('LeaveCriticalSection', 1, ([p]) => { const c = W.cs.get(p); if (c && c.owner === m.cur && --c.rec === 0) c.owner = null; });

    // ---- files
    const fileErr = path => { const { be, rel } = vfs.split(path); return be && rel !== null ? ERR.FILE_NOT_FOUND : ERR.PATH_NOT_FOUND; };
    const createFile = (path, access, disp) => {
      const write = !!(access & 0x40000000) || disp === 1 || disp === 2 || disp === 4 || disp === 5;
      const st = vfs.stat(path);
      W.fileLog?.(path, write, !!st);
      if (st && st.dir) { W.setErr(ERR.ACCESS_DENIED); return INVALID; }
      if (write && !vfs.writable(path)) { W.setErr(ERR.ACCESS_DENIED); return INVALID; }
      // dispositions: 1 CREATE_NEW 2 CREATE_ALWAYS 3 OPEN_EXISTING 4 OPEN_ALWAYS 5 TRUNCATE_EXISTING
      if (!st && (disp === 3 || disp === 5)) { W.setErr(fileErr(path)); return INVALID; }
      if (st && disp === 1) { W.setErr(80); return INVALID; }
      const { be, rel } = vfs.split(path);
      const f = be.open(rel, { write, create: !st, truncate: disp === 2 || disp === 5 });
      if (!f) { W.setErr(write ? ERR.ACCESS_DENIED : fileErr(path)); return INVALID; }
      W.setErr(st && (disp === 2 || disp === 4) ? ERR.ALREADY_EXISTS : 0);
      return m.newHandle({ type: 'file', f, pos: 0, path, write });
    };
    K('CreateFileA', 7, ([p, access, share, sa, disp]) => createFile(m.cstr(p), access, disp));
    K('CreateFileW', 7, ([p, access, share, sa, disp]) => createFile(m.wstr(p), access, disp));
    K('ReadFile', 5, ([h, buf, n, pread, ov]) => {
      const o = W.file(h); if (!o) { W.setErr(ERR.INVALID_HANDLE); return 0; }
      const size = o.f.size(); const k = Math.max(0, Math.min(n, size - o.pos));
      const pos = o.pos; o.pos += k;
      if (pread) m.w32(pread, 0);
      if (!k) return 1;
      return W.asyncOr(o.f.read(pos, k), d => { m.u8.set(d, buf); if (pread) m.w32(pread, d.length); return 1; });
    });
    K('WriteFile', 5, ([h, buf, n, pwr]) => {
      const o = W.file(h);
      if (!o) { if (pwr) m.w32(pwr, n); return 1; }
      if (!o.write) { W.setErr(ERR.ACCESS_DENIED); return 0; }
      const k = o.f.write(o.pos, m.u8.slice(buf, buf + n)); o.pos += k; if (pwr) m.w32(pwr, k); return 1;
    });
    K('SetFilePointer', 4, ([h, lo, phi, method]) => {
      const o = W.file(h); if (!o) { W.setErr(ERR.INVALID_HANDLE); return INVALID; }
      const d = lo | 0, base = method === 0 ? 0 : method === 1 ? o.pos : o.f.size();
      o.pos = Math.max(0, base + d); if (phi) m.w32(phi, 0); return o.pos;
    });
    K('GetFileSize', 2, ([h, phi]) => { const o = W.file(h); if (!o) return INVALID; if (phi) m.w32(phi, 0); return o.f.size(); });
    K('SetEndOfFile', 1, ok); K('FlushFileBuffers', 1, ok);
    K('DeleteFileA', 1, ([p]) => { const path = m.cstr(p); if (!vfs.writable(path)) { W.setErr(ERR.ACCESS_DENIED); return 0; } const { be, rel } = vfs.split(path); return be.remove(rel) ? 1 : 0; });
    K('CreateDirectoryA', 2, ([p]) => {
      const path = m.cstr(p); if (vfs.stat(path)) { W.setErr(ERR.ALREADY_EXISTS); return 0; }
      if (!vfs.writable(path)) { W.setErr(ERR.ACCESS_DENIED); return 0; }
      const { be, rel } = vfs.split(path); return be.mkdir(rel) ? 1 : 0;
    });
    const attrs = path => { const st = vfs.stat(path); if (!st) { W.setErr(fileErr(path)); return INVALID; } return st.dir ? 0x10 : (vfs.writable(path) ? 0x80 : 0x01); };
    K('GetFileAttributesA', 1, ([p]) => attrs(m.cstr(p)));
    K('GetFileAttributesW', 1, ([p]) => { const s = m.wstr(p); if (/[?*]/.test(s)) { W.setErr(ERR.INVALID_NAME); return INVALID; } return attrs(s); });
    K('GetCurrentDirectoryA', 2, ([n, b]) => { const s = vfs.cwd; if (n <= s.length) return s.length + 1; return m.putCStr(b, s, n); });
    K('SetCurrentDirectoryA', 1, ([p]) => { const path = m.cstr(p); const st = vfs.stat(path); if (!st || !st.dir) { W.setErr(ERR.PATH_NOT_FOUND); return 0; } vfs.cwd = vfs.split(path).full.replace(/\\$/, ''); return 1; });
    K('GetFullPathNameA', 4, ([p, n, b, pfile]) => {
      const full = vfs.split(m.cstr(p)).full;
      if (n <= full.length) return full.length + 1;
      m.putCStr(b, full, n);
      if (pfile) { const i = full.lastIndexOf('\\'); m.w32(pfile, b + i + 1); }
      return full.length;
    });
    // FindFirstFile / FindNextFile
    const wild = pat => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    const putFind = (p, e) => { m.bytes(p, 320).fill(0); m.w32(p, e.dir ? 0x10 : 0x01); m.w32(p + 32, e.size); m.putCStr(p + 44, e.name, 260); };
    K('FindFirstFileA', 2, ([p, fd]) => {
      const pat = m.cstr(p), full = vfs.split(pat).full, i = full.lastIndexOf('\\');
      const dir = full.slice(0, i) || full, re = wild(full.slice(i + 1));
      const all = vfs.list(dir); W.fileLog?.(pat, false, !!all);
      const ents = (all || []).filter(e => re.test(e.name));
      if (!ents.length) { W.setErr(all ? ERR.FILE_NOT_FOUND : ERR.PATH_NOT_FOUND); return INVALID; }
      putFind(fd, ents[0]); return m.newHandle({ type: 'find', ents, i: 1 });
    });
    K('FindNextFileA', 2, ([h, fd]) => { const o = m.handles.get(h); if (!o || o.i >= o.ents.length) { W.setErr(ERR.NO_MORE_FILES); return 0; } putFind(fd, o.ents[o.i++]); return 1; });
    K('FindClose', 1, ([h]) => { m.handles.delete(h); return 1; });
    // file mappings (whole-file copies)
    K('CreateFileMappingA', 6, ([h]) => { const o = W.file(h); return o ? m.newHandle({ type: 'mapping', o }) : 0; });
    K('MapViewOfFile', 5, ([h, acc, hi, lo, n]) => {
      const mp = m.handles.get(h); if (!mp) return 0;
      const size = n || mp.o.f.size() - lo; const a = m.heap.alloc(size, false);
      const d = mp.o.f.read(lo, size); if (isPromise(d)) throw new Error('MapViewOfFile on an async backend');
      m.u8.set(d, a); return a;
    });
    K('UnmapViewOfFile', 1, ([a]) => { m.heap.release(a); return 1; });
    // INI files
    const ini = path => {
      const d = W.readWhole(path); if (d === null) return null;
      const finish = d => { const txt = new TextDecoder('latin1').decode(d); const out = new Map(); let sec = null;
        for (const line of txt.split(/\r?\n/)) {
          const t = line.trim(); if (!t || t[0] === ';') continue;
          const s = /^\[(.*)\]$/.exec(t); if (s) { sec = s[1].toLowerCase(); if (!out.has(sec)) out.set(sec, []); continue; }
          if (sec !== null) { const k = t.indexOf('='); out.get(sec).push(k < 0 ? [t, ''] : [t.slice(0, k).trim(), t.slice(k + 1).trim()]); }
        }
        return out; };
      return isPromise(d) ? d.then(finish) : finish(d);
    };
    const withIni = (path, fn) => { const v = ini(path); if (v === null) return fn(new Map()); return W.asyncOr(v, fn); };
    K('GetPrivateProfileStringA', 6, ([ps, pk, pd, buf, n, pf]) => withIni(m.cstr(pf), I => {
      const sec = I.get(m.cstr(ps)?.toLowerCase()) || [], key = pk ? m.cstr(pk).toLowerCase() : null;
      let v = pd ? m.cstr(pd) : '';
      if (key === null) { const s = sec.map(([k]) => k).join('\0') + '\0'; for (let i = 0; i < Math.min(s.length, n); i++) m.w8(buf + i, s.charCodeAt(i)); m.w8(buf + Math.min(s.length, n - 1), 0); return Math.max(0, Math.min(s.length, n - 2)); }
      const hit = sec.find(([k]) => k.toLowerCase() === key); if (hit) v = hit[1];
      return m.putCStr(buf, v, n);
    }));
    K('GetPrivateProfileSectionA', 4, ([ps, buf, n, pf]) => withIni(m.cstr(pf), I => {
      const sec = I.get(m.cstr(ps).toLowerCase()) || [];
      const s = sec.map(([k, v]) => k + '=' + v).join('\0');
      const len = Math.min(s.length, n - 2);
      for (let i = 0; i < len; i++) m.w8(buf + i, s.charCodeAt(i));
      m.w8(buf + len, 0); m.w8(buf + len + 1, 0);
      return len;
    }));
    K('GetPrivateProfileIntA', 4, ([ps, pk, def, pf]) => withIni(m.cstr(pf), I => {
      const sec = I.get(m.cstr(ps).toLowerCase()) || []; const hit = sec.find(([k]) => k.toLowerCase() === m.cstr(pk).toLowerCase());
      const v = hit ? parseInt(hit[1], 10) : NaN; return isNaN(v) ? def : v >>> 0;
    }));
    def('shfolder.dll', 'SHGetFolderPathA', 5, ([hwnd, csidl, tok, fl, buf]) => { m.putCStr(buf, APPDATA_ROOT, 260); return 0; });

    // ---- strings / locale
    const ctype = c => { let t = 0; const ch = String.fromCharCode(c);
      if (c >= 65 && c <= 90 || c >= 0xC0 && c <= 0xDE && c !== 0xD7) t |= 0x101; if (c >= 97 && c <= 122 || c >= 0xDF && c <= 0xFF && c !== 0xF7) t |= 0x102;
      if (c >= 48 && c <= 57) t |= 0x84; if (/[a-fA-F]/.test(ch)) t |= 0x80; if (c === 32 || c >= 9 && c <= 13) t |= 8; if (c === 32 || c === 9) t |= 0x40;
      if (c < 32 || c === 127) t |= 0x20; if (c > 32 && c < 127 && !(t & 0x104)) t |= 0x10; return t; };
    K('GetStringTypeA', 5, ([lcid, type, src, n, out]) => { if ((n | 0) < 0) n = m.cstr(src).length + 1; for (let i = 0; i < n; i++) m.w16(out + 2 * i, type === 1 ? ctype(m.r8(src + i)) : 0); return 1; });
    K('GetStringTypeW', 4, ([type, src, n, out]) => { if ((n | 0) < 0) n = m.wstr(src).length + 1; for (let i = 0; i < n; i++) m.w16(out + 2 * i, type === 1 ? ctype(m.r16(src + 2 * i) & 0xff) : 0); return 1; });
    const mapCase = (s, fl) => (fl & 0x100 ? s.toLowerCase() : fl & 0x200 ? s.toUpperCase() : s);
    K('LCMapStringA', 6, ([lcid, fl, src, n, dst, dn]) => {
      if ((n | 0) < 0) n = m.cstr(src).length + 1;
      const s = mapCase(String.fromCharCode(...m.bytes(src, n)), fl);
      if (!dn) return s.length; for (let i = 0; i < Math.min(s.length, dn); i++) m.w8(dst + i, s.charCodeAt(i)); return Math.min(s.length, dn);
    });
    K('LCMapStringW', 6, ([lcid, fl, src, n, dst, dn]) => {
      if ((n | 0) < 0) n = m.wstr(src).length + 1;
      const s = mapCase(m.wstr(src, n), fl);
      if (!dn) return s.length; for (let i = 0; i < Math.min(s.length, dn); i++) m.w16(dst + 2 * i, s.charCodeAt(i)); return Math.min(s.length, dn);
    });
    const cmp = (a, b, fl) => { if (fl & 1) { a = a.toLowerCase(); b = b.toLowerCase(); } return a < b ? 1 : a > b ? 3 : 2; };
    K('CompareStringA', 6, ([lcid, fl, s1, n1, s2, n2]) => cmp((n1 | 0) < 0 ? m.cstr(s1) : String.fromCharCode(...m.bytes(s1, n1)), (n2 | 0) < 0 ? m.cstr(s2) : String.fromCharCode(...m.bytes(s2, n2)), fl));
    K('CompareStringW', 6, ([lcid, fl, s1, n1, s2, n2]) => cmp(m.wstr(s1, n1 | 0), m.wstr(s2, n2 | 0), fl));
    K('MultiByteToWideChar', 6, ([cp, fl, src, n, dst, dn]) => {
      const len = (n | 0) < 0 ? m.cstr(src).length + 1 : n;
      if (!dn) return len;
      const k = Math.min(len, dn); for (let i = 0; i < k; i++) m.w16(dst + 2 * i, m.r8(src + i));
      if (k < len) { W.setErr(ERR.INSUFFICIENT_BUFFER); return 0; } return k;
    });
    K('WideCharToMultiByte', 8, ([cp, fl, src, n, dst, dn, pdef, pused]) => {
      const len = (n | 0) < 0 ? m.wstr(src).length + 1 : n;
      if (pused) m.w32(pused, 0);
      if (!dn) return len;
      const k = Math.min(len, dn); for (let i = 0; i < k; i++) { const c = m.r16(src + 2 * i); m.w8(dst + i, c < 256 ? c : 0x3f); }
      if (k < len) { W.setErr(ERR.INSUFFICIENT_BUFFER); return 0; } return k;
    });

    // ---- SEH
    K('RaiseException', 4, ([code, flags, n, pargs], mm, esp) => W.raiseException(code, flags, n, pargs, esp));
    K('RtlUnwind', 4, ([frame, target, rec, ret]) => W.rtlUnwind(frame, target, rec, ret));

    // ---- USER32: windows and messages
    U('RegisterClassA', 1, ([p]) => { const name = m.r32(p + 36); const n = name < 0x10000 ? '#' + name : m.cstr(name); W.classes.set(n.toLowerCase(), { proc: m.r32(p + 4) }); return 0xC000 + W.classes.size; });
    U('UnregisterClassA', 2, ok);
    U('FindWindowA', 2, () => 0);
    U('CreateWindowExA', 12, ([ex, cls, title, style, x, y, w, h, parent, menu, inst, param]) => {
      const c = W.classes.get(m.cstr(cls).toLowerCase());
      const hwnd = W.nextHwnd; W.nextHwnd += 0x10;
      W.windows.set(hwnd, { proc: c ? c.proc : 0, w: w | 0, h: h | 0, title: m.cstr(title), long: new Map() });
      m.log(`CreateWindowExA("${m.cstr(cls)}", "${m.cstr(title)}", ${w | 0}x${h | 0}) -> ${hex(hwnd)}`);
      W.mainHwnd = W.mainHwnd || hwnd;
      return hwnd;
    });
    U('DestroyWindow', 1, ok);
    U('ShowWindow', 2, ([hwnd, cmd]) => {
      const w = W.windows.get(hwnd); if (!w) return 0;
      const was = !!w.visible; w.visible = cmd !== 0;
      if (!was && w.visible) {
        // what Windows sends synchronously when a top-level window is shown and activated
        W.sendMessage(hwnd, 0x18, 1, 0);                               // WM_SHOWWINDOW
        W.sendMessage(hwnd, 0x1C, 1, 0);                               // WM_ACTIVATEAPP
        W.sendMessage(hwnd, 0x06, 1, 0);                               // WM_ACTIVATE(WA_ACTIVE)
        W.sendMessage(hwnd, 0x07, 0, 0);                               // WM_SETFOCUS
      }
      return was ? 1 : 0;
    });
    U('UpdateWindow', 1, ok); U('SetActiveWindow', 1, ([h]) => h); U('SetWindowPos', 7, ok);
    U('GetParent', 1, zero);
    const rectOf = hwnd => { const w = W.windows.get(hwnd); return w ? [0, 0, w.w || 640, w.h || 480] : null; };
    U('GetClientRect', 2, ([hwnd, p]) => { const r = rectOf(hwnd); if (!r) { W.setErr(1400); return 0; } r.forEach((v, i) => m.w32(p + 4 * i, v)); return 1; });
    U('GetWindowRect', 2, ([hwnd, p]) => { const r = rectOf(hwnd); if (!r) { W.setErr(1400); return 0; } r.forEach((v, i) => m.w32(p + 4 * i, v)); return 1; });
    U('ClientToScreen', 2, ok); U('MapWindowPoints', 4, zero);
    U('AdjustWindowRect', 3, ok); U('AdjustWindowRectEx', 4, ok);
    U('GetMonitorInfoA', 2, ([h, p]) => { [0, 0, 1920, 1080, 0, 0, 1920, 1040].forEach((v, i) => m.w32(p + 4 + 4 * i, v)); m.w32(p + 36, 1); return 1; });
    U('GetCursorPos', 1, ([p]) => { m.w32(p, W.input.cursor.x); m.w32(p + 4, W.input.cursor.y); return 1; });
    U('SetCursor', 1, zero); U('LoadCursorA', 2, () => 0x20001); U('LoadIconA', 2, () => 0x20003);
    U('ClipCursor', 1, ok); U('GetClipCursor', 1, ([p]) => { [0, 0, 1920, 1080].forEach((v, i) => m.w32(p + 4 * i, v)); return 1; });
    U('SystemParametersInfoA', 4, ([a, ui, pv]) => { if (pv && (a === 0x3A || a === 0x70)) { if (a === 0x70) m.w32(pv, 10); } return 1; });
    U('MessageBoxA', 4, ([h, t, c]) => { const s = `MessageBoxA "${m.cstr(c)}": ${m.cstr(t)}`; m.log('*** ' + s); W.messageBoxes = (W.messageBoxes || 0) + 1; if (W.onMessageBox) W.onMessageBox(s); return 1; });
    U('DrawTextA', 5, zero); U('DrawTextW', 5, zero);
    U('GetWindowLongA', 2, ([h, i]) => W.windows.get(h)?.long.get(i | 0) ?? 0);
    U('SetWindowLongA', 3, ([h, i, v]) => { const w = W.windows.get(h); if (!w) return 0; const o = w.long.get(i | 0) ?? 0; w.long.set(i | 0, v); return o; });
    U('SetWindowTextW', 2, ok);
    U('DefWindowProcA', 4, zero);
    U('PostQuitMessage', 1, ([c]) => { W.postMessage(0, 0x12, c, 0); });
    U('SendMessageA', 4, ([h, msg, w, l]) => (msg === 0x80 ? 0 : W.sendMessage(h, msg, w, l)));   // WM_SETICON: DefWindowProc
    U('TranslateMessage', 1, zero);
    U('DispatchMessageA', 1, ([p]) => W.sendMessage(m.r32(p), m.r32(p + 4), m.r32(p + 8), m.r32(p + 12)));
    U('PeekMessageA', 5, ([p, hwnd, lo, hi, rm]) => {
      W.pumpHook?.();
      if (W.msgq.length && W.msgq[0].hold) W.msgq[0].hold--;                 // held message: try again next pump (frame)
      else if (W.msgq.length) { W.writeMsg(p, W.msgq[0]); if (rm & 1) W.msgq.shift(); return 1; }
      // pump with no Present since the last pump: give the browser (or the virtual clock) one frame tick
      const yieldNow = !W.presentedSincePump && m.cur === m.mainThread && !m.nested;
      W.presentedSincePump = false;
      if (yieldNow) return W.frameWait(10, 'pump');
      return 0;
    });
    U('GetMessageA', 4, ([p]) => {
      if (W.msgq.length) { const q = W.msgq.shift(); W.writeMsg(p, q); return q.msg === 0x12 ? 0 : 1; }
      return new Wait({ check: () => (W.msgq.length ? (W.writeMsg(p, W.msgq[0]), W.msgq.shift().msg === 0x12 ? 0 : 1) : undefined), what: 'GetMessageA' });
    });

    // ---- GDI32 (handles only; text is drawn by the D3DX font HLE in the browser)
    const gnew = o => { const h = W.nextGdi; W.nextGdi += 4; W.gdi.set(h, o); return h; };
    G('CreateDCA', 4, () => gnew({ type: 'dc' })); G('CreateCompatibleDC', 1, () => gnew({ type: 'dc' })); G('DeleteDC', 1, ok);
    G('GetDeviceCaps', 2, ([h, i]) => ({ 4: 400, 6: 300, 8: 1920, 10: 1080, 12: 32, 14: 1, 24: -1, 40: 36, 42: 36, 44: 51, 88: 96, 90: 96, 116: 60 }[i] ?? 0));
    const font = (lf) => gnew({ type: 'font', lf });
    G('CreateFontA', 14, (a) => font({ height: a[0] | 0, width: a[1] | 0, weight: a[4], italic: a[5], face: m.cstr(a[13]) || '' }));
    G('CreateFontW', 14, (a) => font({ height: a[0] | 0, width: a[1] | 0, weight: a[4], italic: a[5], face: m.wstr(a[13]) || '' }));
    G('CreateFontIndirectA', 1, ([p]) => font({ height: m.r32(p) | 0, width: m.r32(p + 4) | 0, weight: m.r32(p + 16), italic: m.r8(p + 20), face: m.cstr(p + 28) }));
    G('GetObjectA', 3, ([h, n, p]) => {
      const o = W.gdi.get(h); if (!o) return 0;
      if (o.type === 'font') { if (!p) return 60; m.bytes(p, Math.min(n, 60)).fill(0); m.w32(p, o.lf.height); m.w32(p + 4, o.lf.width); m.w32(p + 16, o.lf.weight); m.w8(p + 20, o.lf.italic); m.putCStr(p + 28, o.lf.face, 32); return 60; }
      if (o.type === 'bitmap') { if (!p) return 24; m.bytes(p, 24).fill(0); m.w32(p + 4, o.w); m.w32(p + 8, o.h); m.w32(p + 12, o.w * 4); m.w16(p + 16, 1); m.w16(p + 18, 32); m.w32(p + 20, o.bits); return 24; }
      return 0;
    });
    G('CreateDIBSection', 6, ([hdc, bmi, usage, ppv]) => {
      const w = m.r32(bmi + 4) | 0, h = Math.abs(m.r32(bmi + 8) | 0), bpp = m.r16(bmi + 14);
      const bits = m.heap.alloc(Math.max(4, ((w * bpp + 31) >> 5) * 4 * h)); if (ppv) m.w32(ppv, bits);
      return gnew({ type: 'bitmap', w, h, bpp, bits });
    });
    G('SelectObject', 2, ([hdc, h]) => 0x50001); G('DeleteObject', 1, ([h]) => { const o = W.gdi.get(h); if (o?.bits) m.heap.release(o.bits); W.gdi.delete(h); return 1; });
    G('SetTextColor', 2, zero); G('SetBkColor', 2, zero); G('SetBkMode', 2, () => 1); G('GetStockObject', 1, ([i]) => 0x50100 + i);

    // ---- SHELL32
    def('shell32.dll', 'DragAcceptFiles', 2, zero); def('shell32.dll', 'DragFinish', 1, zero);
    def('shell32.dll', 'DragQueryFileA', 4, zero); def('shell32.dll', 'ShellExecuteA', 6, () => 2);

    // ---- binkw32: a frame-timing stub. BinkOpen reads the real .bik header (frames, size, fps) and returns a fake HBINK, so
    // the game's movie loops run for the real duration and end normally (the front end needs a movie to finish: PlayMovie
    // only restores the FE state after a successful open). Frames are black unless W.binkDecoder is set (browser).
    const B = (n, a, f) => def('binkw32.dll', n, a, f);
    W.binks = new Map();
    B('_BinkOpen@8', 2, ([p, fl]) => {
      const name = m.cstr(p), st = vfs.stat(name);
      if (!st || st.dir) { m.log(`BinkOpen("${name}") -> 0 (no file)`); return 0; }
      const { be, rel } = vfs.split(name); const f = be.open(rel, {});
      return W.asyncOr(f.read(0, 44), hdr => {
        const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.length);
        const frames = dv.getUint32(8, true), w = dv.getUint32(20, true), h = dv.getUint32(24, true);
        const fps = dv.getUint32(28, true) || 30, div = dv.getUint32(32, true) || 1, tracks = dv.getUint32(40, true);
        const hb = m.heap.alloc(0x400);
        [w, h, frames, 1, 0, fps, div].forEach((v, i) => m.w32(hb + 4 * i, v));
        m.w32(hb + 0xF0, Math.max(8, tracks));
        W.binks.set(hb, { name, frames, fps, div, t0: m.clock.now(), paused: false, file: f, w, h });
        m.log(`BinkOpen("${name}") -> ${hex(hb)} (${w}x${h}, ${frames} frames @ ${(fps / div).toFixed(2)} fps)`);
        W.moviesOpened = (W.moviesOpened || 0) + 1;
        return hb;
      });
    });
    const frameDue = b => b.t0 + (m.r32(b.hb + 12) - 1) * 1000 * b.div / b.fps;
    B('_BinkWait@4', 1, ([hb]) => { const b = W.binks.get(hb); if (!b) return 0; b.hb = hb; return m.clock.now() < frameDue(b) ? 1 : 0; });
    B('_BinkDoFrame@4', 1, () => 0);
    B('_BinkNextFrame@4', 1, ([hb]) => { m.w32(hb + 16, m.r32(hb + 12)); m.w32(hb + 12, m.r32(hb + 12) + 1); return 0; });
    B('_BinkCopyToBuffer@28', 7, ([hb, dst, pitch, h, x, y, fl]) => {
      const b = W.binks.get(hb); if (!b) return 1;
      if (W.binkDecoder) return W.binkDecoder(b, m.r32(hb + 12) - 1, dst, pitch, h);
      m.bytes(dst, pitch * h).fill(0); return 0;
    });
    B('_BinkClose@4', 1, ([hb]) => { const b = W.binks.get(hb); if (b) { b.file.close?.(); W.binks.delete(hb); m.heap.release(hb); } return 0; });
    B('_BinkPause@8', 2, ([hb, p]) => { const b = W.binks.get(hb); if (b) b.paused = !!p; return p; });
    B('_BinkSetSoundSystem@8', 2, () => 1); B('_BinkOpenDirectSound@4', 1, () => 0); B('_BinkSetVolume@12', 3, zero);
    B('_BinkSetSoundTrack@8', 2, zero); B('_RADSetMemory@8', 2, zero); B('_BinkService@4', 1, zero);
    return S;
  }

  /* ---------------------------------------------------------------- SEH (Win32 x86 frame-based) */
  raiseException(code, flags, n, pargs, esp) {
    const m = this.m;
    m.log(`RaiseException(${hex(code)}, flags ${flags}, ${n} args) from ${hex(m.r32(esp))} thread ${m.cur.name}`);
    this.exceptions = (this.exceptions || 0) + 1;
    // EXCEPTION_RECORD + CONTEXT below the current stack
    const rec = (esp - 0x400) >>> 0, ctx = (rec - 0x300) >>> 0;
    m.bytes(ctx, 0x300).fill(0); m.bytes(rec, 0x50).fill(0);
    m.w32(rec, code); m.w32(rec + 4, flags & 1); m.w32(rec + 12, m.r32(esp)); m.w32(rec + 16, Math.min(n, 15));
    for (let i = 0; i < Math.min(n, 15); i++) m.w32(rec + 20 + 4 * i, m.r32(pargs + 4 * i));
    m.w32(ctx, 0x10007);
    [[0xB0, 0], [0xAC, 1], [0xA8, 2], [0xA4, 3], [0xB4, 5], [0xA0, 6], [0x9C, 7]].forEach(([o, r]) => m.w32(ctx + o, m.reg(r)));
    m.w32(ctx + 0xC4, esp + 4); m.w32(ctx + 0xB8, m.r32(esp));
    const saveEsp = m.esp;
    m.esp = ctx - 0x40;
    let frame = m.r32(m.fsBase), depth = 0;
    while (frame !== 0xFFFFFFFF && frame && depth++ < 256) {
      const handler = m.r32(frame + 4);
      m.log(`  SEH frame ${hex(frame)} handler ${hex(handler)}`);
      const r = m.callGuest(handler, [rec, frame, ctx, 0], 'cdecl');
      if (r === 0) { m.esp = saveEsp; m.log('  -> ExceptionContinueExecution'); return 0; }
      frame = m.r32(frame);
    }
    m.esp = saveEsp;
    throw new Error(`unhandled exception ${hex(code)} (no SEH frame handled it)`);
  }
  rtlUnwind(target, ip, rec, ret) {
    // call each handler between FS:[0] and target with EXCEPTION_UNWINDING, then pop them
    const m = this.m;
    let frame = m.r32(m.fsBase);
    m.log(`RtlUnwind to frame ${hex(target)}`);
    const urec = (m.esp - 0x200) >>> 0; m.bytes(urec, 0x50).fill(0);
    if (rec) m.u8.copyWithin(urec, rec, rec + 0x50);
    m.w32(urec + 4, m.r32(urec + 4) | 2);
    while (frame !== 0xFFFFFFFF && frame !== target) {
      const handler = m.r32(frame + 4);
      const save = m.esp; m.esp = urec - 0x100;
      m.callGuest(handler, [urec, frame, 0, 0], 'cdecl');
      m.esp = save;
      frame = m.r32(frame); m.w32(m.fsBase, frame);
    }
    return { eax: ret };
  }
}
