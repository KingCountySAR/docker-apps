# KCSARA Docker Environment

A consolidated/modular system to collect apps and core services for King County SAR, using Docker Compose.

## Base Services

- **Caddy** lets many web apps sit on the same machine under different host names, with automatic certificates.
  - It's [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy): Caddy, plus a plugin that makes
  the sites from labels on the containers. A service with a site has `caddy` labels (its host names and where it
  listens) and a `kcsara.health` label (the path health checks ask for); `caddy/Caddyfile` has what every site
  shares. Caddy watches Docker, so a labelled container from any compose project on the `kcsara` network becomes a
  site, with nothing changed here.
  - HTTPS only: port 80 redirects to https. Caddy terminates TLS and passes plain http to the apps (which is why
  Hydra's log warns that "HTTPS is disabled").
  - Certificates take care of themselves. Caddy gets each site's certificate from Let's Encrypt once its DNS points
  here (trying Let's Encrypt's staging server while it can't, so waiting doesn't use up the real limits), and renews
  it. They're in `data/caddy/`.
- **Postgres** is shared by the apps (`data/postgres/`), on the compose network at `postgres:5432`, and the VM's own
  loopback address (for `node db.mjs --tunnel`), never outside.
  - Each app has its own database and user, which only it can connect to (see [Adding a database](#adding-a-database)).
  - The superuser's password is in `config/postgres.env`, made by `bin/secrets.sh`.
- **Hydra** runs `serve all` on `oryd/hydra:v2.3.0`, with its database in Postgres.
  - `hydra-migrate` updates the database before Hydra starts, on every `docker compose up`.
  - Hydra's public API is on the internet, at https://jwt.kingcountysar.org: clients anywhere get tokens from
  `/oauth2/token` and check them with `/.well-known/jwks.json`. Apps on the VM use `http://hydra:4444` instead.
  - Its host name, which is also the issuer in its tokens, is `urls.self.issuer` in `hydra/hydra.yml`, and its site
  is the `caddy` labels on the `hydra` service.
  - The admin API is never public. Hydra's admin port (4445) has no authentication. It's only on the compose
  network (`http://hydra:4445`) and the VM's loopback address. `node hydra.mjs` reaches it over ssh.
  - Configuration is in `hydra/hydra.yml` (in git, no secrets). The secrets are only on the VM, in
  `/srv/kcsara/config/hydra.env`, which `bin/secrets.sh` makes.
  - Machine-to-machine tokens only (`client_credentials`). There's no login and consent app, and none is planned:
  hydra.yml leaves `urls.login` and `urls.consent` at Hydra's defaults.
- **Monitoring** (profiles `monitoring` and `full`, on by default on the VM): Prometheus collects metrics and Grafana
  graphs them and alerts, from `monitoring/`. See [Monitoring](#monitoring).
- **Backups**: every day, the databases and the settings that aren't in git, to an
  Azure storage account, by restic. See [Backups](#backups).

The apps (the RAD portal, cedar, KCSARA Reports, Respond, ...) come from their own repos, each with its own
`compose.yaml` and its deploy notes (see [Apps](#apps)).

## On a dev machine

`docker compose up` in this folder runs Hydra and Postgres, without Caddy or certificates, using
`compose.override.yaml`: fixed dev secrets, `--dev` mode, issuer `http://localhost:4444/`, the admin API on
http://localhost:4445, and placeholder login/consent URLs on `http://localhost:3999/...`, out of the way of other dev
servers. Its database is in `data/` here (delete that folder to start over). Each app runs from its own repo
(`npm run dev` there), using this Hydra.

An app's build can also run in Docker here, on the same port as its `npm run dev` and on this stack's `kcsara`
network, where it reaches Hydra and the other apps as on the VM: `npm run docker -- up -d` in its repo, after
`npm run build` (`docker compose` with `deploy/compose.yaml` and `deploy/compose.local.yaml`; see each app's deploy
notes). Without Caddy here, `compose.yaml`'s labels do nothing.

`node hydra.mjs --local <command>` runs Hydra's command line in that local stack, and `node db.mjs --local <database>`
opens psql there.

`docker compose --profile monitoring up` adds monitoring, with Grafana on http://localhost:3030 (admin, password
`dev-only`). Without Caddy locally, the Sites dashboard stays empty, and on Docker Desktop cAdvisor sees only the
whole machine, not each container.

## On the VM

```
/srv/kcsara/
  compose.yaml, hydra/, caddy/,  from this repo (node deploy.mjs vm)
    postgres/, monitoring/, bin/
  .env                           COMPOSE_PROFILES: which profiles run (full, unless changed), and HYDRA_HOSTS if set
  apps/<name>/                   each app (rad, cedar, reports, respond), from its repo (node deploy.mjs app <repo>):
    current/                     what was sent: its compose.yaml and build, run as the compose project <name>
    previous/                    the deploy before
    config/                      its settings, kept between deploys: app.env, database.env, compose.env
  config/                        settings and secrets: caddy.env, and postgres.env, hydra.env, grafana.env and
                                 postgres-exporter.env (made by bin/secrets.sh)
  data/                          everything the services write
    postgres/                    the shared postgres: every app's database
    caddy/                       certificates, and Caddy's Let's Encrypt account
    prometheus/                  metrics, kept a year (or 10 GB)
    grafana/                     Grafana's users, settings and alert state
    backup/                      the backup's cache of what's in Azure, how the last one went, and restored files
```

`config/`, `data/` and each `apps/<name>/config/` are all there is to back up; everything else comes from this repo
or the apps' repos. The backup service backs them up to Azure every day (see [Backups](#backups)).

## First-time setup

1. **Firewall.** Allow ports 22, 80 and 443 to the VM. Check nothing else on it already uses 80 or 443:
   `sudo ss -ltnp | grep -E ':(80|443) '`.
2. **Your ssh login.** Check you can `ssh` to the VM, then put it in `.env` here as `DEPLOY_HOST` (copy
   `.env.example`), or give `--host` on each command.
3. **Docker and folders.** `node deploy.mjs setup` (it asks for your sudo password on the VM).
4. **Copy this folder's files over.** `node deploy.mjs vm`. It makes the secrets (`postgres.env`, `hydra.env`,
   `grafana.env`, `postgres-exporter.env`) with random values. This first time it stops after copying, and lists the
   configuration still missing.
5. **Configuration**, on the VM: `cp /srv/kcsara/config/caddy.env.example /srv/kcsara/config/caddy.env` and set an
   address for Let's Encrypt's expiry warnings; and `config/backup.env` (see [Setting them up](#setting-them-up)).
6. **Test name.** Until `jwt.kingcountysar.org` points here, you can run Hydra under a test name (see
   [Testing under another name](#testing-under-another-name)).
7. **Start everything.** `node deploy.mjs vm` again, then `node deploy.mjs status`.
8. **DNS.** Point Hydra's host name (or the test name) at the VM's public IP. Caddy gets its certificate within
   minutes: watch with `node deploy.mjs logs caddy`. Until its DNS is ready, it keeps trying, less and less often
   (`docker compose restart caddy` on the VM tries again right away).
9. **Check it.** `https://<host>/.well-known/openid-configuration` shows the issuer and endpoints. To try a token,
   make a client with `node hydra.mjs create oauth2-client ...` (below), then
   `curl -u <client id>:<client secret> -d grant_type=client_credentials -d scope=<scope> https://<host>/oauth2/token`.
10. **Back up `config/`** somewhere safe (a password manager). Without `SECRETS_SYSTEM`, the database's
    client secrets and signing keys can't be read. The daily backups have them too, from then on.
11. **The apps**: see [Apps](#apps), and each app's own deploy notes.

## Testing under another name

Hydra's host names are its `caddy` label, which takes them from `HYDRA_HOSTS` in `/srv/kcsara/.env` on the VM when
that's set; an app's come from `HOSTS` in its `apps/<name>/config/compose.env`. So a test name never needs a change in
git:

1. On the VM, add the test name, with the real one if it should keep working too:
   `HOSTS=rad.kingcountysar.org, kcsara-rad.kcesar.org` in `apps/rad/config/compose.env`.
2. For Hydra only: set its issuer to the test name too, as `URLS_SELF_ISSUER=https://<test name>/` in
   `/srv/kcsara/config/hydra.env` (it overrides `hydra/hydra.yml`).
3. Point the test name's DNS at the VM, then deploy again: `node deploy.mjs app ../<repo>` for an app,
   `node deploy.mjs vm` for Hydra.

Hydra has one issuer at a time, and clients check it, so tokens from one name aren't accepted for another.

To switch to the real name once its DNS points here, take the test name (and `URLS_SELF_ISSUER`) out again and
deploy. For Hydra, change the apps using it to the real issuer, including `JWT_ISSUER` in cedar's `app.env`; their
tokens from the test name stop being accepted, so they get new ones.

## Apps

Each app brings its own `compose.yaml`, in a `deploy/` folder in its repo. It runs as its own compose project, on
the `kcsara` network, and gets its site, health checks, metrics and database from this VM. Nothing here changes when
one is added or deployed.

**In the app's repo**, the `deploy/` folder:

```
deploy/
  app.json            { "name": "reports", "files": ["server/dist/db-reporting.mjs", "server/dist/db-reporting.mjs.map"] }
  compose.yaml
  compose.local.yaml  optional: runs the build in Docker on a dev machine (see On a dev machine)
  app.env.example     its settings, for config/app.env on the VM
```

`name` is the app's name on the VM (lower case letters, digits and `-`). `files` are its build's files or folders,
paths in the repo, which arrive next to `compose.yaml` under their own names, with everything else in `deploy/`.
`compose.yaml` is an ordinary compose file, with paths from its own folder:

```yaml
name: reports                       # the same as app.json's name

services:
  reports:                          # unique on the VM: it's also its name on the kcsara network
    image: node:22-alpine
    env_file: [../config/database.env, ../config/app.env]
    volumes:                        # only the build: the folder also has compose's .env
      - ./db-reporting.mjs:/app/db-reporting.mjs:ro
    working_dir: /app
    user: node
    command: [node, --enable-source-maps, db-reporting.mjs]
    labels:
      caddy: ${HOSTS:-reports.kingcountysar.org}
      caddy.import: site
      caddy.reverse_proxy: "{{upstreams 3000}}"
      kcsara.health: /health          # checked over https from the VM
      kcsara.metrics: 3000/metrics    # optional: collected by Prometheus (the apps job), labelled app and service
    restart: unless-stopped
    init: true

networks:
  default:
    name: kcsara
    external: true
```

Its other services (a nightly job, ...) go in the same file. Apps reach each other and Hydra by service name on the
`kcsara` network: `http://hydra:4444`, `http://cedar:3040`, `postgres:5432`. `../config/` is the app's own folder of
settings on the VM, kept between deploys; `${...}` variables come from `config/compose.env` there, if any (like
`HOSTS=` on a test VM).

**On the VM** it lives in `/srv/kcsara/apps/<name>/`: `current/` (what was sent), `previous/` (the deploy before) and
`config/`. Setting one up:

1. **Database**, if it needs one: `node deploy.mjs database <name>`. It makes `config/database.env` there, with
   `DATABASE_URL=postgres://<database>:<password>@postgres:5432/<database>` (the database is the name with `_` for
   `-`, or `node deploy.mjs database <name> <database>`), and the user and database in the shared postgres. Each
   deploy brings them up to date, so to change the password, edit the file and deploy.
2. **Settings**: `config/app.env`, from the app's `app.env.example`, and whatever else its `compose.yaml` names in
   `../config/`, made by hand on the VM.
3. **Deploy**: build it, then `node deploy.mjs app ../<repo>`. On the VM, `bin/deploy-app.sh` checks what arrived (the
   name in `app.json` and `compose.yaml`, and that compose can read `compose.yaml` with its config files there),
   brings the database up to date, swaps it in as `current/`, and recreates its containers. When the check fails,
   nothing changes.
4. **DNS** for its host names, pointed at the VM. Caddy finds its labels and gets a certificate by itself.

`node deploy.mjs logs <name>` shows all of its services' logs, and `node deploy.mjs status` lists it. To go back to
the deploy before, on the VM: in `apps/<name>/`, swap `current` and `previous`
(`mv current x && mv previous current && mv x previous`), then `docker compose up -d --force-recreate` in `current`.

**From GitHub** (not set up yet): a workflow builds the app and sends the same tar over ssh, with a key that can do
nothing but deploy that one app. In the deploying user's `~/.ssh/authorized_keys` on the VM:

```
command="sh /srv/kcsara/bin/deploy-app.sh reports",restrict ssh-ed25519 AAAA... reports-deploy
```

The key's private half and the VM's address go in the repo's GitHub secrets.

## Removing a site

Take its service's `caddy` labels out (or the service), deploy again, and remove its DNS record. Caddy stops serving
it at once; its certificate is left to expire. To remove a whole app, on the VM: `docker compose down` in
`apps/<name>/current`, then remove `apps/<name>/` (and its database, if it had one).

## Running Hydra commands

`node hydra.mjs <command>` runs `hydra <command>` in the hydra container on the VM, against the admin API.
`node hydra.mjs help` lists Hydra's commands.

| To | Run |
|---|---|
| List clients | `node hydra.mjs list oauth2-clients` |
| Add a machine-to-machine client | `node hydra.mjs create oauth2-client --name "<app>" --grant-type client_credentials --scope <scopes> --format json` |
| See or delete one | `node hydra.mjs get oauth2-client <id>`, `node hydra.mjs delete oauth2-client <id>` |
| Change a client's scopes, or give it a new secret | see [Changing a client](#changing-a-client) |

The client secret is shown only when the client is created: copy it to the app's configuration then.

### Changing a client

`hydra update oauth2-client` replaces the whole client: every flag you leave out goes back to its default. With only
`--scope`, the client loses its name and its `client_credentials` grant, and stops getting tokens. So change a client
by saving it to a file, editing that, and sending the whole file back:

1. Save it: `node hydra.mjs get oauth2-client <id> --format json-pretty > client.json`
2. Edit `client.json`:
   - **Scopes**: `"scope"` is one string with the scopes separated by spaces, like `"scope": "read write"`. Tokens
     already issued keep their old scopes until they expire.
   - **A new secret**: add `"client_secret": "<new secret>"`. Make one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The file has no secret otherwise
     (Hydra keeps only a hash), and without one the client keeps its current secret.
3. Send it back: `node hydra.mjs update oauth2-client <id> --file /dev/stdin < client.json`. In PowerShell, where
   `<` doesn't work: `Get-Content client.json | node hydra.mjs update oauth2-client <id> --file /dev/stdin`.
4. Delete `client.json` if it has a secret in it.

A client has one secret at a time, so the old one stops working as soon as the new one is set, and the app gets
errors until its configuration has the new one. To change it without a gap, make a second client with the same scopes
(and audience), move the app to it, and then delete the old client.

Use PowerShell 7 (`pwsh`) for step 1: Windows PowerShell 5's `>` writes UTF-16, which Hydra can't read back.

Apps on the VM (on the `kcsara` network) call Hydra at `http://hydra:4444` (public) and `http://hydra:4445` (admin),
without going through Caddy.

## Adding a database

An app gets its own database and user in the shared postgres with `node deploy.mjs database <name>` (see
[Apps](#apps)). Hydra's, the one service here with a database, comes from its DSN in `config/hydra.env`, through
`hydra-db` (`postgres/create-database.sh`).

## Monitoring

Prometheus collects, every 30 seconds:

| From | What |
|---|---|
| `alloy` | Each site's requests, status codes, response times and bytes, counted from Caddy's log (`monitoring/alloy/config.alloy`; each site logs each request as JSON, `caddy/Caddyfile`) |
| `node-exporter` | The VM's CPU, memory, disk I/O and filesystems (not its network: see cadvisor) |
| `cadvisor` | Each service's CPU, memory, disk and network |
| `postgres-exporter` | Postgres's connections, database sizes and activity, as a read-only `postgres_exporter` user |
| `hydra` | Hydra's own request counts and times, per endpoint |
| `blackbox-exporter` | Health checks: each site over https from the VM (DNS, certificate and its expiry, an answer that isn't a server error), and Hydra's `/health/ready` |
| apps (the `apps` job) | Each app's own metrics, from containers with a `kcsara.metrics` label, labelled `app` and `service` |

A new site is checked and graphed without any other change: the `site-targets` service (`bin/site-targets.sh`)
lists, every minute, each host name in a container's `caddy` label at the path in its `kcsara.health` label (like
`/health/ready` for Hydra). A container without `kcsara.health` isn't checked. It lists the containers with a
`kcsara.metrics` label (a port and path, like `3000/metrics`) the same way, for the apps job.

**Grafana** is only on the VM's own loopback address. `node grafana.mjs` opens it at http://localhost:3030 through an
ssh tunnel, until Ctrl+C. Sign in as `admin`, with `GF_SECURITY_ADMIN_PASSWORD` from `config/grafana.env` on the VM.
Its dashboards, in the KCSARA folder:

- **Sites**: requests (in the time range, and per minute), 4xx and 5xx, response times (median and 95th percentile, and the app's own), per site
- **Host**: the VM's CPU, load, memory, filesystems and disks
- **Containers**: each service's CPU, memory, network and disk
- **Health**: health checks, certificate expiry, what Prometheus can reach, Postgres, and Hydra's token requests

The dashboards come from `monitoring/grafana/dashboards/`, so changes made in Grafana can't be saved over them. To
change one, edit it in Grafana, then copy its JSON (Edit → Settings → JSON Model) into that file, and deploy.

The health checks run from the VM itself, so they can't tell you the VM is down. Add one outside check of a site
(UptimeRobot, Grafana Cloud's free tier, or Azure Monitor) for that.

### Alerts

`monitoring/grafana/provisioning/alerting/rules.yaml` has the rules: a site down (only one that's been up in the last
week, so a site waiting for DNS doesn't count), Hydra's health check failing, Prometheus unable to collect from a
service, a site with over 5% server errors, a certificate with under 14 days left, a filesystem under 10% free, memory
under 10% available, the CPU over 90% for half an hour, and no backup in 2 days (always firing on a dev machine,
which has no backups). Grafana → Alerting → Alert rules shows them.

**They're not sent anywhere yet.** To send them, add a contact point (email or Slack) in Grafana → Alerting → Contact
points, and make it the default policy's in Notification policies. Email needs Grafana's `[smtp]` settings
(`GF_SMTP_*` in `config/grafana.env`); Slack needs only a webhook address.

### Signing in to Grafana with Google

1. Google Cloud console → APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.
   Authorized redirect URI: `http://localhost:3030/login/google`. In a project in your Google Workspace, an
   "Internal" consent screen lets only your organization's accounts in.
2. In `config/grafana.env` on the VM: `GF_AUTH_GOOGLE_ENABLED=true`, the client's id and secret, and
   `GF_AUTH_GOOGLE_ALLOWED_DOMAINS=<your Workspace domain>`. Then `docker compose up -d grafana` there.
3. People signing in for the first time are Viewers; make admins in Grafana → Administration → Users.

When Grafana gets a public site, add `https://<its host>/login/google` to the client's redirect URIs, set
`root_url` in `monitoring/grafana/grafana.ini` to its address, and give the `grafana` service `caddy` labels
(proxying to `grafana:3000`).

### Choosing what runs

The core (postgres, hydra, caddy, backup) always runs. Monitoring is in the `monitoring` profile, and in `full`.

| Command | Runs |
|---|---|
| `docker compose --profile monitoring up` | the core and monitoring |
| `docker compose up` | only the core |

On the VM, `COMPOSE_PROFILES` in `/srv/kcsara/.env` picks the profiles for every `docker compose` command there, comma
separated; `node deploy.mjs vm` sets it to `full` if it isn't set. Turning a profile off doesn't stop what's already
running: stop those by name too (like `docker compose --profile monitoring stop`). The apps aren't in profiles: each
runs in its own project, whatever this one's profiles.

## Backups

Every day at 11:00 UTC (3 or 4 in the morning in Seattle, after the reports' D4H load), the `backup` service backs up
to an Azure storage account, with [restic](https://restic.readthedocs.io/):

- **The databases**: every one in the shared postgres (the apps' and Hydra's), with their users, as one `pg_dumpall`,
  tagged `postgres`.
- **The files that aren't in git**: `.env`, `config/`, each `apps/<name>/config/`, Caddy's certificates
  (`data/caddy`) and Grafana's data (`data/grafana`), tagged `files`. Not Prometheus's metrics, which only cost old
  graphs to lose.

Each backup uploads only what's new since the last one, encrypted on the VM first with the repository's password. Then
restic forgets the backups the keep policy doesn't keep, and deletes their data: the last 7 days, 4 weeks and 12
months, one each (the policy is in `bin/backup.sh`). Prometheus gets how each went: the **Backup late** alert fires
when none has succeeded in 2 days.

### Setting them up

1. **Azure**: a storage account (Standard, locally-redundant is enough). In it, Data management → Data protection:
   turn on soft delete for blobs (14 days), so whatever is deleted, by the keep policy or by someone with the VM's key,
   can be brought back for a while. Step 3 makes the container.
2. **Settings**, on the VM: `config/backup.env`, from `config/backup.env.example`: the account's name and an access
   key, and `RESTIC_PASSWORD` (`openssl rand -base64 32`). **Keep a copy of the password off the VM**, in a password
   manager, with the account's name: without it the backups can't be read, by anyone.
3. **Start it**: `node deploy.mjs vm`, then make the repository (and its container) with
   `node deploy.mjs backup -- init`, then `node deploy.mjs backup` for the first backup now (otherwise the alert fires
   until 11:00 UTC).

### Looking at them

`node deploy.mjs backup -- <restic command>` runs restic in the backup service, with the repository and password from
`backup.env`:

| To | Run |
|---|---|
| Back up now | `node deploy.mjs backup` |
| List the backups | `node deploy.mjs backup -- snapshots` |
| List what's in one | `node deploy.mjs backup -- ls latest --tag files` (or a backup's id for `latest`) |
| See what they take in Azure | `node deploy.mjs backup -- stats --mode raw-data` |
| Read every byte back, to check | `node deploy.mjs backup -- check --read-data` (downloads all of it) |

### Restoring

On the VM, in `/srv/kcsara`. Restored files go to `data/backup/restore/` (`/data/restore` in the container), to copy
from:

- **Files**: `docker compose exec backup restic restore latest --tag files --target /data/restore` (add
  `--include /kcsara/config` for only that). They're under `data/backup/restore/kcsara/`.
- **A database**: the dump, out of the backup, then the one database's part of it, or all of it on an empty postgres:

  ```
  docker compose exec -T backup restic dump latest --tag postgres /postgres.sql > all.sql
  docker compose exec -T postgres psql -U postgres < all.sql
  ```

  Over existing databases, restoring all of it fails on what's already there: drop the database first
  (`DROP DATABASE <name>`), and restore only its part (from `\connect <name>` to the next `\connect`).

**On a new VM**: [First-time setup](#first-time-setup) steps 1 to 4 (which stop before anything starts), and
`config/backup.env` put back from your password manager. Then on the VM, in `/srv/kcsara`:

1. The files, into place before postgres first starts, so it starts with the old password:

   ```
   docker compose up backup-restic
   docker compose run --rm --no-deps backup restic restore latest --tag files --target /data/restore
   sudo cp -a data/backup/restore/kcsara/. .
   ```

2. The databases, into the new, empty postgres (it says the postgres user exists already, which is fine):

   ```
   docker compose up -d --wait postgres
   docker compose run --rm --no-deps -T backup restic dump latest --tag postgres /postgres.sql | docker compose exec -T postgres psql -U postgres
   ```

3. `node deploy.mjs vm`, then deploy each app (`node deploy.mjs app ../<repo>`): their settings are back already.

## Everyday

| To | Run |
|---|---|
| Change hydra.yml, caddy/, monitoring/ or compose.yaml | edit here, then `node deploy.mjs vm` (it restarts each service whose own configuration changed) |
| Deploy an app | `npm run build` in its repo, then `node deploy.mjs app ../<repo>` (like `../rad-portal`, `../cedar`, `../db-reporting`, `../respond-sync`) |
| Run something in an app's container | `node deploy.mjs exec <app> <service> -- <command>`, like a script in its build. Your terminal, or a file or pipe on standard input, reaches it. `--put <path>` (once per file or folder) copies files from here into a temporary folder in the container first, removed after: `'{put}'` in the command is that folder (quoted, for PowerShell) |
| Restart an app | `node deploy.mjs restart <app>` (or one of this project's services, like `restart hydra`) |
| Open Grafana | `node grafana.mjs`, then http://localhost:3030 |
| See what's running | `node deploy.mjs status` |
| See a service's log | `node deploy.mjs logs hydra` (or `postgres`, `caddy`, `grafana`, ...), or all of an app's services: `logs rad` (or `cedar`, `reports`, `respond`); `logs -f hydra` keeps watching |
| Upgrade Hydra | change the image tag in `compose.yaml` (read Ory's upgrade notes first), `node deploy.mjs backup`, `node deploy.mjs vm` |
| Back up now | `node deploy.mjs backup` (see [Backups](#backups)) |
| Dump one database to a file | on the VM: `docker compose exec -T postgres pg_dump -U postgres <database> \| gzip > <database>-$(date +%F).sql.gz` |
| Open psql as the superuser | `node db.mjs <database>` (like `node db.mjs hydra`; no database for `postgres`). Add psql options after it, like `-c "<sql>"`, or `< file.sql` to run a file |
| Run something here against an app's database | `node db.mjs --tunnel` (the VM's postgres at `localhost:15432`, until Ctrl+C), then use the app's URL with `localhost:15432` for `postgres:5432` |
| See certificates | on the VM: `sudo ls data/caddy/caddy/certificates/*/` |

## Rotating Hydra's secret

In `config/hydra.env` on the VM, put the new secret first in `SECRETS_SYSTEM` with the old one after it
(`SECRETS_SYSTEM=<new>,<old>`), then `docker compose up -d hydra` there. Hydra encrypts with the first and can still
read with the others. See Ory's [secret rotation](https://www.ory.sh/docs/hydra/self-hosted/secrets-key-rotation) docs.
