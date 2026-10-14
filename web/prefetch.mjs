// Background download of the game data into the persistent block store of recomp/host/vfs.mjs (Cache Storage
// 'hobbit-data-v1', the same 64 KB blocks and keys the game's own reads use), so later reads never wait for the network.
//
// Why: the game reads its archives in 32 KB ReadFile calls, one after the other, on its io thread. From a remote
// server each call costs a round trip, and the game's main thread waits for that io (measured with 200 ms latency:
// Dream World took 100 s to load, the main thread froze 8.5 s in the first seconds of the level and music streams were
// stopped and restarted). Large ranged requests (0.25-2 MB) fill the store at the link's bandwidth instead.
//
// Rules:
// - The game always comes first: while a game read is waiting, only the file the game is reading right now (the
//   level being loaded) is prefetched, with one request at a time; everything else waits until the game is idle.
// - Order: the archive the game opened last (the level being loaded) -> common/boot -> Dream World (New Game) ->
//   audio2/audio1 -> the next level; with "everything" also the other levels, small files and the Bink headers (movies
//   are stubbed: only their headers are read, so their 670 MB are never downloaded).
// - Background mode stays off with Save-Data or a 2G connection, and backs off for a minute when the measured
//   throughput is below 64 KB/s. "Download everything" ignores that (the user asked) and requests persistent storage.
// - Resumable: on start it lists the store once and only downloads the blocks that are missing.
import { DATA_CACHE } from '../recomp/host/vfs.mjs';

// level archives in game order (the level list of web/game.mjs)
const LEVELS = ['Ch00_Dre', 'Ch01_Hob', 'Ch02_Roa', 'Ch02a_Tr', 'Ch4_Over', 'Ch05_Swo', 'Mirkwood', 'Ch07_Bar', 'CH08_Lak',
  'Ch09_Sma', 'Ch10_Lon', 'Ch11_Clo'].map(s => s.toLowerCase());
const base = p => p.split('/').pop().replace(/\.[^.]*$/, '').toLowerCase();
const ext = p => (/\.([^./]+)$/.exec(p) || [, ''])[1].toLowerCase();

/** be: the HttpBackend; returns the prefetcher (see P.* below). */
export function createPrefetch(be, { log = () => {}, onChange = () => {}, playing = () => false } = {}) {
  const B = be.BLOCK;
  const P = { mode: 'off', state: 'idle', done: 0, total: 0, bgDone: 0, bgTotal: 0, rate: 0, errors: 0, bytes: 0, reason: '' };
  const files = [...be.files.values()];
  // which blocks of a file are worth having: null = never (logs, dlls, tools in the game folder)
  const plan = f => {
    const e = ext(f.path), nb = Math.ceil(f.size / B);
    if (!f.size) return null;
    if (e === 'bik') return [0, Math.min(nb, 2) - 1];                      // header only (movies are stubbed)
    if (e === '000' || e === 'dfs' || e === 'exe') return [0, nb - 1];
    if (/^common\//i.test(f.path)) return [0, nb - 1];
    if (/\.(log|dll|tsv|bat|bak|tga)$|\.dll\.|^shadow|\.off$/i.test(f.path) || f.size > (1 << 20)) return null;
    return [0, nb - 1];
  };
  const want = new Map();     // f -> [first, last]
  for (const f of files) { const r = plan(f); if (r) want.set(f, r); }
  const have = new Map();     // f -> Uint8Array(blocks) 1 = in the store
  const bits = f => { let a = have.get(f); if (!a) { a = new Uint8Array(Math.ceil(f.size / B)); have.set(f, a); } return a; };
  const blockBytes = (f, b) => Math.min(B, f.size - b * B);
  const byFile = f => base(f.path), byName = new Map(files.map(f => [f.path.toLowerCase(), f]));
  let current = null;         // the archive the game opened last (the level it is loading)
  const isLevel = f => LEVELS.includes(byFile(f)) && ext(f.path) === '000';
  const order = everything => {
    const out = [], add = f => { if (f && want.has(f) && !out.includes(f)) out.push(f); };
    const get = n => byName.get(n.toLowerCase());
    const lvl = n => [...want.keys()].filter(f => byFile(f) === n);
    if (current) { add(current); lvl(byFile(current)).forEach(add); }
    const ci = current && isLevel(current) ? LEVELS.indexOf(byFile(current)) : -1;
    ['Meridian.exe', 'boot.DFS', 'common.DFS', 'audio1.DFS', 'audio2.DFS'].forEach(n => add(get(n)));
    if (ci < 0) lvl(LEVELS[0]).forEach(add);           // still in the menu: New Game starts in Dream World
    ['common.000', 'boot.000'].forEach(n => add(get(n)));
    add(get('audio2.000')); add(get('audio1.000'));
    if (ci >= 0 && ci + 1 < LEVELS.length) lvl(LEVELS[ci + 1]).forEach(add);
    [...want.keys()].filter(f => /^common\//i.test(f.path) && ext(f.path) !== 'bik').forEach(add);
    if (everything) {
      for (let i = 1; i < LEVELS.length; i++) lvl(LEVELS[(Math.max(0, ci) + i) % LEVELS.length]).forEach(add);
      [...want.keys()].forEach(add);
    }
    return out;
  };
  let bgCache = null;
  const bgSet = () => bgCache ||= new Set(order(false));
  const recount = () => {
    const bg = bgSet(); let d = 0, t = 0, bd = 0, bt = 0;
    for (const [f, [a, z]] of want) {
      const h = have.get(f); let fd = 0;
      for (let b = a; b <= z; b++) if (h && h[b]) fd += blockBytes(f, b);
      const ft = Math.min(f.size, (z + 1) * B) - a * B;
      d += fd; t += ft; if (bg.has(f)) { bd += fd; bt += ft; }
    }
    P.done = d; P.total = t; P.bgDone = bd; P.bgTotal = bt;
  };
  be.onStored = (f, b) => { const h = bits(f); if (!h[b]) { h[b] = 1; if (want.has(f)) { const r = want.get(f); if (b >= r[0] && b <= r[1]) { P.done += blockBytes(f, b); if (bgSet().has(f)) P.bgDone += blockBytes(f, b); } } } };
  be.onOpen = f => {
    if (isLevel(f) || /^(common|boot)\.000$/i.test(f.path)) {
      if (current !== f) { current = f; bgCache = null; recount(); if (P.mode !== 'off') log(`prefetch: ${f.path} first (the game is reading it)`); }
    }
  };

  // ---- scan the store once (resume)
  let scanned = null;
  const scan = () => scanned ||= (async () => {
    const store = be.store && await be.store; if (!store) return false;
    const pre = new Map(); for (const f of files) pre.set(`${f.url}?v=${encodeURIComponent(f.ver)}-${f.size}`, f);
    const t = performance.now(), keys = await store.keys();
    for (const r of keys) {
      const u = r.url, i = u.lastIndexOf('&b='); if (i < 0) continue;
      const f = pre.get(u.slice(0, i)); if (f) bits(f)[+u.slice(i + 3)] = 1;
    }
    recount();
    log(`prefetch: store has ${(P.done / 1e6).toFixed(0)} of ${(P.total / 1e6).toFixed(0)} MB (${keys.length} blocks, listed in ${(performance.now() - t).toFixed(0)} ms)`);
    return true;
  })();

  // ---- the download loop
  let running = false, ac = null, active = 0, chunk = 8, backoffUntil = 0, restUntil = 0;
  const hist = [];            // [time, bytes] of finished requests (throughput over the last 5 s)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const conn = () => navigator.connection || null;
  const poorLink = () => { const c = conn(); return c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || '')) ? (c.saveData ? 'Save-Data is on' : 'slow connection (' + c.effectiveType + ')') : ''; };
  const nextJob = (everything, gameBusy) => {
    const max = gameBusy ? Math.min(chunk, 8) : chunk;  // while the game waits: <= 512 KB, so its reads are not starved
    for (const f of order(everything)) {
      if (gameBusy && f !== current) return null;      // while the game waits, only the file it is reading
      const [a, z] = want.get(f), h = bits(f);
      for (let b = a; b <= z; b++) {
        if (h[b] || be.inflight.has(be.skey(f, b))) continue;
        let e = b; while (e < z && e - b + 1 < max && !h[e + 1] && !be.inflight.has(be.skey(f, e + 1))) e++;
        return [f, b, e];
      }
    }
    return undefined;         // nothing left
  };
  async function loop() {
    if (running) return; running = true;
    try {
      if (!(await scan())) { P.state = 'unavailable'; P.reason = 'no persistent storage here (needs https or localhost)'; onChange(P); return; }
      ac = new AbortController();
      while (P.mode !== 'off') {
        const everything = P.mode === 'all';
        const poor = !everything && poorLink();
        if (poor) { P.state = 'paused'; P.reason = poor; onChange(P); await sleep(5000); continue; }
        if (!everything && performance.now() < backoffUntil) { P.state = 'paused'; P.reason = 'slow link, retrying soon'; onChange(P); await sleep(2000); continue; }
        // while a level is being played: one request at a time and a pause as long as the request took (about half the
        // link), because reading the stream and storing the blocks costs main-thread time (measured ~10% of the fps)
        const busy = be.gameWaiting > 0, play = !busy && !everything && playing(), limit = busy || play ? 1 : 2;
        if (active >= limit) { await sleep(busy ? 20 : 40); continue; }
        if (play && performance.now() < restUntil) { await sleep(Math.min(200, restUntil - performance.now())); continue; }
        const job = nextJob(everything, busy);
        if (job === null) { await sleep(20); continue; }
        if (job === undefined) {
          if (active) { await sleep(100); continue; }
          P.state = 'complete'; P.reason = everything ? 'everything is downloaded' : 'the data for the current part of the game is downloaded'; onChange(P);
          await sleep(3000); if (P.mode === 'off') break;
          continue;              // the game may open another level: its file moves to the front
        }
        P.state = 'downloading'; P.reason = ''; active++;
        const [f, b, e] = job, t0 = performance.now();
        be.prefetch(f, b, e, { signal: ac.signal, onBytes: n => { P.bytes += n; } }).then(() => {
          const now = performance.now(), n = Math.min(f.size, (e + 1) * B) - b * B;
          restUntil = now + (now - t0);
          hist.push([now, n]); while (hist.length && hist[0][0] < now - 5000) hist.shift();
          const span = Math.max(1000, now - (hist.length > 1 ? hist[0][0] : t0));
          P.rate = hist.reduce((a, h) => a + h[1], 0) / (span / 1000);
          // chunk = ~250 ms of transfer, 4..32 blocks (256 KB .. 2 MB)
          chunk = Math.max(4, Math.min(32, Math.round(P.rate * 0.25 / B)));
          if (hist.length >= 3 && P.rate < 64e3) backoffUntil = now + 60000;
        }, err => { if (err.name !== 'AbortError') { P.errors++; log('prefetch: ' + err.message); backoffUntil = performance.now() + 10000; } })
          .finally(() => { active--; onChange(P); });
      }
    } finally { running = false; if (P.mode === 'off') { P.state = 'idle'; onChange(P); } }
  }
  /** mode: 'off' | 'bg' (background, the default) | 'all' (everything for offline) */
  P.setMode = mode => {
    P.mode = mode;
    if (mode === 'off') { if (ac) ac.abort(); P.reason = ''; }
    else {
      if (mode === 'all' && navigator.storage && navigator.storage.persist) navigator.storage.persist().then(ok => log('prefetch: persistent storage ' + (ok ? 'granted' : 'not granted (the browser may evict it when the disk is full)'))).catch(() => {});
      loop();
    }
    onChange(P);
  };
  P.scan = () => scan().then(() => onChange(P));
  /** Delete everything downloaded (the memory cache of this session is kept, so the running game is not disturbed). */
  P.clear = async () => {
    P.setMode('off');
    while (running || active) await sleep(50);
    await caches.delete(DATA_CACHE);
    be.store = caches.open(DATA_CACHE).catch(() => null);
    have.clear(); scanned = null; await scan(); P.bytes = 0;
    log('prefetch: downloaded game data deleted (background download resumes on the next visit)');
    onChange(P);
  };
  return P;
}
