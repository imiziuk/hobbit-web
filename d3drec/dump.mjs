// .d3dr statistics and listing (Node):
//   node d3drec/dump.mjs <log.d3dr>                 summary: size, frames, op histogram, bytes by op, data kinds, events
//   node d3drec/dump.mjs <log.d3dr> --list [from] [to]   print records of frames [from, to] (default 0..0)
//   node d3drec/dump.mjs <log.d3dr> --fvf            FVF codes / primitive types seen with each draw call (port inventory)
import {LogReader} from "./reader.js";
import {fromFile} from "./nodefile.mjs";

const [path, mode, a1, a2] = process.argv.slice(2);
if (!path){ console.log("usage: node dump.mjs <log.d3dr> [--list from to | --fvf]"); process.exit(2); }
const src = await fromFile(path);
const r = new LogReader(src, {cacheBytes: 64 << 20});
const header = await r.open();
const ops = new Map(), kinds = [0, 0, 0, 0], kindBytes = [0, 0, 0, 0], events = [], fvfs = new Map();
let frame = 0, fvf = 0, shots = 0, firstMs = null, lastMs = 0;
const from = +(a1 || 0), to = +(a2 || from);
const fmtArg = v => v === null ? "null" : v instanceof Uint8Array ? `<${v.length} B>` : v instanceof Float32Array ? `[${[...v].map(x => +x.toFixed(3)).join(",")}]`
  : typeof v === "object" ? (v.kind !== undefined ? `{data kind ${v.kind}${v.blobId ? " blob " + v.blobId : ""}${v.bytes ? " " + v.bytes.length + " B" : ""}${v.spans ? " " + v.spans.length + " spans" : ""}}` : JSON.stringify(v))
  : typeof v === "number" && v > 0xffff ? "0x" + v.toString(16) : String(v);
for await (const rec of r.records()){
  const k = `${rec.iface}::${rec.name}`;
  const o = ops.get(k) || ops.set(k, {n: 0, bytes: 0}).get(k);
  o.n++; o.bytes += rec.size;
  for (const a of rec.args) if (a && a.kind !== undefined){
    kinds[a.kind]++;
    kindBytes[a.kind] += a.bytes ? a.bytes.length : a.spans ? a.spans.reduce((s, x) => s + x.bytes.length, 0) : 0;
  }
  if (rec.name === "SetVertexShader" && rec.iface === "Device") fvf = rec.args[0];
  if (/^Draw/.test(rec.name)){ const key = `fvf 0x${fvf.toString(16)} ${rec.name} pt ${rec.args[0]}`; fvfs.set(key, (fvfs.get(key) || 0) + 1); }
  if (rec.iface === "Meta" && rec.name === "Event") events.push(`[frame ${frame}] ${rec.args[0]}`);
  if (rec.iface === "Meta" && rec.name === "Shot") shots++;
  if (mode === "--list" && frame >= from && frame <= to)
    console.log(`f${frame} ${k}${rec.self ? "#" + rec.self : ""}(${rec.args.map(fmtArg).join(", ")})${rec.hr ? " hr=" + (rec.hr >>> 0).toString(16) : ""}`);
  if (rec.iface === "Device" && rec.name === "Present"){ frame++; if (firstMs === null) firstMs = rec.args[5]; lastMs = rec.args[5]; }
}
const s = r.stats, MB = x => (x / 1048576).toFixed(2) + " MB";
if (mode === "--fvf"){ for (const [k, v] of [...fvfs].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(8)}  ${k}`); process.exit(0); }
if (mode === "--list") process.exit(0);
const secs = (lastMs - (firstMs || 0)) / 1000;
console.log(`${path}\nheader ${JSON.stringify(header)}`);
console.log(`file ${MB(src.size)}, raw ${MB(s.rawBytes)} (LZ4 x${(s.rawBytes / Math.max(1, s.fileBytes)).toFixed(2)}), ${s.chunks} chunks, ${s.records} records, truncated ${s.truncated}, repeated chunks ${s.dupChunks}`);
console.log(`${frame} frames, ${shots} shots, ${secs.toFixed(1)} s between first and last Present` +
  (secs > 0 ? `, ${(frame / secs).toFixed(1)} fps, ${MB(src.size / secs * 1200)} per 20 min at this rate` : ""));
console.log(`lock data: NEW ${kinds[1]} (${MB(kindBytes[1])}), REF ${kinds[2]} (${MB(kindBytes[2])} not stored), DIFF ${kinds[3]} (${MB(kindBytes[3])} stored), none ${kinds[0]}`);
console.log("\nrecords by op (count, raw bytes):");
for (const [k, v] of [...ops].sort((a, b) => b[1].bytes - a[1].bytes)) console.log(`${String(v.n).padStart(10)} ${MB(v.bytes).padStart(12)}  ${k}`);
if (events.length){ console.log(`\nevents (${events.length}):`); for (const e of events.slice(0, 60)) console.log("  " + e); }
await src.close();
