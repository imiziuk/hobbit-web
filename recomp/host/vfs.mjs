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
export class HttpBackend {
  /** base: URL of the read-only game server; manifest: {files: [[relPath, size], ...]} (dirs are implied) */
  constructor(base, manifest) {
    this.base = base.replace(/\/$/, '');
    this.files = new Map(); this.dirs = new Map([['', '']]);
    for (const [p, size] of manifest.files) {
      this.files.set(p.toLowerCase(), { path: p, size });
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) this.dirs.set(parts.slice(0, i).join('/').toLowerCase(), parts.slice(0, i).join('/'));
    }
    this.cache = new Map(); this.BLOCK = 1 << 16; this.fetches = 0; this.bytes = 0;
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
    const be = this;
    return { size: () => f.size, read: (pos, n) => be.read(f, pos, n), close() {} };
  }
  /** returns Uint8Array synchronously when every block is cached, else a Promise */
  read(f, pos, n) {
    n = Math.max(0, Math.min(n, f.size - pos));
    const B = this.BLOCK, b0 = Math.floor(pos / B), b1 = Math.floor((pos + n - 1) / B);
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
    if (!missing.length) return assemble();
    // one ranged request covering the missing blocks (bigger reads stay one request)
    const lo = missing[0] * B, hi = Math.min(f.size, (missing[missing.length - 1] + 1) * B) - 1;
    this.fetches++;
    return fetch(this.base + '/' + f.path.split('/').map(encodeURIComponent).join('/'), { headers: { Range: `bytes=${lo}-${hi}` } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} for ${f.path}`); return r.arrayBuffer(); })
      .then(buf => {
        const d = new Uint8Array(buf); this.bytes += d.length;
        for (let b = missing[0]; b <= missing[missing.length - 1]; b++) this.cache.set(f.path + '#' + b, d.subarray(b * B - lo, Math.min(d.length, (b + 1) * B - lo)));
        if (this.cache.size > 8192) { const ks = [...this.cache.keys()].slice(0, 2048); ks.forEach(k => this.cache.delete(k)); }   // ~128 MB cap
        return assemble();
      });
  }
}
