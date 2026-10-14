"""x86 (32-bit, MSVC 6) -> C translator: one C function per discovered function, literal machine semantics.

Usage: python recomp/x86c.py [--out recomp/out/c] [--chunk 150]
Writes out/c/funcs.h, out/c/chunk_NNN.c, out/c/dispatch.c, out/coverage.tsv, out/coverage.json.
Run with a Python that has capstone + pefile.
"""
import argparse, collections, json, os, sys, time
from capstone import x86_const as X
import cfg

M = {8: 0xFF, 16: 0xFFFF, 32: 0xFFFFFFFF}
SB = {8: 0x80, 16: 0x8000, 32: 0x80000000}
SX = {8: "i8", 16: "i16", 32: "i32"}
REG32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"]
REG16 = {"ax": "eax", "cx": "ecx", "dx": "edx", "bx": "ebx", "sp": "esp", "bp": "ebp", "si": "esi", "di": "edi"}
REG8L = {"al": "eax", "cl": "ecx", "dl": "edx", "bl": "ebx"}
REG8H = {"ah": "eax", "ch": "ecx", "dh": "edx", "bh": "ebx"}
CC = {"o": "of", "no": "!of", "b": "cf", "ae": "!cf", "e": "zf", "ne": "!zf", "be": "(cf|zf)", "a": "!(cf|zf)",
      "s": "sf", "ns": "!sf", "p": "pf", "np": "!pf", "l": "(sf!=of)", "ge": "(sf==of)", "le": "(zf|(sf!=of))",
      "g": "(!zf&&(sf==of))"}
ALU = {"add", "or", "adc", "sbb", "and", "sub", "xor", "cmp", "test"}
VEC = {"movaps", "movups", "movss", "movd", "movq", "shufps", "addps", "subps", "mulps", "divps", "minps", "maxps",
       "addss", "subss", "mulss", "divss", "emms", "pxor", "pand", "por", "pandn", "paddb", "paddw", "paddd", "psubb",
       "psubw", "psubd", "paddsw", "psubsw", "pmullw", "pmulhw", "pmaddwd", "psllw", "pslld", "psllq", "psrlw", "psrld",
       "psrlq", "psraw", "psrad", "punpcklbw", "punpcklwd", "punpckldq", "punpckhbw", "punpckhwd", "punpckhdq",
       "packssdw", "packuswb"}
NOPS = {"nop", "wait", "prefetchnta", "prefetcht0", "prefetcht1", "prefetcht2", "prefetch", "prefetchw", "pause"}


class Unsupported(Exception):
    pass


def h(v):
    return "0x%Xu" % (v & 0xFFFFFFFF)


class Emitter:
    def __init__(self, im, funcs, strong):
        self.im, self.funcs, self.strong = im, funcs, strong
        self.unsup = collections.Counter()      # mnemonic -> count (unique addresses)
        self.unsup_addr = {}

    # ------------------------------------------------------------- operands
    def regname(self, i, r):
        return i.reg_name(r)

    def rreg(self, name):
        if name in REG32:
            return name, 32
        if name in REG16:
            return "(%s & 0xFFFFu)" % REG16[name], 16
        if name in REG8L:
            return "(%s & 0xFFu)" % REG8L[name], 8
        if name in REG8H:
            return "((%s >> 8) & 0xFFu)" % REG8H[name], 8
        raise Unsupported("reg " + name)

    def wreg(self, name, v):
        if name in REG32:
            return "%s = (u32)(%s);" % (name, v)
        if name in REG16:
            p = REG16[name]
            return "%s = (%s & 0xFFFF0000u) | ((u32)(%s) & 0xFFFFu);" % (p, p, v)
        if name in REG8L:
            p = REG8L[name]
            return "%s = (%s & 0xFFFFFF00u) | ((u32)(%s) & 0xFFu);" % (p, p, v)
        if name in REG8H:
            p = REG8H[name]
            return "%s = (%s & 0xFFFF00FFu) | (((u32)(%s) & 0xFFu) << 8);" % (p, p, v)
        raise Unsupported("reg " + name)

    def ea(self, i, op, lea=False):
        m = op.mem
        if 0x67 in i.prefix:
            raise Unsupported("addr16")
        parts = []
        if m.base:
            b = self.regname(i, m.base)
            if b not in REG32:
                raise Unsupported("base " + b)
            parts.append(b)
        if m.index:
            x = self.regname(i, m.index)
            if x not in REG32:
                raise Unsupported("index " + x)
            parts.append(x if m.scale == 1 else "%s*%d" % (x, m.scale))
        d = m.disp & 0xFFFFFFFF
        if d or not parts:
            parts.append(h(d))
        if m.segment and not lea:
            s = self.regname(i, m.segment)
            if s == "fs":
                parts.append("R.fs_base")
            elif s not in ("ds", "ss", "es", "cs"):
                raise Unsupported("seg " + s)
        return "(u32)(" + " + ".join(parts) + ")"

    def rd(self, i, op, bits, a=None):
        if op.type == X.X86_OP_REG:
            e, b = self.rreg(self.regname(i, op.reg))
            return e
        if op.type == X.X86_OP_IMM:
            return h(op.imm & M[bits])
        if op.type == X.X86_OP_MEM:
            return "rd%d(%s)" % (bits, a or self.ea(i, op))
        raise Unsupported("op")

    def wr(self, i, op, bits, v, a=None):
        if op.type == X.X86_OP_REG:
            return self.wreg(self.regname(i, op.reg), v)
        if op.type == X.X86_OP_MEM:
            return "wr%d(%s, %s);" % (bits, a or self.ea(i, op), v)
        raise Unsupported("wr op")

    @staticmethod
    def bits(op):
        return op.size * 8

    # ------------------------------------------------------------- flags
    @staticmethod
    def szp(r, bits):
        return "zf = (%s & 0x%Xu) == 0; sf = (%s >> %d) & 1; pf = PAR(%s);" % (r, M[bits], r, bits - 1, r)

    # ------------------------------------------------------------- control helpers
    def goto_or_tail(self, fn, t):
        if t in fn.tails:
            return "{ SYNC_OUT F_%08x(); return; }" % t
        return "goto L_%08x;" % t

    def call_direct(self, t, nxt):
        if t in self.funcs:
            f = "F_%08x();" % t
        else:
            f = "disp(%s);" % h(t)
        return "esp -= 4; wr32(esp, %s); SYNC_OUT %s SYNC_IN CALLCHK(%s);" % (h(nxt), f, h(nxt))

    # ------------------------------------------------------------- one instruction
    def insn(self, fn, i):
        a = i.address
        nxt = a + i.size
        mn = i.mnemonic
        rep = None
        if mn.startswith(("rep ", "repe ", "repne ", "lock ")):
            p, mn = mn.split(" ", 1)
            if p != "lock":
                rep = p
        ops = i.operands
        L = []
        if mn in ALU:
            dst, src = ops
            b = self.bits(dst)
            pre = ""
            av = None
            if dst.type == X.X86_OP_MEM:
                pre = "u32 a = %s; " % self.ea(i, dst)
                av = "a"
            d = "(%s)" % self.rd(i, dst, b, av)
            s = self.rd(i, src, b)
            if src.type == X.X86_OP_IMM:
                s = h(src.imm & M[b])
            mk = M[b]
            body = "u32 d = %s, s = %s, r; " % (d, s)
            if mn in ("add",):
                body += "r = (d + s) & 0x%Xu; cf = r < d; of = (((d ^ r) & (s ^ r)) >> %d) & 1; af = ((d ^ s ^ r) >> 4) & 1; " % (mk, b - 1)
            elif mn == "adc":
                body += "u32 c = cf; r = (d + s + c) & 0x%Xu; cf = c ? (r <= d) : (r < d); of = (((d ^ r) & (s ^ r)) >> %d) & 1; af = ((d ^ s ^ r) >> 4) & 1; " % (mk, b - 1)
            elif mn in ("sub", "cmp"):
                body += "r = (d - s) & 0x%Xu; cf = d < s; of = (((d ^ s) & (d ^ r)) >> %d) & 1; af = ((d ^ s ^ r) >> 4) & 1; " % (mk, b - 1)
            elif mn == "sbb":
                body += "u32 c = %s;" % ("0" if os.environ.get("RECOMP_MUTATE") == "sbb" else "cf") + " r = (d - s - c) & 0x%Xu; cf = c ? (d <= s) : (d < s); of = (((d ^ s) & (d ^ r)) >> %d) & 1; af = ((d ^ s ^ r) >> 4) & 1; " % (mk, b - 1)
            else:
                o = {"and": "&", "test": "&", "or": "|", "xor": "^"}[mn]
                body += "r = d %s s; cf = 0; of = 0; af = 0; " % o
            body += self.szp("r", b)
            if mn not in ("cmp", "test"):
                body += " " + self.wr(i, dst, b, "r", av)
            return ["{ %s%s }" % (pre, body)]
        if mn == "mov":
            dst, src = ops
            if (dst.type == X.X86_OP_REG and self.regname(i, dst.reg) in ("ds", "es", "fs", "gs", "ss", "cs")) or \
                    (src.type == X.X86_OP_REG and self.regname(i, src.reg) in ("ds", "es", "fs", "gs", "ss", "cs")):
                raise Unsupported("mov sreg")
            b = self.bits(dst)
            return [self.wr(i, dst, b, self.rd(i, src, b))]
        if mn in ("movzx", "movsx"):
            dst, src = ops
            b, sb = self.bits(dst), self.bits(src)
            v = self.rd(i, src, sb)
            if mn == "movsx":
                v = "(u32)(i32)(%s)(%s)" % (SX[sb], v)
            return [self.wr(i, dst, b, v)]
        if mn == "lea":
            dst, src = ops
            return [self.wr(i, dst, self.bits(dst), self.ea(i, src, lea=True))]
        if mn == "push":
            op = ops[0]
            if op.size != 4 and op.type != X.X86_OP_IMM:
                raise Unsupported("push16")
            if op.type == X.X86_OP_REG and self.regname(i, op.reg) in ("ds", "es", "fs", "gs", "ss", "cs"):
                raise Unsupported("push sreg")
            v = h(op.imm) if op.type == X.X86_OP_IMM else self.rd(i, op, 32)
            return ["{ u32 v = %s; esp -= 4; wr32(esp, v); }" % v]
        if mn == "pop":
            op = ops[0]
            if op.size != 4:
                raise Unsupported("pop16")
            if op.type == X.X86_OP_REG and self.regname(i, op.reg) in ("ds", "es", "fs", "gs", "ss", "cs"):
                raise Unsupported("pop sreg")
            return ["{ u32 v = rd32(esp); esp += 4; %s }" % self.wr(i, op, 32, "v")]
        if mn == "pushal":
            return ["{ u32 t = esp; esp -= 32; wr32(esp+28, eax); wr32(esp+24, ecx); wr32(esp+20, edx); wr32(esp+16, ebx); "
                    "wr32(esp+12, t); wr32(esp+8, ebp); wr32(esp+4, esi); wr32(esp, edi); }"]
        if mn == "popal":
            return ["{ edi = rd32(esp); esi = rd32(esp+4); ebp = rd32(esp+8); ebx = rd32(esp+16); edx = rd32(esp+20); "
                    "ecx = rd32(esp+24); eax = rd32(esp+28); esp += 32; }"]
        if mn == "pushfd":
            return ["{ u32 v = (R.eflags & 0x00240200u) | 0x2u | cf | (pf << 2) | (af << 4) | (zf << 6) | (sf << 7) | (R.df << 10) | (of << 11); esp -= 4; wr32(esp, v); }"]
        if mn == "popfd":
            return ["{ u32 v = rd32(esp); esp += 4; cf = v & 1; pf = (v >> 2) & 1; af = (v >> 4) & 1; zf = (v >> 6) & 1; sf = (v >> 7) & 1; R.df = (v >> 10) & 1; of = (v >> 11) & 1; R.eflags = (R.eflags & ~0x00240200u) | (v & 0x00240200u); }"]
        if mn == "cpuid":
            return ["{ u32 a = eax, b = ebx, c = ecx, d = edx; rt_cpuid(&a, &b, &c, &d); eax = a; ebx = b; ecx = c; edx = d; }"]
        if mn == "lahf":
            return ["eax = (eax & 0xFFFF00FFu) | ((0x02u | cf | (pf << 2) | (af << 4) | (zf << 6) | (sf << 7)) << 8);"]
        if mn == "sahf":
            return ["{ u32 v = eax >> 8; cf = v & 1; pf = (v >> 2) & 1; af = (v >> 4) & 1; zf = (v >> 6) & 1; sf = (v >> 7) & 1; }"]
        if mn == "leave":
            return ["esp = ebp; ebp = rd32(esp); esp += 4;"]
        if mn == "enter":
            sz, lvl = ops[0].imm & 0xFFFF, ops[1].imm & 0x1F
            if lvl:
                raise Unsupported("enter nested")
            return ["esp -= 4; wr32(esp, ebp); ebp = esp; esp -= %d;" % sz]
        if mn == "xchg":
            x, y = ops
            b = self.bits(x)
            ax = ay = None
            pre = ""
            if x.type == X.X86_OP_MEM:
                pre += "u32 a = %s; " % self.ea(i, x); ax = "a"
            if y.type == X.X86_OP_MEM:
                pre += "u32 a = %s; " % self.ea(i, y); ay = "a"
            return ["{ %su32 t = %s, u = %s; %s %s }" % (pre, self.rd(i, x, b, ax), self.rd(i, y, b, ay),
                                                         self.wr(i, x, b, "u", ax), self.wr(i, y, b, "t", ay))]
        if mn == "xadd":
            dst, src = ops
            b = self.bits(dst)
            pre, av = "", None
            if dst.type == X.X86_OP_MEM:
                pre, av = "u32 a = %s; " % self.ea(i, dst), "a"
            mk = M[b]
            return ["{ %su32 d = %s, s = %s, r = (d + s) & 0x%Xu; cf = r < d; of = (((d ^ r) & (s ^ r)) >> %d) & 1; af = ((d ^ s ^ r) >> 4) & 1; %s %s %s }"
                    % (pre, self.rd(i, dst, b, av), self.rd(i, src, b), mk, b - 1, self.szp("r", b),
                       self.wr(i, src, b, "d"), self.wr(i, dst, b, "r", av))]
        if mn == "cmpxchg":
            dst, src = ops
            b = self.bits(dst)
            pre, av = "", None
            if dst.type == X.X86_OP_MEM:
                pre, av = "u32 a = %s; " % self.ea(i, dst), "a"
            acc = {8: "(eax & 0xFFu)", 16: "(eax & 0xFFFFu)", 32: "eax"}[b]
            wacc = {8: "eax = (eax & 0xFFFFFF00u) | d;", 16: "eax = (eax & 0xFFFF0000u) | d;", 32: "eax = d;"}[b]
            return ["{ %su32 d = %s, s = %s, r = (s - d) & 0x%Xu; cf = s < d; of = (((d ^ s) & (s ^ r)) >> %d) & 1; af = ((d ^ s ^ r) >> 4) & 1; %s if (zf) { %s } else { %s } }"
                    % (pre, self.rd(i, dst, b, av), acc, M[b], b - 1, self.szp("r", b),
                       self.wr(i, dst, b, self.rd(i, src, b), av), wacc)]
        if mn == "bswap":
            r = self.regname(i, ops[0].reg)
            return ["%s = __builtin_bswap32(%s);" % (r, r)]
        if mn in ("inc", "dec", "neg", "not"):
            dst = ops[0]
            b = self.bits(dst)
            pre, av = "", None
            if dst.type == X.X86_OP_MEM:
                pre, av = "u32 a = %s; " % self.ea(i, dst), "a"
            d = self.rd(i, dst, b, av)
            mk = M[b]
            if mn == "inc":
                body = "u32 d = %s, r = (d + 1) & 0x%Xu; of = r == 0x%Xu; af = (r & 0xF) == 0; %s" % (d, mk, SB[b], self.szp("r", b))
            elif mn == "dec":
                body = "u32 d = %s, r = (d - 1) & 0x%Xu; of = d == 0x%Xu; af = (d & 0xF) == 0; %s" % (d, mk, SB[b], self.szp("r", b))
            elif mn == "neg":
                body = "u32 d = %s, r = (0u - d) & 0x%Xu; cf = d != 0; of = d == 0x%Xu; af = ((d ^ r) >> 4) & 1; %s" % (d, mk, SB[b], self.szp("r", b))
            else:
                body = "u32 d = %s, r = (~d) & 0x%Xu;" % (d, mk)
            return ["{ %s%s %s }" % (pre, body, self.wr(i, dst, b, "r", av))]
        if mn in ("shl", "sal", "shr", "sar", "rol", "ror", "rcl", "rcr"):
            dst = ops[0]
            b = self.bits(dst)
            cnt = "1" if len(ops) == 1 else self.rd(i, ops[1], 8)
            if len(ops) > 1 and ops[1].type == X.X86_OP_IMM:
                cnt = str(ops[1].imm & 0xFF)
            pre, av = "", None
            if dst.type == X.X86_OP_MEM:
                pre, av = "u32 a = %s; " % self.ea(i, dst), "a"
            mk, top = M[b], b - 1
            d = self.rd(i, dst, b, av)
            if mn in ("shl", "sal"):
                op = ("u64 t = (u64)d << c; r = (u32)t & 0x%Xu; cf = (u32)(t >> %d) & 1; of = ((r >> %d) ^ cf) & 1; af = 0; %s"
                      % (mk, b, top, self.szp("r", b)))
            elif mn == "shr":
                op = ("cf = (u32)(((u64)d >> (c - 1)) & 1); r = (u32)((u64)d >> c); of = (d >> %d) & 1; af = 0; %s" % (top, self.szp("r", b)))
            elif mn == "sar":
                op = ("i64 sd = (i64)(%s)d; cf = (u32)((sd >> (c > %d ? %d : c - 1)) & 1); r = (u32)(sd >> (c > %d ? %d : c)) & 0x%Xu; of = 0; af = 0; %s"
                      % (SX[b], b, b - 1, b, b - 1, mk, self.szp("r", b)))
            elif mn == "rol":
                op = ("u32 k = c %% %d; r = k ? ((d << k) | (d >> (%d - k))) & 0x%Xu : d; cf = r & 1; of = ((r >> %d) ^ cf) & 1;" % (b, b, mk, top))
            elif mn == "ror":
                op = ("u32 k = c %% %d; r = k ? ((d >> k) | (d << (%d - k))) & 0x%Xu : d; cf = (r >> %d) & 1; of = ((r >> %d) ^ (r >> %d)) & 1;" % (b, b, mk, top, top, top - 1))
            elif mn == "rcl":
                op = "r = rt_rcl(d, c, %d, &cf); of = ((r >> %d) ^ cf) & 1;" % (b, top)
            else:
                op = "of = ((d >> %d) ^ cf) & 1; r = rt_rcr(d, c, %d, &cf);" % (top, b)
            return ["{ %su32 c = (%s) & 31; if (c) { u32 d = %s, r; %s %s } }" % (pre, cnt, d, op, self.wr(i, dst, b, "r", av))]
        if mn in ("shld", "shrd"):
            dst, src, cop = ops
            b = self.bits(dst)
            if b != 32:
                raise Unsupported(mn + "16")
            cnt = str(cop.imm & 0xFF) if cop.type == X.X86_OP_IMM else self.rd(i, cop, 8)
            pre, av = "", None
            if dst.type == X.X86_OP_MEM:
                pre, av = "u32 a = %s; " % self.ea(i, dst), "a"
            d, s = self.rd(i, dst, b, av), self.rd(i, src, b)
            if mn == "shld":
                op = "r = (d << c) | (s >> (32 - c)); cf = (d >> (32 - c)) & 1; of = ((r ^ d) >> 31) & 1;"
            else:
                op = "r = (d >> c) | (s << (32 - c)); cf = (d >> (c - 1)) & 1; of = ((r ^ d) >> 31) & 1;"
            return ["{ %su32 c = (%s) & 31; if (c) { u32 d = %s, s = %s, r; %s %s %s } }" % (pre, cnt, d, s, op, self.szp("r", 32), self.wr(i, dst, 32, "r", av))]
        if mn in ("mul", "imul") and len(ops) == 1:
            src = ops[0]
            b = self.bits(src)
            s = self.rd(i, src, b)
            if b == 32:
                if mn == "mul":
                    return ["{ u64 p = (u64)eax * (u64)(%s); eax = (u32)p; edx = (u32)(p >> 32); cf = of = edx != 0; }" % s]
                return ["{ i64 p = (i64)(i32)eax * (i64)(i32)(%s); eax = (u32)p; edx = (u32)((u64)p >> 32); cf = of = p != (i64)(i32)eax; }" % s]
            if b == 16:
                if mn == "mul":
                    return ["{ u32 p = (eax & 0xFFFFu) * (u32)(%s); eax = (eax & 0xFFFF0000u) | (p & 0xFFFF); edx = (edx & 0xFFFF0000u) | (p >> 16); cf = of = (p >> 16) != 0; }" % s]
                return ["{ i32 p = (i32)(i16)eax * (i32)(i16)(%s); eax = (eax & 0xFFFF0000u) | ((u32)p & 0xFFFF); edx = (edx & 0xFFFF0000u) | (((u32)p >> 16) & 0xFFFF); cf = of = p != (i32)(i16)p; }" % s]
            if mn == "mul":
                return ["{ u32 p = (eax & 0xFFu) * (u32)(%s); eax = (eax & 0xFFFF0000u) | (p & 0xFFFF); cf = of = (p >> 8) != 0; }" % s]
            return ["{ i32 p = (i32)(i8)eax * (i32)(i8)(%s); eax = (eax & 0xFFFF0000u) | ((u32)p & 0xFFFF); cf = of = p != (i32)(i8)p; }" % s]
        if mn == "imul":
            if len(ops) == 2:
                dst, s1, s2 = ops[0], ops[0], ops[1]
            else:
                dst, s1, s2 = ops
            b = self.bits(dst)
            v1, v2 = self.rd(i, s1, b), self.rd(i, s2, b)
            if s2.type == X.X86_OP_IMM:
                v2 = h(s2.imm & M[b])
            return ["{ i64 p = (i64)(%s)(%s) * (i64)(%s)(%s); u32 r = (u32)p & 0x%Xu; cf = of = p != (i64)(%s)r; %s }"
                    % (SX[b], v1, SX[b], v2, M[b], SX[b], self.wr(i, dst, b, "r"))]
        if mn in ("div", "idiv"):
            src = ops[0]
            b = self.bits(src)
            s = self.rd(i, src, b)
            T = "TRAP(T_DE, %s)" % h(a)
            if b == 32:
                if mn == "div":
                    return ["{ u32 s = %s; if (!s) %s; u64 n = ((u64)edx << 32) | eax; u64 q = n / s; if (q >> 32) %s; edx = (u32)(n %% s); eax = (u32)q; }" % (s, T, T)]
                return ["{ i32 s = (i32)(%s); if (!s) %s; i64 n = (i64)(((u64)edx << 32) | eax); if (s == -1 && n == (i64)0x8000000000000000ull) %s; i64 q = n / s; if (q != (i64)(i32)q) %s; edx = (u32)(i32)(n %% s); eax = (u32)(i32)q; }" % (s, T, T, T)]
            if b == 16:
                if mn == "div":
                    return ["{ u32 s = %s; if (!s) %s; u32 n = ((edx & 0xFFFF) << 16) | (eax & 0xFFFF); u32 q = n / s; if (q > 0xFFFF) %s; edx = (edx & 0xFFFF0000u) | (n %% s); eax = (eax & 0xFFFF0000u) | q; }" % (s, T, T)]
                return ["{ i32 s = (i16)(%s); if (!s) %s; i32 n = (i32)(((edx & 0xFFFF) << 16) | (eax & 0xFFFF)); i64 q = (i64)n / s; if (q != (i16)q) %s; edx = (edx & 0xFFFF0000u) | ((u32)(n %% s) & 0xFFFF); eax = (eax & 0xFFFF0000u) | ((u32)q & 0xFFFF); }" % (s, T, T)]
            if mn == "div":
                return ["{ u32 s = %s; if (!s) %s; u32 n = eax & 0xFFFF; u32 q = n / s; if (q > 0xFF) %s; eax = (eax & 0xFFFF0000u) | ((n %% s) << 8) | q; }" % (s, T, T)]
            return ["{ i32 s = (i8)(%s); if (!s) %s; i32 n = (i16)eax; i32 q = n / s; if (q != (i8)q) %s; eax = (eax & 0xFFFF0000u) | (((u32)(n %% s) & 0xFF) << 8) | ((u32)q & 0xFF); }" % (s, T, T)]
        if mn == "cdq":
            return ["edx = (u32)((i32)eax >> 31);"]
        if mn == "cwde":
            return ["eax = (u32)(i32)(i16)eax;"]
        if mn == "cbw":
            return ["eax = (eax & 0xFFFF0000u) | ((u32)(i16)(i8)eax & 0xFFFF);"]
        if mn == "cwd":
            return ["edx = (edx & 0xFFFF0000u) | (((i16)eax < 0) ? 0xFFFFu : 0);"]
        if mn.startswith("set") and mn[3:] in CC:
            return [self.wr(i, ops[0], 8, CC[mn[3:]])]
        if mn.startswith("cmov") and mn[4:] in CC:
            dst, src = ops
            return ["if (%s) { %s }" % (CC[mn[4:]], self.wr(i, dst, self.bits(dst), self.rd(i, src, self.bits(dst))))]
        if mn in ("bt", "bts", "btr", "btc"):
            dst, src = ops
            b = self.bits(dst)
            if dst.type == X.X86_OP_MEM and src.type == X.X86_OP_REG:
                pre = "u32 o = %s; u32 a = %s + (u32)(((i32)o >> 5) * 4); u32 k = o & 31; " % (self.rd(i, src, 32), self.ea(i, dst))
                d, av, b = "rd32(a)", "a", 32
            else:
                k = (src.imm & (b - 1)) if src.type == X.X86_OP_IMM else None
                pre = "u32 k = %s; " % (str(k) if k is not None else "(%s) & %d" % (self.rd(i, src, b), b - 1))
                av = None
                if dst.type == X.X86_OP_MEM:
                    pre += "u32 a = %s; " % self.ea(i, dst); av = "a"
                d = self.rd(i, dst, b, av)
            op = {"bt": "", "bts": "d |= 1u << k;", "btr": "d &= ~(1u << k);", "btc": "d ^= 1u << k;"}[mn]
            w = self.wr(i, dst, b, "d", av) if mn != "bt" else ""
            return ["{ %su32 d = %s; cf = (d >> k) & 1; %s %s }" % (pre, d, op, w)]
        if mn in ("bsf", "bsr"):
            dst, src = ops
            b = self.bits(dst)
            v = "__builtin_ctz(s)" if mn == "bsf" else "(31 - __builtin_clz(s))"
            return ["{ u32 s = %s; zf = s == 0; if (s) { %s } }" % (self.rd(i, src, b), self.wr(i, dst, b, v))]
        if mn in ("clc", "stc", "cmc"):
            return [{"clc": "cf = 0;", "stc": "cf = 1;", "cmc": "cf ^= 1;"}[mn]]
        if mn in ("cld", "std"):
            return ["R.df = %d;" % (mn == "std")]
        if mn == "xlatb":
            return ["eax = (eax & 0xFFFFFF00u) | rd8(ebx + (eax & 0xFF));"]
        if mn in NOPS or mn == "fwait":
            return [";"]
        if mn[:4] in ("movs", "stos", "lods", "scas", "cmps") and len(mn) == 5 and mn[4] in "bwd":
            return [self.strop(mn[:4], {"b": 1, "w": 2, "d": 4}[mn[4]], rep)]
        if 0xD8 <= i.opcode[0] <= 0xDF:
            return self.x87(i)
        if mn in VEC:
            return self.vec(i, mn)
        raise Unsupported(mn)

    # ------------------------------------------------------------- MMX / SSE (subset used by the game)
    def vreg(self, i, op):
        n = self.regname(i, op.reg)
        if n.startswith("xmm"):
            return "xmm", int(n[3:])
        if n.startswith("mm"):
            return "mm", int(n[2:])
        return "gp", n

    def vld(self, i, op, var, nbytes):
        """load an operand into V128 var (zero-filled)"""
        s = "V128 %s = {{0, 0}}; " % var
        if op.type == X.X86_OP_REG:
            k, r = self.vreg(i, op)
            if k == "xmm":
                return s + "%s = XM[%d]; " % (var, r)
            if k == "mm":
                return s + "%s.q[0] = MM[%d]; " % (var, r)
            return s + "%s.d[0] = %s; " % (var, self.rreg(r)[0])
        s += "{ u32 a = %s; " % self.ea(i, op)
        for q in range(nbytes // 4):
            s += "%s.d[%d] = rd32(a + %d); " % (var, q, 4 * q)
        return s + "} "

    def vst(self, i, op, var, nbytes):
        if op.type == X.X86_OP_REG:
            k, r = self.vreg(i, op)
            if k == "xmm":
                if nbytes == 4:
                    return "XM[%d].d[0] = %s.d[0]; " % (r, var)
                return "XM[%d] = %s; " % (r, var)
            if k == "mm":
                return "MM[%d] = %s.q[0]; " % (r, var)
            return self.wreg(r, "%s.d[0]" % var) + " "
        s = "{ u32 a = %s; " % self.ea(i, op)
        for q in range(nbytes // 4):
            s += "wr32(a + %d, %s.d[%d]); " % (4 * q, var, q)
        return s + "} "

    def vec(self, i, mn):
        ops = i.operands
        if mn == "emms":
            return ["for (int q = 0; q < 8; q++) F.tag[q] = 3;"]
        d, sop = ops[0], ops[1] if len(ops) > 1 else None

        def kind(op):
            return self.vreg(i, op)[0] if op is not None and op.type == X.X86_OP_REG else None
        if mn == "emms":
            return ["for (int q = 0; q < 8; q++) F.tag[q] = 3;"]
        isx = kind(d) == "xmm" or kind(sop) == "xmm"
        pre = "" if isx else "mmx_enter(); "
        if mn in ("movaps", "movups"):
            return ["{ %s%s}" % (self.vld(i, sop, "s", 16), self.vst(i, d, "s", 16))]
        if mn == "movss":
            if sop.type == X.X86_OP_MEM:
                return ["{ %sXM[%d] = s; }" % (self.vld(i, sop, "s", 4), self.vreg(i, d)[1])]
            return ["{ %s%s}" % (self.vld(i, sop, "s", 16), self.vst(i, d, "s", 4))]
        if mn in ("movd", "movq"):
            if isx:
                raise Unsupported(mn + " xmm")
            n = 4 if mn == "movd" else 8
            st = "MM[%d] = s.q[0]; " % self.vreg(i, d)[1] if kind(d) == "mm" else self.vst(i, d, "s", n)
            return ["{ %s%s%s}" % (pre, self.vld(i, sop, "s", n), st)]
        if mn == "shufps":
            imm = ops[2].imm & 0xFF
            r = self.vreg(i, d)[1]
            return ["{ %sV128 t = XM[%d], o; o.d[0] = t.d[%d]; o.d[1] = t.d[%d]; o.d[2] = s.d[%d]; o.d[3] = s.d[%d]; XM[%d] = o; }"
                    % (self.vld(i, sop, "s", 16), r, imm & 3, (imm >> 2) & 3, (imm >> 4) & 3, (imm >> 6) & 3, r)]
        if mn in ("addps", "subps", "mulps", "divps", "minps", "maxps", "addss", "subss", "mulss", "divss"):
            o = {"add": "+", "sub": "-", "mul": "*", "div": "/"}.get(mn[:3])
            n = 4 if mn.endswith("ps") else 1
            r = self.vreg(i, d)[1]
            if o:
                body = "".join("XM[%d].f[%d] = XM[%d].f[%d] %s s.f[%d]; " % (r, k, r, k, o, k) for k in range(n))
            else:
                c = "<" if mn.startswith("min") else ">"
                body = "".join("XM[%d].f[%d] = (XM[%d].f[%d] %s s.f[%d]) ? XM[%d].f[%d] : s.f[%d]; " % (r, k, r, k, c, k, r, k, k) for k in range(n))
            return ["{ %s%s}" % (self.vld(i, sop, "s", 16 if n == 4 else 4), body)]
        # MMX integer ops on one 64-bit register
        if isx:
            raise Unsupported(mn + " xmm")
        r = self.vreg(i, d)[1]
        src = self.vld(i, sop, "s", 8) if sop.type != X.X86_OP_IMM else "V128 s = {{0, 0}}; s.q[0] = %du; " % (sop.imm & 0xFF)
        head = "{ %s%sV128 t = {{0, 0}}; t.q[0] = MM[%d]; V128 o = {{0, 0}}; " % (pre, src, r)
        tail = "MM[%d] = o.q[0]; }" % r
        if mn in ("pxor", "pand", "por", "pandn"):
            e = {"pxor": "t.q[0] ^ s.q[0]", "pand": "t.q[0] & s.q[0]", "por": "t.q[0] | s.q[0]", "pandn": "~t.q[0] & s.q[0]"}[mn]
            return [head + "o.q[0] = %s; " % e + tail]
        if mn in ("paddb", "paddw", "paddd", "psubb", "psubw", "psubd"):
            n, f = {"b": (8, "b"), "w": (4, "w"), "d": (2, "d")}[mn[-1]]
            o = "+" if mn.startswith("padd") else "-"
            return [head + "".join("o.%s[%d] = t.%s[%d] %s s.%s[%d]; " % (f, k, f, k, o, f, k) for k in range(n)) + tail]
        if mn in ("paddsw", "psubsw"):
            o = "+" if mn.startswith("padd") else "-"
            return [head + "".join("{ i32 v = (i32)t.sw[%d] %s (i32)s.sw[%d]; o.sw[%d] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; } " % (k, o, k, k) for k in range(4)) + tail]
        if mn == "pmullw":
            return [head + "".join("o.w[%d] = (u16)((i32)t.sw[%d] * (i32)s.sw[%d]); " % (k, k, k) for k in range(4)) + tail]
        if mn == "pmulhw":
            return [head + "".join("o.w[%d] = (u16)(((i32)t.sw[%d] * (i32)s.sw[%d]) >> 16); " % (k, k, k) for k in range(4)) + tail]
        if mn == "pmaddwd":
            return [head + "o.d[0] = (u32)((i32)t.sw[0] * s.sw[0]) + (u32)((i32)t.sw[1] * s.sw[1]); "
                           "o.d[1] = (u32)((i32)t.sw[2] * s.sw[2]) + (u32)((i32)t.sw[3] * s.sw[3]); " + tail]
        if mn in ("psllw", "pslld", "psllq", "psrlw", "psrld", "psrlq", "psraw", "psrad"):
            k2, f = mn[2:4], mn[-1]
            n, fld, sfld = {"w": (4, "w", "sw"), "d": (2, "d", "sd"), "q": (1, "q", None)}[f]
            bits = {"w": 16, "d": 32, "q": 64}[f]
            if k2 == "ll":
                e = "o.%s[{k}] = c >= %d ? 0 : t.%s[{k}] << c; " % (fld, bits, fld)
            elif k2 == "rl":
                e = "o.%s[{k}] = c >= %d ? 0 : t.%s[{k}] >> c; " % (fld, bits, fld)
            else:
                e = "o.%s[{k}] = t.%s[{k}] >> (c >= %d ? %d : c); " % (sfld, sfld, bits, bits - 1)
            return [head + "u64 c = s.q[0]; " + "".join(e.format(k=k) for k in range(n)) + tail]
        if mn.startswith("punpck"):
            part, f = mn[6], mn[7]
            n, fld = {"b": (8, "b"), "w": (4, "w"), "d": (2, "d")}[f]
            base = 0 if part == "l" else n // 2
            body = "".join("o.%s[%d] = t.%s[%d]; o.%s[%d] = s.%s[%d]; " % (fld, 2 * k, fld, base + k, fld, 2 * k + 1, fld, base + k)
                           for k in range(n // 2))
            return [head + body + tail]
        if mn == "packssdw":
            sat = "(v > 32767 ? 32767 : v < -32768 ? -32768 : v)"
            body = "".join("{ i32 v = t.sd[%d]; o.sw[%d] = %s; } " % (k, k, sat) for k in range(2))
            body += "".join("{ i32 v = s.sd[%d]; o.sw[%d] = %s; } " % (k, k + 2, sat) for k in range(2))
            return [head + body + tail]
        if mn == "packuswb":
            sat = "(v > 255 ? 255 : v < 0 ? 0 : v)"
            body = "".join("{ i32 v = t.sw[%d]; o.b[%d] = %s; } " % (k, k, sat) for k in range(4))
            body += "".join("{ i32 v = s.sw[%d]; o.b[%d] = %s; } " % (k, k + 4, sat) for k in range(4))
            return [head + body + tail]
        raise Unsupported(mn)

    def strop(self, op, n, rep):
        b = n * 8
        st = "d" if 1 else ""
        step = "(R.df ? (u32)-%d : %du)" % (n, n)
        acc = {1: "(eax & 0xFFu)", 2: "(eax & 0xFFFFu)", 4: "eax"}[n]
        wacc = {1: "eax = (eax & 0xFFFFFF00u) | v;", 2: "eax = (eax & 0xFFFF0000u) | v;", 4: "eax = v;"}[n]
        if op == "movs":
            body = "wr%d(edi, rd%d(esi)); esi += st; edi += st;" % (b, b)
        elif op == "stos":
            body = "wr%d(edi, %s); edi += st;" % (b, acc)
        elif op == "lods":
            body = "{ u32 v = rd%d(esi); %s } esi += st;" % (b, wacc)
        else:
            if op == "scas":
                pair = "u32 d = %s, s = rd%d(edi); edi += st;" % (acc, b)
            else:
                pair = "u32 d = rd%d(esi), s = rd%d(edi); esi += st; edi += st;" % (b, b)
            body = ("{ %s u32 r = (d - s) & 0x%Xu; cf = d < s; of = (((d ^ s) & (d ^ r)) >> %d) & 1; af = ((d ^ s ^ r) >> 4) & 1; %s }"
                    % (pair, M[b], b - 1, self.szp("r", b)))
        if rep is None:
            return "{ u32 st = %s; %s }" % (step, body)
        if op in ("scas", "cmps"):
            cond = "if (!zf) break;" if rep == "repe" else "if (zf) break;"
            return "{ u32 st = %s; while (ecx) { %s ecx--; %s } }" % (step, body, cond)
        return "{ u32 st = %s; while (ecx) { %s ecx--; } }" % (step, body)

    # ------------------------------------------------------------- x87 (decoded from opcode bytes)
    def x87(self, i):
        op = i.opcode[0]
        modrm = i.modrm
        reg = (modrm >> 3) & 7
        memop = [o for o in i.operands if o.type == X.X86_OP_MEM]
        if (modrm >> 6) != 3:
            if not memop:
                raise Unsupported("x87 mem?")
            a = self.ea(i, memop[0])
            return [self.x87mem(op, reg, a)]
        return [self.x87reg(op, modrm)]

    ARITH = {0: "+", 1: "*", 4: "-", 5: "r-", 6: "/", 7: "r/"}

    def arith(self, k, x, y):
        """x op y (k from the reg field: 4 sub, 5 subr, 6 div, 7 divr)"""
        o = self.ARITH[k]
        if o.startswith("r"):
            return "PR(%s %s %s)" % (y, o[1], x)
        return "PR(%s %s %s)" % (x, o, y)

    def x87mem(self, op, reg, a):
        if op in (0xD8, 0xDC, 0xDA, 0xDE):
            ld = {0xD8: "(double)rdf32(a)", 0xDC: "rdf64(a)", 0xDA: "(double)(i32)rd32(a)", 0xDE: "(double)(i16)rd16(a)"}[op]
            if reg in (2, 3):
                return "{ u32 a = %s; rt_fcom(ST(0), %s);%s }" % (a, ld, " fpop();" if reg == 3 else "")
            return "{ u32 a = %s; double v = %s; ST(0) = %s; }" % (a, ld, self.arith(reg, "ST(0)", "v"))
        if op == 0xD9:
            if reg == 0:
                return "{ u32 a = %s; fpush((double)rdf32(a)); }" % a
            if reg == 2:
                return "wrf32(%s, (float)ST(0));" % a
            if reg == 3:
                return "{ wrf32(%s, (float)ST(0)); fpop(); }" % a
            if reg == 5:
                return "F.cw = rd16(%s);" % a
            if reg == 7:
                return "wr16(%s, F.cw);" % a
            if reg == 4:
                return "rt_fldenv(%s);" % a
            if reg == 6:
                return "rt_fstenv(%s);" % a
            raise Unsupported("x87 env")
        if op == 0xDB:
            if reg == 0:
                return "fpush((double)(i32)rd32(%s));" % a
            if reg == 1:
                return "{ double v = ST(0); wr32(%s, (v >= -2147483648.0 && v < 2147483648.0) ? (u32)(i32)v : 0x80000000u); fpop(); }" % a
            if reg in (2, 3):
                return "{ wr32(%s, rt_fist32(ST(0)));%s }" % (a, " fpop();" if reg == 3 else "")
            if reg == 5:
                return "fpush(rt_ldext(%s));" % a
            if reg == 7:
                return "{ rt_stext(%s, ST(0)); fpop(); }" % a
            raise Unsupported("x87 db")
        if op == 0xDD:
            if reg == 0:
                return "fpush(rdf64(%s));" % a
            if reg in (2, 3):
                return "{ wrf64(%s, ST(0));%s }" % (a, " fpop();" if reg == 3 else "")
            if reg == 7:
                return "wr16(%s, fstsw());" % a
            if reg == 4:
                return "rt_frstor(%s);" % a
            if reg == 6:
                return "rt_fsave(%s);" % a
            raise Unsupported("x87 save")
        if op == 0xDF:
            if reg == 0:
                return "fpush((double)(i16)rd16(%s));" % a
            if reg in (2, 3):
                return "{ wr16(%s, rt_fist16(ST(0)));%s }" % (a, " fpop();" if reg == 3 else "")
            if reg == 5:
                return "fpush((double)(i64)rd64(%s));" % a
            if reg == 7:
                return "{ wr64(%s, rt_fist64(ST(0))); fpop(); }" % a
            raise Unsupported("x87 bcd")
        raise Unsupported("x87 mem %02x" % op)

    def x87reg(self, op, modrm):
        r = modrm & 7
        k = (modrm >> 3) & 7
        si = "ST(%d)" % r
        if op == 0xD8:
            if k in (2, 3):
                return "{ rt_fcom(ST(0), %s);%s }" % (si, " fpop();" if k == 3 else "")
            return "ST(0) = %s;" % self.arith(k, "ST(0)", si)
        if op in (0xDC, 0xDE):
            if op == 0xDE and modrm == 0xD9:
                return "{ rt_fcom(ST(0), ST(1)); fpop(); fpop(); }"
            if k in (2, 3):
                raise Unsupported("x87 dc cmp")
            # DC/DE reg forms: ST(i) = ST(i) op ST(0), with sub/subr and div/divr swapped vs D8 (E0=subr, E8=sub)
            kk = {0: 0, 1: 1, 4: 5, 5: 4, 6: 7, 7: 6}[k]
            return "{ %s = %s;%s }" % (si, self.arith(kk, si, "ST(0)"), " fpop();" if op == 0xDE else "")
        if op == 0xD9:
            if k == 0:
                return "{ double v = %s; fpush(v); }" % si
            if k == 1:
                return "{ double v = ST(0); ST(0) = %s; %s = v; u32 t = F.tag[F.top]; F.tag[F.top] = F.tag[(F.top + %d) & 7]; F.tag[(F.top + %d) & 7] = t; }" % (si, si, r, r)
            m = {0xD0: ";", 0xE0: "ST(0) = -ST(0);", 0xE1: "ST(0) = __builtin_fabs(ST(0));",
                 0xE4: "rt_fcom(ST(0), 0.0);", 0xE5: "rt_fxam();", 0xE8: "fpush(1.0);",
                 0xE9: "fpush(3.321928094887362347870319429489390175864831393);",
                 0xEA: "fpush(1.442695040888963407359924681001892137426645954);",
                 0xEB: "fpush(3.141592653589793238462643383279502884197169399);",
                 0xEC: "fpush(0.301029995663981195213738894724493026768189881);",
                 0xED: "fpush(0.693147180559945309417232121458176568075500134);", 0xEE: "fpush(0.0);",
                 0xF0: "ST(0) = rt_exp2(ST(0)) - 1.0;", 0xF1: "{ ST(1) = ST(1) * rt_log2(ST(0)); fpop(); }",
                 0xF2: "{ ST(0) = rt_tan(ST(0)); fpush(1.0); }", 0xF3: "{ ST(1) = rt_atan2(ST(1), ST(0)); fpop(); }",
                 0xF4: "rt_fxtract();", 0xF5: "rt_fprem(1);", 0xF6: "F.top = (F.top - 1) & 7;",
                 0xF7: "F.top = (F.top + 1) & 7;", 0xF8: "rt_fprem(0);",
                 0xF9: "{ ST(1) = ST(1) * rt_log2(ST(0) + 1.0); fpop(); }", 0xFA: "ST(0) = PR(__builtin_sqrt(ST(0)));",
                 0xFB: "{ double v = ST(0); ST(0) = rt_sin(v); fpush(rt_cos(v)); }", 0xFC: "ST(0) = rt_frnd(ST(0));",
                 0xFD: "ST(0) = rt_ldexp(ST(0), (int)rt_trunc(ST(1)));", 0xFE: "ST(0) = rt_sin(ST(0));",
                 0xFF: "ST(0) = rt_cos(ST(0));"}
            if modrm in m:
                return m[modrm]
            raise Unsupported("x87 d9 %02x" % modrm)
        if op == 0xDA:
            if modrm == 0xE9:
                return "{ rt_fcom(ST(0), ST(1)); fpop(); fpop(); }"
            raise Unsupported("fcmov")
        if op == 0xDB:
            if modrm == 0xE2:
                return "F.sw &= 0x7F00u;"
            if modrm == 0xE3:
                return "{ F.cw = 0x37F; F.sw = 0; F.top = 0; for (int q = 0; q < 8; q++) F.tag[q] = 3; }"
            raise Unsupported("fcomi")
        if op == 0xDD:
            if k == 0:
                return "F.tag[(F.top + %d) & 7] = 3;" % r
            if k in (2, 3):
                return "{ %s = ST(0);%s }" % (si, " fpop();" if k == 3 else "")
            if k in (4, 5):
                return "{ rt_fcom(ST(0), %s);%s }" % (si, " fpop();" if k == 5 else "")
            raise Unsupported("x87 dd")
        if op == 0xDF:
            if modrm == 0xE0:
                return "eax = (eax & 0xFFFF0000u) | fstsw();"
            raise Unsupported("fcomip")
        raise Unsupported("x87 %02x %02x" % (op, modrm))

    # ------------------------------------------------------------- control flow
    def control(self, fn, i):
        """returns C for branches/calls/rets or None"""
        a, nxt = i.address, i.address + i.size
        mn = i.mnemonic
        ops = i.operands
        if mn == "ret":
            n = ops[0].imm & 0xFFFF if ops else 0
            return "{ u32 t = rd32(esp); esp += %d; SYNC_OUT R.retaddr = t; return; }" % (4 + n)
        if mn in cfg.JCC:
            t = ops[0].imm & 0xFFFFFFFF
            g = self.goto_or_tail(fn, t)
            if mn == "jecxz":
                return "if (ecx == 0) %s" % g
            if mn == "loop":
                return "if (--ecx) %s" % g
            if mn == "loope":
                return "if (--ecx && zf) %s" % g
            if mn == "loopne":
                return "if (--ecx && !zf) %s" % g
            return "if (%s) %s" % (CC[mn[1:]], g)
        if mn == "jmp":
            op = ops[0]
            if op.type == X.X86_OP_IMM:
                return self.goto_or_tail(fn, op.imm & 0xFFFFFFFF)
            t = self.rd(i, op, 32)
            cases = "".join("case %s: %s " % (h(x), self.goto_or_tail(fn, x)) for x in fn.tables.get(a, ()))
            return "{ u32 t = %s; switch (t) { %sdefault: SYNC_OUT disp(t); return; } }" % (t, cases)
        if mn == "call":
            op = ops[0]
            if op.type == X.X86_OP_IMM:
                return self.call_direct(op.imm & 0xFFFFFFFF, nxt)
            t = self.rd(i, op, 32)
            return "{ u32 t = %s; esp -= 4; wr32(esp, %s); SYNC_OUT disp(t); SYNC_IN CALLCHK(%s); }" % (t, h(nxt), h(nxt))
        if mn in cfg.STOP:
            return "TRAP(T_INT, %s);" % h(a)
        return None

    # ------------------------------------------------------------- function
    def function(self, fn, stats):
        addrs = sorted(fn.insns)
        labels = set(fn.labels)
        falls = {}
        for k, a in enumerate(addrs):
            i = fn.insns[a]
            if i is None:
                continue
            mn = i.mnemonic.split(" ")[-1]
            term = mn in ("ret", "jmp") or mn in cfg.STOP
            if not term:
                n = a + i.size
                falls[a] = n
                if k + 1 >= len(addrs) or addrs[k + 1] != n:
                    labels.add(n)
        out = ["void F_%08x(void) {" % fn.entry]
        if fn.entry in self.hle:
            out += ["#ifdef RT_FLAT", "VIS[%d] = 1; rt_hle(%s); return;" % (self.ordinal[fn.entry], h(fn.entry)), "#endif"]
        if fn.entry in self.probes:
            out += ["#ifdef RT_FLAT", "rt_probe(%s);" % h(fn.entry), "#endif"]
        out += ["LOCALS", "VIS[%d] = 1;" % self.ordinal[fn.entry]]
        if addrs[0] != fn.entry:
            out.append("goto L_%08x;" % fn.entry)
        block_start = True
        for k, a in enumerate(addrs):
            i = fn.insns[a]
            if a in labels:
                out.append("L_%08x:" % a)
                block_start = True
            if block_start:
                # instructions until the next label / terminator
                n, j = 0, k
                while j < len(addrs):
                    ii = fn.insns[addrs[j]]
                    if j > k and addrs[j] in labels:
                        break
                    n += 1
                    if ii is None or ii.mnemonic.split(" ")[-1] in ("ret", "jmp") or ii.mnemonic.split(" ")[-1] in cfg.STOP \
                            or ii.mnemonic.split(" ")[-1] in cfg.JCC:
                        break
                    j += 1
                out.append("IC(%d);" % n)
                block_start = False
            stats["insns"] += 1
            if i is None:
                out.append("TRAP(T_BAD, %s);" % h(a))
                stats["bad"] += 1
                continue
            try:
                c = self.control(fn, i)
                if c is None:
                    c = " ".join(self.insn(fn, i))
                stats["ok"] += 1
            except Unsupported as e:
                key = str(e)
                self.unsup[key] += 1
                self.unsup_addr.setdefault(key, a)
                stats["unsup"] += 1
                stats["unsup_funcs"].add(fn.entry)
                c = "TRAP(T_UNSUP, %s); /* %s %s */" % (h(a), i.mnemonic, i.op_str.replace("*/", ""))
            mn = i.mnemonic.split(" ")[-1]
            out.append(c + ("  /* %08x %s */" % (a, i.mnemonic) if False else ""))
            if mn in cfg.JCC:
                block_start = True
            if a in falls and (k + 1 >= len(addrs) or addrs[k + 1] != falls[a]):
                out.append("goto L_%08x;" % falls[a])
        out.append("}")
        return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(cfg.HERE, "out"))
    ap.add_argument("--chunk", type=int, default=120)
    opt = ap.parse_args()
    t0 = time.time()
    im = cfg.Image()
    funcs, abi, strong = cfg.discover(im)
    print("%d functions discovered (%.1fs)" % (len(funcs), time.time() - t0), flush=True)
    em = Emitter(im, funcs, strong)
    em.ordinal = {e: k for k, e in enumerate(sorted(funcs))}
    # functions replaced by host implementations in the flat game build only (recomp/hle.txt: "addr name" per line)
    # recomp/probes.txt: functions whose entry calls the host (rt_probe: logging/milestones, no effect on guest state)
    em.hle, em.probes = set(), set()
    for name, dst in (("hle.txt", em.hle), ("probes.txt", em.probes)):
        hp = os.path.join(cfg.HERE, name)
        if os.path.exists(hp):
            for l in open(hp):
                l = l.split("#")[0].split()
                if l:
                    dst.add(int(l[0], 16))
    units = cfg.load_units()
    cdir = os.path.join(opt.out, "c")
    os.makedirs(cdir, exist_ok=True)
    def put(path, text):
        """write only when changed (keeps build.py's object cache valid)"""
        if os.path.exists(path) and open(path).read() == text:
            return
        with open(path, "w") as f:
            f.write(text)
    put(os.path.join(cdir, "funcs.h"), '#include "rt.h"\nextern u8 VIS[];   /* function-entered bitmap (coverage) */\n' +
        "".join("void F_%08x(void);\n" % e for e in sorted(funcs)))
    order = sorted(funcs)
    perfunc = []
    stats_all = collections.Counter()
    for c0 in range(0, len(order), opt.chunk):
        part = order[c0:c0 + opt.chunk]
        text = ['#include "funcs.h"\n']
        for e in part:
            st = {"insns": 0, "ok": 0, "unsup": 0, "bad": 0, "unsup_funcs": set()}
            text.append(em.function(funcs[e], st) + "\n\n")
            kind = abi[e][1] if e in abi else "units.tsv-only" if e in units else "call/pointer-target"
            perfunc.append((e, kind, st["insns"], st["ok"], st["unsup"], st["bad"]))
            for k in ("insns", "ok", "unsup", "bad"):
                stats_all[k] += st[k]
        put(os.path.join(cdir, "chunk_%03d.c" % (c0 // opt.chunk)), "".join(text))
    # dispatcher: binary search over the sorted entry addresses + call through a function-pointer table
    # (a 20k-case switch made a 680 KB wasm function that TurboFan cannot compile)
    d = ['#include "funcs.h"\nu8 VIS[%d];\n' % len(order),
         '__attribute__((export_name("rt_vis"))) u32 rt_vis(void) { return (u32)(uintptr_t)VIS; }\n',
         '__attribute__((export_name("rt_nfunc"))) u32 rt_nfunc(void) { return %d; }\n' % len(order),
         "static const u32 ADDR[%d] = {\n" % len(order)]
    d += ["0x%Xu,%s" % (e, "\n" if k % 8 == 7 else " ") for k, e in enumerate(order)]
    d.append("};\nstatic void (*const FN[%d])(void) = {\n" % len(order))
    d += ["F_%08x,%s" % (e, "\n" if k % 8 == 7 else " ") for k, e in enumerate(order)]
    d.append("};\nvoid disp(u32 t) {\n  u32 lo = 0, hi = %d;\n  while (lo < hi) { u32 m = (lo + hi) >> 1; if (ADDR[m] < t) lo = m + 1; else hi = m; }\n"
             "  if (lo < %d && ADDR[lo] == t) { FN[lo](); return; }\n  rt_ext(t);\n}\n" % (len(order), len(order)))
    put(os.path.join(cdir, "dispatch.c"), "".join(d))
    with open(os.path.join(opt.out, "funcs.txt"), "w") as f:
        f.write("".join("%08x\n" % e for e in order))
    with open(os.path.join(opt.out, "coverage.tsv"), "w") as f:
        f.write("addr\tkind\tinsns\ttranslated\tunsupported\tundecodable\n")
        for r in perfunc:
            f.write("%08x\t%s\t%d\t%d\t%d\t%d\n" % r)
    byk = collections.defaultdict(lambda: [0, 0, 0, 0])
    for e, k, n, ok, un, bad in perfunc:
        s = byk[k]
        s[0] += 1; s[1] += (un == 0 and bad == 0); s[2] += n; s[3] += ok
    summary = {"functions": len(funcs), "by_kind": {k: {"functions": v[0], "fully_translated": v[1], "insns": v[2],
                                                        "insns_translated": v[3]} for k, v in byk.items()},
               "insns": stats_all["insns"], "translated": stats_all["ok"], "unsupported": stats_all["unsup"],
               "undecodable": stats_all["bad"],
               "unsupported_by_reason": [(k, v, "%08x" % em.unsup_addr[k]) for k, v in em.unsup.most_common()]}
    json.dump(summary, open(os.path.join(opt.out, "coverage.json"), "w"), indent=1)
    print(json.dumps({k: summary[k] for k in ("functions", "insns", "translated", "unsupported", "undecodable")}))
    for k, v in summary["by_kind"].items():
        print(" ", k, v)
    print("top unsupported:", summary["unsupported_by_reason"][:25])
    print("%.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
