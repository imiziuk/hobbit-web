// DirectSound mixer core, shared by the browser AudioWorklet (web/audio-worklet.js) and the Node offline renderer
// (recomp/boot_node.mjs --audio-wav). No DOM / WebAudio dependencies.
//
// Model: "data" objects hold the raw bytes of a DirectSound buffer (a copy of guest memory, updated on every Unlock);
// "voices" play a data object (DuplicateSoundBuffer = two voices on one data object). Timed commands carry `at`
// (seconds on the mixer's own clock: frame / sampleRate) and take effect on that output frame, so the play cursor the
// host reports to the game (computed on the main thread from the same `at` + rate) matches what the mixer plays.
//
// commands (post):
//   {op:'data', id, size, bits, ch}             create/resize a data object
//   {op:'write', id, off, bytes:Uint8Array}     copy bytes into it (immediate)
//   {op:'voice', id, data}                      create a voice on data object `data` (immediate)
//   {op:'free', id} / {op:'freeData', id}       (immediate)
//   {op:'set', id, at, pos?, freq?, playing?, loop?, gl?, gr?}   timed; pos in bytes, freq in frames/s
//   {op:'master', gain}                         (immediate; the primary buffer's volume)
//   {op:'reset'}                                drop everything (before a resync)
export class DsMixer {
  constructor(sampleRate) {
    this.sr = sampleRate; this.frame = 0; this.data = new Map(); this.voices = new Map(); this.queue = [];
    this.master = 1;
    this.stats = { peak: 0, sumsq: 0, n: 0 };     // reset by the reader
  }
  post(c) {
    if (c.at !== undefined) {
      const f = Math.max(this.frame, Math.round(c.at * this.sr));
      c.frame = f;
      let i = this.queue.length;                 // keep sorted by frame, stable
      while (i > 0 && this.queue[i - 1].frame > f) i--;
      this.queue.splice(i, 0, c);
      return;
    }
    this.apply(c);
  }
  apply(c) {
    switch (c.op) {
      case 'data': {
        const old = this.data.get(c.id), size = c.size + (c.size & 1);
        const d = { bytes: new Uint8Array(size), bits: c.bits || 16, ch: c.ch || 1 };
        if (old) d.bytes.set(old.bytes.subarray(0, Math.min(size, old.bytes.length)));
        d.i16 = new Int16Array(d.bytes.buffer, 0, size >> 1);
        d.align = (d.bits >> 3) * d.ch; d.frames = Math.floor(c.size / d.align);
        this.data.set(c.id, d); break;
      }
      case 'write': { const d = this.data.get(c.id); if (d) d.bytes.set(c.bytes.subarray(0, Math.max(0, d.bytes.length - c.off)), c.off); break; }
      case 'voice': this.voices.set(c.id, { data: c.data, pos: 0, step: 1, playing: false, loop: false, gl: 1, gr: 1, freq: this.sr }); break;
      case 'free': this.voices.delete(c.id); break;
      case 'freeData': this.data.delete(c.id); break;
      case 'master': this.master = c.gain; break;
      case 'reset': this.data.clear(); this.voices.clear(); this.queue.length = 0; this.master = 1; break;
      case 'set': {
        const v = this.voices.get(c.id); if (!v) break;
        const d = this.data.get(v.data);
        if (c.freq !== undefined) { v.freq = c.freq; }
        v.step = v.freq / this.sr;
        if (c.pos !== undefined && d) v.pos = c.pos / d.align;
        if (c.loop !== undefined) v.loop = c.loop;
        if (c.playing !== undefined) v.playing = c.playing;
        if (c.gl !== undefined) { v.gl = c.gl; v.gr = c.gr; }
        break;
      }
    }
  }
  /** Mix n frames into L and R (Float32Array, overwritten), starting at offset o. */
  render(L, R, n, o = 0) {
    let done = 0;
    while (done < n) {
      while (this.queue.length && this.queue[0].frame <= this.frame) this.apply(this.queue.shift());
      let k = n - done;
      if (this.queue.length) k = Math.min(k, this.queue[0].frame - this.frame);
      this.mix(L, R, o + done, k);
      done += k; this.frame += k;
    }
  }
  mix(L, R, o, k) {
    for (let i = 0; i < k; i++) { L[o + i] = 0; R[o + i] = 0; }
    for (const v of this.voices.values()) {
      if (!v.playing) continue;
      const d = this.data.get(v.data); if (!d || !d.frames) { v.playing = false; continue; }
      const N = d.frames, st = v.step, gl = v.gl, gr = v.gr, ch = d.ch, b16 = d.bits === 16, s16 = d.i16, s8 = d.bytes;
      let p = v.pos;
      for (let i = 0; i < k; i++) {
        if (p >= N) { if (v.loop) p -= N * Math.floor(p / N); else { v.playing = false; break; } }
        const a = p | 0, f = p - a;
        let b = a + 1; if (b >= N) b = v.loop ? 0 : a;
        let l, r;
        if (b16) {
          if (ch === 1) { l = r = (s16[a] + (s16[b] - s16[a]) * f) * (1 / 32768); }
          else { l = (s16[2 * a] + (s16[2 * b] - s16[2 * a]) * f) * (1 / 32768); r = (s16[2 * a + 1] + (s16[2 * b + 1] - s16[2 * a + 1]) * f) * (1 / 32768); }
        } else {
          if (ch === 1) { l = r = (s8[a] + (s8[b] - s8[a]) * f - 128) * (1 / 128); }
          else { l = (s8[2 * a] + (s8[2 * b] - s8[2 * a]) * f - 128) * (1 / 128); r = (s8[2 * a + 1] + (s8[2 * b + 1] - s8[2 * a + 1]) * f - 128) * (1 / 128); }
        }
        L[o + i] += l * gl; R[o + i] += r * gr;
        p += st;
      }
      v.pos = p;
    }
    const g = this.master, S = this.stats;
    for (let i = 0; i < k; i++) {
      let l = L[o + i] * g, r = R[o + i] * g;
      l = l > 1 ? 1 : l < -1 ? -1 : l; r = r > 1 ? 1 : r < -1 ? -1 : r;
      L[o + i] = l; R[o + i] = r;
      const a = Math.max(Math.abs(l), Math.abs(r)); if (a > S.peak) S.peak = a;
      S.sumsq += l * l + r * r; S.n += 2;
    }
  }
}

/** DirectSound volume (hundredths of a dB, 0 .. -10000) and pan (-10000 .. 10000) -> left/right linear gains. */
export function dsGains(vol, pan) {
  const g = vol <= -10000 ? 0 : Math.pow(10, Math.min(0, vol) / 2000);
  const p = Math.max(-10000, Math.min(10000, pan | 0));
  const gl = p > 0 ? (p >= 10000 ? 0 : Math.pow(10, -p / 2000)) : 1;
  const gr = p < 0 ? (p <= -10000 ? 0 : Math.pow(10, p / 2000)) : 1;
  return [g * gl, g * gr];
}

/** 16-bit PCM WAV from interleaved-able float channels. */
export function wavBytes(L, R, sr, n = L.length) {
  const out = new Uint8Array(44 + n * 4), dv = new DataView(out.buffer);
  const s = (o, t) => { for (let i = 0; i < 4; i++) out[o + i] = t.charCodeAt(i); };
  s(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); s(8, 'WAVE'); s(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); s(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + 4 * i, Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), true);
    dv.setInt16(46 + 4 * i, Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), true);
  }
  return out;
}
