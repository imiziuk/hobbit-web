"""Summarise a V8 .cpuprofile of the recompiled game (recomp/harness/perf_node.mjs or Chrome DevTools).

usage: python -I recomp/harness/perf_prof.py recomp/out/perf/NAME.cpuprofile [--top 30] [--md]

Self time per function (samples * their intervals), inclusive time (a function is charged once per sample in which it
appears anywhere on the stack), and buckets: wasm game code (F_xxxxxxxx: names from Hobbit-RE/db/catalog.tsv and
auto/symbols.tsv), wasm runtime (rt.c helpers), host JS (recomp/host/*.mjs, web/d3d8/*.js), V8 (gc, program, idle).
"""
import csv, json, os, re, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))           # Hobbit-Decomp
IRA = os.path.dirname(ROOT)

def load_names():
    names = {}
    cat = os.path.join(IRA, 'Hobbit-RE', 'db', 'catalog.tsv')
    sym = os.path.join(ROOT, 'auto', 'symbols.tsv')
    for path, col in ((sym, 'name'), (cat, 'name')):     # catalog wins (hand/label names), symbols fill the rest
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8', errors='replace') as f:
            for row in csv.DictReader(f, delimiter='\t'):
                a = row.get('addr', '').lower().lstrip('0')
                n = row.get(col, '')
                if a and n and not n.startswith('FUN_'):
                    names[a] = n
    return names

def bucket(fn, url):
    if fn.startswith('F_'):
        return 'wasm:game'
    if url.startswith('wasm:') or 'wasm-function' in fn or fn in ('rt_call',) or fn.startswith('rt_') or fn.startswith('ld_') or fn.startswith('st_') or fn.startswith('x87_'):
        return 'wasm:runtime'
    if fn in ('(garbage collector)',):
        return 'v8:gc'
    if fn in ('(program)', '(idle)', '(root)'):
        return 'v8:' + fn.strip('()')
    if 'd3d8' in url or 'com.js' in url:
        return 'host:d3d8'
    if 'host/' in url or 'host\\' in url:
        return 'host:' + os.path.basename(url).replace('.mjs', '')
    return 'js:other'

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    top = 30
    if '--top' in sys.argv:
        top = int(sys.argv[sys.argv.index('--top') + 1])
    md = '--md' in sys.argv
    prof = json.load(open(args[0], encoding='utf-8'))
    names = load_names()
    nodes = {n['id']: n for n in prof['nodes']}
    parent = {}
    for n in prof['nodes']:
        for c in n.get('children', []):
            parent[c] = n['id']
    samples, deltas = prof['samples'], prof['timeDeltas']
    total_us = sum(deltas)
    self_us, incl_us, calls = defaultdict(int), defaultdict(int), defaultdict(int)
    buckets, by_node_self = defaultdict(int), defaultdict(int)
    def key(n):
        cf = n['callFrame']
        fn = cf.get('functionName') or '(anonymous)'
        url = cf.get('url', '')
        if fn.startswith('F_'):
            a = fn[2:].lower().lstrip('0')
            nm = names.get(a)
            return fn + (' ' + nm if nm else ''), bucket(fn, url)
        if fn.startswith('wasm-function['):
            return fn, 'wasm:unnamed'
        b = bucket(fn, url)
        return (fn + ' @' + os.path.basename(url)) if url else fn, b
    keyc = {}
    for nid, n in nodes.items():
        keyc[nid] = key(n)
    for nid, dt in zip(samples, deltas):
        if dt < 0:
            dt = 0
        k, b = keyc[nid]
        self_us[k] += dt
        buckets[b] += dt
        seen = set()
        p = nid
        while p is not None:
            kk = keyc[p][0]
            if kk not in seen:
                seen.add(kk)
                incl_us[kk] += dt
            p = parent.get(p)
    ms = lambda us: us / 1000.0
    pct = lambda us: 100.0 * us / max(1, total_us)
    out = []
    out.append(f"profile {os.path.basename(args[0])}: {len(samples)} samples, {ms(total_us):.0f} ms")
    out.append("")
    out.append("buckets (self time):")
    for b, us in sorted(buckets.items(), key=lambda x: -x[1]):
        out.append(f"  {b:16s} {ms(us):9.1f} ms {pct(us):5.1f}%")
    out.append("")
    hdr = "| self ms | % | function |" if md else "self ms      %   function"
    sep = "|---:|---:|---|" if md else None
    out.append(f"top {top} self time:")
    out.append(hdr)
    if sep: out.append(sep)
    for k, us in sorted(self_us.items(), key=lambda x: -x[1])[:top]:
        out.append(f"| {ms(us):.1f} | {pct(us):.1f} | {k} |" if md else f"{ms(us):9.1f} {pct(us):5.1f}   {k}")
    out.append("")
    out.append(f"top {top} inclusive time (game functions only):")
    out.append(hdr)
    if sep: out.append(sep)
    game = [(k, us) for k, us in incl_us.items() if k.startswith('F_')]
    for k, us in sorted(game, key=lambda x: -x[1])[:top]:
        out.append(f"| {ms(us):.1f} | {pct(us):.1f} | {k} |" if md else f"{ms(us):9.1f} {pct(us):5.1f}   {k}")
    print("\n".join(out))

if __name__ == '__main__':
    main()
