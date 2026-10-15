// Per-slot skins + name labels for the web port's multiplayer (docs/MP_SKINS.md). Installed by web/game.mjs after mp.mjs.
// A port of the skin / marker ideas of The Hobbit Synchrony v3 (https://github.com/hobbit-kingdom/hobbit-synchrony-v3,
// BSD-3-Clause, Hobbit Kingdom community): SkinSystem.h (slot k -> bilb<k+1>[d].xbmp, geometry bilbo<k+1>.npcgeom),
// Marker.h/.cpp + Player.cpp (nickname marker object 0D8AD911_<npc guid lo> moved to (x, y + 110, z) every tick, text at
// marker+0xC0) and client.cpp (applySkinMetadataToPlayer, applyLocalIdentityMarkers).
//
// Skins: nothing to do at run time. Synchrony's FAKE_HOBBITS.EXPORT (served by recomp/mp_assets.py) already binds the
// fake Bilbo of slot k (GUID 0D8AD910_E885100(2+k)) to `props/bilbofake<k+1>.npcgeom`, and that geometry's diffuse
// material is `bilb<k+1>[D].xbmp` (COMMON\PROPS\). The release ships 8 byte-identical placeholder textures (the retail
// Bilbo look); in Synchrony a player's own skin file replaces its slot's placeholder on disk (SkinSync). This module
// adds the web equivalent that needs no files: a per-slot colour tint applied to the slot's texture in the D3D8 bridge
// (see `tint` below), so remote players are told apart even with the placeholders.
//
// Name labels: Synchrony writes the name into the marker object and lets the engine draw it (marker::RenderCustom
// 0x0049A340 -> text-at-3D-point 0x0066AE20 -> the xCore debug text queue 0x0067D360, flushed in eng_PageFlip
// 0x0065F480). In the retail exe that text never reaches the screen (docs/MP_SKINS.md section 2), so the label is an
// HTML overlay over the canvas: the fake Bilbo's position (+0x14, already lifted like Synchrony's renderY) + 120 units,
// projected with the VIEW/PROJECTION matrices the game last set for a perspective pass (captured by wrapping the
// bridge device's SetTransform at run time; nothing in web/d3d8 is edited) and the D3D viewport.
//
// Engine memory is only read here; the only engine-side writes are the texture tints (bridge-side JS objects).

const TS_VIEW = 2, TS_PROJECTION = 3;
const LABEL_LIFT = 120;                 // units above the NPC's (lifted) position; Synchrony's marker sits at +110
const FAKE_GUID_HI = 0x0D8AD910, FAKE_GUID_LO0 = 0xE8851002;
const SLOT_COLORS = ['#ffd84a', '#5ec8ff', '#7cff6e', '#ff7a7a', '#d38bff', '#ffa94d', '#6ef5e6', '#ffffff'];

export function installSkins({ mp, m, W, log = console.log, panel = null }) {
  const S = {
    labels: new Map(),        // player id -> {el, P}
    cam: null,                // {view, proj, vp} of the last perspective pass of the current frame
    last: null,
    show: true,
    hooked: false,
    tints: new Map(),         // slot -> tint applied ('#rrggbb' or null)
    stats: { projected: 0, hidden: 0, camFrames: 0 },
  };
  try { S.show = localStorage.getItem('hobbit.mp.labels') !== '0'; } catch { /* private mode */ }

  /* ------------------------------------------------------------------ camera capture */
  // The engine transforms vertices itself: D3D VIEW stays identity and WORLD is identity for almost every draw, so the
  // camera lives in the engine's view object (view 0 = [0x007EFF3C]): world-to-view 4x3 matrix at +0x8C (16-byte rows:
  // x, y, z columns + pad; view::W2V 0x00672710), screen centre/scale at +0x470/+0x474 (x) and +0x478/+0x47C (y), focal
  // length DAT_006E92E8, +0x70 = 0 for perspective (view::Project 0x00673820). At Present time the HUD pass has reset
  // that matrix, so it is snapshotted while the 3D pass draws: on every SetTransform(PROJECTION) with a perspective
  // matrix (the bridge device's method is wrapped at run time) the fields are copied when they describe a valid camera.
  const isPerspective = P => P && P[15] === 0 && P[11] !== 0;   // D3D row-vector projection: w = z * P[11]
  const VIEW_TABLE = 0x007EFF3C, FOCAL = 0x006E92E8;
  function snapshotView() {
    const v = m.r32(VIEW_TABLE);
    if (!v || m.r32(v + 0x70) !== 0) return;
    const a = new Float32Array(16);
    for (let i = 0; i < 16; i++) a[i] = mp.rf(v + 0x8C + 4 * i);
    const n0 = a[0] * a[0] + a[4] * a[4] + a[8] * a[8];               // first column of the rotation = unit vector
    if (!(n0 > 0.9 && n0 < 1.1)) return;
    // screen centre / scale as view::UpdateScreenScale 0x006746F0 + 0x006746A0 compute them (lazily, so the cached
    // +0x470.. fields are stale mid-frame): viewport ints +0x4C/+0x50/+0x54/+0x58 (l, t, r, b), fov +0x64 (radians)
    const l = m.r32(v + 0x4C) | 0, t = m.r32(v + 0x50) | 0, r = m.r32(v + 0x54) | 0, b = m.r32(v + 0x58) | 0, fov = mp.rf(v + 0x64);
    const tan = Math.tan(fov * 0.5);
    if (!(tan > 0) || r <= l || b <= t) return;
    const s = -((r - l + 1) * 0.5) / tan;
    S.last = { a, cx: (l + r) * 0.5, cy: (t + b) * 0.5, sx: s, sy: s, f: mp.rf(FOCAL) || 1, vp: { l, t, r, b } };
  }
  function hookDevice() {
    const d = m.com && m.com.device;
    if (!d || S.hooked) return;
    S.hooked = true; S.dev = d;
    const orig = d.SetTransform;
    d.SetTransform = function (t, mat) {
      const r = orig.call(this, t, mat);
      if (t === TS_PROJECTION && !this.recording && isPerspective(mat)) { try { snapshotView(); } catch (e) { S.stats.snapErr = e.message; } }
      return r;
    };
    log('[mp] skins: camera capture hooked on the D3D8 device');
  }
  /** world -> back-buffer pixels (D3D top-left origin, same maths as view::Project), or null when behind the camera */
  function project(cam, x, y, z) {
    const a = cam.a;
    const vx = a[0] * x + a[4] * y + a[8] * z + a[12], vy = a[1] * x + a[5] * y + a[9] * z + a[13], vz = a[2] * x + a[6] * y + a[10] * z + a[14];
    if (vz <= 1) return null;
    const k = cam.f / vz;
    return { x: k * vx * cam.sx + cam.cx, y: k * vy * cam.sy + cam.cy, z: vz, dist: vz };
  }

  /* ------------------------------------------------------------------ overlay DOM */
  const doc = typeof document !== 'undefined' ? document : null;
  const stage = doc && (doc.getElementById('stage') || (doc.querySelector('canvas') && doc.querySelector('canvas').parentElement));
  const canvas = doc && (doc.getElementById('screen') || doc.querySelector('canvas'));
  let box = null;
  if (stage && canvas) {
    box = doc.createElement('div');
    box.id = 'mpLabels';
    Object.assign(box.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', overflow: 'visible', pointerEvents: 'none', zIndex: 4 });
    stage.appendChild(box);
  }
  const labelStyle = {
    position: 'absolute', transform: 'translate(-50%, -100%)', whiteSpace: 'nowrap', pointerEvents: 'none',
    font: 'bold 12px/1.2 system-ui, sans-serif', color: '#fff', padding: '1px 5px', borderRadius: '3px',
    background: 'rgba(0,0,0,.55)', textShadow: '0 0 2px #000, 0 0 2px #000', letterSpacing: '.2px',
  };
  function labelFor(P) {
    let L = S.labels.get(P.id);
    if (!L) {
      const el = doc.createElement('div');
      Object.assign(el.style, labelStyle);
      box.appendChild(el);
      L = { el, name: null, slot: -1, dev: null };
      S.labels.set(P.id, L);
    }
    const name = String(P.name || '').slice(0, 24) || 'Hobbit';
    if (L.name !== name || L.slot !== P.slot || L.dev !== !!P.dev) {
      L.name = name; L.slot = P.slot; L.dev = !!P.dev;
      el_set(L.el, name, P.slot, !!P.dev);
    }
    return L;
  }
  function el_set(el, name, slot, dev) {
    el.textContent = name + (dev ? ' [DEV]' : '');
    el.style.borderBottom = `2px solid ${SLOT_COLORS[slot & 7]}`;
  }
  function dropLabel(id) { const L = S.labels.get(id); if (L) { L.el.remove(); S.labels.delete(id); } }
  function hideAll() { for (const L of S.labels.values()) L.el.style.display = 'none'; }
  let boxRect = '';
  function fitBox() {                     // the overlay box follows the canvas's CSS box inside #stage (fullscreen too)
    const key = `${canvas.offsetLeft},${canvas.offsetTop},${canvas.offsetWidth},${canvas.offsetHeight}`;
    if (key === boxRect) return;
    boxRect = key;
    box.style.left = canvas.offsetLeft + 'px'; box.style.top = canvas.offsetTop + 'px';
    box.style.width = canvas.offsetWidth + 'px'; box.style.height = canvas.offsetHeight + 'px';
  }

  /* ------------------------------------------------------------------ per frame */
  function frame(local) {
    hookDevice();
    if (!box) return;
    if (!local || !S.show || !S.last || !S.dev) { hideAll(); return; }
    S.cam = S.last;
    S.stats.camFrames++;
    fitBox();
    const sx = canvas.offsetWidth / canvas.width, sy = canvas.offsetHeight / canvas.height;
    const seen = new Set();
    for (const P of mp.players.values()) {
      const N = mp.npc.get(P.slot);
      if (!P.have || P.level !== local.l || !N || !mp.validNpc(N.obj, (FAKE_GUID_LO0 + P.slot) >>> 0)) continue;
      const x = mp.rf(N.obj + 0x14), y = mp.rf(N.obj + 0x18), z = mp.rf(N.obj + 0x1C);
      const pt = project(S.cam, x, y + LABEL_LIFT, z);
      const L = labelFor(P);
      seen.add(P.id);
      if (!pt || pt.x < S.cam.vp.l - 40 || pt.x > S.cam.vp.r + 40 || pt.y < S.cam.vp.t - 20 || pt.y > S.cam.vp.b + 20) { L.el.style.display = 'none'; S.stats.hidden++; continue; }
      L.el.style.display = '';
      L.el.style.left = (pt.x * sx).toFixed(1) + 'px';
      L.el.style.top = (pt.y * sy).toFixed(1) + 'px';
      L.el.style.opacity = pt.dist > 6000 ? '0.55' : '1';
      L.pt = pt;
      S.stats.projected++;
    }
    for (const [id, L] of S.labels) if (!seen.has(id)) L.el.style.display = 'none';
  }
  function onMessage(msg) {
    if (msg.t === 'leave') dropLabel(msg.id);
    else if (msg.t === 'welcome') { for (const id of [...S.labels.keys()]) dropLabel(id); }
    else if (msg.t === 'join' || msg.t === 'name' || msg.t === 'dev') { const P = mp.players.get(msg.id); if (P && S.labels.has(P.id)) labelFor(P); }
  }
  mp.frameHooks.push(frame);
  mp.listeners.push(onMessage);
  mp.levelHooks.push(() => hideAll());

  /* ------------------------------------------------------------------ per-slot tint (bridge textures) */
  // Finds the bridge Texture objects created from the slot placeholders. The 8 bilb<N>[D] files are identical, so a
  // texture cannot be told from its bytes alone; `findSlotTextures` therefore works from the fake Bilbo NPC itself:
  // see docs/MP_SKINS.md section 3 for what was tried. It is exposed for experiments and used by `tint`.
  function textures() {
    const out = [];
    if (!m.com) return out;
    for (const o of m.com.objs.values()) if (o && o.__iface === 'IDirect3DTexture8' && o.lv) out.push(o);
    return out;
  }
  /** DXT1 colour-endpoint tint of every mip of a bridge texture: c' = c*(1-k) + tint*k. Re-uploaded at the next draw. */
  function tintTexture(tex, rgb, k = 0.45) {
    if (!tex || tex.fmt !== 0x31545844) return false;       // FMT.DXT1 ('DXT1')
    const [tr, tg, tb] = rgb;
    for (const v of tex.lv) {
      const u8 = v.mem.u8, n = v.size >>> 3;
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        for (const e of [0, 2]) {
          const c = u8[o + e] | u8[o + e + 1] << 8;
          let r = (c >> 11) * 255 / 31, g = (c >> 5 & 63) * 255 / 63, b = (c & 31) * 255 / 31;
          r = r * (1 - k) + tr * k; g = g * (1 - k) + tg * k; b = b * (1 - k) + tb * k;
          const nc = (Math.round(r / 255 * 31) << 11) | (Math.round(g / 255 * 63) << 5) | Math.round(b / 255 * 31);
          u8[o + e] = nc & 255; u8[o + e + 1] = nc >> 8;
        }
      }
      v.dirty = true;
    }
    if (tex.dev && tex.dev.dirtyTex) tex.dev.dirtyTex.add(tex);
    return true;
  }

  /* ------------------------------------------------------------------ panel */
  if (panel && doc) {
    const row = doc.createElement('div');
    row.style.cssText = 'margin-top:4px;font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap';
    const lab = doc.createElement('label');
    const cb = doc.createElement('input'); cb.type = 'checkbox'; cb.checked = S.show;
    cb.addEventListener('change', () => { S.show = cb.checked; try { localStorage.setItem('hobbit.mp.labels', S.show ? '1' : '0'); } catch { /* private mode */ } if (!S.show) hideAll(); });
    lab.append(cb, ' Name labels');
    const info = doc.createElement('span'); info.style.opacity = '.7';
    info.textContent = 'Skins: slot k → bilb(k+1)[d].xbmp (Synchrony placeholders, all identical)';
    row.append(lab, info);
    panel.appendChild(row);
  }

  const api = { S, project, textures, tintTexture, labelFor, hideAll, setShow: on => { S.show = !!on; if (!on) hideAll(); } };
  mp.skins = api;
  return api;
}
