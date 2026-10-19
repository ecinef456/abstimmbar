---
title: Installation
description: Run Abstimmbar at your own institution — Docker Compose, Caddy, OIDC and LTI 1.3.
---

# Installation

Abstimmbar is free software (Apache-2.0) and runs as a **Docker Compose
stack** on your own Linux server: PostgreSQL, Django (uvicorn) and Caddy as
a reverse proxy with automatic HTTPS. Teachers sign in through your
institution's identity provider (OIDC, e.g. Keycloak); participants don't
need an account.

!!! info "Source of this page"
    The following text is the English version of the operations guide in
    the repository
    ([`docs/deployment.md`](https://github.com/virtUOS/abstimmbar/blob/main/docs/deployment.md),
    written in German). Integration into learning platforms such as Moodle
    is described on the page
    [LMS integration (LTI 1.3)](lti.md).

Abstimmbar runs in production as a Docker Compose stack modelled on
AusleihBar: **PostgreSQL + Django (uvicorn/ASGI) + Caddy** as a
TLS-terminating reverse proxy. There is no Keycloak in the stack — OIDC
points to your institution's IdP.

```
Browser ── https ──> Caddy ──> /api, /admin, /oidc, /lti, /p → uvicorn (Django)
                        │        /static, /media → volumes (file_server)
                        │        everything else → SPA build (volume frontend_data)
                        └── automatic TLS (Let's Encrypt) or your own certificates
```

The `app` image (Dockerfile in the repository root) already contains the
fully built SPA (multi-stage build: Node builds the frontend, the following
stage contains Django). On startup the container copies it into the
`frontend_data` volume, from which Caddy serves it directly. This means
there is no separate frontend build step on the host.

The first part is a **complete step-by-step guide for Rocky Linux 9**,
followed by Keycloak/LTI configuration, operational notes, everyday
commands, updates, certificates and backups.

---

## Installation on Rocky Linux 9 — step by step

A complete guide for a fresh **Rocky Linux 9 server**, written so that you
can follow it without prior Linux experience. Copy every command exactly.

**How it fits together (read this once):** Only one thing is installed on
the server — **Docker**. Docker downloads and runs all the building blocks
as *containers*: the database (**PostgreSQL**), the application
(**Django**) and the web server with HTTPS (**Caddy**). PostgreSQL and
Caddy are **not** installed by hand, and Caddy obtains its HTTPS
certificate from Let's Encrypt automatically. Everything is reachable under
one address, e.g. `https://abstimmbar.example.org` — participants use
`https://abstimmbar.example.org/p/` or the QR code from presentation mode.

**What you need beforehand:**

- A server running Rocky Linux 9 and a user with `sudo` rights (or `root`
  — in that case, leave out the `sudo` in front of the commands).
- A **domain name** (e.g. `abstimmbar.example.org`) for which you can
  create a DNS record. HTTPS needs a real domain.
- The server's **public IP address**.
- An **OIDC client** in your institution's Keycloak (details below; this
  can also be added later — the stack starts without a working login).

> Notation: lines starting with `sudo` are run in the server's terminal.
> In the `nano` editor you save with **Ctrl+O**, **Enter** and exit with
> **Ctrl+X**.

### Step 1 — Log in to the server

From your own computer:

```bash
ssh USER@SERVER-IP                # e.g. ssh admin@203.0.113.10
```

### Step 2 — Update the system and install basic tools

```bash
sudo dnf -y update
sudo dnf -y install git nano dnf-plugins-core
```

If `dnf update` installed a new kernel (typical on a fresh VM), **reboot
once now** so that the new kernel and its matching modules are running —
otherwise Docker can't set up its network rules in step 3 (see
[Troubleshooting](#troubleshooting)):

```bash
sudo reboot
```

### Step 3 — Install Docker

```bash
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo docker --version            # prints a version → Docker is running
```

(Optional, to drop the `sudo` in front of `docker`:
`sudo usermod -aG docker $USER`, then log out and back in. This guide keeps
`sudo` so that it works either way.)

### Step 4 — Open the firewall for web traffic

Caddy needs port **80** (for the certificate and the redirect to HTTPS)
and **443** (HTTPS).

Rocky uses **firewalld**; on a minimal installation it may be missing.
Install/enable it first (no effect if it's already there):

```bash
sudo dnf -y install firewalld
sudo systemctl enable --now firewalld
```

Then open the two web ports and reload:

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
sudo firewall-cmd --list-services      # must include 'http' and 'https'
```

> **Note:** Some servers (especially cloud or data-centre VMs) have no
> host firewall and filter traffic through an external **security group /
> network firewall** instead. If `firewall-cmd` still reports
> `FirewallD is not running` after the steps above — or you deliberately
> don't use firewalld — skip this step and have ports **80** and **443**
> opened in the external firewall instead.

### Step 5 — Point the domain at the server (DNS)

Ask whoever manages your DNS (at a university: the computing centre) to
create an **A record** for the domain pointing to the server's public IP
(and an **AAAA record** if IPv6 is available). Then check from the server:

```bash
sudo dnf -y install bind-utils        # provides the 'dig' command
dig +short abstimmbar.example.org     # must print the server's IP
```

Don't continue until the correct IP shows up here — that's exactly what
Let's Encrypt checks.

### Step 6 — Download the application

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone git@gitlab.uni-osnabrueck.de:virtuos/digitale-dienste/abstimmbar.git
cd abstimmbar
```

(For the internal repository the server needs an SSH key with read access,
or you use the HTTPS URL with credentials.)

### Step 7 — Create the configuration file

```bash
sudo cp .env.prod.example .env
openssl rand -base64 48              # copy the output — this becomes the secret key
sudo nano .env
```

In `nano`, set at least these values (replace every `...` and the example
domain; paste in the secret key you just generated):

```dotenv
# Public address of the instance (the same value twice)
PUBLIC_BASE_URL=https://abstimmbar.example.org
CSRF_TRUSTED_ORIGINS=https://abstimmbar.example.org

# Django
DJANGO_SECRET_KEY=PASTE-THE-GENERATED-SECRET-KEY-HERE
DJANGO_ALLOWED_HOSTS=abstimmbar.example.org

# Database — choose a long random password (e.g. openssl rand -base64 24)
POSTGRES_PASSWORD=a-strong-password-here

# Login (OIDC) — institutional Keycloak. OIDC_OP_ISSUER is enough, the
# endpoints come via discovery; details in the section "Keycloak client".
OIDC_RP_CLIENT_ID=abstimmbar
OIDC_RP_CLIENT_SECRET=...
OIDC_OP_ISSUER=https://sso.example.org/realms/example
# Members of this IdP group get Django admin on login (empty = off).
OIDC_ADMIN_GROUP=abstimmbar-admins
```

Save with **Ctrl+O**, **Enter**, exit with **Ctrl+X**.

### Step 8 — Configure the web server (Caddy)

**How Caddy gets installed:** not via `dnf` at all — Caddy runs as a
Docker container from the official `caddy:2` image, which Docker downloads
automatically when the stack starts (step 10). It is defined in
`docker-compose.prod.yml` (service `caddy`); there it opens ports 80/443
and stores its certificates in the `caddy_data` volume.

**Where the configuration lives:** in the file `Caddyfile` in the project
folder, i.e. `/opt/abstimmbar/Caddyfile`. The Compose file mounts it
**read-only into the container** — you edit it on the host, nothing needs
to be copied.

Change two things: the domain in the line `abstimmbar.example.org {` and
the `email` address at the top (Let's Encrypt sends expiry notices there):

```bash
cd /opt/abstimmbar
sudo nano Caddyfile
```

You do **not** set up certificates by hand — Caddy obtains and renews the
Let's Encrypt certificate automatically as soon as the domain and ports are
right. Apply later changes to the Caddyfile with
`sudo docker compose -f docker-compose.prod.yml restart caddy`.

### Step 9 — Allow file access under SELinux

Rocky Linux has SELinux enabled; without a label, a container may not read
files mounted from the host. Grant access to the path Caddy reads
(`frontend/dist` no longer exists — the SPA now lives in a Docker volume,
which needs no host permission):

```bash
sudo chcon -Rt container_file_t Caddyfile
```

### Step 10 — Start everything

Either build from source (Node builds the SPA, the Django image is created
right after — no separate frontend build step needed any more):

```bash
sudo docker compose -f docker-compose.prod.yml up -d --build
```

… or pull a published release image (no local build needed, faster; set
`ABSTIMMBAR_VERSION`, e.g. `v1.2.0`, in the `.env`, otherwise `latest` is
used):

```bash
sudo docker compose -f docker-compose.prod.yml pull
sudo docker compose -f docker-compose.prod.yml up -d
```

This downloads PostgreSQL and Caddy, runs the database migrations and
starts all services. Caddy fetches the HTTPS certificate (takes up to a
minute). Watch the logs:

```bash
sudo docker compose -f docker-compose.prod.yml logs -f      # Ctrl+C stops the output
```

Then open `https://abstimmbar.example.org` in the browser — the start page
of the management interface appears; `https://abstimmbar.example.org/p/`
shows the code entry for participants.

### Step 11 — Create the first admin account

A local break-glass account, independent of the IdP (useful in case OIDC
is ever unreachable):

```bash
sudo docker compose -f docker-compose.prod.yml exec app python manage.py createsuperuser
```

Follow the prompts (username, email, password); then log in at
`https://abstimmbar.example.org/admin/`. Teachers sign in as usual with
their university login (OIDC) on the start page; members of the group set
in `OIDC_ADMIN_GROUP` automatically get Django admin rights when they do.

### Does this survive a server reboot?

Yes — the setup is reboot-safe:

- Docker starts at boot (`systemctl enable docker`, step 3).
- All services have `restart: unless-stopped` — database, backend and
  Caddy come back up on their own after a reboot (unless you deliberately
  stopped the stack with `… down`).
- All data lives in persistent volumes: database (`postgres_data`),
  uploaded images (`media_data`), certificates (`caddy_data`). On startup,
  migrations and `collectstatic` run again automatically.
- The firewall rules were saved with `--permanent` (step 4).

To check:

```bash
sudo reboot
# log in again after the reboot, then:
cd /opt/abstimmbar
sudo docker compose -f docker-compose.prod.yml ps     # all services "running"
```

---

## Keycloak client (institutional IdP)

Client settings (confidential client, standard flow):

- **Redirect URI:** `https://<domain>/oidc/callback/`
- **Post-logout redirect URI:** `https://<domain>/`
- **Back-channel logout URL:** `https://<domain>/oidc/backchannel-logout/`
- Group membership mapper to the claim `groups` (for `OIDC_ADMIN_GROUP`)

In `.env`, `OIDC_OP_ISSUER` is enough (the endpoints come via discovery);
different endpoints can be set explicitly via `OIDC_OP_*`.

## LTI (Moodle/Stud.IP)

Register the LMS platforms as described in [lti.md](lti.md); the tool
endpoints are under `https://<domain>/lti/…`. Launching in a **new
window** is recommended. Only for iframe operation, set
`SESSION_COOKIE_SAMESITE=None` in `.env` (this enforces secure cookies).

## Monitoring (Prometheus/Grafana)

The usage figures from the admin statistics are optionally available to
Prometheus at `https://<domain>/metrics` (off as long as `METRICS_TOKEN`
is not set). Setup, metrics and example queries:
[monitoring.md](https://github.com/virtUOS/abstimmbar/blob/main/docs/monitoring.md).

## Operational notes

- **One backend process, no scale-out:** The SSE hub (ADR-0003) lives in
  process memory. Multiple uvicorn workers or replicas would split the
  connections — votes from worker A would never reach devices connected to
  worker B. One process handles ≥1000 participants (load test
  `scripts/loadtest.py`); more would require an external broker (e.g.
  Redis Pub/Sub) — deliberately deferred.
- **File descriptors:** SSE keeps one socket open per participant device;
  the Compose file sets `nofile` to 65536.
- **Graceful shutdown:** `--timeout-graceful-shutdown 5` is set because
  open SSE streams never end on their own — without the flag every restart
  would hang.
- **DB connections:** The psycopg pool (settings.py) caps at 20
  connections; PostgreSQL's default (100) needs no adjustment.
- **Mode statistics (privacy):** For the metric "sessions per day by
  Easy/Pro mode", `whoami` creates one row per session and day in
  `DailyModeSession` — only a SHA-256 hash of the session key is stored
  (never the raw key), in line with the anonymity promise. As a result the
  table grows by roughly one row per active session per day; see
  "Retention" below.
- **Tour statistics (privacy):** Starts, completions and cancellations of
  the guided tour are recorded only as daily counters in `TourDailyCount`
  (day, mode, start source or cancellation step, count) — with no link to
  persons or sessions and no timestamps. The table stays small (a few rows
  per day). Example rooms don't count towards the usage figures.

## Retention of the mode statistics

The `DailyModeSession` table grows continuously. A management command
deletes rows older than N days (default 400, i.e. a good academic year of
lead time):

```bash
cd /opt/abstimmbar
P="sudo docker compose -f docker-compose.prod.yml"
$P exec app python manage.py prune_mode_sessions            # default: 400 days
$P exec app python manage.py prune_mode_sessions --days 180 # shorter window
```

Recommended as a weekly cron job on the host, e.g. in
`/etc/cron.d/abstimmbar-prune` (Sunday 03:30):

```cron
30 3 * * 0 root cd /opt/abstimmbar && docker compose -f docker-compose.prod.yml exec -T app python manage.py prune_mode_sessions >/dev/null 2>&1
```

The job is optional — it only keeps the table small; without it the
application keeps working but collects (hashed) rows indefinitely.

## Everyday commands

Run all of these in the `/opt/abstimmbar` folder:

```bash
P="sudo docker compose -f docker-compose.prod.yml"
$P ps                 # what is running
$P logs -f            # live logs (Ctrl+C stops)
$P restart            # restart the application
$P down               # stop everything
$P up -d --build      # start / apply changes
```

There is one periodic job: the optional retention of the mode statistics
(see the section [Retention of the mode statistics](#retention-of-the-mode-statistics)).
Apart from that, Abstimmbar needs no scheduled maintenance tasks.

## Applying updates

Build from source:

```bash
cd /opt/abstimmbar
sudo git pull
sudo docker compose -f docker-compose.prod.yml up -d --build    # build + migrations + restart automatically
```

Or apply a published release image (no local build; set
`ABSTIMMBAR_VERSION` in the `.env` to the desired version, e.g.
`v1.3.0`):

```bash
cd /opt/abstimmbar
sudo docker compose -f docker-compose.prod.yml pull
sudo docker compose -f docker-compose.prod.yml up -d             # migrations + restart automatically
```

### New configuration variable? Update it in three places

`docker-compose.prod.yml` uses **no `env_file`** — every variable is passed
through individually under `environment:` as `${VAR}`. A variable that is
only in the `.env` but **not** in the `environment:` block never reaches
the container. So if an update brings a new setting, add it in three
places:

1. **`docker-compose.prod.yml`** → `environment:` of the `app` service
   (the place that is easy to forget),
2. **`.env.prod.example`** (documentation),
3. the real **`.env`** on the server, then `up -d app`.

**`VITE_API_BASE_URL`** is a special case and normally **not needed**: by
default the SPA uses relative URLs (same origin as the API, behind Caddy).
Set it only for a deliberately different setup (SPA and API on different
origins). Vite then bakes the value into the bundle **at build time** —
this only works if you build yourself (`up -d --build`); a published
release image has already been built with the default value and cannot be
reconfigured afterwards.

**`VITE_GUIDE_URL`** (optional) is the target of the "Guide" entry in the
app's "?" menu when the UI is in German; the default is the German guide
on the public project website
(`https://virtuos.github.io/abstimmbar/anleitung/`).
**`VITE_GUIDE_URL_EN`** (optional) does the same for the English UI; the
default is `https://virtuos.github.io/abstimmbar/en/guide/`. Like
`VITE_API_BASE_URL`, both values are fixed **at build time** (build
arguments of the `app` service, only effective with `up -d --build`).

Double-check what actually reaches the running container:

```bash
sudo docker compose -f docker-compose.prod.yml exec app env \
  | grep -oE "^(DJANGO_|OIDC_|POSTGRES_|AI_|CSRF|FRONTEND|SESSION)[A-Z_]*" | sort
```

## HTTPS certificates (Caddy), in plain terms

- Caddy obtains and **automatically renews** a free Let's Encrypt
  certificate for the domain in the `Caddyfile`. Nothing to do by hand.
  Requirements: ports **80 and 443** reachable from the internet, correct
  **DNS** (step 5) and a valid `email` in the `Caddyfile`.
- The certificates live in the Docker volume `caddy_data` — **include it
  in backups** so they survive a rebuild (otherwise Caddy simply issues
  new ones, but that is subject to Let's Encrypt's rate limits).
- No public domain (purely internal host)? Add the line `tls internal`
  inside the site block in the `Caddyfile` — Caddy then uses its own local
  CA instead of Let's Encrypt.

### Your own certificate (e.g. HARICA) instead of Let's Encrypt

If your university issues the certificate (HARICA, DFN, internal CA …),
point Caddy at the files instead of using automatic HTTPS:

1. Put the two PEM files on the host, outside the repository, so that the
   **private key is never committed**, e.g. under
   `/etc/abstimmbar/certs/`:
   - `abstimmbar.pem` — server certificate **with intermediate
     certificate(s)** (leaf first, then the CA chain), PEM format.
   - `abstimmbar.key` — the matching **private key**, PEM, **without a
     passphrase** (Caddy can't prompt for one).
2. Mount the directory into the Caddy container —
   `docker-compose.prod.yml` contains the (commented-out) line for this:
   ```yaml
   - /etc/abstimmbar/certs:/etc/caddy/certs:ro
   ```
3. In the `Caddyfile` site block, replace the automatic behaviour with a
   `tls` line using the **container** paths (certificate first, then the
   key):
   ```
   tls /etc/caddy/certs/abstimmbar.pem /etc/caddy/certs/abstimmbar.key
   ```
4. Label the directory for SELinux (Rocky) so the container may read it:
   ```bash
   sudo chcon -Rt container_file_t /etc/abstimmbar/certs
   ```
5. Apply with `sudo docker compose -f docker-compose.prod.yml up -d`
   (or `restart caddy`). In this mode renewal is **manual**: replace the
   files before they expire, then `restart caddy`. The global `email` is
   not used in this case.

## Backup

The data lives in the volumes `postgres_data` (database) and `media_data`
(uploaded images); `caddy_data` (certificates) is optional but saves you
from having certificates reissued:

```bash
cd /opt/abstimmbar
sudo docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U abstimmbar abstimmbar | gzip > abstimmbar-$(date +%F).sql.gz
sudo docker run --rm -v abstimmbar_media_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/abstimmbar-media-$(date +%F).tar.gz -C /data .
```

Create the dumps regularly (e.g. via cron) and copy them to another
system.

## Troubleshooting

### Docker doesn't start: missing netfilter kernel modules

**Symptom.** `sudo systemctl enable --now docker` fails;
`sudo journalctl -u docker --no-pager` shows lines like:

```
iptables ... -m addrtype ... Warning: Extension addrtype revision 0 not supported, missing kernel module?
iptables ... RULE_APPEND failed (No such file or directory)
failed to start daemon: Error initializing network controller ...
```

**Cause.** On startup Docker creates its NAT rules and needs kernel modules
such as `xt_addrtype`, `br_netfilter` and `nf_nat` for that. Minimal or
cloud images (e.g. OpenStack/Nova) often lack the `kernel-modules`
package, or `dnf update` (step 2) installed a new kernel without a reboot
— then the running kernel's directory doesn't match the installed modules.

**Check.** The diagnosis is confirmed if this prints "Module not found":

```bash
sudo modprobe xt_addrtype
```

**Fix.** Install the matching kernel modules and reboot (the reboot also
brings up the kernel that is current after the update):

```bash
sudo dnf -y install "kernel-modules-$(uname -r)" iptables-nft
sudo reboot
```

After the reboot, clear the failed start state and start Docker:

```bash
sudo systemctl reset-failed docker.service
sudo systemctl enable --now docker
sudo docker run --rm hello-world      # must print "Hello from Docker!"
```

If `dnf` reports that `kernel-modules-$(uname -r)` is already installed or
finds no match, the problem is purely the kernel/module mismatch after the
update — then the **reboot** alone is enough (skip the `dnf install`).

### No HTTPS: `ERR_SSL_PROTOCOL_ERROR` / Let's Encrypt timeout (firewall)

**Symptom.** The browser reports `ERR_SSL_PROTOCOL_ERROR`, and in the
Caddy logs certificate issuance fails:

```bash
sudo docker compose -f docker-compose.prod.yml logs caddy | grep -iE "challenge|obtain|error"
```
```
challenge failed ... "detail":"<IP>: Timeout during connect (likely firewall problem)"
could not get certificate from issuer ... acme:error:connection
```

**Cause.** Let's Encrypt validates via `http-01` (incoming port 80) or
`tls-alpn-01` (incoming port 443). Both challenges must reach the server
**from the public internet**. If you get the timeout, incoming 80/443 is
blocked. Without a certificate Caddy can't serve valid TLS on 443 →
`ERR_SSL_PROTOCOL_ERROR`. On OpenStack VMs there are **two** possible
blocks: the instance's **security group** (the default often only allows
SSH/22) and the data centre's **perimeter firewall**.

**Check.** DNS points to a public IP (`dig +short <domain>`), the ports
are listening locally (`sudo ss -tlnp | grep -E ':80|:443'`) — but a test
from outside the university network (e.g. a phone on mobile data) goes
nowhere.

**Fix.**

1. Open the **security group** (in Horizon: Network → Security Groups →
   Add Rule — ingress TCP 80 and 443 from `0.0.0.0/0`; optionally UDP 443
   for HTTP/3), or via the CLI:
   ```bash
   openstack security group rule create --proto tcp --dst-port 80  --remote-ip 0.0.0.0/0 <sg>
   openstack security group rule create --proto tcp --dst-port 443 --remote-ip 0.0.0.0/0 <sg>
   ```
2. If it stays closed, have the network team open the **perimeter
   firewall** for incoming TCP 80+443 to the server's IP.
3. Then trigger a fresh attempt and watch the logs:
   ```bash
   sudo docker compose -f docker-compose.prod.yml restart caddy
   sudo docker compose -f docker-compose.prod.yml logs -f caddy | grep -iE "obtain|certificate|error"
   ```
   Success: `certificate obtained successfully`.

> Note: Repeated failed attempts count towards Let's Encrypt's limit of
> "5 failed validations per account/hostname/hour". Sort out the firewall
> first, then restart — don't loop while 80/443 are still closed. If you
> see `rateLimited`, wait about an hour.
>
> If the service can't be publicly reachable at all, a **HARICA
> certificate** is the way to go instead of Let's Encrypt (see
> [Your own certificate](#your-own-certificate-eg-harica-instead-of-lets-encrypt))
> — it doesn't need any incoming internet access.

## Security checklist

- [ ] `DJANGO_DEBUG` is hard-wired to `0` in the production Compose file;
      strong `DJANGO_SECRET_KEY`; real `DJANGO_ALLOWED_HOSTS`.
- [ ] `PUBLIC_BASE_URL` and `CSRF_TRUSTED_ORIGINS` point to the real
      `https://` domain (`VITE_API_BASE_URL` only for a deliberately
      different setup, see
      [New configuration variable?](#new-configuration-variable-update-it-in-three-places)).
- [ ] Strong `POSTGRES_PASSWORD`; all secrets only in `.env` (never
      committed).
- [ ] OIDC points to the institutional IdP; `/oidc/callback/` and the
      back-channel logout URL are registered there.
- [ ] Regular backups of `postgres_data` and `media_data`.
- [ ] Only ports 80/443 are open; the services `db` and `app` are not
      published (`expose` instead of `ports`).
- [ ] Checked once that the stack comes back on its own after
      `sudo reboot`.
