// Minimal PE32 reader for Meridian.exe: sections and the import directory (resolved by name / ordinal).
export function parsePE(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pe = dv.getUint32(0x3c, true);
  const nsec = dv.getUint16(pe + 6, true), optsz = dv.getUint16(pe + 20, true);
  const opt = pe + 24;
  const base = dv.getUint32(opt + 28, true), entry = base + dv.getUint32(opt + 16, true);
  const sizeOfImage = dv.getUint32(opt + 56, true);
  const sections = [];
  for (let s = 0; s < nsec; s++) {
    const o = opt + optsz + 40 * s;
    let name = ''; for (let k = 0; k < 8 && buf[o + k]; k++) name += String.fromCharCode(buf[o + k]);
    sections.push({ name, va: base + dv.getUint32(o + 12, true), vsize: dv.getUint32(o + 8, true),
      raw: dv.getUint32(o + 20, true), rawSize: dv.getUint32(o + 16, true), chars: dv.getUint32(o + 36, true) });
  }
  const rva2off = rva => {
    for (const s of sections) { const r = s.va - base; if (rva >= r && rva < r + Math.max(s.vsize, s.rawSize)) return s.raw + (rva - r); }
    return -1;
  };
  const cstr = off => { let s = ''; while (buf[off]) s += String.fromCharCode(buf[off++]); return s; };
  const impRva = dv.getUint32(opt + 104, true);
  const imports = [];
  for (let d = rva2off(impRva); ; d += 20) {
    const ilt = dv.getUint32(d, true), nameRva = dv.getUint32(d + 12, true), iat = dv.getUint32(d + 16, true);
    if (!nameRva) break;
    const dll = cstr(rva2off(nameRva));
    for (let k = 0; ; k++) {
      const e = dv.getUint32(rva2off(ilt || iat) + 4 * k, true);
      if (!e) break;
      const slot = base + iat + 4 * k;
      if (e & 0x80000000) imports.push({ dll, name: '#' + (e & 0xffff), slot });
      else imports.push({ dll, name: cstr(rva2off(e) + 2), slot });
    }
  }
  return { base, entry, sizeOfImage, sections, imports };
}
