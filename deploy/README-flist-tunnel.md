# F-List Postgres tunnel — setup

Sets up the persistent SSH tunnel the ledger uses to read F-List subscription
status (design: [../docs/8-flist-status-check.md](../docs/8-flist-status-check.md)).

**Model:** an unprivileged systemd service holds one long-lived `ssh -L` forward.
The local end binds to the ledger's pinned compose-network gateway
(`172.28.0.1:15432`), and the app container connects to that IP directly. The
far end is `127.0.0.1:5432` as seen from the F-List database host. The port is
never published on a public interface, and the app knows nothing about SSH — it
just sees a Postgres URL. A dropped tunnel makes checks report "unavailable"
(the feature is feature-gated and fails fast); systemd reconnects.

**F-List side:** Postgres runs as a Docker container on the database host. It
must publish its port on the host's loopback only, so the SSH forward has a
target and nothing else does. In F-List's compose file for the `db` service:

```yaml
    ports:
      - "127.0.0.1:5432:5432"
```

Connections arriving through that mapping reach Postgres from the container
bridge's gateway, not from `127.0.0.1`, so `pg_hba.conf`'s `trust` rules for
loopback do not apply and the read-only role authenticates with its password
(`md5`). Do not loosen `pg_hba.conf` to avoid that.

Placeholders to fill in: `<pg-box-host>`, `<ssh-user>`, `<ssh-port>`,
`<ro-user>`, `<ro-password>`, `<db-name>`.

---

## 1. Service account on the ledger host

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin flist-tunnel
sudo -u flist-tunnel mkdir -p /home/flist-tunnel/.ssh
sudo -u flist-tunnel chmod 700 /home/flist-tunnel/.ssh
```

(Skip this if you'd rather run the tunnel as an existing user — just set
`User=` in the unit accordingly.)

## 2. Dedicated tunnel keypair (no passphrase — it runs unattended)

```sh
sudo -u flist-tunnel ssh-keygen -t ed25519 -N '' \
  -f /home/flist-tunnel/.ssh/id_ed25519 -C 'flist-ledger-tunnel'
sudo -u flist-tunnel cat /home/flist-tunnel/.ssh/id_ed25519.pub
```

## 3. Have the sysadmin authorize that key — forward-only

Send the public key to whoever administers the database host. Ask them to add
it to `<ssh-user>@<pg-box-host>`'s `~/.ssh/authorized_keys` **restricted to the
Postgres forward** (no shell, no other ports):

```
restrict,port-forwarding,permitopen="127.0.0.1:5432" ssh-ed25519 AAAA... flist-ledger-tunnel
```

`restrict` turns off everything, including port forwarding, so
`port-forwarding` re-enables just that and `permitopen` limits it to Postgres.
This matters most when `<ssh-user>` is a privileged account (for example one in
the `docker` or `sudo` group): a leak of the tunnel key then grants nothing but
a pipe to Postgres.

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
sudo -u flist-tunnel ssh-keygen -l -F '[<pg-box-host>]:<ssh-port>' \
  -f /home/flist-tunnel/.ssh/known_hosts
```

Compare that fingerprint with the host's own, as reported by its admin:

```sh
ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub    # run on <pg-box-host>
```

When `<ssh-port>` is not 22, known_hosts stores the entry as
`[<pg-box-host>]:<ssh-port>`, and the lookup above must use that form. Keep the
`-t ed25519`: without it the scan also adds RSA and ECDSA keys you have not
verified. A missing or mismatched entry shows up in the journal as
`Host key verification failed`, with the unit restarting every 5s.

## 6. Test the forward by hand

This proves the whole path before the unit depends on it: SSH, the key
restriction, the F-List port mapping, and the read-only credential. The test
forward binds a spare port (`25432`) on the compose gateway, so it can run
alongside a live tunnel on `15432` and the ledger container can reach it.
`172.28.0.1` exists once the ledger's compose network is up (step 8). `ssh -N`
produces no output and stays open; that is success, so run the check in a
second shell.

```sh
# Terminal 1 — start the test forward (no output = working; Ctrl-C to stop):
sudo -u flist-tunnel ssh -N -o ExitOnForwardFailure=yes \
  -L 172.28.0.1:25432:127.0.0.1:5432 flist-db

# Terminal 2 — run a real read through it, from inside the app container,
# using the app's own driver and FLIST_DB_URL with only the port swapped:
docker compose exec app node -e '
  const pg = require("pg");
  const url = process.env.FLIST_DB_URL.replace(":15432/", ":25432/");
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  c.connect()
    .then(() => c.query("select current_user, inet_server_addr() as srv, (select count(*) from account) as accounts"))
    .then(r => { console.log(r.rows[0]); return c.end(); })
    .catch(e => { console.error("FAILED:", e.message); process.exit(1); });
'
```

`-L 172.28.0.1:25432:127.0.0.1:5432` means: listen on the ledger host at
`172.28.0.1:25432`, and forward whatever connects there — through SSH — to
`127.0.0.1:5432` **as seen from the database host**, which is the container's
loopback-only port mapping.

Reading failures:

- SSH errors in terminal 1: the key is not authorized (step 3) or the host key
  is not pinned (step 5).
- `ECONNREFUSED`: the test forward is not running, or the F-List `db` container
  does not publish `127.0.0.1:5432`.
- `password authentication failed`: `FLIST_DB_URL` holds the wrong password for
  `<ro-user>` on this database.

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

`compose.yaml` already pins the network subnet, so the gateway IP `172.28.0.1`
(where the tunnel binds) is deterministic, and passes `FLIST_DB_URL` through:

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

Set the connection string in `.env` (the hop is inside SSH, so no TLS):

```
FLIST_DB_URL=postgres://<ro-user>:<ro-password>@172.28.0.1:15432/<db-name>?sslmode=disable
```

After changing `.env`, recreate the container with `docker compose up -d app`;
a plain restart does not re-read it.

`FLIST_DB_URL` is optional: leave it unset and the status-check feature is simply
disabled (dev/test need no tunnel).

## 9. Verify end to end

Run the step 6 query again without the `.replace(...)`, which exercises the real
`15432` tunnel. Then click the F-List check on one mapped subscriber in the UI.

## Moving to a different F-List database host

The unit and the app's URL stay the same; only the tunnel's far end changes.

1. Make sure the new host meets the **F-List side** requirements above.
2. Authorize the tunnel key there (step 3) and pin its host key (step 5).
3. Add a temporary alias (say `flist-db-new`) for the new host in the tunnel
   user's SSH config and run step 6 against it. The live tunnel keeps serving
   the old host meanwhile.
4. Point the `flist-db` alias at the new host, delete the temporary alias, and
   `sudo systemctl restart flist-tunnel.service`. If the password differs,
   update `.env` and recreate the container (step 8).
5. Verify (step 9).
6. Clean up: remove the old host's known_hosts entry, and have the old host's
   admin remove the tunnel key. Cached F-List values checked while the ledger
   still pointed at a disconnected database are stale; have staff re-check.

Rollback before step 6 is pointing `flist-db` back and restarting the unit.

## Operating notes

- Logs: `journalctl -u flist-tunnel.service -f`.
- Restart after config changes: `sudo systemctl restart flist-tunnel.service`.
- The unit restarts every 5s until the bind succeeds, so ordering vs. `docker
  compose up` (which creates the bridge) is self-healing.
