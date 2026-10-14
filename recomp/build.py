"""Compile the generated C (out/c) + runtime to out/hobbit.wasm with wasi-sdk clang (wasm32).

Usage: python recomp/build.py [--jobs N] [--opt -O2] [--only chunk_012,...]
Objects are cached by source mtime in out/o/.
"""
import argparse, glob, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SDK = os.environ.get("WASI_SDK") or r"C:\tools\wasi-sdk-34.0-x86_64-windows"
CLANG = os.path.join(SDK, "bin", "clang.exe" if os.name == "nt" else "clang")
OUT = os.path.join(HERE, "out")


def cc(src, obj, opt, defs=()):
    if os.path.exists(obj) and os.path.getmtime(obj) >= os.path.getmtime(src) and \
            os.path.getmtime(obj) >= os.path.getmtime(os.path.join(HERE, "runtime", "rt.h")):
        return src, 0, ""
    r = subprocess.run([CLANG, "--target=wasm32-wasip1", opt, "-I", os.path.join(HERE, "runtime"), "-w", *defs,
                        "-c", src, "-o", obj], capture_output=True, text=True)
    return src, r.returncode, r.stderr[-3000:]


def main():
    global OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=max(1, os.cpu_count() - 1))
    ap.add_argument("--opt", default="-O2")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--flat", action="store_true",
                    help="game build: flat guest memory (guest address = linear address), host imports, -> hobbit_flat.wasm")
    opt = ap.parse_args()
    OUT = opt.out
    odir = os.path.join(OUT, "o_flat" if opt.flat else "o")
    defs = ("-DRT_FLAT",) if opt.flat else ()
    t0 = time.time()
    os.makedirs(odir, exist_ok=True)
    srcs = sorted(glob.glob(os.path.join(OUT, "c", "*.c"))) + [os.path.join(HERE, "runtime", "rt.c")]
    jobs = [(s, os.path.join(odir, os.path.basename(s)[:-2] + ".o")) for s in srcs]
    bad = 0
    with ThreadPoolExecutor(opt.jobs) as ex:
        for k, (s, rc, err) in enumerate(ex.map(lambda j: cc(j[0], j[1], opt.opt, defs), jobs)):
            if rc:
                bad += 1
                print("FAILED", s, err, flush=True)
            if (k + 1) % 20 == 0:
                print("  %d/%d compiled (%.0fs)" % (k + 1, len(jobs), time.time() - t0), flush=True)
    if bad:
        sys.exit(1)
    wasm = os.path.join(OUT, "hobbit_flat.wasm" if opt.flat else "hobbit.wasm")
    rsp = os.path.join(odir, "link.rsp")
    with open(rsp, "w") as f:
        for _, o in jobs:
            f.write('"%s"\n' % o.replace("\\", "/"))
    if opt.flat:
        # wasm data + C stack live in 1..4 MB (below the exe image at 0x400000); the host maps the image and the guest heap
        mem = ["-Wl,--global-base=1048576", "-Wl,-z,stack-size=1048576", "-Wl,--initial-memory=67108864",
               "-Wl,--max-memory=4294967296", "-Wl,--export=__heap_base", "-Wl,--export=__data_end"]
    else:
        mem = ["-Wl,-z,stack-size=8388608", "-Wl,--initial-memory=134217728", "-Wl,--max-memory=1073741824"]
    r = subprocess.run([CLANG, "--target=wasm32-wasip1", opt.opt, "-nostartfiles", "-Wl,--no-entry",
                        "-Wl,--export=__stack_pointer", *mem, "@" + rsp, "-lm", "-o", wasm], capture_output=True, text=True)
    if r.returncode:
        print("LINK FAILED", r.stderr[-5000:])
        sys.exit(1)
    print("%s %.1f MB (%.0fs)" % (wasm, os.path.getsize(wasm) / 1e6, time.time() - t0))


if __name__ == "__main__":
    main()
