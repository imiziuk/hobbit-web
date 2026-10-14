// Node file source for reader.js: random-access reads without loading the whole log.
import {open} from "node:fs/promises";
export async function fromFile(path){
  const fh = await open(path, "r");
  const {size} = await fh.stat();
  return {size, close: () => fh.close(), read: async (off, len) => {
    const n = Math.max(0, Math.min(len, size - off)), b = Buffer.alloc(n);
    if (n) await fh.read(b, 0, n, off);
    return new Uint8Array(b.buffer, b.byteOffset, n);
  }};
}
