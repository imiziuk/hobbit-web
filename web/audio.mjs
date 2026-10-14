// Browser audio backend for the DirectSound port (recomp/host/dx.mjs installDirectSound).
// AudioContext -> AudioWorkletNode 'ds-mixer' (web/audio-worklet.js, the mixer in recomp/host/dsmix.mjs) -> analyser ->
// user gain (volume slider / mute) -> speakers. Without AudioWorklet (plain-http LAN pages are not a secure context)
// the same mixer runs in a ScriptProcessorNode on the main thread.
//
// Timeline: the DirectSound host computes play cursors from backend.now(). While the context is running that is
// ctx.currentTime (+ offset); before the first user gesture, or while the context is suspended, it is
// performance.now(), so the game still sees sounds start and finish. Every change of clock re-sends all live
// buffers to the mixer (W.ds.resync()).
import { DsMixer, wavBytes } from '../recomp/host/dsmix.mjs';

export function createAudio({ log = () => {}, lead = 0.05 } = {}) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const A = { ctx: null, kind: 'none', state: 'off', stats: { rms: 0, peak: 0, voices: 0 }, rmsLog: [], ds: null, user: { vol: 0.8, mute: false } };
  const perf = () => performance.now() / 1000;
  let mode = 'clock', off = 0, port = null, spMixer = null, captureCb = null;
  const send = (c, tr) => {
    if (mode !== 'ctx') return;                                  // replayed by resync when the context starts
    if (c.at !== undefined) c.at -= off;
    if (port) port.postMessage(c, tr || []); else if (spMixer) spMixer.post(c);
  };
  A.backend = { lead, now: () => (mode === 'ctx' ? A.ctx.currentTime : perf()) + off, post: send };

  const switchMode = running => {
    const t = A.backend.now();
    if (running && mode !== 'ctx') {
      mode = 'ctx'; off = t - A.ctx.currentTime;
      send({ op: 'reset' }); if (A.ds) A.ds.resync();
      log(`audio: ${A.kind} running at ${A.ctx.sampleRate} Hz` + (A.ds ? `, ${A.ds.buffers.size} live buffers resent` : ''));
    } else if (!running && mode === 'ctx') { mode = 'clock'; off = t - perf(); }
    A.state = A.ctx ? A.ctx.state : 'off';
  };
  A.attach = ds => { A.ds = ds; if (mode === 'ctx') { send({ op: 'reset' }); ds.resync(); } };

  const applyUser = () => { if (A.userGain) A.userGain.gain.setTargetAtTime(A.user.mute ? 0 : A.user.vol * A.user.vol, A.ctx.currentTime, 0.02); };
  A.setVolume = v => { A.user.vol = Math.max(0, Math.min(1, v)); applyUser(); };
  A.setMute = b => { A.user.mute = !!b; applyUser(); };

  A.init = async () => {
    if (!AC) { log('audio: no Web Audio in this browser (silent)'); return A; }
    A.ctx = new AC({ latencyHint: 'interactive' });
    A.userGain = A.ctx.createGain(); A.userGain.connect(A.ctx.destination);
    A.analyser = A.ctx.createAnalyser(); A.analyser.fftSize = 2048; A.analyser.connect(A.userGain);
    let src;
    try {
      if (!A.ctx.audioWorklet) throw new Error('AudioWorklet needs a secure context (https or localhost)');
      await A.ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
      src = new AudioWorkletNode(A.ctx, 'ds-mixer', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      port = src.port; A.kind = 'AudioWorklet';
      port.onmessage = e => {
        const d = e.data;
        if (d.op === 'stats') onStats(d);
        else if (d.op === 'captured' && captureCb) { const cb = captureCb; captureCb = null; cb(d); }
      };
    } catch (e) {
      log('audio: ' + e.message + '; using a main-thread ScriptProcessor');
      spMixer = new DsMixer(A.ctx.sampleRate); A.kind = 'ScriptProcessor';
      src = A.ctx.createScriptProcessor(2048, 0, 2);
      let last = 0;
      src.onaudioprocess = ev => {
        const ob = ev.outputBuffer, L = ob.getChannelData(0), R = ob.getChannelData(1);
        const f = Math.round(ev.playbackTime * A.ctx.sampleRate); if (spMixer.frame < f) spMixer.frame = f;
        spMixer.render(L, R, L.length);
        if (captureCb && A._cap) { A._cap.L.push(L.slice()); A._cap.R.push(R.slice()); A._cap.got += L.length; if (A._cap.got >= A._cap.n) { const cb = captureCb; captureCb = null; cb({ ...A._cap, sampleRate: A.ctx.sampleRate }); } }
        if (spMixer.frame - last >= A.ctx.sampleRate / 4) {
          const st = spMixer.stats; let voices = 0; for (const v of spMixer.voices.values()) if (v.playing) voices++;
          onStats({ rms: Math.sqrt(st.sumsq / Math.max(1, st.n)), peak: st.peak, voices }); st.sumsq = 0; st.n = 0; st.peak = 0; last = spMixer.frame;
        }
      };
    }
    src.connect(A.analyser);
    A.ctx.onstatechange = () => switchMode(A.ctx.state === 'running');
    if (A.ctx.state === 'running') switchMode(true);
    applyUser();
    // autoplay policy: the context starts on the first user gesture
    const kick = () => { if (A.ctx.state !== 'running' && A.ctx.state !== 'closed') A.ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'mousedown']) window.addEventListener(ev, kick, { capture: true, passive: true });
    window.addEventListener('gamepadconnected', kick);
    return A;
  };

  function onStats(d) {
    A.stats = d;
    A.rmsLog.push([+(A.backend.now()).toFixed(2), +d.rms.toFixed(4), +d.peak.toFixed(3), d.voices]);
    if (A.rmsLog.length > 2400) A.rmsLog.splice(0, A.rmsLog.length - 2400);
  }

  /** Record the mixer output for `seconds` (before the user volume). Resolves {rms, peak, sampleRate, wav: Uint8Array}. */
  A.capture = seconds => new Promise((res, rej) => {
    if (mode !== 'ctx') { rej(new Error('audio context not running (click the page first)')); return; }
    captureCb = d => {
      const cat = a => { const n = a.reduce((x, b) => x + b.length, 0), o = new Float32Array(n); let k = 0; for (const b of a) { o.set(b, k); k += b.length; } return o; };
      const L = cat(d.L), R = cat(d.R);
      let s = 0, pk = 0; for (let i = 0; i < L.length; i++) { s += L[i] * L[i] + R[i] * R[i]; pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); }
      res({ rms: Math.sqrt(s / (2 * L.length)), peak: pk, sampleRate: d.sampleRate, frames: L.length, wav: wavBytes(L, R, d.sampleRate) });
    };
    if (port) port.postMessage({ op: 'capture', seconds });
    else A._cap = { n: Math.round(seconds * A.ctx.sampleRate), L: [], R: [], got: 0 };
  });
  return A;
}
