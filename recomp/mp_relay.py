"""WebSocket relay for Hobbit Web multiplayer (stdlib only: RFC 6455 handshake + framing).

    python recomp/mp_relay.py [--port 5192] [--host 127.0.0.1]

Rooms of up to 8 players. On join the server gives each client a fake-Bilbo slot 0..7; slot k drives the level NPC
with GUID 0D8AD910_E885100(2+k) (Synchrony's FAKE_BILBO_GUID.txt order). Messages are compact JSON text frames;
see docs/MULTIPLAYER.md. The relay does not interpret game state: it stamps the sender id on state messages and
forwards them to everyone else in the room.

client -> server   {"t":"hello","name":"Ivan","room":"main"}           first message
                   {"t":"s", ...state...}                                ~20 Hz, relayed as {"t":"s","id":N,...}
                   {"t":"name","name":"..."}
server -> client   {"t":"welcome","id":N,"slot":k,"guid":"0D8AD910_E8851002","room":"main","players":[...]}
                   {"t":"join","id":N,"slot":k,"guid":...,"name":...}  {"t":"leave","id":N}  {"t":"full"}
"""
import argparse, base64, hashlib, json, socket, socketserver, struct, threading, time

GUIDS = ["0D8AD910_E885100%X" % (2 + k) for k in range(8)]
MAX_PLAYERS = 8
MAX_FRAME = 1 << 16
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class Conn:
    def __init__(self, sock, addr):
        self.sock, self.addr = sock, addr
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
        self.lock = threading.Lock()
        self.next_id = 1
        self.log = log

    def join(self, c, name, room):
        with self.lock:
            members = self.rooms.setdefault(room, {})
            used = {m.slot for m in members.values()}
            free = [k for k in range(MAX_PLAYERS) if k not in used]
            if not free:
                return False
            c.id, self.next_id = self.next_id, self.next_id + 1
            c.slot, c.name, c.room = free[0], name, room
            others = list(members.values())
            members[c.id] = c
        c.send({"t": "welcome", "id": c.id, "slot": c.slot, "guid": GUIDS[c.slot], "room": room,
                "players": [self.info(m) for m in others]})
        for m in others:
            m.send(dict(self.info(c), t="join"))
        self.log(f"[relay] {c.addr[0]} joined room {room!r} as #{c.id} {name!r} slot {c.slot} ({len(others) + 1} in room)")
        return True

    def info(self, c):
        return {"id": c.id, "slot": c.slot, "guid": GUIDS[c.slot], "name": c.name, "level": c.level}

    def leave(self, c):
        if c.id is None:
            return
        with self.lock:
            members = self.rooms.get(c.room, {})
            members.pop(c.id, None)
            others = list(members.values())
            if not members:
                self.rooms.pop(c.room, None)
        for m in others:
            m.send({"t": "leave", "id": c.id})
        self.log(f"[relay] #{c.id} {c.name!r} left room {c.room!r}")

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
            if not self.join(c, name, room):
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
                    self.broadcast(c, msg)
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
    """Reads the HTTP upgrade request; returns True after sending 101. Plain GET / gets a short status page."""
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
    accept = base64.b64encode(hashlib.sha1((key + WS_MAGIC).encode()).digest()).decode()
    sock.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
    return True


def make_server(host, port, log=lambda s: print(s, flush=True)):
    relay = Relay(log)

    class H(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.request.settimeout(20)        # clients send at least one message per second
            try:
                ok = handshake(self.request)
            except OSError:                    # idle preconnects, resets
                return
            if ok:
                relay.handle(Conn(self.request, self.client_address))

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
