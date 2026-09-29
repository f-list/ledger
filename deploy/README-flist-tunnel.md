# F-List Postgres tunnel — setup

Sets up the persistent SSH tunnel the ledger uses to read F-List subscription
status (design: [../docs/8-flist-status-check.md](../docs/8-flist-status-check.md)).

**Model:** an unprivileged systemd service holds one long-lived `ssh -L` forward.
The local end binds to the Docker bridge gateway (`172.28.0.1:15432`); the app
container reaches it via `host.docker.internal`. The port is never published on a
public interface, and the app knows nothing about SSH — it just sees a Postgres
URL. A dropped tunnel makes checks report "unavailable" (the feature is
feature-gated and fails fast); systemd reconnects.

Placeholders to fill in: `<pg-box-host>`, `<ssh-user>`, `<ssh-port>`,
`<ro-user>`, `<ro-password>`, `<db-name>`.

---

## 1. Service account on the ledger host

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin flist-tunnel
sudo -u flist-tunnel mkdir -p /home/flist-tunnel/.ssh
sudo -u flist-tunnel chmod 700 /home/flist-tunnel/.ssh
```

(Skip this if you'd rather run the tunnel as an existing user who already has
`ssh flist-db` working — just set `User=` in the unit accordingly.)

## 2. Dedicated tunnel keypair (no passphrase — it runs unattended)

```sh
sudo -u flist-tunnel ssh-keygen -t ed25519 -N '' \
  -f /home/flist-tunnel/.ssh/id_ed25519 -C 'flist-ledger-tunnel'
sudo -u flist-tunnel cat /home/flist-tunnel/.ssh/id_ed25519.pub
```

## 3. Have the sysadmin authorize that key — forward-only

Send the public key to whoever administers the Postgres box. Ask them to add it
to `<ssh-user>@<pg-box-host>`'s `~/.ssh/authorized_keys` **restricted to port
forwarding only** (no shell, only the Postgres forward):

```
restrict,permitopen="127.0.0.1:5432",command="" ssh-ed25519 AAAA... flist-ledger-tunnel
```

This means a leak of the tunnel key grants nothing but a pipe to Postgres.

## 4. SSH config alias for the service user

`/home/flist-tunnel/.ssh/config` (mode 600, owned by flist-tunnel):

```
Host flist-db
    HostName <pg-box-host>
    User <ssh-user>
    Port <ssh-port>
    IdentityFile /home/flist-tunnel/.ssh/id_ed25519
    IdentitiesOnly yes
```

## 5. Pin the host key (no trust-on-first-use for a service)

```sh
sudo -u flist-tunnel sh -c \
  'ssh-keyscan -p <ssh-port> -t ed25519 <pg-box-host> >> /home/flist-tunnel/.ssh/known_hosts'
```

Verify the printed fingerprint against what the sysadmin confirms before trusting it.

## 6. Test the forward by hand

This just proves "can I reach F-List's Postgres through SSH?" before involving the
app. Use `127.0.0.1` here (it always exists) — **not** `172.28.0.1`, which only
comes into being once the Docker network is pinned in step 8. `ssh -N` produces no
output and stays open; that is success, so run the check in a second shell.

```sh
# Terminal 1 — start the forward (no output = working; Ctrl-C to stop):
sudo -u flist-tunnel ssh -N -L 127.0.0.1:15432:127.0.0.1:5432 flist-db

# Terminal 2 — knock on the near end of the tunnel:
pg_isready -h 127.0.0.1 -p 15432        # -> 127.0.0.1:15432 - accepting connections
# and, if psql is installed, an actual read:
psql "postgres://<ro-user>:<ro-password>@127.0.0.1:15432/<db-name>?sslmode=disable" \
     -tAc "select subscribed from account where account_id = 710764"
```

`-L 127.0.0.1:15432:127.0.0.1:5432` means: listen locally on `127.0.0.1:15432`, and
forward whatever connects there — through SSH — to `127.0.0.1:5432` **as seen from
the Postgres box** (the local connection its pg_hba allows). The systemd unit later
uses `172.28.0.1` instead so the container can reach it; that address is created by
step 8, which is why this by-hand test uses loopback.

(The `sudo: unable to resolve host ...` line some systems print is a harmless
hostname warning, unrelated to the tunnel.)

## 7. Install and enable the unit

```sh
sudo cp deploy/flist-tunnel.service /etc/systemd/system/flist-tunnel.service
sudo systemctl daemon-reload
sudo systemctl enable --now flist-tunnel.service
systemctl status flist-tunnel.service
```

The unit binds to `172.28.0.1`, so until step 8 has created that Docker gateway it
will fail with `Cannot assign requested address` and restart every 5s — expected.
Either do step 8 first, or just let it retry; it goes green on its own once the
compose network is up. (`journalctl -u flist-tunnel.service -f` to watch.)

## 8. Wire the app container to the tunnel (compose)

Pin the network subnet so the gateway IP `172.28.0.1` (where the tunnel binds) is
deterministic, and have the app connect to it **directly**. Add to `compose.yaml`:

```yaml
services:
  app:
    environment:
      - FLIST_DB_URL=${FLIST_DB_URL:-}

networks:
  default:
    ipam:
      config:
        - subnet: 172.28.0.0/16   # change if it collides with your network
```

Do NOT use `host.docker.internal`: with `host-gateway` it resolves to the daemon's
default `docker0` bridge (172.17.0.1), *not* this pinned network's gateway, so a
tunnel bound to 172.28.0.1 would be unreachable (ECONNREFUSED 172.17.0.1). The app
container is on the `172.28.0.0/16` network, so `172.28.0.1` is its gateway (the
host) and is reachable directly.

Then set the connection string in `.env` (the loopback leg is inside SSH, so no TLS):

```
FLIST_DB_URL=postgres://<ro-user>:<ro-password>@172.28.0.1:15432/<db-name>?sslmode=disable
```

`FLIST_DB_URL` is optional: leave it unset and the status-check feature is simply
disabled (dev/test need no tunnel).

## 9. Verify from inside the container

```sh
docker compose up -d
docker compose exec app node -e '
  const net = require("net");
  const s = net.connect(15432, "172.28.0.1")
    .on("connect", () => { console.log("tunnel reachable"); s.end(); })
    .on("error", e => { console.error("unreachable:", e.message); process.exit(1); });
'
```

End-to-end (an actual `SELECT subscribed`) is exercised once the feature code
lands; this step only confirms the container can reach the tunnel.

## Operating notes

- Logs: `journalctl -u flist-tunnel.service -f`.
- Restart after config changes: `sudo systemctl restart flist-tunnel.service`.
- The unit restarts every 5s until the bind succeeds, so ordering vs. `docker
  compose up` (which creates the bridge) is self-healing.
