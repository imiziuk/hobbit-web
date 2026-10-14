// Port of Meridian.exe's texture-stage mini language (the game's own combiner front end), used to enumerate
// exactly which D3D8 combiner states the game can produce and to feed them through the shader generator in tests.
//   FUN_00555ab0  argument token   d c x k s t f 0 1  with prefixes ~ (complement) @ (alpha replicate) & (0x40000000)
//   FUN_00555900  operator token   * *2 *4 + +- +-2 +* - % , : ; < = > <end>
//   FUN_00554910  one channel      "a", "a op b", "a*b+c" / "a+b*c" (MULTIPLYADD), "a<b>c" (BLEND*ALPHA or LERP), "t=..."
//   FUN_00554860  one stage        colour string (ARG1/OP/ARG2/ARG0 = 2/1/3/0x1a), alpha string (5/4/6/0x1b), RESULTARG
// The order and values of the emitted SetTextureStageState calls follow the disassembly (docs section 2.5).
"use strict";

const END_ARG = 0x7ffffffe, ERR = 0x7fffffff, END = 0x7ffffff9, EQ = 0x7ffffff8, LT = 0x7ffffffe, GT = 0x7ffffffd;
const isSpace = c => c === " " || c === "\t" || c === "\n" || c === "\r";

class Cursor { constructor(s){ this.s = s; this.i = 0; } get c(){ return this.s[this.i] || "\0"; } }

export function parseArg(cur){                        // FUN_00555ab0
  while (cur.c !== "\0" && isSpace(cur.c)) cur.i++;
  let comp = false, rep = false, amp = false;
  for (;;){ const c = cur.c; if (c === "~") comp = !comp; else if (c === "@") rep = true; else if (c === "&") amp = true; else break; cur.i++; }
  let v;
  switch (cur.c){
    case "\0": return END_ARG;
    case "0": v = 0xf; break; case "1": comp = !comp; v = 0xf; break;
    case "c": v = 1; break; case "d": v = 0; break; case "f": v = 0xe; break; case "k": v = 3; break;
    case "s": v = 4; break; case "t": v = 5; break; case "x": v = 2; break;
    default: cur.i++; return ERR;
  }
  cur.i++;
  // FUN_00555d00: optional decimal suffix; must be 0 here
  while (cur.c !== "\0" && isSpace(cur.c)) cur.i++;
  let n = 0; while (/[0-9]/.test(cur.c)){ n = n * 10 + (cur.c.charCodeAt(0) - 48); cur.i++; }
  if (n) return ERR;
  if (comp) v |= 0x10; if (rep) v |= 0x20; if (amp) v |= 0x40000000;
  return v >>> 0;
}
export function parseOp(cur){                         // FUN_00555900
  while (cur.c !== "\0" && isSpace(cur.c)) cur.i++;
  const c = cur.c, n = cur.s[cur.i + 1] || "\0";
  switch (c){
    case "\0": return END;
    case "%": cur.i++; return 0x18;
    case "*": cur.i++; if (n === "2"){ cur.i++; return 5; } if (n === "4"){ cur.i++; return 6; } return 4;
    case "+": cur.i++;
      if (n === "-"){ cur.i++; if ((cur.s[cur.i] || "") === "2"){ cur.i++; return 9; } return 8; }
      if (n === "*"){ cur.i++; return 0xb; } return 7;
    case ",": cur.i++; return 0x7ffffffc; case "-": cur.i++; return 10; case ":": cur.i++; return 0x7ffffffa;
    case ";": cur.i++; return 0x7ffffffb; case "<": cur.i++; return LT; case "=": cur.i++; return EQ; case ">": cur.i++; return GT;
    default: cur.i++; return ERR;
  }
}

/** FUN_00554910. calls: array receiving [stage, state, value]. res: {v} result register (-1 = none yet).
 *  opCaps = D3DCAPS8.TextureOpCaps (selects BLEND*ALPHA over LERP). Returns true on success. */
export function setupChannel(calls, stage, str, ARG1, OP, ARG2, ARG0, res, opCaps){
  const set = (s, v) => calls.push([stage, s, v >>> 0]);
  if (str == null) return true;
  if (str === ""){ set(ARG1, 1); set(OP, 2); return true; }
  const cur = new Cursor(str);
  let a = parseArg(cur), op = parseOp(cur);
  if (a === ERR || op === ERR) return false;
  if (a !== END_ARG && op === EQ){
    if (res.v === -1) res.v = a; else if (res.v !== a) return false;
    a = parseArg(cur); op = parseOp(cur);
  } else set(28, 1);                                   // RESULTARG = CURRENT
  const b = parseArg(cur), op2 = parseOp(cur), c = parseArg(cur);
  if (a === ERR || b === ERR || c === ERR || op === ERR || op2 === ERR) return false;
  if (op === END){ set(ARG1, a); set(OP, 2); return true; }
  if (op2 === END){
    if (b === END_ARG) return false;
    if (op < 4 || (op > 0xb && op !== 0x18)) return false;
    set(ARG1, a); set(OP, op); set(ARG2, b); return true;
  }
  if (b === END_ARG || c === END_ARG) return false;
  let p = a, q = c;                                    // ebp, esi in the disassembly
  if ((op === 7 && op2 === 4) || (op === 4 && op2 === 7)){
    if (op === 7){ p = c; q = a; }
    set(ARG1, b); set(ARG2, q); set(ARG0, p); set(OP, 25); return true;   // MULTIPLYADD
  }
  if (op === LT && op2 === GT){
    let m = b;
    if (m & 0x10){ p = c; q = a; m &= ~0x10; }
    set(ARG1, q); set(ARG2, p);
    const pick = {0x20: [0x800, 12], 0x23: [0x2000, 14], 0x22: [0x1000, 13], 0x21: [0x8000, 16]}[m];
    if (pick && (opCaps & pick[0])){ set(OP, pick[1]); return true; }
    set(ARG0, m); set(OP, 26); return true;            // LERP
  }
  return false;
}

/** FUN_00554860: one stage = colour + alpha string. Returns the SetTextureStageState call list or null on error. */
export function setupStage(stage, colour, alpha, opCaps = 0x03feffff){
  const calls = [], res = {v: -1};
  if (!setupChannel(calls, stage, colour, 2, 1, 3, 0x1a, res, opCaps)) return null;
  if (!setupChannel(calls, stage, alpha, 5, 4, 6, 0x1b, res, opCaps)) return null;
  calls.push([stage, 28, res.v === -1 ? 1 : res.v]);
  return calls;
}

/** Every (stage, colour, alpha) combination passed to FUN_00554860 in the exe (strings read from .rdata). */
export const GAME_STRINGS = {
  colour: ["x", "x*2d", "x*d", "x+c", "x*d+c", "x*c", "@x*~k", "x*~k", "t<c>x", "@x*k", "t=x", "t=x*d", "c*d", "x*~c", "c*@c",
    "x<@d>c", "c<t>x", "t=@x*k", "x*~@d", "x*@d", "x*@k", "d*~c", "d*c", "c*@x", "t<@x>c", "c*~@x", "@x*c", "~@x*c", "c*k",
    "c<@d>x", "c+@c*x", "x*k", "c", "d", "k", "k*d", "@c"],
  alpha: ["", "x", "x*2d", "x*k", "c", "d", "k", "x*d", "c*d", "x*c", "k*d", null],
  // blend strings go to FUN_00554fb0 (frame blend), not to the stage parser
  frame: ["f+c", "f+c*@f", "&f=f*~@c+c*~@f", "@f=c", "&f=c*~@f+f", "&f=c*@f+f*~@c"],
};
