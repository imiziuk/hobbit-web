// DirectInput 8 and DirectSound 8 as host COM objects (vtables of host thunks in guest memory), and the glue that
// plugs web/d3d8/com.js (ComBridge: IDirect3D8 / IDirect3DDevice8 / resources) into the host-call protocol.
import { hex } from './machine.mjs';

/** Host COM class: methods = [[name, nargs, fn(self, args)] ...] in vtable order (IUnknown first). */
export class ComClass {
  constructor(m, iface, methods) {
    this.m = m; this.iface = iface;
    this.vtbl = m.heap.alloc(4 * methods.length);
    methods.forEach(([name, nargs, fn], i) => {
      const a = m.defineHle(iface + '::' + name, nargs + 1, (args) => {
        const self = m.comObjs.get(args[0]);
        if (!fn) { m.log(`unimplemented ${iface}::${name}`); return 0x80004001; }
        return fn(self, args.slice(1));
      });
      m.w32(this.vtbl + 4 * i, a);
    });
  }
  create(state = {}) {
    const m = this.m, p = m.heap.alloc(16);
    m.w32(p, this.vtbl); state.ptr = p; state.refs = 1; state.cls = this;
    (m.comObjs ||= new Map()).set(p, state);
    return p;
  }
}
const unk = (qi) => [['QueryInterface', 2, qi || ((s, [riid, pp]) => { s.cls.m.w32(pp, s.ptr); s.refs++; return 0; })],
  ['AddRef', 0, s => ++s.refs], ['Release', 0, s => Math.max(0, --s.refs)]];

const guid = (m, p) => [...m.bytes(p, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
const GUID_SysMouse = '602b1d6fa0d5cf11bfc7444553540000', GUID_SysKeyboard = '612b1d6fa0d5cf11bfc7444553540000';

/* ------------------------------------------------------------------ DirectInput 8 */
export function installDirectInput(m, W, S) {
  const devCls = new ComClass(m, 'IDirectInputDevice8A', [...unk(),
    ['GetCapabilities', 1, (s, [p]) => { const n = m.r32(p); m.bytes(p + 4, Math.max(0, n - 4)).fill(0); m.w32(p + 4, 5); m.w32(p + 8, s.kind === 'kbd' ? 0x413 : 0x212); m.w32(p + 12, s.kind === 'kbd' ? 0 : 3); m.w32(p + 16, s.kind === 'kbd' ? 128 : 4); return 0; }],
    ['EnumObjects', 3, () => 0], ['GetProperty', 2, () => 0], ['SetProperty', 2, () => 0],
    ['Acquire', 0, s => { s.acq = true; return 0; }], ['Unacquire', 0, s => { s.acq = false; return 0; }],
    ['GetDeviceState', 2, (s, [n, p]) => {
      if (s.kind === 'kbd') { m.bytes(p, n).set(W.input.keys.subarray(0, n)); return 0; }
      const ms = W.input.mouse; m.bytes(p, n).fill(0);
      m.w32(p, ms.dx); m.w32(p + 4, ms.dy); m.w32(p + 8, ms.dz); ms.dx = ms.dy = ms.dz = 0;
      for (let i = 0; i < 4 && 12 + i < n; i++) m.w8(p + 12 + i, ms.b[i] ? 0x80 : 0);
      return 0;
    }],
    ['GetDeviceData', 4, (s, [cb, pdod, pn, fl]) => {
      const q = s.kind === 'kbd' ? W.input.kbdEvents : W.input.mouseEvents;
      const cap = m.r32(pn); let k = 0;
      while (q && q.length && k < cap && pdod) { const e = q.shift(); m.bytes(pdod + k * cb, cb).fill(0); m.w32(pdod + k * cb, e.ofs); m.w32(pdod + k * cb + 4, e.data); m.w32(pdod + k * cb + 8, m.clock.now() >>> 0); m.w32(pdod + k * cb + 12, e.seq || 0); k++; }
      if (!pdod && q) { k = Math.min(q.length, cap); if (!(fl & 1)) q.splice(0, k); }
      m.w32(pn, k); return 0;
    }],
    ['SetDataFormat', 1, () => 0], ['SetEventNotification', 1, () => 0], ['SetCooperativeLevel', 2, () => 0],
    ['GetObjectInfo', 3, () => 0x80004001], ['GetDeviceInfo', 1, () => 0x80004001], ['RunControlPanel', 2, () => 0], ['Initialize', 3, () => 0],
    ['CreateEffect', 4, () => 0x80004001], ['EnumEffects', 3, () => 0], ['GetEffectInfo', 2, () => 0x80004001], ['GetForceFeedbackState', 1, () => 0x80004001],
    ['SendForceFeedbackCommand', 1, () => 0x80004001], ['EnumCreatedEffectObjects', 3, () => 0], ['Escape', 1, () => 0x80004001], ['Poll', 0, () => 1],
    ['SendDeviceData', 4, () => 0], ['EnumEffectsInFile', 4, () => 0], ['WriteEffectToFile', 4, () => 0], ['BuildActionMap', 3, () => 0x80004001],
    ['SetActionMap', 3, () => 0x80004001], ['GetImageInfo', 1, () => 0x80004001]]);
  const devInst = (p, kind) => {
    m.bytes(p, 0x244).fill(0); m.w32(p, 0x244);
    const g = kind === 'kbd' ? GUID_SysKeyboard : GUID_SysMouse;
    for (let i = 0; i < 16; i++) { m.w8(p + 4 + i, parseInt(g.slice(2 * i, 2 * i + 2), 16)); m.w8(p + 20 + i, parseInt(g.slice(2 * i, 2 * i + 2), 16)); }
    m.w32(p + 36, kind === 'kbd' ? 0x413 : 0x212);
    m.putCStr(p + 40, kind === 'kbd' ? 'Keyboard' : 'Mouse'); m.putCStr(p + 300, kind === 'kbd' ? 'Keyboard' : 'Mouse');
  };
  const diCls = new ComClass(m, 'IDirectInput8A', [...unk(),
    ['CreateDevice', 3, (s, [rg, pp]) => {
      const g = guid(m, rg), kind = g === GUID_SysKeyboard ? 'kbd' : g === GUID_SysMouse ? 'mouse' : null;
      if (!kind) { m.log('DirectInput CreateDevice: unknown GUID ' + g); return 0x80040154; }
      m.w32(pp, devCls.create({ kind })); return 0;
    }],
    ['EnumDevices', 4, (s, [type, cb, ref, flags]) => {
      // DI8DEVCLASS_ALL 0, DEVICE 1, POINTER 2, KEYBOARD 3, GAMECTRL 4; or a DI8DEVTYPE_*
      const list = []; const t = type & 0xff;
      if (t === 0 || t === 3 || t === 0x13) list.push('kbd');
      if (t === 0 || t === 2 || t === 0x12) list.push('mouse');
      const p = m.heap.alloc(0x244);
      for (const k of list) { devInst(p, k); if (m.callGuest(cb, [p, ref]) === 0) break; }
      m.heap.release(p); return 0;
    }],
    ['GetDeviceStatus', 1, () => 0], ['RunControlPanel', 2, () => 0], ['Initialize', 2, () => 0], ['FindDevice', 3, () => 0x80004005],
    ['EnumDevicesBySemantics', 5, () => 0], ['ConfigureDevices', 4, () => 0]]);
  S.set('dinput8.dll!DirectInput8Create', { nargs: 5, fn: ([hinst, ver, riid, ppv]) => { m.w32(ppv, diCls.create({})); return 0; } });
}

/* ------------------------------------------------------------------ DirectSound 8 (silent; play cursors follow the clock) */
export function installDirectSound(m, W, S) {
  const pos = s => {
    if (!s.playing || !s.size) return s.cursor || 0;
    const ms = m.clock.now() - s.t0;
    const p = Math.floor(ms * s.bps / 1000);
    return s.loop ? (s.cursor0 + p) % s.size : Math.min(s.size, s.cursor0 + p);
  };
  const bufCls = new ComClass(m, 'IDirectSoundBuffer8', [
    ['QueryInterface', 2, (s, [riid, pp]) => { m.w32(pp, s.ptr); s.refs++; return 0; }], ['AddRef', 0, s => ++s.refs], ['Release', 0, s => Math.max(0, --s.refs)],
    ['GetCaps', 1, (s, [p]) => { m.w32(p + 4, s.flags); m.w32(p + 8, s.size); return 0; }],
    ['GetCurrentPosition', 2, (s, [pp, pw]) => { const c = pos(s) & ~3; if (pp) m.w32(pp, c); if (pw) m.w32(pw, s.size ? (c + 1764 * 4) % s.size : 0); return 0; }],
    ['GetFormat', 3, (s, [p, n, pw]) => { if (p) m.u8.set(s.wfx, p); if (pw) m.w32(pw, 18); return 0; }],
    ['GetVolume', 1, (s, [p]) => { m.w32(p, s.vol | 0); return 0; }], ['GetPan', 1, (s, [p]) => { m.w32(p, s.pan | 0); return 0; }],
    ['GetFrequency', 1, (s, [p]) => { m.w32(p, s.freq); return 0; }],
    ['GetStatus', 1, (s, [p]) => { if (s.playing && !s.loop && pos(s) >= s.size) s.playing = false; m.w32(p, s.playing ? (1 | (s.loop ? 4 : 0)) : 0); return 0; }],
    ['Initialize', 2, () => 0],
    ['Lock', 7, (s, [off, n, pp1, pn1, pp2, pn2, fl]) => {
      if (fl & 2) { off = 0; n = s.size; } if (fl & 1) off = pos(s);
      if (!s.size) { m.w32(pp1, 0); m.w32(pn1, 0); return 0x88780032 | 0; }
      off %= s.size; n = Math.min(n, s.size);
      const n1 = Math.min(n, s.size - off);
      m.w32(pp1, s.mem + off); m.w32(pn1, n1);
      if (pp2) m.w32(pp2, n > n1 ? s.mem : 0); if (pn2) m.w32(pn2, n - n1);
      return 0;
    }],
    ['Play', 3, (s, [r, p, fl]) => { if (!s.playing) { s.playing = true; s.t0 = m.clock.now(); s.cursor0 = s.cursor || 0; } s.loop = !!(fl & 1); return 0; }],
    ['SetCurrentPosition', 1, (s, [c]) => { s.cursor = c; s.cursor0 = c; s.t0 = m.clock.now(); return 0; }],
    ['SetFormat', 1, (s, [p]) => { s.wfx = m.u8.slice(p, p + 18); return 0; }],
    ['SetVolume', 1, (s, [v]) => { s.vol = v; return 0; }], ['SetPan', 1, (s, [v]) => { s.pan = v; return 0; }],
    ['SetFrequency', 1, (s, [f]) => { if (f) { s.freq = f; s.bps = f * s.align; } return 0; }],
    ['Stop', 0, s => { s.cursor = pos(s); s.playing = false; return 0; }],
    ['Unlock', 4, () => 0], ['Restore', 0, () => 0],
    ['SetFX', 3, () => 0x80004001], ['AcquireResources', 3, () => 0], ['GetObjectInPath', 4, () => 0x80004001]]);
  const dsCls = new ComClass(m, 'IDirectSound8', [...unk(),
    ['CreateSoundBuffer', 3, (s, [pd, pp]) => {
      const flags = m.r32(pd + 4), size = m.r32(pd + 8), pwfx = m.r32(pd + 16);
      const wfx = pwfx ? m.u8.slice(pwfx, pwfx + 18) : new Uint8Array(18);
      const dvw = new DataView(wfx.buffer);
      const freq = dvw.getUint32(4, true) || 22050, align = dvw.getUint16(12, true) || 4;
      const st = { flags, size: (flags & 1) ? 0 : size, wfx, freq, align, bps: freq * align, mem: size && !(flags & 1) ? m.heap.alloc(size) : 0, playing: false };
      m.w32(pp, bufCls.create(st)); W.dsBuffers = (W.dsBuffers || 0) + 1; return 0;
    }],
    ['GetCaps', 1, (s, [p]) => { const n = m.r32(p); m.bytes(p + 4, Math.max(0, n - 4)).fill(0); m.w32(p + 4, 0xF5F); return 0; }],
    ['DuplicateSoundBuffer', 2, () => 0x80004001], ['SetCooperativeLevel', 2, () => 0], ['Compact', 0, () => 0],
    ['GetSpeakerConfig', 1, (s, [p]) => { m.w32(p, 4); return 0; }], ['SetSpeakerConfig', 1, () => 0], ['Initialize', 1, () => 0],
    ['VerifyCertification', 1, (s, [p]) => { m.w32(p, 0); return 0; }]]);
  S.set('dsound.dll!#11', { nargs: 3, fn: ([g, pp]) => { m.w32(pp, dsCls.create({})); return 0; } });
}

/* ------------------------------------------------------------------ Direct3D 8 via web/d3d8/com.js */
/** gl: a WebGL2 context (browser) or nullGL() (Node). Returns the ComBridge. */
export async function installD3D8(m, W, S, gl, comModule) {
  const { ComBridge } = comModule;
  const bridge = new ComBridge(m.mem, m.heap.comAdapter(), gl);
  m.com = bridge;
  S.set('d3d8.dll!Direct3DCreate8', { nargs: 1, fn: ([sdk]) => { const p = bridge.Direct3DCreate8(sdk); m.log(`Direct3DCreate8(${sdk}) -> ${hex(p)}`); return p; } });
  W.d3dCalls = new Map();
  m.onCom = (name, r) => {
    if (name === 'IDirect3D8::CreateDevice') {
      m.log(`IDirect3D8::CreateDevice -> ${hex(r)}`);
      m.fpucw = m.fpucw & ~0x300;                       // D3D without FPU_PRESERVE drops the x87 to 24-bit precision
    }
    if (name === 'IDirect3DDevice8::Present') {
      W.frames++; W.presentedSincePump = true;
      if (W.onPresent) W.onPresent(W.frames);
      return W.frameWait(33.4, 'Present');
    }
    if (r === undefined) return 0;
  };
  return bridge;
}

/** A WebGL2 stand-in for Node: every call is a counted no-op (creates return objects, queries succeed). */
export function nullGL(width = 640, height = 480) {
  const counts = new Map();
  const target = { canvas: { width, height, style: {} }, counts, drawingBufferWidth: width, drawingBufferHeight: height };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'symbol') return undefined;
      if (/^[A-Z0-9_]+$/.test(p)) return 0x1000 + p.length;          // GL enums: any distinct-ish number
      return (...a) => {
        counts.set(p, (counts.get(p) || 0) + 1);
        if (p === 'getExtension') return null;
        if (p === 'getShaderParameter' || p === 'getProgramParameter') return true;
        if (p === 'getUniformLocation') return {};
        if (p === 'getAttribLocation') return 0;
        if (p === 'getActiveUniform' || p === 'getActiveAttrib') return { name: 'u' + a[1], size: 1, type: 0 };
        if (p === 'getParameter') return 0;
        if (p === 'checkFramebufferStatus') return 0x8CD5;
        if (p.startsWith('create')) return {};
        if (p === 'getError') return 0;
        return undefined;
      };
    },
  });
}
