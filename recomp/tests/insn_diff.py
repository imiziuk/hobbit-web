"""Instruction-level differential test: every (mnemonic, operand shape) used by the translated code, run in Unicorn
and in the recompiled wasm on random inputs, compared with the capsule harness (--all-regs).

For each sample instruction I (real bytes from Meridian.exe) a test function is synthesized at 0x10000000 + 64k:
    push imm32 FLAGS_IN ; popfd ; I ; pushfd ; and dword [esp], MASK ; pop dword [FLAGOUT] ; ret
MASK removes the flags Intel documents as undefined for I (and TF/IF/...), so EFLAGS are compared exactly where
defined. Unicorn runs it first with lazily mapped, pseudo-random memory; the pages it touched (initial content) and
the bytes it changed become a capsule in the replay format (caps.bin + pages.bin). The same test functions are
translated by x86c.Emitter into tests.wasm, and harness/replay_wasm.mjs replays the capsules (all 8 GPRs, memory,
masked flags). Instructions that fault in Unicorn (#DE, ...) are skipped.

usage: tools/.venv/Scripts/python recomp/tests/insn_diff.py [--samples 4] [--inputs 8] [--seed 1]
then:  node recomp/harness/replay_wasm.mjs recomp/out/insn --wasm recomp/out/insn/tests.wasm --all-regs
       --out recomp/out/insn/results.tsv --caps-out recomp/out/insn/caps.tsv
"""
import argparse, collections, os, random, struct, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import cfg, x86c
from capstone import x86_const as X
from unicorn import Uc, UcError, UC_ARCH_X86, UC_MODE_32, UC_HOOK_MEM_UNMAPPED, UC_HOOK_MEM_WRITE
from unicorn.x86_const import *

OUT = os.path.join(os.path.dirname(HERE), "out", "insn")
CODE = 0x10000000
STACK = 0x0FF00000
FLAGOUT = 0x0FE00000
FLAGIN = FLAGOUT + 16
SENT = 0xBADC0000
TEB = 0x7FFDE000

SKIP = {"push", "pop", "pushal", "popal", "pushfd", "popfd", "leave", "enter", "ret", "call", "jmp", "int3", "int",
        "hlt", "nop", "wait", "fwait", "cpuid", "rdtsc", "cld", "std", "lahf", "sahf"} | x86c.cfg.JCC
F_ALL = 0x8D5 | 0x400                    # CF PF AF ZF SF OF + DF


def flag_mask(mn, i):
    m = F_ALL
    base = mn.split(" ")[-1]
    if base in ("and", "or", "xor", "test"):
        m &= ~0x10
    elif base in ("shl", "sal", "shr", "sar", "rol", "ror", "rcl", "rcr", "shld", "shrd"):
        m &= ~0x10 & ~0x800                      # AF undefined; OF undefined unless count == 1 (masked always)
        if base in ("rol", "ror", "rcl", "rcr"):
            pass
    elif base in ("mul", "imul"):
        m &= ~(0x80 | 0x40 | 0x10 | 0x4)
    elif base in ("div", "idiv"):
        m = 0x400
    elif base in ("bsf", "bsr"):
        m = 0x40 | 0x400
    elif base in ("bt", "bts", "btr", "btc"):
        m = 0x1 | 0x40 | 0x400
    return m


def shape(i):
    parts = [i.mnemonic]
    for op in i.operands:
        if op.type == X.X86_OP_REG:
            n = i.reg_name(op.reg)
            parts.append("r%d%s" % (op.size * 8, "h" if n in ("ah", "bh", "ch", "dh") else ""))
        elif op.type == X.X86_OP_IMM:
            parts.append("i%d" % (op.size * 8))
        else:
            parts.append("m%d%s" % (op.size * 8, "i" if op.mem.index else ""))
    return " ".join(parts)


def usable(i):
    mn = i.mnemonic.split(" ")[-1]
    if mn in SKIP or 0xD8 <= i.opcode[0] <= 0xDF or mn in x86c.VEC:
        return False
    for op in i.operands:
        if op.type == X.X86_OP_REG and i.reg_name(op.reg) in ("esp", "sp", "ebp") or \
                op.type == X.X86_OP_REG and i.reg_name(op.reg) in ("cs", "ds", "es", "fs", "gs", "ss"):
            return False
        if op.type == X.X86_OP_MEM:
            if op.mem.segment:
                return False
            if op.mem.base and i.reg_name(op.mem.base) in ("esp", "ebp"):
                return False
            if op.mem.index and i.reg_name(op.mem.index) in ("esp", "ebp"):
                return False
    if mn in ("movs", "stos", "lods", "scas", "cmps") or mn[:4] in ("movs", "stos", "lods", "scas", "cmps") and len(mn) == 5:
        return True
    return True


def page_content(rng):
    return bytes(rng.getrandbits(8) for _ in range(4096))


def run_unicorn(code_bytes, func, regs, flags_in, rng):
    uc = Uc(UC_ARCH_X86, UC_MODE_32)
    touched = {}

    def mp(p, data):
        uc.mem_map(p, 0x1000)
        uc.mem_write(p, data)
        touched[p] = data

    uc.mem_map(CODE, 0x100000)
    uc.mem_write(CODE, code_bytes)
    uc.mem_map(SENT, 0x1000)
    stack = bytearray(page_content(rng))
    esp = STACK + 0xF00
    stack[0xF00:0xF04] = struct.pack("<I", SENT)
    mp(STACK, bytes(stack))
    fp = bytearray(4096)
    fp[16:20] = struct.pack("<I", flags_in)
    mp(FLAGOUT, bytes(fp))

    def on_unmapped(uc_, access, addr, size, value, user):
        for p in range(addr & ~0xFFF, addr + max(size, 1), 0x1000):
            p &= 0xFFFFFFFF
            if p in touched or CODE <= p < CODE + 0x100000 or p == SENT:
                continue
            if p >= 0xB0000000 or p < 0x10000:
                return False
            mp(p, page_content(rng))
        return True
    uc.hook_add(UC_HOOK_MEM_UNMAPPED, on_unmapped)
    for r, v in zip((UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_ESI, UC_X86_REG_EDI,
                     UC_X86_REG_EBP), regs):
        uc.reg_write(r, v)
    uc.reg_write(UC_X86_REG_ESP, esp)
    uc.reg_write(UC_X86_REG_EFLAGS, 0x202)
    try:
        uc.emu_start(func, SENT, count=100000)
    except UcError:
        return None
    if uc.reg_read(UC_X86_REG_EIP) != SENT:
        return None
    out = [uc.reg_read(r) for r in (UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_ESI,
                                    UC_X86_REG_EDI, UC_X86_REG_EBP, UC_X86_REG_ESP, UC_X86_REG_EFLAGS)]
    written = {}
    for p, data in touched.items():
        now = bytes(uc.mem_read(p, 0x1000))
        for k in range(4096):
            if now[k] != data[k]:
                written[p + k] = now[k]
    return out, touched, written, esp


def capsule(func, regs, esp, pages_hashes, written, out):
    body = struct.pack("<7I", func, 0, 2, 0, TEB, 0, 0)
    body += struct.pack("<10I", regs[0], regs[1], regs[2], regs[3], regs[4], regs[5], regs[6], esp, func, 0x202)
    body += struct.pack("<H", 0x27F) + bytes(110)
    body += struct.pack("<9I", *out)
    body += struct.pack("<HH", 0, 0x27F) + bytes(10)
    body += struct.pack("<I", len(pages_hashes))
    for a, hh in pages_hashes:
        body += struct.pack("<IQ", a, hh)
    body += struct.pack("<I", len(written))
    for a in sorted(written):
        body += struct.pack("<IB", a, written[a])
    return struct.pack("<III", 0x53504143, 1, len(body)) + body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=4, help="instruction instances per shape")
    ap.add_argument("--inputs", type=int, default=8, help="random input states per instance")
    ap.add_argument("--seed", type=int, default=1)
    opt = ap.parse_args()
    rng = random.Random(opt.seed)
    im = cfg.Image()
    funcs, abi, strong = cfg.discover(im)
    # real instruction instances, grouped by shape (only from abi/units functions: no garbage decodes)
    groups = collections.defaultdict(dict)
    for e in sorted(strong):
        fn = funcs.get(e)
        if not fn:
            continue
        for a, i in fn.insns.items():
            if i is None or not usable(i):
                continue
            g = groups[shape(i)]
            if len(g) < opt.samples and bytes(i.bytes) not in g:
                g[bytes(i.bytes)] = a
    print("%d instruction shapes" % len(groups))
    # synthesize test functions (flags come from memory so one function serves every input)
    code = bytearray()
    tests = []                              # (func addr, insn bytes, shape, source addr)
    for sh in sorted(groups):
        for ib, src in groups[sh].items():
            i = im.insn(src)
            m = flag_mask(i.mnemonic, i)
            f = CODE + len(code)
            seq = (b"\xFF\x35" + struct.pack("<I", FLAGIN) + b"\x9D" + ib + b"\x9C\x81\x24\x24" + struct.pack("<I", m) +
                   b"\x8F\x05" + struct.pack("<I", FLAGOUT) + b"\xC3")
            assert len(seq) <= 64
            code += seq.ljust(64, b"\xCC")
            tests.append((f, ib, sh, src))
    print("%d test functions" % len(tests))
    os.makedirs(os.path.join(OUT, "c"), exist_ok=True)
    caps, pages = bytearray(), bytearray()
    hcount = 0
    n = collections.Counter()
    shapes_tested = set()
    for f, ib, sh, src in tests:
        for k in range(opt.inputs):
            regs = [rng.getrandbits(32) if rng.random() < 0.6 else
                    rng.choice((0, 1, 2, 0x1F, 0x20, 0xFFFFFFFF, 0x80000000, 0x7FFFFFFF, rng.getrandbits(8)))
                    for _ in range(7)]
            if any(x in sh for x in ("movs", "stos", "lods", "scas", "cmps")):
                regs[2] = rng.randrange(0, 24)
            if sh.startswith(("div", "idiv")) and rng.random() < 0.8:
                regs[3] = 0 if rng.random() < 0.5 else 0xFFFFFFFF
            flags_in = 0x202 | (rng.getrandbits(12) & 0x8D5) | (0x400 if rng.random() < 0.2 else 0)
            r = run_unicorn(bytes(code), f, regs, flags_in, rng)
            if r is None:
                n["skipped: fault in Unicorn"] += 1
                continue
            out, touched, written, esp = r
            ph = []
            for p, data in sorted(touched.items()):
                hcount += 1
                pages += struct.pack("<Q", hcount) + data
                ph.append((p, hcount))
            caps += capsule(f, regs, esp, ph, written, out)
            n["capsules"] += 1
            shapes_tested.add(sh)
    open(os.path.join(OUT, "caps.bin"), "wb").write(caps)
    open(os.path.join(OUT, "pages.bin"), "wb").write(pages)
    with open(os.path.join(OUT, "tests.tsv"), "w") as fo:
        fo.write("func\tshape\tbytes\tsource\n")
        for f, ib, sh, src in tests:
            fo.write("%08x\t%s\t%s\t%08x\n" % (f, sh, ib.hex(), src))
    print(dict(n), "%d shapes with at least one capsule" % len(shapes_tested))

    # translate the test functions with the same emitter
    class TestImage(cfg.Image):
        def is_code(self, a):
            return CODE <= a < CODE + len(code) or super().is_code(a)

        def insn(self, a):
            if CODE <= a < CODE + len(code):
                o = a - CODE
                for i in self.md.disasm(bytes(code[o:o + 16]), a, 1):
                    return i
                return None
            return super().insn(a)
    tim = TestImage()
    entries = [t[0] for t in tests]
    tf = {e: cfg.build_func(tim, e, set(entries), {}) for e in entries}
    em = x86c.Emitter(tim, tf, set(entries))
    em.ordinal = {e: k for k, e in enumerate(entries)}
    src = ['#include "rt.h"\nu8 VIS[%d];\n' % len(entries)]
    src += ["void F_%08x(void);\n" % e for e in entries]
    st = {"insns": 0, "ok": 0, "unsup": 0, "bad": 0, "unsup_funcs": set()}
    for e in entries:
        src.append(em.function(tf[e], st) + "\n")
    src.append("static const u32 ADDR[%d] = {%s};\n" % (len(entries), ",".join("0x%Xu" % e for e in entries)))
    src.append("static void (*const FN[%d])(void) = {%s};\n" % (len(entries), ",".join("F_%08x" % e for e in entries)))
    src.append('__attribute__((export_name("rt_vis"))) u32 rt_vis(void) { return (u32)(uintptr_t)VIS; }\n'
               '__attribute__((export_name("rt_nfunc"))) u32 rt_nfunc(void) { return %d; }\n'
               "void disp(u32 t) { for (u32 k = 0; k < %d; k++) if (ADDR[k] == t) { FN[k](); return; } "
               "R.last_ip = t; rt_trap(T_EXT, t, 0); }\n" % (len(entries), len(entries)))
    cpath = os.path.join(OUT, "c", "tests.c")
    open(cpath, "w").write("".join(src))
    print("translated:", {k: st[k] for k in ("insns", "ok", "unsup", "bad")}, dict(em.unsup))
    sdk = r"C:\tools\wasi-sdk-34.0-x86_64-windows\bin\clang.exe"
    rt = os.path.join(os.path.dirname(HERE), "runtime")
    r = subprocess.run([sdk, "--target=wasm32-wasip1", "-O2", "-w", "-I", rt, "-nostartfiles", "-Wl,--no-entry",
                        "-Wl,--export=__stack_pointer", "-Wl,-z,stack-size=8388608", "-Wl,--initial-memory=134217728",
                        cpath, os.path.join(rt, "rt.c"), "-lm", "-o", os.path.join(OUT, "tests.wasm")],
                       capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-3000:])
        sys.exit(1)
    # the harness reads funcs.txt next to the wasm for the coverage summary
    open(os.path.join(OUT, "funcs.txt"), "w").write("".join("%08x\n" % e for e in entries))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
