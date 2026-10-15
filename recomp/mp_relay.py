"""WebSocket relay for Hobbit Web multiplayer (stdlib only: RFC 6455 handshake + framing).

    python recomp/mp_relay.py [--port 5192] [--host 127.0.0.1]

Rooms of up to 8 players. On join the server gives each client a fake-Bilbo slot 0..7; slot k drives the level NPC
with GUID 0D8AD910_E885100(2+k) (Synchrony's FAKE_BILBO_GUID.txt order). Messages are compact JSON text frames;
see docs/MULTIPLAYER.md. The relay does not interpret game state: it stamps the sender id on state messages and
forwards them to everyone else in the room.

client -> server   {"t":"hello","name":"Ivan","room":"main"}           first message
                   {"t":"s", ...state...}                                ~20 Hz, relayed as {"t":"s","id":N,...}
                   {"t":"name","name":"..."}
                   {"t":"dev","a":"on"|"off"|<action>, ...detail}       developer mode (docs/DEVMODE.md)
                   {"t":"room","allowDev":true|false}                    room owner only
                   {"t":"e", ...}  {"t":"w","g":"<GUID>", ...}             game-state extensions (enemies / world objects),
                                                                          relayed with "id" like "s"; the latest "w" per
                                                                          (level, g) is kept and sent in welcome.world
server -> client   {"t":"welcome","id":N,"slot":k,"guid":"0D8AD910_E8851002","room":"main","players":[...]}
                   {"t":"join","id":N,"slot":k,"guid":...,"name":...}  {"t":"leave","id":N}  {"t":"full"}
                   {"t":"dev","id":N,"name":...,"a":...,"dev":bool,"ts":...,...}  to EVERYONE in the room, sender too
                   {"t":"room","owner":N,"allowDev":bool,"by":N}
Developer mode is transparent: the relay keeps each player's dev state (the DEV badge comes from it, late joiners get
it in welcome), logs every dev event with time, room, player and IP, and flags position jumps of players that did not
announce dev mode ("suspicious").
"""
import argparse, base64, collections, datetime, hashlib, ipaddress, json, math, socket, socketserver, struct, threading, time

GUIDS = ["0D8AD910_E885100%X" % (2 + k) for k in range(8)]
MAX_PLAYERS = 8
MAX_FRAME = 1 << 16
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
# dev actions a client may announce (anything else is logged as "other")
DEV_ACTIONS = {"on", "off", "fly", "speed", "teleport", "god", "health", "warp", "wire", "overlay", "sysmenu", "other"}
EVENTS_KEPT = 50          # per room, sent to late joiners
# suspicious-movement heuristic for players NOT in dev mode (game units; Bilbo runs ~316 u/s, dev flight ~860 u/s)
JUMP_UNITS = 1500         # one state update (~50 ms) moving further than this = teleport-like jump
SPEED_UPS = 1400          # average speed over >= 1 s above this = speed-hack-like
FLAG_EVERY_S = 10         # at most one flag per player per 10 s


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


class Conn:
    def __init__(self, sock, addr, ip=None):
        self.sock, self.addr = sock, addr
        self.ip = ip or addr[0]           # real client IP (CF-Connecting-IP / X-Forwarded-For behind our proxy)
        self.dev = False                  # developer mode, as announced to the relay (source of the DEV badge)
        self.track = None                 # (t, level, x, y, z) of the last state, for the heuristic
        self.win = None                   # (t0, distance) speed window
        self.last_flag = 0.0
        self.lock = threading.Lock()
        self.id = self.slot = None
        self.name, self.room, self.level = "Hobbit", "main", 0
        self.alive = True

    # ---- framing
    def send_frame(self, opcode, payload):
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack(">H", n)
        else:
            head += bytes([127]) + struct.pack(">Q", n)
        with self.lock:
            try:
                self.sock.sendall(head + payload)
            except OSError:
                self.alive = False

    def send(self, obj):
        self.send_frame(1, json.dumps(obj, separators=(",", ":")).encode())

    def recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
        return buf

    def recv_message(self):
        """Returns (opcode, payload) of one complete message; handles fragmentation."""
        data, op0 = b"", None
        while True:
            b0, b1 = self.recv_exact(2)
            fin, op, masked, n = b0 & 0x80, b0 & 0x0F, b1 & 0x80, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self.recv_exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self.recv_exact(8))[0]
            if n > MAX_FRAME:
                raise ConnectionError("frame too large")
            mask = self.recv_exact(4) if masked else b"\0\0\0\0"
            payload = bytes(c ^ mask[i & 3] for i, c in enumerate(self.recv_exact(n)))
            if op >= 8:                                  # control frames may interleave
                if op == 8:
                    self.send_frame(8, payload[:2])
                    raise ConnectionError("close")
                if op == 9:
                    self.send_frame(10, payload)
                continue
            if op0 is None:
                op0 = op
            data += payload
            if len(data) > MAX_FRAME:
                raise ConnectionError("message too large")
            if fin:
                return op0, data


class Relay:
    def __init__(self, log=lambda s: print(s, flush=True)):
        self.rooms = {}          # room -> {id: Conn}
        self.meta = {}           # room -> {"owner": id, "allowDev": bool, "events": deque of dev events}
        self.lock = threading.Lock()
        self.next_id = 1
        self.log = log

    def who(self, c):
        return f"#{c.id} {c.name!r} ip {c.ip}" + (f" (via {c.addr[0]})" if c.addr and c.addr[0] != c.ip else "")

    def join(self, c, name, room, allow_dev=True):
        with self.lock:
            new_room = room not in self.rooms
            members = self.rooms.setdefault(room, {})
            used = {m.slot for m in members.values()}
            free = [k for k in range(MAX_PLAYERS) if k not in used]
            if not free:
                return False
            c.id, self.next_id = self.next_id, self.next_id + 1
            c.slot, c.name, c.room = free[0], name, room
            others = list(members.values())
            members[c.id] = c
            if new_room or room not in self.meta:
                self.meta[room] = {"owner": c.id, "allowDev": bool(allow_dev), "events": collections.deque(maxlen=EVENTS_KEPT),
                                   "world": {}}
            meta = self.meta[room]
            events = list(meta["events"])
            world = list(meta.setdefault("world", {}).values())
        c.send({"t": "welcome", "id": c.id, "slot": c.slot, "guid": GUIDS[c.slot], "room": room,
                "players": [self.info(m) for m in others], "owner": meta["owner"], "allowDev": meta["allowDev"],
                "events": events, "world": world})
        for m in others:
            m.send(dict(self.info(c), t="join"))
        self.log(f"[relay] {c.ip} joined room {room!r} as #{c.id} {name!r} slot {c.slot} ({len(others) + 1} in room)")
        if new_room:
            self.log(f"[relay] {now_iso()} room {room!r} created by {self.who(c)}: allowDev={meta['allowDev']}")
        return True

    def info(self, c):
        return {"id": c.id, "slot": c.slot, "guid": GUIDS[c.slot], "name": c.name, "level": c.level, "dev": c.dev}

    def room_all(self, room):
        with self.lock:
            return list(self.rooms.get(room, {}).values())

    def event(self, c, a, extra=None, suspicious=False):
        """One developer-mode event: logged (stdout -> docker logs) and sent to everyone in the room, sender too."""
        ev = {"t": "dev", "ts": now_iso(), "id": c.id, "name": c.name, "a": a, "dev": c.dev}
        for k, v in (extra or {}).items():
            ev.setdefault(k, v)
        if suspicious:
            ev["suspicious"] = True
        with self.lock:
            meta = self.meta.get(c.room)
            if meta:
                meta["events"].append(ev)
        detail = " ".join(f"{k}={json.dumps(v, separators=(',', ':'))}" for k, v in (extra or {}).items())
        self.log(f"[relay] {ev['ts']} DEV{' SUSPICIOUS' if suspicious else ''} room {c.room!r} {self.who(c)} "
                 f"level {c.level}: {a}" + (f" {detail}" if detail else ""))
        data = json.dumps(ev, separators=(",", ":")).encode()
        for m in self.room_all(c.room):
            m.send_frame(1, data)

    def on_dev(self, c, msg):
        a = str(msg.get("a") or "other")[:16]
        if a not in DEV_ACTIONS:
            a = "other"
        extra = {}
        for k, v in msg.items():                      # small JSON detail only (numbers, short strings, bools)
            if k in ("t", "a", "id", "name", "ts", "dev", "suspicious") or len(extra) >= 8:
                continue
            if isinstance(v, (bool, int, float)) or (isinstance(v, str) and len(v) <= 64):
                extra[str(k)[:16]] = v
            elif isinstance(v, list) and len(v) <= 4 and all(isinstance(x, (int, float)) for x in v):
                extra[str(k)[:16]] = [round(x, 1) for x in v]
        with self.lock:
            allow = self.meta.get(c.room, {}).get("allowDev", True)
        if a == "on":
            if not allow:
                c.send({"t": "dev", "ts": now_iso(), "id": c.id, "name": c.name, "a": "denied", "dev": False})
                self.log(f"[relay] {now_iso()} DEV room {c.room!r} {self.who(c)}: tried to enable dev mode, denied (allowDev=false)")
                return
            if c.dev:
                return
            c.dev = True
        elif a == "off":
            if not c.dev:
                return
            c.dev = False
        elif not c.dev:                               # an action without announcing dev mode first
            self.event(c, a, dict(extra, note="dev action without dev mode on"), suspicious=True)
            return
        self.event(c, a, extra)

    def on_room(self, c, msg):
        with self.lock:
            meta = self.meta.get(c.room)
            owner = meta["owner"] if meta else None
            ok = bool(meta) and owner == c.id and "allowDev" in msg
            if ok:
                meta["allowDev"] = bool(msg["allowDev"])
        if not ok:
            self.log(f"[relay] {now_iso()} room {c.room!r} {self.who(c)}: room setting refused (owner is #{owner})")
            return
        self.log(f"[relay] {now_iso()} room {c.room!r} {self.who(c)} (owner) set allowDev={meta['allowDev']}")
        out = {"t": "room", "owner": owner, "allowDev": meta["allowDev"], "by": c.id}
        for m in self.room_all(c.room):
            m.send(out)
        if not meta["allowDev"]:                      # switch everyone's dev mode off (clients obey "forced")
            for m in self.room_all(c.room):
                if m.dev:
                    m.dev = False
                    self.event(m, "off", {"forced": True, "by": c.name})

    def check_motion(self, c, msg):
        """Flags big position jumps / sustained high speed of players that have NOT announced dev mode.
        Level changes, respawns and cutscenes can move Bilbo too, so a flag is a hint, not proof."""
        p, l, t = msg.get("p"), msg.get("l"), time.monotonic()
        if not (isinstance(p, list) and len(p) == 3 and all(isinstance(v, (int, float)) for v in p)) or not isinstance(l, int) or l < 0:
            c.track = c.win = None
            return
        prev, c.track = c.track, (t, l, p[0], p[1], p[2])
        if c.dev or not prev or prev[1] != l:
            c.win = None
            return
        dt, d = t - prev[0], math.dist(p, prev[2:])
        if dt > 2:                                    # paused / tab in background: start over
            c.win = None
            return
        why = None
        if d > JUMP_UNITS:
            why = f"moved {d:.0f} units in {dt:.2f} s"
            c.win = None
        else:
            t0, acc = c.win or (prev[0], 0.0)
            acc += d
            if t - t0 >= 1.0:
                if acc / (t - t0) > SPEED_UPS:
                    why = f"average speed {acc / (t - t0):.0f} units/s over {t - t0:.1f} s"
                c.win = None
            else:
                c.win = (t0, acc)
        if why and t - c.last_flag > FLAG_EVERY_S:
            c.last_flag = t
            self.event(c, "flag", {"note": why + " without dev mode (respawns/cutscenes can also do this)",
                                   "to": [round(v, 1) for v in p]}, suspicious=True)

    def remember_world(self, c, msg):
        """Keeps the latest "w" message per (level, GUID) so late joiners get the room's world state in welcome.world
        (a reset of a level's state: {"t":"w","reset":true,"l":N}, or the whole room with no "l")."""
        g, l = msg.get("g"), msg.get("l", c.level)
        with self.lock:
            meta = self.meta.get(c.room)
            if not meta:
                return
            world = meta.setdefault("world", {})
            if msg.get("reset"):
                for k in [k for k in world if "l" not in msg or k[0] == l]:
                    world.pop(k, None)
            elif isinstance(g, str) and len(g) <= 32 and len(world) < 4096:
                world[(l, g)] = msg

    def leave(self, c):
        if c.id is None:
            return
        with self.lock:
            members = self.rooms.get(c.room, {})
            members.pop(c.id, None)
            others = list(members.values())
            meta = self.meta.get(c.room)
            new_owner = None
            if not members:
                self.rooms.pop(c.room, None)
                self.meta.pop(c.room, None)
            elif meta and meta["owner"] == c.id:
                new_owner = meta["owner"] = min(members)          # the longest-connected player takes over
        for m in others:
            m.send({"t": "leave", "id": c.id})
        self.log(f"[relay] #{c.id} {c.name!r} left room {c.room!r}" + (" (was in dev mode)" if c.dev else ""))
        if new_owner is not None:
            self.log(f"[relay] {now_iso()} room {c.room!r}: owner #{c.id} left, new owner #{new_owner}")
            out = {"t": "room", "owner": new_owner, "allowDev": meta["allowDev"], "by": None}
            for m in others:
                m.send(out)

    def broadcast(self, c, obj):
        with self.lock:
            others = [m for m in self.rooms.get(c.room, {}).values() if m is not c]
        data = json.dumps(obj, separators=(",", ":")).encode()
        for m in others:
            m.send_frame(1, data)

    def handle(self, c):
        try:
            op, data = c.recv_message()
            msg = json.loads(data)
            if msg.get("t") != "hello":
                return
            name = str(msg.get("name") or "Hobbit")[:24]
            room = str(msg.get("room") or "main")[:32]
            if not self.join(c, name, room, msg.get("allowDev", True) is not False):
                c.send({"t": "full"})
                return
            while c.alive:
                op, data = c.recv_message()
                if op != 1:
                    continue
                msg = json.loads(data)
                t = msg.get("t")
                if t == "s":
                    msg["id"] = c.id
                    if isinstance(msg.get("l"), int):
                        c.level = msg["l"]
                    self.check_motion(c, msg)
                    self.broadcast(c, msg)
                elif t in ("e", "w"):                 # game-state extensions: forwarded like "s", world state remembered
                    msg["id"] = c.id
                    if t == "w":
                        self.remember_world(c, msg)
                    self.broadcast(c, msg)
                elif t == "dev":
                    self.on_dev(c, msg)
                elif t == "room":
                    self.on_room(c, msg)
                elif t == "name":
                    c.name = str(msg.get("name") or c.name)[:24]
                    self.broadcast(c, dict(self.info(c), t="join"))
                elif t == "ping":
                    c.send({"t": "pong", "ts": msg.get("ts")})
        except (ConnectionError, OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            self.leave(c)


def handshake(sock):
    """Reads the HTTP upgrade request; returns its headers (lower-case keys) after sending 101. Plain GET / gets a short status page."""
    req = b""
    while b"\r\n\r\n" not in req:
        chunk = sock.recv(4096)
        if not chunk or len(req) > 16384:
            return False
        req += chunk
    lines = req.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
    hdr = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
    key = hdr.get("sec-websocket-key")
    if not key or "websocket" not in hdr.get("upgrade", "").lower():
        body = b"Hobbit Web multiplayer relay (WebSocket). Open the game page and connect to this address.\n"
        sock.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body))
        return False
    send_101(sock, key)
    return hdr


def send_101(sock, key):
    accept = base64.b64encode(hashlib.sha1((key + WS_MAGIC).encode()).digest()).decode()
    sock.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())


def serve_upgrade(handler, relay):
    """WebSocket on an existing HTTP server (start.py single-origin mode, path /relay): `handler` is a
    BaseHTTPRequestHandler that has parsed the upgrade request. Returns False if it is not a WebSocket upgrade.
    Blocks until the client leaves; the HTTP connection is closed afterwards."""
    key = handler.headers.get("Sec-WebSocket-Key")
    if not key or "websocket" not in handler.headers.get("Upgrade", "").lower():
        return False
    sock = handler.connection
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.settimeout(20)                   # clients send at least one message per second
    handler.close_connection = True
    try:
        send_101(sock, key)
    except OSError:
        return True
    relay.handle(Conn(sock, handler.client_address, client_ip(handler.headers.get, handler.client_address[0])))
    return True


def client_ip(get, peer):
    """The real client IP behind Cloudflare / a reverse proxy, else the peer address. The headers are trusted only
    when the peer itself is a private or loopback address (our own proxy), so a direct client cannot fake them."""
    try:
        a = ipaddress.ip_address(peer)
        trusted = a.is_private or a.is_loopback
    except ValueError:
        trusted = False
    if trusted:
        for h in ("CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For"):
            v = get(h)
            if v:
                return v.split(",")[0].strip()[:64]
    return peer


def make_server(host, port, log=lambda s: print(s, flush=True), relay=None):
    relay = relay or Relay(log)

    class H(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.request.settimeout(20)        # clients send at least one message per second
            try:
                ok = handshake(self.request)
            except OSError:                    # idle preconnects, resets
                return
            if ok:
                ip = client_ip(lambda h: ok.get(h.lower()), self.client_address[0])
                relay.handle(Conn(self.request, self.client_address, ip))

    class S(socketserver.ThreadingTCPServer):
        daemon_threads = True
        allow_reuse_address = True

    srv = S((host, port), H)
    srv.relay = relay
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5192)
    a = ap.parse_args()
    srv = make_server(a.host, a.port)
    print(f"multiplayer relay on ws://{a.host}:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
