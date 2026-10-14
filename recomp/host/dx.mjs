// DirectInput 8 and DirectSound 8 as host COM objects (vtables of host thunks in guest memory), and the glue that
// plugs web/d3d8/com.js (ComBridge: IDirect3D8 / IDirect3DDevice8 / resources) into the host-call protocol.
import { hex } from './machine.mjs';
import { dsGains } from './dsmix.mjs';

/** Host COM class: methods = [[name, nargs, fn(self, args)] ...] in vtable order (IUnknown first). */
export class ComClass {
  constructor(m, iface, methods) {
    this.m = m; this.iface = iface;
    this.vtbl = m.heap.alloc(4 * methods.length);
    methods.forEach(([name, nargs, fn], i) => {
      const a = m.defineHle(iface + '::' + name, nargs + 1, (args) => {
        const self = m.comObjs.get(args[0]);
        if (m.comTrace) m.comTrace(iface, name, args, self);
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
// Virtual gamepad, XInput-style DirectInput layout. The game sets the c_dfDIJoystick2 format (0x6f9d04, 272 bytes),
// enumerates the axes and sets DIPROP_RANGE -1000..1000 on each (00670dc0), then polls GetDeviceState(0x110) (0066fc30).
// The GUIDs are our own: the game compares the product GUID with a few known pads (00670860) and otherwise uses its
// generic profile (type 0).
const GUID_Pad = '48424a4f595041440000000000000001', GUID_PadProduct = '48424a4f595041440000000000000002';
const PAD_DEVTYPE = 0x10215;   // DI8DEVTYPE_GAMEPAD | DI8DEVTYPEGAMEPAD_STANDARD << 8 | DIDEVTYPE_HID
// axes in DIJOYSTATE2 order (name, offset); dwType = DIDFT_ABSAXIS | DIDFT_MAKEINSTANCE(i)
const PAD_AXES = [['X Axis', 0], ['Y Axis', 4], ['Z Axis', 8], ['X Rotation', 12], ['Y Rotation', 16], ['Z Rotation', 20]];
const GUID_AXIS = ['a36d02e0c9f3cf11bfc7444553540000', 'a36d02e1c9f3cf11bfc7444553540000', 'a36d02e2c9f3cf11bfc7444553540000',
  'a36d02f4c9f3cf11bfc7444553540000', 'a36d02f5c9f3cf11bfc7444553540000', 'a36d02e3c9f3cf11bfc7444553540000'];
const putGuid = (m, p, g) => { for (let i = 0; i < 16; i++) m.w8(p + i, parseInt(g.slice(2 * i, 2 * i + 2), 16)); };

/** Fill a DIJOYSTATE2 (n bytes) from the page's gamepad snapshot (W3C "standard" mapping).
 *  Axes follow the game's default bindings (Options > Controls > Gamepad): Move = lX/lY (left stick), Camera = lZ/lRz
 *  (right stick, the classic DirectInput dual-analog layout). POV 0 = D-pad (Walking-stick left, Stones up, Sword right);
 *  in menus the D-pad is sent as the left stick instead. Buttons are placed on the DirectInput indices the game binds by default (0-based, as its Controls
 *  screen shows them): 0 Toggle View, 1 Equip Ring, 2 Jump, 3 Attack, 4 Crouch, 5 Use (also menu accept), 7 Target.
 *    gameplay: A=Jump X=Attack B=Crouch Y=Use LB=Ring RB=Target Back=Toggle view (Start = Esc, sent by the page)
 *    menus:    A and Y = accept (Use); B = Esc, Start = Enter (skips movies) (both sent by the page)
 *  Rebinding in the game's own Controls screen still works: it sees these DirectInput indices. */
const PAD_BTN_GAME = { 0: 2, 2: 3, 1: 4, 3: 5, 4: 1, 5: 7, 8: 0, 10: 8, 11: 9, 6: 10, 7: 11 };   // standard button -> DI index
const PAD_BTN_MENU = { 0: 5, 3: 5 };
export function padState(m, s, W, p, n) {
  m.bytes(p, n).fill(0);
  for (let i = 0; i < 4 && 32 + 4 * i + 4 <= n; i++) m.w32(p + 32 + 4 * i, 0xffffffff);   // POVs centred
  const g = W.input.readPad && W.input.readPad();
  const v = g ? [g.axes[0], g.axes[1], g.axes[2], 0, 0, g.axes[3]] : [0, 0, 0, 0, 0, 0];   // lX lY lZ lRx lRy lRz
  // Menus: the D-pad goes out as the left stick, not the POV. With the POV a short press moved the menu cursor two
  // items (measured in the browser: 40 ms on the POV = 2 steps, the same time on lY = 1 step).
  const menu = W.input.padMode && W.input.padMode() === 'menu';
  if (g && menu) {
    const b = g.buttons;
    if (b[12] || b[13]) v[1] = b[12] ? -1 : 1;
    if (b[14] || b[15]) v[0] = b[14] ? -1 : 1;
  }
  v.forEach((x, i) => {
    const r = s.range.get(i) || [-1000, 1000], dz = s.dead.get(i) || 0;
    let a = Math.max(-1, Math.min(1, x || 0)); if (Math.abs(a) * 10000 < dz) a = 0;
    if (4 * i + 4 <= n) m.w32(p + 4 * i, Math.round(r[0] + (a + 1) / 2 * (r[1] - r[0])) | 0);
  });
  if (!g) return;
  const b = g.buttons, up = b[12], dn = b[13], lf = b[14], rt = b[15];
  const pov = up && rt ? 4500 : rt && dn ? 13500 : dn && lf ? 22500 : lf && up ? 31500 : up ? 0 : rt ? 9000 : dn ? 18000 : lf ? 27000 : -1;
  if (pov >= 0 && n >= 36 && !menu) m.w32(p + 32, pov);
  const map = menu ? PAD_BTN_MENU : PAD_BTN_GAME;
  for (const [src, di] of Object.entries(map)) if (b[src] && 48 + di < n) m.w8(p + 48 + di, 0x80);
}

/* ------------------------------------------------------------------ DirectInput 8 */
export function installDirectInput(m, W, S) {
  const devCls = new ComClass(m, 'IDirectInputDevice8A', [...unk(),
    ['GetCapabilities', 1, (s, [p]) => {
      const n = m.r32(p); m.bytes(p + 4, Math.max(0, n - 4)).fill(0); m.w32(p + 4, 5);
      if (s.kind === 'pad') { m.w32(p + 8, PAD_DEVTYPE); m.w32(p + 12, 6); m.w32(p + 16, 10); m.w32(p + 20, 1); return 0; }
      m.w32(p + 8, s.kind === 'kbd' ? 0x413 : 0x212); m.w32(p + 12, s.kind === 'kbd' ? 0 : 3); m.w32(p + 16, s.kind === 'kbd' ? 128 : 4); return 0;
    }],
    ['EnumObjects', 3, (s, [cb, ref, flags]) => {
      if (s.kind !== 'pad' || !(flags === 0 || flags & 3)) return 0;      // DIDFT_ALL or DIDFT_AXIS: the 6 absolute axes
      const p = m.heap.alloc(316);
      for (let i = 0; i < PAD_AXES.length; i++) {
        m.bytes(p, 316).fill(0); m.w32(p, 316); putGuid(m, p + 4, GUID_AXIS[i]);
        m.w32(p + 20, PAD_AXES[i][1]); m.w32(p + 24, 2 | (i << 8)); m.putCStr(p + 32, PAD_AXES[i][0]);
        if (m.callGuest(cb, [p, ref]) === 0) break;                       // DIENUM_STOP
      }
      m.heap.release(p); return 0;
    }],
    ['GetProperty', 2, () => 0],
    ['SetProperty', 2, (s, [prop, ph]) => {                                // DIPROP_RANGE (4) / DIPROP_DEADZONE (5) per axis
      if (s.kind !== 'pad' || (prop !== 4 && prop !== 5)) return 0;
      const obj = m.r32(ph + 8), how = m.r32(ph + 12);
      const axes = how === 0 ? [0, 1, 2, 3, 4, 5] : how === 2 ? [(obj >> 8) & 0xff] : how === 1 ? [PAD_AXES.findIndex(a => a[1] === obj)] : [];
      for (const i of axes) if (i >= 0 && i < 6) { if (prop === 4) s.range.set(i, [m.r32(ph + 16) | 0, m.r32(ph + 20) | 0]); else s.dead.set(i, m.r32(ph + 16)); }
      return 0;
    }],
    ['Acquire', 0, s => { s.acq = true; return 0; }], ['Unacquire', 0, s => { s.acq = false; return 0; }],
    ['GetDeviceState', 2, (s, [n, p]) => {
      if (s.kind === 'kbd') { m.bytes(p, n).set(W.input.keys.subarray(0, n)); return 0; }
      if (s.kind === 'pad') { padState(m, s, W, p, n); return 0; }
      const ms = W.input.mouse; m.bytes(p, n).fill(0);
      m.w32(p, ms.dx); m.w32(p + 4, ms.dy); m.w32(p + 8, ms.dz); ms.dx = ms.dy = ms.dz = 0;
      // a press stays visible for 3 polls even if the button is already up (a quick click between two polls was lost)
      ms.latch ||= [0, 0, 0, 0];
      for (let i = 0; i < 4 && 12 + i < n; i++) { m.w8(p + 12 + i, ms.b[i] || ms.latch[i] > 0 ? 0x80 : 0); if (ms.latch[i] > 0) ms.latch[i]--; }
      return 0;
    }],
    ['GetDeviceData', 4, (s, [cb, pdod, pn, fl]) => {
      const q = s.kind === 'kbd' ? W.input.kbdEvents : s.kind === 'mouse' ? W.input.mouseEvents : null;
      const cap = m.r32(pn); let k = 0;
      while (q && q.length && k < cap && pdod) { const e = q.shift(); m.bytes(pdod + k * cb, cb).fill(0); m.w32(pdod + k * cb, e.ofs); m.w32(pdod + k * cb + 4, e.data); m.w32(pdod + k * cb + 8, m.clock.now() >>> 0); m.w32(pdod + k * cb + 12, e.seq || 0); k++; }
      if (!pdod && q) { k = Math.min(q.length, cap); if (!(fl & 1)) q.splice(0, k); }
      m.w32(pn, k); return 0;
    }],
    ['SetDataFormat', 1, () => 0], ['SetEventNotification', 1, () => 0], ['SetCooperativeLevel', 2, () => 0],
    ['GetObjectInfo', 3, () => 0x80004001], ['GetDeviceInfo', 1, () => 0x80004001], ['RunControlPanel', 2, () => 0], ['Initialize', 3, () => 0],
    ['CreateEffect', 4, () => 0x80004001], ['EnumEffects', 3, () => 0], ['GetEffectInfo', 2, () => 0x80004001], ['GetForceFeedbackState', 1, () => 0x80004001],
    ['SendForceFeedbackCommand', 1, () => 0x80004001], ['EnumCreatedEffectObjects', 3, () => 0], ['Escape', 1, () => 0x80004001], ['Poll', 0, s => (s.kind === 'pad' ? 0 : 1)],
    ['SendDeviceData', 4, () => 0], ['EnumEffectsInFile', 4, () => 0], ['WriteEffectToFile', 4, () => 0], ['BuildActionMap', 3, () => 0x80004001],
    ['SetActionMap', 3, () => 0x80004001], ['GetImageInfo', 1, () => 0x80004001]]);
  const devInst = (p, kind) => {
    m.bytes(p, 0x244).fill(0); m.w32(p, 0x244);
    if (kind === 'pad') {
      putGuid(m, p + 4, GUID_Pad); putGuid(m, p + 20, GUID_PadProduct); m.w32(p + 36, PAD_DEVTYPE);
      m.putCStr(p + 40, 'Gamepad'); m.putCStr(p + 300, 'Gamepad (browser)'); m.w8(p + 576, 1); m.w8(p + 578, 5); return;
    }
    const g = kind === 'kbd' ? GUID_SysKeyboard : GUID_SysMouse;
    for (let i = 0; i < 16; i++) { m.w8(p + 4 + i, parseInt(g.slice(2 * i, 2 * i + 2), 16)); m.w8(p + 20 + i, parseInt(g.slice(2 * i, 2 * i + 2), 16)); }
    m.w32(p + 36, kind === 'kbd' ? 0x413 : 0x212);
    m.putCStr(p + 40, kind === 'kbd' ? 'Keyboard' : 'Mouse'); m.putCStr(p + 300, kind === 'kbd' ? 'Keyboard' : 'Mouse');
  };
  const diCls = new ComClass(m, 'IDirectInput8A', [...unk(),
    ['CreateDevice', 3, (s, [rg, pp]) => {
      const g = guid(m, rg), kind = g === GUID_SysKeyboard ? 'kbd' : g === GUID_SysMouse ? 'mouse' : g === GUID_Pad ? 'pad' : null;
      if (!kind) { m.log('DirectInput CreateDevice: unknown GUID ' + g); return 0x80040154; }
      m.w32(pp, devCls.create({ kind, range: new Map(), dead: new Map() })); return 0;
    }],
    ['EnumDevices', 4, (s, [type, cb, ref, flags]) => {
      // DI8DEVCLASS_ALL 0, DEVICE 1, POINTER 2, KEYBOARD 3, GAMECTRL 4; or a DI8DEVTYPE_*
      const list = []; const t = type & 0xff;
      if (t === 0 || t === 3 || t === 0x13) list.push('kbd');
      if (t === 0 || t === 2 || t === 0x12) list.push('mouse');
      if (t === 0 || t === 4 || (t >= 0x14 && t <= 0x18)) list.push('pad');   // always attached: a pad can be plugged in any time
      const p = m.heap.alloc(0x244);
      for (const k of list) { devInst(p, k); if (m.callGuest(cb, [p, ref]) === 0) break; }
      m.heap.release(p); return 0;
    }],
    ['GetDeviceStatus', 1, () => 0], ['RunControlPanel', 2, () => 0], ['Initialize', 2, () => 0], ['FindDevice', 3, () => 0x80004005],
    ['EnumDevicesBySemantics', 5, () => 0], ['ConfigureDevices', 4, () => 0]]);
  S.set('dinput8.dll!DirectInput8Create', { nargs: 5, fn: ([hinst, ver, riid, ppv]) => { m.w32(ppv, diCls.create({})); return 0; } });
}

/* ------------------------------------------------------------------ DirectSound 8
 * Buffers live in guest memory: the game Locks, writes PCM it decoded itself (IMA ADPCM, 0067b860) and Unlocks. Each
 * buffer keeps a list of timeline segments {t0, c0, rate, loop}: the play cursor at time t is c0 + (t - t0) * rate.
 * `out` (optional) is the audio backend { now(): seconds, lead: seconds, post(cmd, transfer) } (web/audio.mjs). Every
 * state change takes effect at now() + lead and is posted with that time (`at`) to the mixer (recomp/host/dsmix.mjs),
 * so the cursor the game polls is the position the mixer plays. Without `out` (Node) the timeline is the machine
 * clock and nothing is played (boot_node.mjs --audio-wav attaches the offline renderer). */
export function installDirectSound(m, W, S, out) {
  const be = out || { now: () => m.clock.now() / 1000, lead: 0, post() {} };
  const DS = W.ds = { buffers: new Set(), created: 0, plays: 0 };
  let nextId = 1;
  const segAt = (s, t) => { const g = s.segs; let i = g.length - 1; while (i > 0 && g[i].t0 > t) i--; return g[i]; };
  const rawPos = (s, t) => { const g = segAt(s, t); return g.rate ? g.c0 + Math.max(0, t - g.t0) * g.rate : g.c0; };
  const isPlaying = (s, t) => { const g = segAt(s, t); return !!g.rate && (g.loop || rawPos(s, t) < s.size); };
  const pos = (s, t) => {
    const g = segAt(s, t), p = rawPos(s, t);
    if (!g.rate || !s.size) return Math.min(p, s.size || 0);
    return g.loop ? p % s.size : (p >= s.size ? 0 : p);     // a one-shot that played to its end stops at 0
  };
  const pushSeg = (s, seg) => {
    const now = be.now();
    s.segs = s.segs.filter((g, i, a) => g.t0 < seg.t0 && !(a[i + 1] && a[i + 1].t0 <= now)); s.segs.push(seg);
  };
  const T = () => be.now() + be.lead;
  const cur = (s, t) => Math.floor(pos(s, t) / s.align) * s.align;
  const writeLead = s => Math.ceil((be.lead + 0.015) * s.freq) * s.align;    // DirectSound's write cursor runs ~15 ms ahead
  const post = (c, tr) => be.post(c, tr);
  const fmt = wfx => { const dv = new DataView(wfx.buffer, wfx.byteOffset); return { tag: dv.getUint16(0, true), ch: dv.getUint16(2, true) || 1, rate: dv.getUint32(4, true) || 22050, align: dv.getUint16(12, true) || 2, bits: dv.getUint16(14, true) || 16 }; };
  const setGains = s => { const [gl, gr] = dsGains(s.vol, s.pan); post({ op: 'set', id: s.id, at: T(), gl, gr }); };
  const newBuffer = st => {
    st.id = nextId++; st.segs = [{ t0: -1e9, c0: 0, rate: 0, loop: false }]; st.vol = 0; st.pan = 0;
    if (!st.primary) { post({ op: 'voice', id: st.id, data: st.data.id }); post({ op: 'set', id: st.id, at: T(), freq: st.freq, gl: 1, gr: 1 }); }
    DS.buffers.add(st); DS.created++;
    return bufCls.create(st);
  };
  const release = s => {
    if (--s.refs > 0) return s.refs;
    if (s.dead) return 0; s.dead = true; s.refs = 0;
    DS.buffers.delete(s); m.comObjs.delete(s.ptr);
    if (!s.primary) {
      const t = T();                       // after any Stop that is still pending in the mixer
      post({ op: 'free', id: s.id, at: t });
      if (--s.data.refs === 0) { post({ op: 'freeData', id: s.data.id, at: t }); if (s.data.mem) m.heap.release(s.data.mem); }
    }
    return 0;
  };
  const IID_DSB8 = '49a425682475824d920f50e36ab3ab1e', IID_DSB = '8ab4ac279a6dc311a6bd0020af0be560', IID_UNK = '00000000000000000c00000000000046';
  const bufCls = new ComClass(m, 'IDirectSoundBuffer8', [
    ['QueryInterface', 2, (s, [riid, pp]) => {
      const g = guid(m, riid);
      if (g === IID_DSB8 || g === IID_DSB || g === IID_UNK) { m.w32(pp, s.ptr); s.refs++; return 0; }
      m.log('IDirectSoundBuffer8::QueryInterface: no interface ' + g); m.w32(pp, 0); return 0x80004002 | 0;
    }],
    ['AddRef', 0, s => ++s.refs], ['Release', 0, s => release(s)],
    ['GetCaps', 1, (s, [p]) => { m.w32(p + 4, s.flags); m.w32(p + 8, s.size); m.w32(p + 12, 0); m.w32(p + 16, 0); return 0; }],
    ['GetCurrentPosition', 2, (s, [pp, pw]) => {
      if (!s.size) { if (pp) m.w32(pp, 0); if (pw) m.w32(pw, 0); return 0; }
      const t = be.now(), c = cur(s, t);
      if (pp) m.w32(pp, c); if (pw) m.w32(pw, (c + (isPlaying(s, t) ? writeLead(s) : 0)) % s.size); return 0;
    }],
    ['GetFormat', 3, (s, [p, n, pw]) => { if (p) m.u8.set(s.wfx.subarray(0, Math.min(18, n || 18)), p); if (pw) m.w32(pw, 18); return 0; }],
    ['GetVolume', 1, (s, [p]) => { m.w32(p, s.vol | 0); return 0; }], ['GetPan', 1, (s, [p]) => { m.w32(p, s.pan | 0); return 0; }],
    ['GetFrequency', 1, (s, [p]) => { m.w32(p, s.freq); return 0; }],
    ['GetStatus', 1, (s, [p]) => { const t = be.now(); m.w32(p, !s.primary && isPlaying(s, t) ? (1 | (segAt(s, t).loop ? 4 : 0)) : 0); return 0; }],
    ['Initialize', 2, () => 0],
    ['Lock', 7, (s, [off, n, pp1, pn1, pp2, pn2, fl]) => {
      if (!s.size) { m.w32(pp1, 0); m.w32(pn1, 0); return 0x88780032 | 0; }      // DSERR_INVALIDCALL (primary buffer)
      if (fl & 2) { off = 0; n = s.size; }                                          // DSBLOCK_ENTIREBUFFER
      if (fl & 1) { const t = be.now(); off = cur(s, t) + (isPlaying(s, t) ? writeLead(s) : 0); }   // DSBLOCK_FROMWRITECURSOR
      off %= s.size; n = Math.min(n, s.size);
      const n1 = Math.min(n, s.size - off);
      m.w32(pp1, s.data.mem + off); m.w32(pn1, n1);
      if (pp2) m.w32(pp2, n > n1 ? s.data.mem : 0); if (pn2) m.w32(pn2, n - n1);
      return 0;
    }],
    ['Play', 3, (s, [r, prio, fl]) => {
      if (s.primary) return 0;
      const loop = !!(fl & 1), t = T(), was = isPlaying(s, t);
      if (was && segAt(s, t).loop === loop) return 0;
      const c = pos(s, t);
      pushSeg(s, { t0: t, c0: c, rate: s.freq * s.align, loop });
      post({ op: 'set', id: s.id, at: t, pos: c, freq: s.freq, loop, playing: true });
      if (!was) { DS.plays++; if (DS.onPlay) DS.onPlay(s); }
      return 0;
    }],
    ['SetCurrentPosition', 1, (s, [c]) => {
      if (!s.size) return 0;
      c = Math.min(c >>> 0, s.size - 1); c -= c % s.align;
      const t = T(), g = segAt(s, t);
      pushSeg(s, { t0: t, c0: c, rate: g.rate, loop: g.loop }); post({ op: 'set', id: s.id, at: t, pos: c }); return 0;
    }],
    ['SetFormat', 1, (s, [p]) => { s.wfx = m.u8.slice(p, p + 18); return 0; }],
    ['SetVolume', 1, (s, [v]) => {
      s.vol = Math.max(-10000, Math.min(0, v | 0));
      if (s.primary) post({ op: 'master', gain: dsGains(s.vol, 0)[0] }); else setGains(s);
      return 0;
    }],
    ['SetPan', 1, (s, [v]) => { s.pan = Math.max(-10000, Math.min(10000, v | 0)); if (!s.primary) setGains(s); return 0; }],
    ['SetFrequency', 1, (s, [f]) => {
      if (s.primary) return 0;
      f = f === 0 ? s.freq0 : Math.max(100, Math.min(200000, f >>> 0));         // 0 = DSBFREQUENCY_ORIGINAL
      if (f === s.freq) return 0;
      const t = T(), g = segAt(s, t), c = pos(s, t);
      s.freq = f;
      pushSeg(s, { t0: t, c0: c, rate: g.rate ? f * s.align : 0, loop: g.loop }); post({ op: 'set', id: s.id, at: t, pos: c, freq: f }); return 0;
    }],
    ['Stop', 0, s => {
      if (s.primary) return 0;
      const t = T(); if (!segAt(s, t).rate) return 0;
      const c = pos(s, t);
      pushSeg(s, { t0: t, c0: c, rate: 0, loop: false }); post({ op: 'set', id: s.id, at: t, pos: c, playing: false }); return 0;
    }],
    ['Unlock', 4, (s, [p1, n1, p2, n2]) => {
      if (!s.size) return 0;
      for (const [p, n] of [[p1, n1], [p2, n2]]) {
        if (!p || !n) continue;
        const off = p - s.data.mem; if (off < 0 || off >= s.size) continue;
        const bytes = m.u8.slice(p, p + Math.min(n, s.size - off));
        post({ op: 'write', id: s.data.id, off, bytes }, [bytes.buffer]);
      }
      return 0;
    }],
    ['Restore', 0, () => 0],
    ['SetFX', 3, () => 0x80004001], ['AcquireResources', 3, () => 0], ['GetObjectInPath', 4, () => 0x80004001]]);
  const dsCls = new ComClass(m, 'IDirectSound8', [...unk(),
    ['CreateSoundBuffer', 3, (s, [pd, pp]) => {
      const flags = m.r32(pd + 4), size = m.r32(pd + 8), pwfx = m.r32(pd + 16);
      if (flags & 1) {   // DSBCAPS_PRIMARYBUFFER: its SetVolume is the master volume
        const wfx = new Uint8Array(18); new DataView(wfx.buffer).setUint16(0, 1, true);
        m.w32(pp, newBuffer({ flags, primary: true, size: 0, wfx, freq: 44100, freq0: 44100, align: 4, data: null })); return 0;
      }
      if (!pwfx || size < 4) { m.w32(pp, 0); return 0x80070057 | 0; }   // DSERR_INVALIDPARAM
      const wfx = m.u8.slice(pwfx, pwfx + 18), f = fmt(wfx);
      if (f.tag !== 1) m.log(`DirectSound CreateSoundBuffer: format tag ${f.tag} (not PCM), played as PCM`);
      if (flags & 0x10) m.log('DirectSound CreateSoundBuffer: DSBCAPS_CTRL3D requested (played as 2D)');
      const data = { id: nextId++, mem: m.heap.alloc(size), size, bits: f.bits, ch: f.ch, refs: 1 };
      post({ op: 'data', id: data.id, size, bits: f.bits, ch: f.ch });
      m.w32(pp, newBuffer({ flags, size, wfx, freq: f.rate, freq0: f.rate, align: f.align, data }));
      if (DS.onCreate) DS.onCreate(m.comObjs.get(m.r32(pp)));
      return 0;
    }],
    ['GetCaps', 1, (s, [p]) => {   // DSCAPS: software mixing only, like DirectSound on Vista+ (the game then uses 16 voices, 0067b470)
      const n = m.r32(p); m.bytes(p + 4, Math.max(0, n - 4)).fill(0);
      m.w32(p + 4, 0xF5F); m.w32(p + 8, 100); m.w32(p + 12, 200000); m.w32(p + 16, 1); return 0;
    }],
    ['DuplicateSoundBuffer', 2, (s, [src, pp]) => {
      const o = m.comObjs.get(src);
      if (!o || o.primary || !o.data) { m.w32(pp, 0); return 0x88780032 | 0; }
      o.data.refs++;
      m.w32(pp, newBuffer({ flags: o.flags, size: o.size, wfx: o.wfx, freq: o.freq0, freq0: o.freq0, align: o.align, data: o.data })); return 0;
    }],
    ['SetCooperativeLevel', 2, () => 0], ['Compact', 0, () => 0],
    ['GetSpeakerConfig', 1, (s, [p]) => { m.w32(p, 4); return 0; }], ['SetSpeakerConfig', 1, () => 0], ['Initialize', 1, () => 0],
    ['VerifyCertification', 1, (s, [p]) => { m.w32(p, 0); return 0; }]]);
  /** Re-send every live buffer (data + state) to the mixer: used when the AudioContext (re)starts on a new clock. */
  DS.resync = () => {
    const t = T(), sent = new Set();
    for (const s of DS.buffers) {
      if (s.primary) { post({ op: 'master', gain: dsGains(s.vol, 0)[0] }); continue; }
      if (!sent.has(s.data.id)) {
        sent.add(s.data.id);
        post({ op: 'data', id: s.data.id, size: s.size, bits: s.data.bits, ch: s.data.ch });
        const bytes = m.u8.slice(s.data.mem, s.data.mem + s.size); post({ op: 'write', id: s.data.id, off: 0, bytes }, [bytes.buffer]);
      }
      const g = segAt(s, t), [gl, gr] = dsGains(s.vol, s.pan);
      post({ op: 'voice', id: s.id, data: s.data.id });
      post({ op: 'set', id: s.id, at: t, pos: pos(s, t), freq: s.freq, loop: g.loop, playing: isPlaying(s, t), gl, gr });
    }
  };
  /** Live state for the page / tests. */
  DS.status = () => { const t = be.now(); return [...DS.buffers].filter(s => !s.primary).map(s => ({ id: s.id, size: s.size, freq: s.freq, ch: s.data.ch, bits: s.data.bits, vol: s.vol, pan: s.pan, playing: isPlaying(s, t), loop: segAt(s, t).loop, cursor: cur(s, t), name: s.name })); };
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
