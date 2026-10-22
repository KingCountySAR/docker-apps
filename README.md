# KCSARA Docker Environment

A consolidated/modular system to collect apps and core services for King County SAR, using Docker Compose.

## Base Services

- **Caddy** lets many web apps sit on the same machine under different host names, with automatic certificates.
  - It's [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy): Caddy, plus a plugin that makes
  the sites from labels on the containers. A service with a site has `caddy` labels in `compose.yaml` (its host
  names and where it listens) and a `kcsara.health` label (the path health checks ask for); `caddy/Caddyfile` has
  what every site shares. Caddy watches Docker, so a labelled container from any compose project on the `kcsara`
  network becomes a site, with nothing changed here.
  - HTTPS only: port 80 redirects to https. Caddy terminates TLS and passes plain http to the apps (which is why
  Hydra's log warns that "HTTPS is disabled").
  - Certificates take care of themselves. Caddy gets each site's certificate from Let's Encrypt once its DNS points
  here (trying Let's Encrypt's staging server while it can't, so waiting doesn't use up the real limits), and renews
  it. They're in `data/caddy/`.
- **Postgres** is shared by the apps (`data/postgres/`), on the compose network at `postgres:5432`, never published.
  - Each app has its own database and user, which only it can connect to. Its `<app>-db` service makes them from
    the app's connection URL before the app starts (see [Adding a database](#adding-a-database)).
  - The superuser's password is in `config/postgres.env`, made by `bin/secrets.sh`.
- **Hydra** runs `serve all` on `oryd/hydra:v2.3.0`, with its database in Postgres.
  - `hydra-migrate` updates the database before Hydra starts, on every `docker compose up`.
  - Hydra's public API is on the internet, at https://jwt.kingcountysar.org: clients anywhere get tokens from
  `/oauth2/token` and check them with `/.well-known/jwks.json`.
  - Its host name, which is also the issuer in its tokens, is `urls.self.issuer` in `hydra/hydra.yml`, and its site
  is the `caddy` labels on the `hydra` service.
  - The admin API is never public. Hydra's admin port (4445) has no authentication. It's only on the compose
  network (`http://hydra:4445`) and the VM's loopback address. `node hydra.mjs` reaches it over ssh.
  - Configuration is in `hydra/hydra.yml` (in git, no secrets). The secrets are only on the VM, in
  `/srv/kcsara/config/hydra.env`, which `bin/secrets.sh` makes.
  - Machine-to-machine tokens only (`client_credentials`). There's no login and consent app, and none is planned:
  hydra.yml leaves `urls.login` and `urls.consent` at Hydra's defaults.
- **RAD portal** (profiles `rad` and `full`) at https://rad.kingcountysar.org: the
  [rad-portal](../rad-portal) app, run from its one-file build on `node:22-alpine`. Its MongoDB stays in Atlas. See
  [RAD portal](#rad-portal).
- **cedar** (profiles `cedar` and `full`) at https://cedar.kingcountysar.org: the [cedar](../cedar) API in front of
  other KCSARA systems (D4H, ...), for clients with tokens from Hydra. Also run from its one-file build. See
  [cedar](#cedar).
- **KCSARA Reports** (profiles `reports` and `full`) at https://reports.kingcountysar.org: the
  [db-reporting](../db-reporting) app, with its data in the shared Postgres, loaded from D4H through cedar every night.
  See [KCSARA Reports](#kcsara-reports).
- **Respond** (profiles `respond` and `full`), for now at https://respond-next.kcesar.org (a test name), later
  https://respond.kingcountysar.org and each organization's own host names: the [respond-sync](../respond-sync)
  (Mission Sync) app, with its data in the shared Postgres. Run from its build folder rather than one file. See
  [Respond](#respond).
- **Monitoring** (profiles `monitoring` and `full`, on by default on the VM): Prometheus collects metrics and Grafana graphs
  them and alerts, from `monitoring/`. See [Monitoring](#monitoring).

## On a dev machine

`docker compose up` in this folder runs Hydra and Postgres, without Caddy or certificates, using
`compose.override.yaml`: fixed dev secrets, `--dev` mode, issuer `http://localhost:4444/`, the admin API on
http://localhost:4445, and placeholder login/consent URLs on `http://localhost:3999/...`, out of the way of other dev
servers. Its database is in `data/` here (delete that folder to start over).

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
  .env                           COMPOSE_PROFILES: which profiles run (full, unless changed), and any <APP>_HOSTS
  apps/rad/                      the RAD portal's build, rad-portal.mjs (node deploy.mjs rad)
  apps/cedar/                    cedar's build, cedar.mjs (node deploy.mjs cedar)
  apps/reports/                  the reports' build, db-reporting.mjs (node deploy.mjs reports)
  apps/respond/                  Respond's build folder, current/ (and the one before, previous/) (node deploy.mjs respond)
  config/                        settings and secrets: caddy.env, rad.env, cedar.env, reports.env and respond.env, and
                                 postgres.env, hydra.env, reports-db.env, respond-db.env, grafana.env and
                                 postgres-exporter.env (made by bin/secrets.sh)
  data/                          everything the services write
    postgres/                    the shared postgres: every app's database
    caddy/                       certificates, and Caddy's Let's Encrypt account
    prometheus/                  metrics, kept a year (or 10 GB)
    grafana/                     Grafana's users, settings and alert state
```

`config/` and `data/` are all there is to back up; everything else comes from this repo.

## First-time setup

1. **Firewall.** Allow ports 22, 80 and 443 to the VM. Check nothing else on it already uses 80 or 443:
   `sudo ss -ltnp | grep -E ':(80|443) '`.
2. **Your ssh login.** Check you can `ssh` to the VM, then put it in `.env` here as `DEPLOY_HOST` (copy
   `.env.example`), or give `--host` on each command.
3. **Docker and folders.** `node deploy.mjs setup` (it asks for your sudo password on the VM).
4. **Copy this folder's files over.** `node deploy.mjs vm`. It makes the secrets (`postgres.env`, `hydra.env`,
   `grafana.env`, `postgres-exporter.env`) with random values. This first time it stops after copying, and lists the configuration still missing.
5. **Configuration**, on the VM: `cp /srv/kcsara/config/caddy.env.example /srv/kcsara/config/caddy.env` and set an
   address for Let's Encrypt's expiry warnings.
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
    client secrets and signing keys can't be read.

## Moving from nginx to Caddy (once)

A VM set up before Caddy has nginx and certbot. To move it over:

1. On the VM: `cd /srv/kcsara && sed s/CERTBOT_EMAIL/ACME_EMAIL/ config/certbot.env > config/caddy.env`.
2. Any test names in the old `nginx/sites/` become `<APP>_HOSTS` in `/srv/kcsara/.env` (see
   [Testing under another name](#testing-under-another-name)). Respond's, above all: add
   `RESPOND_HOSTS=respond-next.kcesar.org, rn-4x4.kcesar.org, rn-esar.kcesar.org`, or its sites disappear.
3. `node deploy.mjs vm`. It removes nginx and certbot and starts Caddy, which gets a new certificate for each site:
   each is unreachable until its certificate arrives, usually within a minute. Watch with `node deploy.mjs logs caddy`.
4. Once the Health dashboard shows every site up, remove what's left of nginx and certbot on the VM:
   `sudo rm -rf nginx data/letsencrypt data/acme-challenge config/certbot.env config/certbot.env.example`.

## Testing under another name

A site's host names are its service's `caddy` label, which takes them from `<APP>_HOSTS` in `/srv/kcsara/.env` on
the VM when that's set (`HYDRA_HOSTS`, `RAD_HOSTS`, `CEDAR_HOSTS`, `REPORTS_HOSTS`, `RESPOND_HOSTS`), so a test name never needs a change here:

1. On the VM, add the test name to `/srv/kcsara/.env`, with the real one if it should keep working too:
   `RAD_HOSTS=rad.kingcountysar.org, kcsara-rad.kcesar.org`.
2. For Hydra only: set its issuer to the test name too, as `URLS_SELF_ISSUER=https://<test name>/` in
   `/srv/kcsara/config/hydra.env` (it overrides `hydra/hydra.yml`).
3. Point the test name's DNS at the VM, then `docker compose up -d` in `/srv/kcsara` (or `node deploy.mjs vm`).

Hydra has one issuer at a time, and clients check it, so tokens from one name aren't accepted for another.

To switch to the real name once its DNS points here, take the test name (and `URLS_SELF_ISSUER`) out again and run
`docker compose up -d`. For Hydra, change the apps using it to the real issuer, including `JWT_ISSUER` in
`config/cedar.env`; their tokens from the test name stop being accepted, so they get new ones.

## RAD portal

The `rad` service runs `apps/rad/rad-portal.mjs` on the VM, the whole app in one file from `npm run build` in the
rad-portal repo. Caddy passes its site (its `caddy` labels) to it at `http://rad:3000`. Until the first build
arrives, it waits.

Setting it up:

1. **Configuration**, on the VM: `cp /srv/kcsara/config/rad.env.example /srv/kcsara/config/rad.env` and fill it in.
   `node deploy.mjs vm` stops until this file exists.
2. **Atlas**: add the VM's public IP to the cluster's IP access list.
3. **Google**: add `https://rad.kingcountysar.org` (and the test name's https address) to the OAuth client's
   Authorized JavaScript origins.
4. **The app**: `npm run build` in rad-portal, then `node deploy.mjs rad` here. It copies
   `../rad-portal/server/dist/rad-portal.mjs` (and its `.map`), or the path you give, and restarts the app.
5. Point the site's DNS at the VM, and run `node deploy.mjs vm`.

Health checks ask for its `/health`.

## cedar

The `cedar` service runs `apps/cedar/cedar.mjs` on the VM, built by `npm run build` in the cedar repo. Caddy passes
its site (its `caddy` labels) to it at `http://cedar:3040`. Until the first build arrives, it waits. Its routes,
scopes and settings are in cedar's README.

Setting it up:

1. **Configuration**, on the VM: `cp /srv/kcsara/config/cedar.env.example /srv/kcsara/config/cedar.env` and fill it
   in: the D4H token and team, and `JWT_ISSUER`, which must be Hydra's issuer exactly as in `hydra/hydra.yml`.
   `node deploy.mjs vm` stops until this file exists.
2. **The app**: `npm run build` in cedar, then `node deploy.mjs cedar` here. It copies `../cedar/dist/cedar.mjs` (and
   its `.map`), or the path you give, and restarts the app.
3. Point the site's DNS at the VM, and run `node deploy.mjs vm`.
4. **Clients**: make each one in Hydra with the scopes it needs, like
   `node hydra.mjs create oauth2-client --name "<app>" --grant-type client_credentials --scope d4h:members.read --format json`.

cedar gets Hydra's signing keys from Hydra itself, at `http://hydra:4444` on the compose network (`JWT_URL` in
`compose.yaml`), not through the internet. Tokens must still name `JWT_ISSUER` as their issuer.

Health checks ask for its `/health`.

## KCSARA Reports

The `reports` service runs `apps/reports/db-reporting.mjs` on the VM, built by `npm run build` in the db-reporting
repo. Caddy passes its site (its `caddy` labels) to it at `http://reports:3000`. Its data is in the shared postgres,
in the `reporting` database (user `reporting`), which `reports-db` makes from `config/reports-db.env`. `reports-etl`
runs the same file as `node db-reporting.mjs etl` every night at 10:00 UTC, loading D4H through cedar. Until the first
build arrives, both wait.

Setting it up:

1. **Configuration**, on the VM: `cp /srv/kcsara/config/reports.env.example /srv/kcsara/config/reports.env` and fill
   it in. `node deploy.mjs vm` makes `reports-db.env` itself, and stops until `reports.env` exists.
2. **Hydra client** for the ETL, with the scopes in db-reporting's `docs/DESIGN.md`:
   `node hydra.mjs create oauth2-client --name "db-reporting ETL" --grant-type client_credentials --scope d4h:members.read,d4h:groups.read,d4h:qualifications.read,d4h:activities.read --format json`.
   Its id and secret go in `reports.env` as `CEDAR_CLIENT_ID` and `CEDAR_CLIENT_SECRET`.
3. **Google**: add `https://reports.kingcountysar.org` to the OAuth client's Authorized JavaScript origins.
4. **The app**: `npm run build` in db-reporting, then `node deploy.mjs reports` here, then `node deploy.mjs vm`.
5. **The old database**, once: `npm run import:legacy` in db-reporting. It needs the VM's `reporting` database, which
   isn't reachable from outside the VM; how to get there is still to settle (see db-reporting's `docs/DEPLOY.md`).
6. **The first load from D4H**, rather than waiting for the night: on the VM,
   `docker compose exec reports-etl node db-reporting.mjs etl` (add `--force` when D4H has far fewer records than
   last time). Its output is in `node deploy.mjs logs reports-etl`.

Health checks ask for its `/health`.

## Respond

The `respond` service runs Respond, the [respond-sync](../respond-sync) (Mission Sync) repo's build. Unlike the
other apps it's a folder: `apps/respond/current/` holds `index.mjs` (the server), `public/` (the UI it serves) and
`seed.mjs` (the organizations import) and `import-legacy.mjs` (respond-next's data). `node deploy.mjs respond` swaps a new build in whole, keeping the one before as
`apps/respond/previous/`, and restarts it. Its data is in the shared postgres, in the `respond` database (user
`respond`), which `respond-db` makes from `config/respond-db.env`. Until the first build arrives, it waits.

Caddy passes its sites (its `caddy` labels) to it at `http://respond:4000`, with `/api/sync`, the app's live
connection, as a WebSocket. Every organization in Respond has its own site, told apart by host name, so each host
name is in two places: in the app (the organization's host names, from the seed file or the app's admin page) and in
`RESPOND_HOSTS` in `/srv/kcsara/.env` on the VM (comma separated; `respond.kingcountysar.org` when it isn't set).
A name in only one of them doesn't work: without it in `RESPOND_HOSTS` it has no certificate, and a name the app
doesn't know answers "No site is set up".

Setting it up:

1. **Configuration**, on the VM: `cp /srv/kcsara/config/respond.env.example /srv/kcsara/config/respond.env` and set
   `SITE_ADMINS`. `node deploy.mjs vm` makes `respond-db.env` itself (the database URL and `SECRETS_KEY`, which
   encrypts the providers' client secrets in the database: back it up with the rest of `config/`), and stops until
   `respond.env` exists.
2. **Hydra client** for member lookups through cedar:
   `node hydra.mjs create oauth2-client --name Respond --grant-type client_credentials --scope members.read,d4h:members.read --format json`.
   Its id and secret go in the seed file's cedar member provider, with cedar's and Hydra's addresses on the compose
   network: `"url": "http://cedar:3040"`, `"tokenUrl": "http://hydra:4444/oauth2/token"`.
3. **Google**: an OAuth client (Web application) whose Authorized redirect URIs list
   `https://<host name>/api/auth/callback` for each of Respond's sites. Its id and secret go in the seed file's sign-in
   provider, named by the top organization so every site under it uses it.
4. **The app**: `npm run build` in respond-sync, then `node deploy.mjs respond` here. It copies
   `../respond-sync/dist`, or the folder you give.
5. **The organizations**: `node deploy.mjs seed-respond <file>`, with a seed file kept out of git (it has the client
   secrets). It goes over ssh straight into `seed.mjs`, never onto the VM's disk; each provider and organization in it
   replaces the stored one with its id, and nothing else changes, so it's safe to run again. It restarts the app.
   See respond-sync's README for the file's shape. Each organization's `hostnames` must name its sites here.
6. **Sites**: each host name in `RESPOND_HOSTS` in `/srv/kcsara/.env` on the VM, its DNS pointed at the VM, then
   `node deploy.mjs vm`.
7. **respond-next's data** (once, at cut-over): `node deploy.mjs import-respond <folder> --dry-run`, then without
   `--dry-run`, with a folder from `mongoexport --jsonArray` of respond-next's `activities` and `locations`. Only those
   two files go over ssh, into the running app's container, which unpacks them to a temporary folder, imports them (`import-legacy.mjs`) and removes them, so they never
   land on the VM's disk. Activities and saved locations already there are skipped, so it's safe to run again; it
   restarts the app. The organizations need their `legacyId` from the seed first (see "Importing from respond-next"
   in respond-sync's README).

For now Respond runs under test names: `RESPOND_HOSTS=respond-next.kcesar.org, rn-4x4.kcesar.org, rn-esar.kcesar.org`.
**Moving to respond.kingcountysar.org** (and each organization's own names): add each one to `RESPOND_HOSTS`, its
DNS and its Google redirect URI, add it to its organization's host names in Respond, and `node deploy.mjs vm`. Then
remove the test name the same way: from the organization, `RESPOND_HOSTS`, Google and DNS. Once the names are
settled, they can be the default in `compose.yaml` instead.

Health checks ask for its `/health`.

## Removing a site

Take its service's `caddy` labels out (or the service), run `node deploy.mjs vm`, and remove its DNS record. Caddy
stops serving it at once; its certificate is left to expire.

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

Apps on the VM in another compose project can join the `kcsara` network (see `compose.yaml`) and call Hydra at
`http://hydra:4444` (public) and `http://hydra:4445` (admin), without going through Caddy.

## Adding a database

For an app that uses the shared postgres (`<app>` is its name):

1. Give it a connection URL with its own user, database and a hex password (no URL encoding), in its env file in
   `config/`: `postgres://<app>:<password>@postgres:5432/<app>`. Add making it to `bin/secrets.sh`, like hydra.env's.
2. Copy the `hydra-db` service in `compose.yaml` to `<app>-db`, with the app's env file first in `env_file` and
   `DATABASE_URL_FROM` set to the name of the variable holding the URL. Make the app depend on it:
   `depends_on: { <app>-db: { condition: service_completed_successfully } }`.
3. `node deploy.mjs vm`. `<app>-db` creates the user and database, and on every start sets the user's password to
   the one in the URL: to change it, change the URL and run `docker compose up -d` on the VM.

An app in a separate compose project uses it the same way: join the `kcsara` network and connect to `postgres:5432`.
Its `<app>-db` service still goes here.

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

A new site is checked and graphed without any other change: the `site-targets` service (`bin/site-targets.sh`)
lists, every minute, each host name in a container's `caddy` label at the path in its `kcsara.health` label (like
`/health/ready` for Hydra). A container without `kcsara.health` isn't checked.

**Grafana** is only on the VM's own loopback address. `node grafana.mjs` opens it at http://localhost:3030 through an
ssh tunnel, until Ctrl+C. Sign in as `admin`, with `GF_SECURITY_ADMIN_PASSWORD` from `config/grafana.env` on the VM.
Its dashboards, in the KCSARA folder:

- **Sites**: requests per second, 4xx and 5xx, response times (median and 95th percentile, and the app's own), per site
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
under 10% available, and the CPU over 90% for half an hour. Grafana → Alerting → Alert rules shows them.

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

The core (postgres, hydra, caddy) always runs. Everything else is in profiles: each part in `full` and in its
own (`monitoring`, `rad`, `cedar`, `reports`, `respond`, and each app added later). Profiles only add services, so to leave one part out, list the others
rather than using `full`.

| Command | Runs |
|---|---|
| `docker compose --profile full up` | everything |
| `docker compose --profile monitoring up` | the core and monitoring |
| `docker compose --profile monitoring --profile rad up` | the core, monitoring and the RAD portal |
| `docker compose up` | only the core |

On the VM, `COMPOSE_PROFILES` in `/srv/kcsara/.env` picks the profiles for every `docker compose` command there, comma
separated; `node deploy.mjs vm` sets it to `full` if it isn't set. Turning a profile off doesn't stop what's already
running: stop those by name too (like `docker compose --profile monitoring stop`).

A new optional part gets `profiles: [full, <its name>]` on each of its services.

## Everyday

| To | Run |
|---|---|
| Change hydra.yml, caddy/, monitoring/ or compose.yaml | edit here, then `node deploy.mjs vm` (it restarts each service whose own configuration changed) |
| Deploy a new RAD portal build | `npm run build` in rad-portal, then `node deploy.mjs rad` |
| Deploy a new cedar build | `npm run build` in cedar, then `node deploy.mjs cedar` |
| Deploy a new reports build | `npm run build` in db-reporting, then `node deploy.mjs reports` |
| Deploy a new Respond build | `npm run build` in respond-sync, then `node deploy.mjs respond` |
| Import Respond organizations | `node deploy.mjs seed-respond <file>` (see [Respond](#respond)) |
| Import respond-next's activities into Respond | `node deploy.mjs import-respond <folder> [--dry-run]` (see [Respond](#respond)) |
| Open Grafana | `node grafana.mjs`, then http://localhost:3030 |
| See what's running | `node deploy.mjs status` |
| See a service's log | `node deploy.mjs logs hydra` (or `rad`, `cedar`, `reports`, `reports-etl`, `respond`, `postgres`, `caddy`, `grafana`, ...); `logs -f hydra` keeps watching |
| Upgrade Hydra | change the image tag in `compose.yaml` (read Ory's upgrade notes first), back up the database, `node deploy.mjs vm` |
| Back up a database | on the VM: `docker compose exec -T postgres pg_dump -U postgres <database> \| gzip > <database>-$(date +%F).sql.gz` (or `pg_dumpall` for all of them) |
| Open psql as the superuser | `node db.mjs <database>` (like `node db.mjs hydra`; no database for `postgres`). Add psql options after it, like `-c "<sql>"`, or `< file.sql` to run a file |
| See certificates | on the VM: `sudo ls data/caddy/caddy/certificates/*/` |

## Rotating Hydra's secret

In `config/hydra.env` on the VM, put the new secret first in `SECRETS_SYSTEM` with the old one after it
(`SECRETS_SYSTEM=<new>,<old>`), then `docker compose up -d hydra` there. Hydra encrypts with the first and can still
read with the others. See Ory's [secret rotation](https://www.ory.sh/docs/hydra/self-hosted/secrets-key-rotation) docs.
