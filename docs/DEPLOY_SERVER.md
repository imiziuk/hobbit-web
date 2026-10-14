# Always-on deployment on a home server (hardened)

`docker-compose.server.yml` runs the game on a Linux server with tight isolation, so the public link (Cloudflare) or a
shared Tailscale node is the only way in, and a compromised game server cannot reach anything else.

## Isolation, and how it was verified (2026-10-14, on the PC, before moving)

| Layer | Setting | Verified |
|---|---|---|
| Network | the game container is only on `internal` (a Docker network with `internal: true`: no gateway) | 1.1.1.1, 8.8.8.8, github.com, the LAN router, the Docker host and the home server are all unreachable from inside |
| Inbound | only `tailscale` and `cloudflared` share that network; they forward HTTP to `hobbit:5190` (and the legacy 5191/5192) | `hobbit:5190/__mode` → 200 from the internal network |
| User | `user: 10001:10001`, not root | `id` → uid 10001 |
| Privileges | `cap_drop: [ALL]`, `no-new-privileges` | CapEff 0, NoNewPrivs 1 |
| Filesystem | `read_only: true`; mounts: game folder `:ro`, prebuilt `recomp/out` `:ro`, `cache` `:ro`; 64 MB tmpfs `/tmp` | writes to /app, /game, /etc and the build folder denied |
| Resources | 2 GB RAM, 2 CPUs, 256 processes, log rotation | `docker inspect` |
| Secrets | none in the game container. The Cloudflare token lives only in the `cloudflared` env; the Tailscale identity lives in `./ts-state` (700) and is excluded from the image (`.dockerignore`) | |
| App | the data server only serves files inside the game folder (`normpath` + prefix check); the page is behind Cloudflare Access when published | |

Remaining exposure (accepted): anyone who passes Cloudflare Access can download the game files and use the relay; the
gateways (official tailscale / cloudflared images) do have internet access. Docker itself runs as root on the host;
for more, enable `userns-remap` in the daemon or rootless Docker.

## Layout on the server (`/home/claude/hobbit-web`)
- the repo files (no `.git`), plus `recomp/out/{hobbit_flat.wasm, hobbit_flat.wasm.gz, funcs.txt}` built on the PC
  (the server never builds; the container has no network to download anything);
- `cache/synchrony/` (the multiplayer assets, prefetched on the PC);
- `ts-state/` = the `hobbit-web` Tailscale node copied from the PC, so the node name, URL and shares stay the same
  (do not run the PC stack's tailscale at the same time);
- `.env` (600): `GAME_DIR=/home/claude/hobbit-game`, `CF_TUNNEL_TOKEN=...`;
- the game folder in `/home/claude/hobbit-game` (read-only mount).

## Run (as an admin; the `claude` account has no Docker access on purpose)
```
sudo docker compose --project-directory /home/claude/hobbit-web -f /home/claude/hobbit-web/docker-compose.server.yml --profile cloudflare up -d --build
```
Cloudflare: the tunnel route must point at **`http://hobbit:5190`** (not localhost: the gateways are separate
containers now). Tailscale: unchanged (`https://hobbit-web.<tailnet>.ts.net`).

Stop the public link: `sudo docker stop hobbit-cloudflared`. Everything: `... down`.

## Updating
Rebuild on the PC (`start.py --rebuild` or `docker compose up -d --build`), then copy `recomp/out/hobbit_flat.wasm*`,
`funcs.txt` and any changed code to the server and run the same `up -d --build`.
