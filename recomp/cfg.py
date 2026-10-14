"""Image loading, function discovery and per-function CFG (recursive traversal) for the x86 -> C recompiler.

Mechanical: functions are code regions reachable from an entry by intra-procedural edges (fallthrough, jcc, jmp,
switch tables). A direct jmp/jcc to another strong entry (auto/abi.tsv start) is a tail call. Code shared between
functions (jumps into the middle of another function) is simply duplicated into each function that reaches it.
"""
import os, collections, struct
import pefile
import capstone
from capstone import x86_const as X

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.environ.get("HOBBIT_EXE") or os.path.join(ROOT, "..", "The.Hobbit.-.Clean", "The Hobbit - Reference", "Meridian.exe")


class Image:
    def __init__(self, path=EXE):
        pe = pefile.PE(path, fast_load=True)
        self.base = pe.OPTIONAL_HEADER.ImageBase
        self.img = bytes(pe.get_memory_mapped_image())
        self.exec_ranges = [(self.base + s.VirtualAddress, self.base + s.VirtualAddress + s.Misc_VirtualSize)
                            for s in pe.sections if s.Characteristics & 0x20000000]
        self.md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
        self.md.detail = True
        self._cache = {}

    def is_code(self, a):
        return any(lo <= a < hi for lo, hi in self.exec_ranges)

    def in_image(self, a):
        return self.base <= a < self.base + len(self.img)

    def u32(self, a):
        o = a - self.base
        return struct.unpack_from("<I", self.img, o)[0]

    def insn(self, a):
        """capstone instruction at a, or None (undecodable / outside code)"""
        if a in self._cache:
            return self._cache[a]
        r = None
        if self.is_code(a):
            o = a - self.base
            for i in self.md.disasm(self.img[o:o + 16], a, 1):
                r = i
        self._cache[a] = r
        return r


def load_abi():
    out = {}
    with open(os.path.join(ROOT, "auto", "abi.tsv"), encoding="utf-8") as f:
        hdr = f.readline().rstrip("\n").split("\t")
        ki = hdr.index("kind")
        for l in f:
            p = l.rstrip("\n").split("\t")
            out[int(p[0], 16)] = (p[1], p[ki])
    return out


def load_units():
    """function starts of the C-decompilation track (auto/units.tsv, Ghidra project of Oct 8): some are not in abi.tsv"""
    out = set()
    p = os.path.join(ROOT, "auto", "units.tsv")
    if os.path.exists(p):
        for l in open(p, encoding="utf-8"):
            x = l.split("	")[0]
            try:
                out.add(int(x, 16))
            except ValueError:
                pass
    return out


def load_computed_jumps():
    """jmp instruction address -> set of targets (Ghidra computed-jump refs = switch tables)"""
    out = collections.defaultdict(set)
    with open(os.path.join(ROOT, "auto", "xrefs.tsv"), encoding="utf-8") as f:
        f.readline()
        for l in f:
            p = l.split("\t")
            if p[4] == "computed-jump":
                out[int(p[1], 16)].add(int(p[2], 16))
    return out


def load_pointer_targets(im):
    """code addresses referenced as data (vtables, EH, CRT init tables, pointer constants) -> weak entries"""
    out = set()
    with open(os.path.join(ROOT, "auto", "xrefs.tsv"), encoding="utf-8") as f:
        f.readline()
        for l in f:
            p = l.split("\t")
            if p[4] in ("vtable-entry", "eh-entry", "crt-table-entry", "data-pointer", "pointer-const"):
                t = int(p[2], 16)
                if im.is_code(t):
                    out.add(t)
    return out


JCC = {"jo", "jno", "jb", "jae", "je", "jne", "jbe", "ja", "js", "jns", "jp", "jnp", "jl", "jge", "jle", "jg",
       "jecxz", "loop", "loope", "loopne"}
STOP = {"int3", "hlt", "ud2", "int", "into", "iretd", "retf"}


def imm_target(i):
    op = i.operands[0]
    return op.imm & 0xFFFFFFFF if op.type == X.X86_OP_IMM else None


def table_targets(im, i, cj):
    """switch targets for an indirect jmp: Ghidra refs, else read the table at disp (jmp [disp+r*4])"""
    t = set(cj.get(i.address, ()))
    if not t and i.operands and i.operands[0].type == X.X86_OP_MEM:
        m = i.operands[0].mem
        if m.base == 0 and m.index != 0 and m.scale == 4 and im.is_code(m.disp & 0xFFFFFFFF):
            a = m.disp & 0xFFFFFFFF
            for k in range(512):
                v = im.u32(a + 4 * k)
                if not im.is_code(v):
                    break
                t.add(v)
    return t


class Func:
    __slots__ = ("entry", "insns", "labels", "tails", "calls", "bad", "tables")

    def __init__(self, entry):
        self.entry = entry
        self.insns = {}          # addr -> capstone insn (None = undecodable)
        self.labels = {entry}    # goto targets
        self.tails = set()       # direct tail-call targets
        self.calls = set()       # direct call targets
        self.bad = set()
        self.tables = {}         # jmp addr -> sorted targets (local)


def build_func(im, entry, strong, cj):
    fn = Func(entry)
    work = [entry]
    while work:
        a = work.pop()
        while a not in fn.insns:
            i = im.insn(a)
            fn.insns[a] = i
            if i is None:
                fn.bad.add(a)
                break
            m = i.mnemonic
            if m.startswith(("rep ", "repe ", "repne ", "lock ")):
                m = m.split(" ", 1)[1]
            nxt = a + i.size
            if m == "ret":
                break
            if m in STOP:
                break
            if m == "jmp":
                t = imm_target(i)
                if t is None:
                    tg = sorted(table_targets(im, i, cj))
                    fn.tables[a] = tg
                    for x in tg:
                        if x in strong and x != entry:
                            fn.tails.add(x)
                        else:
                            fn.labels.add(x)
                            work.append(x)
                    break
                if t in strong and t != entry:
                    fn.tails.add(t)
                else:
                    fn.labels.add(t)
                    work.append(t)
                break
            if m in JCC:
                t = imm_target(i)
                if t in strong and t != entry:
                    fn.tails.add(t)
                else:
                    fn.labels.add(t)
                    work.append(t)
                a = nxt
                continue
            if m == "call":
                t = imm_target(i)
                if t is not None:
                    fn.calls.add(t)
            a = nxt
    return fn


def discover(im):
    """all functions: abi.tsv entries + direct call targets + code pointers, to a fixpoint"""
    abi = load_abi()
    cj = load_computed_jumps()
    strong = set(abi) | load_units()
    weak = {t for t in load_pointer_targets(im)}
    funcs = {}
    work = sorted(strong | weak)
    seen = set(work)
    while work:
        e = work.pop()
        if not im.is_code(e):
            continue
        fn = build_func(im, e, strong, cj)
        funcs[e] = fn
        for t in fn.calls | fn.tails:
            if t not in seen and im.is_code(t):
                seen.add(t)
                work.append(t)
    return funcs, abi, strong
