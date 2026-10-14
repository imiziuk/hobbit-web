// Virtual file system for the Win32 shims. Windows paths are case-insensitive; two roots:
//   C:\HOBBIT  -> the game folder, READ-ONLY (Node: real folder; browser: HTTP Range reads from a local server)
//   C:\APPDATA -> settings (%APPDATA%\The Hobbit): Node = scratch dir, browser = memory
// Everything else does not exist.
export const GAME_ROOT = 'C:\\HOBBIT', APPDATA_ROOT = 'C:\\APPDATA';

export function normWin(p, cwd) {
  p = p.replace(/\//g, '\\');
  if (/^[a-zA-Z]:\\/.test(p)) { /* absolute */ }
  else if (/^[a-zA-Z]:/.test(p)) p = p.slice(0, 2) + '\\' + p.slice(2);
  else if (p.startsWith('\\')) p = cwd.slice(0, 2) + p;
  else p = cwd + '\\' + p;
  const parts = [];
  for (const s of p.split('\\')) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (parts.length > 1) parts.pop(); continue; }
    parts.push(s);
  }
  if (parts.length === 1) return parts[0] + '\\';
  return parts.join('\\');
}

export class VFS {
  /** game: backend for C:\HOBBIT (read-only); appdata: backend for C:\APPDATA (read-write) */
  constructor(game, appdata) { this.game = game; this.appdata = appdata; this.cwd = GAME_ROOT; this.log = null; }
  split(winPath) {
    const full = normWin(winPath, this.cwd), up = full.toUpperCase();
    for (const [root, be] of [[GAME_ROOT, this.game], [APPDATA_ROOT, this.appdata]]) {
      if (up === root || up === root + '\\') return { full, be, rel: '' };
      if (up.startsWith(root + '\\')) return { full, be, rel: full.slice(root.length + 1).replace(/\\/g, '/') };
    }
    if (up === 'C:\\') return { full, be: null, rel: '', root: true };
    return { full, be: null, rel: null };
  }
  stat(winPath) {
    const { be, rel, root } = this.split(winPath);
    if (root) return { dir: true, size: 0 };
    if (!be || rel === null) return null;
    return be.stat(rel);
  }
  list(winDir) { const { be, rel, root } = this.split(winDir); if (root) return [{ name: 'HOBBIT', dir: true, size: 0 }, { name: 'APPDATA', dir: true, size: 0 }]; return be && rel !== null ? be.list(rel) : null; }
  writable(winPath) { const { be } = this.split(winPath); return be === this.appdata; }
}

/* ------------------------------------------------------------------ in-memory read-write backend (browser APPDATA) */
export class MemBackend {
  constructor() { this.files = new Map(); this.dirs = new Set(['']); }
  key(rel) { return rel.toLowerCase(); }
  stat(rel) {
    const k = this.key(rel);
    if (this.dirs.has(k)) return { dir: true, size: 0 };
    const f = this.files.get(k); return f ? { dir: false, size: f.data.length } : null;
  }
  list(rel) {
    const k = this.key(rel), pre = k ? k + '/' : '', out = [];
    for (const [fk, f] of this.files) if (fk.startsWith(pre) && !fk.slice(pre.length).includes('/')) out.push({ name: f.name, dir: false, size: f.data.length });
    for (const d of this.dirs) if (d && d.startsWith(pre) && !d.slice(pre.length).includes('/')) out.push({ name: d.slice(pre.length), dir: true, size: 0 });
    return this.dirs.has(k) ? out : null;
  }
  mkdir(rel) { this.dirs.add(this.key(rel)); return true; }
  open(rel, { write, create, truncate }) {
    const k = this.key(rel);
    let f = this.files.get(k);
    if (!f) { if (!create) return null; f = { name: rel.split('/').pop(), data: new Uint8Array(0) }; this.files.set(k, f); }
    if (truncate) f.data = new Uint8Array(0);
    return { size: () => f.data.length, read: (pos, n) => f.data.slice(pos, pos + n),
      write: (pos, d) => { if (pos + d.length > f.data.length) { const nd = new Uint8Array(pos + d.length); nd.set(f.data); f.data = nd; } f.data.set(d, pos); return d.length; },
      close() {} };
  }
  remove(rel) { return this.files.delete(this.key(rel)); }
}

/* ------------------------------------------------------------------ HTTP Range backend (browser, read-only game folder) */
// Reads are 64 KB blocks: memory cache (~128 MB) -> blocks already being downloaded (read-ahead or web/prefetch.mjs)
// -> persistent Cache API store (browser only, secure contexts: https or localhost) -> one ranged request per run of
// missing blocks. The store is keyed by file + version + size (from the manifest), so a changed game folder or the
// multiplayer overlay never serves stale blocks, and a second session reads almost nothing from the network. Node has
// no Cache API: it is skipped there.
// Read-ahead: the game reads its archives in 32 KB ReadFile calls, one after the other, so from a remote server every
// call paid a full round trip (measured with 80 ms latency: ~115 ms per 32 KB = 0.3 MB/s while loading a level). When
// a file is read sequentially, the next blocks (2, 4, 8 .. 16 = 1 MB) are requested in the background; the following
// ReadFile calls find them in flight or in memory.
export const DATA_CACHE = 'hobbit-data-v1';
export class HttpBackend {
  /** base: URL of the read-only game server; manifest: {files: [[relPath, size, version?], ...]} (dirs are implied)
   *  opts.persist: false disables the Cache API store; opts.readAhead: max blocks (default 16, 0 = off) */
  constructor(base, manifest, opts = {}) {
    this.base = base.replace(/\/$/, '');
    this.files = new Map(); this.dirs = new Map([['', '']]);
    for (const [p, size, ver] of manifest.files) {
      this.files.set(p.toLowerCase(), { path: p, size, ver: ver === undefined ? '' : String(ver),
        url: this.base + '/' + p.split('/').map(encodeURIComponent).join('/') });
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.set(parts.slice(0, i).join('/').toLowerCase(), parts.slice(0, i).join('/'));
    }
    this.cache = new Map(); this.BLOCK = 1 << 16; this.fetches = 0; this.bytes = 0; this.stored = 0; this.storeHits = 0;
    this.readAhead = opts.readAhead === undefined ? 16 : opts.readAhead;
    this.inflight = new Map();      // store key -> Promise<Uint8Array|null> of a block being downloaded
    this.gameWaiting = 0;           // game reads waiting right now (web/prefetch.mjs starts no request then)
    this.lastGameRead = 0;          // performance.now() when the last game read that had to wait finished
    this.onOpen = null;             // (f) => void: the game opened a file (prefetch priorities)
    this.onStored = null;           // (f, block, bytes) => void: a block reached the persistent store
    // diagnostics: reads the game had to wait for (the calling green thread blocks; see web/game.mjs hobbit.diag())
    this.waits = 0; this.waitMs = 0; this.netWaits = 0; this.trace = []; this.who = null;
    this.t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const can = opts.persist !== false && typeof caches !== 'undefined' && (typeof isSecureContext === 'undefined' || isSecureContext);
    this.store = can ? caches.open(DATA_CACHE).catch(() => null) : null;
  }
  stat(rel) {
    const k = rel.toLowerCase();
    if (this.dirs.has(k)) return { dir: true, size: 0 };
    const f = this.files.get(k); return f ? { dir: false, size: f.size } : null;
  }
  list(rel) {
    const k = rel.toLowerCase(); if (!this.dirs.has(k)) return null;
    const pre = k ? k + '/' : '', out = [];
    for (const [fk, f] of this.files) if (fk.startsWith(pre) && !fk.slice(pre.length).includes('/')) out.push({ name: f.path.split('/').pop(), dir: false, size: f.size });
    for (const [dk, d] of this.dirs) if (dk && dk.startsWith(pre) && !dk.slice(pre.length).includes('/')) out.push({ name: d.split('/').pop(), dir: true, size: 0 });
    return out;
  }
  open(rel, { write }) {
    if (write) return null;
    const f = this.files.get(rel.toLowerCase()); if (!f) return null;
    if (this.onOpen) try { this.onOpen(f); } catch { /* priorities only */ }
    const be = this;
    return { size: () => f.size, read: (pos, n) => be.read(f, pos, n), close() {} };
  }
  /** versioned URL: the server marks ?v= responses immutable (HTTP cache) */
  furl(f) { return f.ver ? `${f.url}?v=${encodeURIComponent(f.ver)}-${f.size}` : f.url; }
  skey(f, b) { return `${f.url}?v=${encodeURIComponent(f.ver)}-${f.size}&b=${b}`; }
  remember(f, b, blk) {
    this.cache.set(f.path + '#' + b, blk);
    if (this.cache.size > 8192) { const ks = [...this.cache.keys()].slice(0, 2048); ks.forEach(k => this.cache.delete(k)); }   // ~128 MB cap
  }
  /** returns Uint8Array synchronously when every block is in memory, else a Promise */
  read(f, pos, n) {
    n = Math.max(0, Math.min(n, f.size - pos));
    const B = this.BLOCK, b0 = Math.floor(pos / B), b1 = Math.floor((pos + n - 1) / B);
    const seq = f.lastEnd !== undefined && pos >= f.lastEnd - B && pos <= f.lastEnd + B;
    f.lastEnd = pos + n;
    const missing = [];
    for (let b = b0; b <= b1 && n > 0; b++) if (!this.cache.has(f.path + '#' + b)) missing.push(b);
    const assemble = () => {
      const out = new Uint8Array(n);
      for (let b = b0, o = 0; b <= b1 && n > 0; b++) {
        const blk = this.cache.get(f.path + '#' + b), s = Math.max(pos, b * B) - b * B, e = Math.min(pos + n, (b + 1) * B) - b * B;
        out.set(blk.subarray(s, e), o); o += e - s;
      }
      return out;
    };
    // read-ahead: grows while the file is read sequentially (also while the reads are memory hits)
    f.ra = seq ? Math.min(this.readAhead, Math.max(2, (f.ra || 1) * 2)) : 0;
    if (f.ra && n > 0) {
      const ahead = [], nb = Math.ceil(f.size / B);
      for (let b = b1 + 1; b <= b1 + f.ra && b < nb; b++)
        if (!this.cache.has(f.path + '#' + b) && !this.inflight.has(this.skey(f, b))) ahead.push(b);
      if (ahead.length) this.load(f, ahead, new Map(), true).catch(() => {});
    }
    if (!missing.length) return assemble();
    const pending = new Map();   // the blocks of this read stay referenced even if the memory cache evicts them
    const assemble2 = () => { for (const [b, blk] of pending) if (!this.cache.has(f.path + '#' + b)) this.cache.set(f.path + '#' + b, blk); return assemble(); };
    const t = performance.now(), who = this.who ? this.who() : '';
    this.waits++; this.gameWaiting++;
    return this.load(f, missing, pending, true).then(net => {
      const now = performance.now(), ms = now - t; this.waitMs += ms; if (net) this.netWaits++;
      this.gameWaiting--; this.lastGameRead = now;
      if (this.trace.length < 20000) this.trace.push([+((t - this.t0) / 1000).toFixed(3), f.path, pos, n, +ms.toFixed(1), net, missing.length - net, who]);
      return assemble2();
    }, e => { this.gameWaiting--; throw e; });
  }
  /** Get `blocks` of f into `pending` (and the memory cache when mem): blocks in flight, then the store, then the
   *  network. Every block this call looks up is claimed in `inflight` at once (synchronously), so a second reader
   *  (the game, read-ahead or the prefetcher) waits for it instead of downloading it again. A block is released when
   *  it is in the store. Resolves to the number of blocks that came from the network.
   *  opts: {skipStore: the caller knows they are not stored, signal, onBytes(n)} */
  async load(f, blocks, pending, mem, opts = {}) {
    const waits = [], mine = new Map();     // block -> resolve(bytes | null)
    for (const b of blocks) {
      const k = this.skey(f, b), p = this.inflight.get(k);
      if (p) { waits.push(p.then(blk => { if (blk) { pending.set(b, blk); if (mem) this.remember(f, b, blk); } })); continue; }
      let res; const pr = new Promise(r => { res = r; }); this.inflight.set(k, pr); mine.set(b, res);
    }
    const give = (b, blk) => { const r = mine.get(b); if (r) { mine.delete(b); r(blk); } };
    let net = 0;
    try {
      let rest = [...mine.keys()].sort((a, b) => a - b);
      if (rest.length && !opts.skipStore) {
        rest = await this.fromStore(f, rest, pending, mem);
        for (const b of mine.keys()) if (!rest.includes(b)) { give(b, pending.get(b)); this.inflight.delete(this.skey(f, b)); }
      }
      net = rest.length;
      await this.fromNet(f, rest, pending, mem, opts, give);
      await Promise.all(waits);
      // a block another reader was fetching and that failed: fetch it now
      const lost = blocks.filter(b => !pending.has(b));
      if (lost.length) { net += lost.length; await this.fromNet(f, lost, pending, mem, opts, () => {}); }
    } finally {
      for (const b of [...mine.keys()]) { give(b, null); this.inflight.delete(this.skey(f, b)); }
    }
    return net;
  }
  async fromStore(f, blocks, pending, mem = true) {
    const store = this.store && await this.store;
    if (!store || !blocks.length) return blocks;
    const got = await Promise.all(blocks.map(b => store.match(this.skey(f, b)).then(r => r ? r.arrayBuffer() : null).catch(() => null)));
    const rest = [];
    blocks.forEach((b, i) => {
      if (got[i]) { const blk = new Uint8Array(got[i]); pending.set(b, blk); if (mem) this.remember(f, b, blk); this.storeHits++; }
      else rest.push(b);
    });
    return rest;
  }
  /** Download blocks (one ranged request per run of up to 64 blocks) and put them into the store; mem: also into the
   *  memory cache. The body is read as a stream and every block is handed to give(b, bytes) as soon as it is
   *  complete, so a reader waiting for the first block of a 1 MB run does not wait for the whole run. */
  async fromNet(f, blocks, pending, mem = true, opts = {}, give = () => {}) {
    if (!blocks.length) return;
    const B = this.BLOCK, runs = [];
    for (const b of blocks) { const r = runs[runs.length - 1]; if (r && r[1] === b - 1 && b - r[0] < 64) r[1] = b; else runs.push([b, b]); }
    const store = this.store && await this.store;
    const puts = [];
    const emit = (b, blk) => {
      pending.set(b, blk); if (mem) this.remember(f, b, blk);
      if (!store) { give(b, blk); this.inflight.delete(this.skey(f, b)); return; }
      give(b, blk); this.stored++;
      // the claim stays until the store has the block, so nobody downloads it a second time meanwhile
      puts.push(store.put(this.skey(f, b), new Response(blk, { headers: { 'Content-Type': 'application/octet-stream' } }))
        .then(() => { if (this.onStored) this.onStored(f, b, blk.length); }).catch(() => {})
        .finally(() => this.inflight.delete(this.skey(f, b))));
    };
    await Promise.all(runs.map(async ([first, last]) => {
      const lo = first * B, hi = Math.min(f.size, (last + 1) * B) - 1, len = hi - lo + 1;
      this.fetches++;
      // no-store: the blocks go to the Cache API store; Chrome's HTTP cache would keep a second copy of them
      const r = await fetch(this.furl(f), { headers: { Range: `bytes=${lo}-${hi}` }, signal: opts.signal, ...(store ? { cache: 'no-store' } : {}) });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${f.path}`);
      if (r.status === 200 && +(r.headers.get('content-length') || len) !== len) throw new Error(`no Range support for ${f.path}`);
      const buf = new Uint8Array(len);
      let got = 0, next = first;
      const flush = () => { while (next <= last && got >= Math.min(len, (next - first + 1) * B)) { emit(next, buf.slice((next - first) * B, Math.min(len, (next - first + 1) * B))); next++; } };
      if (r.body && r.body.getReader) {
        const rd = r.body.getReader();
        for (;;) {
          const { done, value } = await rd.read(); if (done) break;
          const n = Math.min(value.length, len - got); buf.set(value.subarray(0, n), got); got += n; this.bytes += n;
          if (opts.onBytes) opts.onBytes(n);
          flush();
        }
      } else { const d = new Uint8Array(await r.arrayBuffer()); buf.set(d.subarray(0, len)); got = Math.min(len, d.length); this.bytes += got; flush(); }
      if (got < len) throw new Error(`short read for ${f.path} (${got} of ${len} bytes)`);
    }));
    await Promise.all(puts);
  }
  /** Download blocks first..last of f into the store only (web/prefetch.mjs); blocks in flight are skipped. */
  prefetch(f, first, last, opts = {}) {
    const blocks = [];
    for (let b = first; b <= last; b++) if (!this.inflight.has(this.skey(f, b))) blocks.push(b);
    return this.load(f, blocks, new Map(), false, { skipStore: true, ...opts });
  }
}

/** Delete the persistent game-data cache (browser). */
export async function clearDataCache() { return typeof caches !== 'undefined' ? caches.delete(DATA_CACHE) : false; }
