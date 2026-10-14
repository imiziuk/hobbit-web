// Phone / touch controls for web/game.html: an on-screen overlay that acts as a virtual W3C "standard" gamepad.
// game.mjs merges it with a physical pad in W.input.readPad(), so it reaches the game exactly like a real controller
// (recomp/host/dx.mjs padState). Page-only (needs the DOM); boot_node.mjs never imports it.
//   left half:  floating joystick = left stick (game and cutscene modes only)
//   right half: drag area = right stick (camera), A/B/X/Y cluster, LB/RB, Back/Start, D-pad (always)
// In menus the two drag areas are switched off, so a finger tap reaches the canvas and works as a mouse click.

// standard-gamepad button indices
const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, BACK = 8, START = 9, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;
const LABELS = {
  game:     { [A]: 'Jump', [B]: 'Crouch', [X]: 'Attack', [Y]: 'Use', [LB]: 'Ring', [RB]: 'Target', [BACK]: 'View', [START]: 'Pause' },
  cutscene: { [A]: 'A', [B]: 'B', [X]: 'X', [Y]: 'Y', [LB]: 'LB', [RB]: 'RB', [BACK]: 'Back', [START]: 'Skip' },
  menu:     { [A]: 'OK', [B]: 'Back', [X]: 'X', [Y]: 'OK', [LB]: 'LB', [RB]: 'RB', [BACK]: 'Back', [START]: 'Enter' },
};
const CSS = `
.tc { position: absolute; inset: 0; pointer-events: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  touch-action: none; font: 600 13px/1 system-ui, sans-serif; color: #fff; z-index: 5; }
.tc[hidden] { display: none; }
.tc .zone { position: absolute; top: 0; bottom: 0; pointer-events: auto; touch-action: none; }
.tc .zone.l { left: 0; width: 50%; }
.tc .zone.r { right: 0; width: 50%; }
.tc.menu .zone { pointer-events: none; }
.tc .knob-base, .tc .knob { position: absolute; border-radius: 50%; transform: translate(-50%, -50%); pointer-events: none; display: none; }
.tc .knob-base { width: 120px; height: 120px; border: 2px solid rgba(255,255,255,.45); background: rgba(255,255,255,.08); }
.tc .knob { width: 54px; height: 54px; background: rgba(255,255,255,.4); }
.tc .hint { position: absolute; bottom: 14px; font-size: 11px; color: rgba(255,255,255,.35); pointer-events: none; }
.tc.menu .hint { display: none; }
.tc button { position: absolute; pointer-events: auto; touch-action: none; border: 2px solid rgba(255,255,255,.55); color: #fff;
  background: rgba(30,30,30,.35); border-radius: 50%; padding: 0; font: inherit; text-shadow: 0 1px 2px #000; outline: none;
  -webkit-tap-highlight-color: transparent; }
.tc button.on { background: rgba(255,255,255,.45); }
.tc button.face { width: 62px; height: 62px; font-size: 13px; }
.tc button.face .k { display: block; font-size: 10px; opacity: .7; margin-top: 2px; }
.tc button.sm { width: 52px; height: 30px; border-radius: 15px; font-size: 11px; }
.tc button.dp { width: 38px; height: 38px; border-radius: 8px; font-size: 14px; }
.tc .a { border-color: rgba(90,200,90,.8); } .tc .b { border-color: rgba(220,80,80,.8); }
.tc .x { border-color: rgba(80,140,230,.8); } .tc .y { border-color: rgba(230,200,60,.8); }
`;

/** Build the overlay inside `host` (a positioned element over the canvas). getMode() -> 'menu' | 'cutscene' | 'game'.
 *  Returns { state(), setEnabled(on), enabled, el }. state() is a gamepad snapshot like W.input.readPad(), or null. */
export function installTouch(host, getMode) {
  if (!document.getElementById('tc-css')) {
    const st = document.createElement('style'); st.id = 'tc-css'; st.textContent = CSS; document.head.append(st);
  }
  const el = document.createElement('div'); el.className = 'tc menu'; el.hidden = true;
  const btn = new Array(17).fill(false);            // held by a touch button (counts of pointers below)
  const holders = Array.from({ length: 17 }, () => new Set());
  const axes = [0, 0, 0, 0];
  const R = 55;                                      // stick radius in CSS px

  // ---- floating sticks: left = move (left stick), right = camera (right stick)
  const stick = (cls, ax, hintText, hintSide) => {
    const zone = document.createElement('div'); zone.className = 'zone ' + cls;
    const base = document.createElement('div'); base.className = 'knob-base';
    const knob = document.createElement('div'); knob.className = 'knob';
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = hintText; hint.style[hintSide] = '14px';
    zone.append(base, knob, hint);
    let id = null, ox = 0, oy = 0;
    const show = (on) => { base.style.display = knob.style.display = on ? 'block' : 'none'; };
    const place = (x, y) => {
      const r = zone.getBoundingClientRect();
      let dx = x - ox, dy = y - oy; const d = Math.hypot(dx, dy);
      if (ax === 2 && d > R) { ox = x - dx * R / d; oy = y - dy * R / d; dx = x - ox; dy = y - oy; }   // camera: anchor follows
      const k = d > R ? R / d : 1;
      axes[ax] = dx * k / R; axes[ax + 1] = dy * k / R;
      base.style.left = (ox - r.left) + 'px'; base.style.top = (oy - r.top) + 'px';
      knob.style.left = (ox - r.left + dx * k) + 'px'; knob.style.top = (oy - r.top + dy * k) + 'px';
    };
    zone.addEventListener('pointerdown', e => {
      e.preventDefault(); if (id !== null) return;
      id = e.pointerId; ox = e.clientX; oy = e.clientY; try { zone.setPointerCapture(id); } catch {}
      show(true); place(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', e => { if (e.pointerId === id) { e.preventDefault(); place(e.clientX, e.clientY); } });
    const end = e => { if (e.pointerId !== id) return; id = null; axes[ax] = axes[ax + 1] = 0; show(false); };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end); zone.addEventListener('lostpointercapture', end);
    zone.reset = () => { id = null; axes[ax] = axes[ax + 1] = 0; show(false); };
    return zone;
  };
  const zl = stick('l', 0, 'drag: move', 'left'), zr = stick('r', 2, 'drag: camera', 'right');
  el.append(zl, zr);

  // ---- buttons (positions from the bottom-right / bottom-left corners, in CSS px)
  const labelEls = {};
  const mk = (i, cls, pos, text, key) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.dataset.btn = i;
    Object.assign(b.style, pos);
    const t = document.createElement('span'); t.textContent = text; b.append(t);
    if (key) { const k = document.createElement('span'); k.className = 'k'; k.textContent = key; b.append(k); }
    labelEls[i] = t;
    const down = e => { e.preventDefault(); e.stopPropagation(); holders[i].add(e.pointerId); try { b.releasePointerCapture(e.pointerId); } catch {} upd(i); };
    b.addEventListener('pointerdown', down);
    // sliding a finger onto a button presses it (pointer capture released above, so pointerenter fires)
    b.addEventListener('pointerenter', e => { if (e.pointerType !== 'mouse' && e.buttons) { holders[i].add(e.pointerId); upd(i); } });
    b.addEventListener('pointerleave', e => { if (e.pointerType !== 'mouse' && holders[i].delete(e.pointerId)) upd(i); });
    b.addEventListener('contextmenu', e => e.preventDefault());
    el.append(b); return b;
  };
  const btnEls = [];
  const upd = i => { btn[i] = holders[i].size > 0; btnEls[i] && btnEls[i].classList.toggle('on', btn[i]); };
  const release = e => { for (let i = 0; i < 17; i++) if (holders[i].delete(e.pointerId)) upd(i); };
  window.addEventListener('pointerup', release, true); window.addEventListener('pointercancel', release, true);
  // A/B/X/Y diamond, bottom right
  btnEls[A] = mk(A, 'face a', { right: '78px', bottom: '16px' }, 'A', 'A');
  btnEls[B] = mk(B, 'face b', { right: '12px', bottom: '78px' }, 'B', 'B');
  btnEls[X] = mk(X, 'face x', { right: '144px', bottom: '78px' }, 'X', 'X');
  btnEls[Y] = mk(Y, 'face y', { right: '78px', bottom: '140px' }, 'Y', 'Y');
  // shoulders, top right
  btnEls[LB] = mk(LB, 'sm', { right: '74px', top: '12px' }, 'LB');
  btnEls[RB] = mk(RB, 'sm', { right: '12px', top: '12px' }, 'RB');
  // Back / Start, top centre
  btnEls[BACK] = mk(BACK, 'sm', { left: 'calc(50% - 60px)', top: '12px' }, 'Back');
  btnEls[START] = mk(START, 'sm', { left: 'calc(50% + 8px)', top: '12px' }, 'Start');
  // D-pad, top left (the left half below it is the move stick)
  btnEls[UP] = mk(UP, 'dp', { left: '52px', top: '52px' }, '▲');
  btnEls[LEFT] = mk(LEFT, 'dp', { left: '10px', top: '94px' }, '◀');
  btnEls[RIGHT] = mk(RIGHT, 'dp', { left: '94px', top: '94px' }, '▶');
  btnEls[DOWN] = mk(DOWN, 'dp', { left: '52px', top: '136px' }, '▼');
  host.append(el);

  let mode = '';
  const setMode = md => {
    if (md === mode) return; mode = md;
    el.classList.toggle('menu', md === 'menu');
    if (md === 'menu') { zl.reset(); zr.reset(); }
    const L = LABELS[md] || LABELS.game;
    for (const i of [A, B, X, Y, LB, RB, BACK, START]) labelEls[i].textContent = L[i];
  };
  setMode('menu');
  const timer = setInterval(() => { if (!el.hidden) { try { setMode(getMode()); } catch {} } }, 100);

  const api = {
    el, enabled: false,
    setEnabled(on) {
      api.enabled = !!on; el.hidden = !on;
      if (!on) { zl.reset(); zr.reset(); for (let i = 0; i < 17; i++) { holders[i].clear(); upd(i); } }
    },
    state() {
      if (!api.enabled) return null;
      return { axes: [axes[0], axes[1], axes[2], axes[3], 0, 0], buttons: btn.slice() };
    },
    stop() { clearInterval(timer); },
  };
  return api;
}

/** Merge two gamepad snapshots (either may be null): OR the buttons, take the larger-magnitude value per axis. */
export function mergePads(a, b) {
  if (!a) return b; if (!b) return a;
  const n = Math.max(a.buttons.length, b.buttons.length);
  return {
    axes: a.axes.map((v, i) => (Math.abs(b.axes[i] || 0) > Math.abs(v || 0) ? b.axes[i] : v)),
    buttons: Array.from({ length: n }, (_, i) => !!(a.buttons[i] || b.buttons[i])),
  };
}
