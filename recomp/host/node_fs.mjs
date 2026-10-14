// Node file backend for vfs.mjs: a real directory, read-only or read-write.
import fs from 'node:fs';
import path from 'node:path';

export class NodeBackend {
  constructor(root, writable = false) { this.root = root; this.writable = writable; this.reads = 0; this.bytes = 0; }
  real(rel) { return path.join(this.root, ...rel.split('/').filter(Boolean)); }
  stat(rel) {
    try { const s = fs.statSync(this.real(rel)); return { dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size }; } catch { return null; }
  }
  list(rel) {
    try {
      return fs.readdirSync(this.real(rel), { withFileTypes: true }).map(d => {
        const dir = d.isDirectory(); let size = 0;
        if (!dir) try { size = fs.statSync(path.join(this.real(rel), d.name)).size; } catch {}
        return { name: d.name, dir, size };
      });
    } catch { return null; }
  }
  mkdir(rel) { if (!this.writable) return false; try { fs.mkdirSync(this.real(rel), { recursive: true }); return true; } catch { return false; } }
  remove(rel) { if (!this.writable) return false; try { fs.unlinkSync(this.real(rel)); return true; } catch { return false; } }
  open(rel, { write, create, truncate }) {
    if (write && !this.writable) return null;
    const p = this.real(rel);
    let fd;
    try {
      if (write) {
        if (!fs.existsSync(p)) { if (!create) return null; fs.writeFileSync(p, ''); }
        if (truncate) fs.truncateSync(p, 0);
        fd = fs.openSync(p, 'r+');
      } else fd = fs.openSync(p, 'r');
    } catch { return null; }
    const be = this;
    return {
      size: () => fs.fstatSync(fd).size,
      read(pos, n) { const b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, pos); be.reads++; be.bytes += k; return new Uint8Array(b.buffer, b.byteOffset, k); },
      write(pos, d) { return fs.writeSync(fd, d, 0, d.length, pos); },
      close() { try { fs.closeSync(fd); } catch {} },
    };
  }
}
