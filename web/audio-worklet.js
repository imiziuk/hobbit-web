// AudioWorklet side of the DirectSound port: runs recomp/host/dsmix.mjs on the audio thread. The main thread
// (recomp/host/dx.mjs + web/audio.mjs) posts buffer data and timed state changes; this file only mixes.
import { DsMixer } from '../recomp/host/dsmix.mjs';

class DsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mx = new DsMixer(sampleRate);
    this.cap = null; this.lastStats = 0;
    this.port.onmessage = e => {
      const c = e.data;
      if (c.op === 'capture') { this.cap = { n: Math.round(c.seconds * sampleRate), L: [], R: [], got: 0 }; return; }
      this.mx.post(c);
    };
  }
  process(inputs, outputs) {
    const o = outputs[0], L = o[0], R = o[1] || new Float32Array(L.length), n = L.length;
    if (this.mx.frame < currentFrame) this.mx.frame = currentFrame;      // stay on the context clock (`at` = ctx seconds)
    this.mx.render(L, R, n);
    if (this.cap) {
      const c = this.cap; c.L.push(L.slice()); c.R.push(R.slice()); c.got += n;
      if (c.got >= c.n) { this.port.postMessage({ op: 'captured', L: c.L, R: c.R, sampleRate }); this.cap = null; }
    }
    if (currentFrame - this.lastStats >= sampleRate / 4) {
      const st = this.mx.stats; let voices = 0;
      for (const v of this.mx.voices.values()) if (v.playing) voices++;
      this.port.postMessage({ op: 'stats', rms: Math.sqrt(st.sumsq / Math.max(1, st.n)), peak: st.peak, voices, frame: currentFrame });
      st.sumsq = 0; st.n = 0; st.peak = 0; this.lastStats = currentFrame;
    }
    return true;
  }
}
registerProcessor('ds-mixer', DsProcessor);
