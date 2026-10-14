// Offline round-trip check of logs written by synth.exe through the real recorder DLL:
//   node test/check_log.mjs build/run_a [build/run_b ...]
// Parses each log with reader.js and compares with the run's expect.json: call counts, texture contents (CRC32 after
// resolving dedupe REFs), the dynamic VB contents rebuilt from DISCARD/NOOVERWRITE locks + DIFF spans, HR prefixes
// of the failing calls, shot count/size/pixels, END record, chunk sequence.
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {LogReader} from "../reader.js";
import {fromFile} from "../nodefile.mjs";

const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); if (!ok) failures++; };

for (const dir of process.argv.slice(2)){
  const log = readdirSync(dir).find(f => f.endsWith(".d3dr"));
  const exp = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8"));
  console.log(`${dir}/${log}`);
  const src = await fromFile(join(dir, log));
  const r = new LogReader(src);
  const header = await r.open();
  const counts = {}, texIds = [], vbIds = [], surfTex = new Map(), texData = new Map(), texKinds = new Map();
  const vbMem = new Map(), vbLocks = new Map(), hrOf = {};
  let shots = [], end = null, creates = 0;
  for await (const rec of r.records()){
    const key = rec.iface === "Device" || rec.iface === "Meta" ? rec.name : `${rec.iface}_${rec.name}`;
    counts[key] = (counts[key] || 0) + 1;
    if (rec.hr) hrOf[rec.name] = rec.hr >>> 0;
    const a = rec.args;
    switch (`${rec.iface}::${rec.name}`){
      case "Meta::Create": creates++; break;
      case "Device::CreateTexture": texIds.push(a[6]); break;
      case "Device::CreateVertexBuffer": vbIds.push(a[4]); vbMem.set(a[4], new Uint8Array(a[0])); break;
      case "Texture::GetSurfaceLevel": surfTex.set(a[1], rec.self); break;
      case "Surface::UnlockRect": case "Texture::UnlockRect": {
        const tex = rec.iface === "Surface" ? surfTex.get(rec.self) : rec.self, d = a[a.length - 1];
        if (d.kind && (rec.iface === "Surface" || a[0] === 0)){ texData.set(tex, d.bytes); texKinds.set(tex, d.kind); }
        break;
      }
      case "VB::Lock": (vbLocks.get(rec.self) || vbLocks.set(rec.self, []).get(rec.self)).push({off: a[0], size: a[1]}); break;
      case "VB::Unlock": {
        const L = vbLocks.get(rec.self).pop(), mem = vbMem.get(rec.self), d = a[0];
        const size = L.size || mem.length - L.off, view = mem.subarray(L.off, L.off + size);
        if (d.kind === 1 || d.kind === 2) view.set(d.bytes.subarray(0, size));
        else if (d.kind === 3) for (const s of d.spans) view.set(s.bytes, s.off);
        break;
      }
      case "Meta::Shot": shots.push({frame: a[0], w: a[1], h: a[2], scale: a[3], px: a[5]}); break;
      case "Meta::End": end = {frames: a[0], calls: a[1]}; break;
    }
  }
  await src.close();
  const s = r.stats;
  console.log(`  header: shot_interval ${header.shot_interval}, scale ${header.shot_scale}, chunk_kb ${header.chunk_kb}, diff ${header.diff}, compress ${header.compress}`);
  console.log(`  ${s.records} records, ${s.chunks} chunks, raw ${s.rawBytes} B -> file ${s.fileBytes} B, truncated ${s.truncated}`);
  check("Meta::Create once", creates === 1);
  for (const [k, v] of Object.entries(exp.counts)) check(`count ${k} = ${v}`, counts[k] === v, `got ${counts[k]}`);
  check("T1 contents (A8R8G8B8 via surface lock)", crc32(texData.get(texIds[0]) || []) === exp.crc.T1);
  check("T2 contents (DXT1 via texture lock)", crc32(texData.get(texIds[1]) || []) === exp.crc.T2);
  check("T4 = T1 stored once (REF)", texKinds.get(texIds[3]) === 2 && crc32(texData.get(texIds[3])) === exp.crc.T1, `kind ${texKinds.get(texIds[3])}`);
  check("T5 incompressible contents", crc32(texData.get(texIds[4]) || []) === exp.crc.T5);
  check("dynamic VB rebuilt from locks/diffs", crc32(vbMem.get(vbIds[0]).subarray(0, 160)) === exp.crc.dyn160);
  check("HR prefix on failing CreateCubeTexture", hrOf.CreateCubeTexture === 0x8876086C, (hrOf.CreateCubeTexture >>> 0).toString(16));
  check("HR prefix on failing GetDepthStencilSurface", hrOf.GetDepthStencilSurface === 0x8876086C);
  check("shots: count, size", shots.length === exp.shots && shots.every(x => x.w === exp.width / exp.scale && x.h === exp.height / exp.scale && x.px.length === x.w * x.h * 4));
  if (exp.scale === 1 && shots.length){
    const px = (sh, x, y) => [...sh.px.subarray((y * sh.w + x) * 4, (y * sh.w + x) * 4 + 4)];
    check("shot pixel inside rect A = (32,192,64)", px(shots[0], 10, 10).join() === "32,192,64,255", px(shots[0], 10, 10).join());
    const bad = shots.find(x => x.frame === exp.bad_frame);
    check("shot of frame 3 contains the magenta error", bad && px(bad, 135, 95).join() === "255,0,255,255");
  }
  check("END record", end && end.frames === exp.frames, JSON.stringify(end));
}
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
