"""Multiplayer asset overlay for the web port: virtual patched DFS archives (stdlib only).

The retail game reads its data from <name>.DFS (index) + <name>.000 (data). The Hobbit Synchrony mod
(https://github.com/hobbit-kingdom/hobbit-synchrony-v3, BSD-3) adds remote players as "fake Bilbo" NPCs that are
authored into every level by an extra layer FAKE_HOBBITS (+ BILBOFAKE.NPCGEOM), plus replacement Common\\ assets.
Its release targets an *unpacked* install (loose files). Here nothing is written anywhere: the game-data server
serves virtual archives instead:

  <name>.DFS  -> the original index with the extra entries appended (and overridden entries re-pointed)
  <name>.000  -> original bytes + zero padding to 0x800 + the appended file data (served from memory)

What is added (same as Synchrony's MultiplayerSetup / FakeHobbitsPatcher):
  every level archive: LEVELS\\<LEVEL>\\FAKE_HOBBITS.EXPORT, LEVELS\\<LEVEL>\\BILBOFAKE.NPCGEOM, and ALLUSEDLAYERS.TXT /
                       INITIALOBJECTLAYERS.TXT with "FAKE_HOBBITS" appended and the [ Layers : N ] counter bumped;
  Common\\... files:   replace the entry in every archive that already has it, else appended to common.DFS.

The Synchrony data comes from its release zip, downloaded once into a gitignored cache (fetch_release). Only data
files are extracted; the zip's .exe/.dll files are never extracted or run.

    python recomp/mp_assets.py --game <game dir> [--check]     build the overlay and print what changed
"""
import io, os, re, struct, sys, urllib.request, zipfile

RELEASE_URL = ("https://github.com/hobbit-kingdom/hobbit-synchrony-v3/releases/download/v1.0/"
               "The.Hobbit.Synchrony.-.Release.v1.0.zip")
RELEASE_SIZE = 14574293
DATA_EXT = (".export", ".npcgeom", ".info", ".xbmp", ".charanim", ".rgeom", ".txt")
FAKE_LAYER = "FAKE_HOBBITS"
ALIGN = 0x800
PROPS_ALIASES = ("BILBO_GLOSS[M].XBMP", "BILBO_SKIN_ENV[D].XBMP", "BILBO_LEATHER_ENV[D].XBMP", "BILBO_HAIR_ENV[D].XBMP")


def say(msg):
    print("[mp-assets] " + msg, flush=True)


# ------------------------------------------------------------------ release download (data only)
def fetch_release(cache_dir):
    """Download the Synchrony release zip once and extract its data files. Returns the 'THE SYNCHRONY' folder."""
    data = os.path.join(cache_dir, "data")
    marker = os.path.join(data, ".complete")
    if os.path.exists(marker):
        return os.path.join(data, "THE SYNCHRONY")
    os.makedirs(cache_dir, exist_ok=True)
    zpath = os.path.join(cache_dir, os.path.basename(RELEASE_URL))
    if not os.path.exists(zpath) or os.path.getsize(zpath) != RELEASE_SIZE:
        say(f"downloading the Synchrony v1.0 release (data files only are used, {RELEASE_SIZE / 1e6:.1f} MB, once)")
        urllib.request.urlretrieve(RELEASE_URL, zpath + ".part")
        os.replace(zpath + ".part", zpath)
    n = 0
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            name = info.filename.replace("\\", "/")
            if name.endswith("/") or "/THE SYNCHRONY/" not in name or not name.lower().endswith(DATA_EXT):
                continue
            rel = name.split("/THE SYNCHRONY/", 1)[1]
            if ".." in rel.split("/") or rel.startswith("/"):
                continue
            out = os.path.join(data, "THE SYNCHRONY", *rel.split("/"))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(info) as src, open(out, "wb") as dst:
                dst.write(src.read())
            n += 1
    open(marker, "w").write("ok\n")
    say(f"extracted {n} data files into {data}")
    return os.path.join(data, "THE SYNCHRONY")


# ------------------------------------------------------------------ DFS index
class Index:
    def __init__(self, raw):
        magic, ver, align, flags, n, nparts, nsize, poff, foff, noff = struct.unpack_from("<4s9I", raw, 0)
        assert magic == b"SFDX" and ver == 1
        self.head = (ver, align, flags)
        self.parts = list(struct.unpack_from(f"<{nparts}I", raw, poff))
        self.names = bytearray(raw[noff:noff + nsize])
        self.entries = [list(struct.unpack_from("<6I", raw, foff + 24 * i)) for i in range(n)]   # n1 n2 dir ext off size

    def s(self, o):
        return self.names[o:self.names.index(b"\0", o)].decode("latin-1")

    def path(self, e):
        return self.s(e[2]) + self.s(e[0]) + self.s(e[1]) + self.s(e[3])

    def intern(self, text):
        b = text.encode("latin-1") + b"\0"
        if self.names.startswith(b):
            return 0
        i = self.names.find(b"\0" + b)
        if i >= 0:
            return i + 1
        o = len(self.names)
        self.names += b
        return o

    def add(self, path, off, size):
        d, f = path.rsplit("\\", 1)
        stem, ext = (f.rsplit(".", 1) + [""])[:2]
        ext = "." + ext if ext else ""
        self.entries.append([self.intern(stem), self.intern(""), self.intern(d + "\\"), self.intern(ext), off, size])

    def build(self):
        n, np_ = len(self.entries), len(self.parts)
        poff = 40
        foff = poff + 4 * np_
        noff = foff + 24 * n
        out = bytearray(struct.pack("<4s9I", b"SFDX", self.head[0], self.head[1], self.head[2], n, np_, len(self.names), poff, foff, noff))
        out += struct.pack(f"<{np_}I", *self.parts)
        for e in self.entries:
            out += struct.pack("<6I", *e)
        out += self.names
        return bytes(out)


def patch_layer_list(text):
    """Append FAKE_HOBBITS after the last layer entry and bump [ Layers : N ] (idempotent, keeps CRLF and columns)."""
    if re.search(r'^\s*"' + FAKE_LAYER + r'"', text, re.M | re.I):
        return text
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(nl)
    last = max(i for i, l in enumerate(lines) if re.match(r'^\s*"[^"]*"\s*$', l))
    m = re.match(r'^(\s*)("[^"]*")(\s*)$', lines[last])
    width = len(m.group(2)) + len(m.group(3))
    lines.insert(last + 1, m.group(1) + ('"%s"' % FAKE_LAYER).ljust(width))
    out = nl.join(lines)
    return re.sub(r"\[\s*Layers\s*:\s*(\d+)\s*\]", lambda mm: mm.group(0).replace(mm.group(1), str(int(mm.group(1)) + 1)), out, count=1)


# ------------------------------------------------------------------ virtual files
class VirtualData:
    """<name>.000 = original file bytes, zero padding to `base`, then `extra`."""

    def __init__(self, real, base, extra):
        self.real, self.real_size, self.base, self.extra = real, os.path.getsize(real), base, bytes(extra)
        self.size = base + len(self.extra)

    def read(self, lo, n):
        out = bytearray()
        if lo < self.real_size:
            with open(self.real, "rb") as f:
                f.seek(lo)
                out += f.read(min(n, self.real_size - lo))
        p = lo + len(out)
        while len(out) < n and p < self.base:
            k = min(n - len(out), self.base - p)
            out += b"\0" * k
            p += k
        if len(out) < n and p >= self.base:
            out += self.extra[p - self.base:p - self.base + n - len(out)]
        return bytes(out)


class VirtualBytes:
    def __init__(self, data):
        self.data, self.size = bytes(data), len(data)

    def read(self, lo, n):
        return self.data[lo:lo + n]


def build_overlay(game, syn):
    """Returns {relative path (game-folder spelling): VirtualData | VirtualBytes} for every archive that changes."""
    common_files = {}
    for d, _, fs in os.walk(os.path.join(syn, "Common")):
        for f in fs:
            rel = os.path.relpath(os.path.join(d, f), syn).replace("/", "\\").upper()
            common_files[rel] = open(os.path.join(d, f), "rb").read()
    fake_export = open(os.path.join(syn, "FAKE_HOBBITS.EXPORT"), "rb").read()
    fake_geom = open(os.path.join(syn, "BILBOFAKE.NPCGEOM"), "rb").read()
    names = os.listdir(game)
    overlay, report, placed = {}, [], set()
    archives = sorted(n for n in names if n.lower().endswith(".dfs") and not n.lower().startswith("audio"))
    common_name = next(n for n in archives if n.lower() == "common.dfs")
    for pass_ in (0, 1):                 # pass 0: everything but common.DFS; pass 1: common.DFS (gets the leftovers)
        for dfs in archives:
            if (dfs == common_name) != (pass_ == 1):
                continue
            base = dfs[:-4]
            data_name = next((n for n in names if n.lower() == (base + ".000").lower()), None)
            if not data_name:
                continue
            idx = Index(open(os.path.join(game, dfs), "rb").read())
            if len(idx.parts) != 1:
                continue
            real = os.path.join(game, data_name)
            start = (os.path.getsize(real) + ALIGN - 1) // ALIGN * ALIGN
            extra = bytearray()

            def put(blob):
                off = start + len(extra)
                extra.extend(blob)
                extra.extend(b"\0" * ((-len(blob)) % ALIGN))
                return off

            by_path = {idx.path(e).upper(): e for e in idx.entries}
            changes = []
            # level layer: FAKE_HOBBITS + its NPC geometry + patched layer lists
            levels = sorted({p.split("\\")[1] for p in by_path if p.startswith("LEVELS\\") and p.endswith("\\ALLUSEDLAYERS.TXT")})
            for lv in levels:
                for lst in ("ALLUSEDLAYERS.TXT", "INITIALOBJECTLAYERS.TXT"):
                    e = by_path.get(f"LEVELS\\{lv}\\{lst}")
                    if not e:
                        continue
                    with open(real, "rb") as f:
                        f.seek(e[4])
                        old = f.read(e[5]).decode("latin-1")
                    new = patch_layer_list(old).encode("latin-1")
                    e[4], e[5] = put(new), len(new)
                    changes.append(lst)
                for fname, blob in (("FAKE_HOBBITS.EXPORT", fake_export), ("BILBOFAKE.NPCGEOM", fake_geom)):
                    p = f"LEVELS\\{lv}\\{fname}"
                    if p in by_path:
                        e = by_path[p]
                        e[4], e[5] = put(blob), len(blob)
                    else:
                        idx.add(p, put(blob), len(blob))
                    changes.append(fname)
            # Common overrides (and, in common.DFS, every Common file that no archive had)
            for p, blob in sorted(common_files.items()):
                if p in by_path:
                    e = by_path[p]
                    e[4], e[5] = put(blob), len(blob)
                    placed.add(p)
                    changes.append(p.split("\\")[-1] + "*")
                elif pass_ == 1 and p not in placed:
                    idx.add(p, put(blob), len(blob))
                    changes.append(p.split("\\")[-1] + "+")
            # BILBOFAKE.NPCGEOM's materials name props/bilbo_*.xbmp textures that the retail archives only have under
            # COMMON\BILBO\ (rsc_mgr "File not found" in the browser log): add copies under COMMON\PROPS\.
            if pass_ == 1:
                for tex in PROPS_ALIASES:
                    src, dst = by_path.get("COMMON\\BILBO\\" + tex), "COMMON\\PROPS\\" + tex
                    if src and dst not in by_path:
                        with open(real, "rb") as f:
                            f.seek(src[4])
                            blob = f.read(src[5])
                        idx.add(dst, put(blob), len(blob))
                        changes.append(tex + "+")
            if not extra:
                continue
            idx.parts[0] = start + len(extra)
            overlay[dfs] = VirtualBytes(idx.build())
            overlay[data_name] = VirtualData(real, start, extra)
            report.append(f"{dfs}: {len(changes)} files ({', '.join(sorted(set(changes)))[:160]})")
    return overlay, report


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache", "synchrony"))
    ap.add_argument("--check", action="store_true", help="re-read every virtual archive and verify each entry")
    a = ap.parse_args()
    syn = fetch_release(a.cache)
    overlay, report = build_overlay(a.game, syn)
    for r in report:
        say(r)
    if a.check:
        for dfs, vb in overlay.items():
            if not dfs.lower().endswith(".dfs"):
                continue
            idx = Index(vb.data)
            vd = overlay[next(k for k in overlay if k.lower() == dfs[:-4].lower() + ".000")]
            assert idx.parts[0] == vd.size
            bad = 0
            for e in idx.entries:
                if e[4] + e[5] > vd.size:
                    bad += 1
            lv = [e for e in idx.entries if idx.path(e).upper().endswith("ALLUSEDLAYERS.TXT")]
            txt = vd.read(lv[0][4], lv[0][5]).decode("latin-1") if lv else ""
            say(f"check {dfs}: {len(idx.entries)} entries, out of range {bad}, FAKE_HOBBITS in ALLUSEDLAYERS: {FAKE_LAYER in txt}")


if __name__ == "__main__":
    main()
