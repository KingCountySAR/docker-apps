# KCSARA Docker Environment

A consolidated/modular system to collect apps and core services for King County SAR, using Docker Compose.

## Base Services

- **Nginx and Certbot** allows many web apps to sit on the same machine with different hostnames with automated SSL certificates.
  - Sites are files in `nginx/sites/`, one per host name.
  - HTTPS only. Port 80 only answers Let's Encrypt and redirects to https. nginx terminates TLS and passes plain
  http to Hydra (which is why Hydra's log warns that "HTTPS is disabled").
  - Certificates take care of themselves. certbot gets each site's certificate once Let's Encrypt
  can reach it here (trying staging first, so waiting for DNS doesn't use up the real limits), and renews it.
  nginx loads each site once it has a certificate. When a site's file is removed, certbot deletes its certificate.
- **Postgres** is shared by the apps (`data/postgres/`), on the compose network at `postgres:5432`, never published.
  - Each app has its own database and user, which only it can connect to. Its `<app>-db` service makes them from
    the app's connection URL before the app starts (see [Adding a database](#adding-a-database)).
  - The superuser's password is in `config/postgres.env`, made by `bin/secrets.sh`.
- **Hydra** runs `serve all` on `oryd/hydra:v2.3.0`, with its database in Postgres.
  - `hydra-migrate` updates the database before Hydra starts, on every `docker compose up`.
  - Hydra's public API is on the internet, at https://jwt.kingcountysar.org: clients anywhere get tokens from
  `/oauth2/token` and check them with `/.well-known/jwks.json`.
  - Its host name, which is also the issuer in its tokens, is `urls.self.issuer` in `hydra/hydra.yml`, with its site
  in `nginx/sites/jwt.kingcountysar.org.conf`.
  - The admin API is never public. Hydra's admin port (4445) has no authentication. It's only on the compose
  network (`http://hydra:4445`) and the VM's loopback address. `node hydra.mjs` reaches it over ssh.
  - Configuration is in `hydra/hydra.yml` (in git, no secrets). The secrets are only on the VM, in
  `/srv/kcsara/config/hydra.env`, which `bin/secrets.sh` makes.
  - Machine-to-machine tokens only (`client_credentials`). There's no login and consent app, and none is planned:
  hydra.yml leaves `urls.login` and `urls.consent` at Hydra's defaults.
- **RAD portal** (profiles `rad` and `full`) at https://rad.kingcountysar.org: the
  [rad-portal](../rad-portal) app, run from its one-file build on `node:22-alpine`. Its MongoDB stays in Atlas. See
  [RAD portal](#rad-portal).
- **Monitoring** (profiles `monitoring` and `full`, on by default on the VM): Prometheus collects metrics and Grafana graphs
  them and alerts, from `monitoring/`. See [Monitoring](#monitoring).

## On a dev machine

`docker compose up` in this folder runs Hydra and Postgres, without nginx or certificates, using
`compose.override.yaml`: fixed dev secrets, `--dev` mode, issuer `http://localhost:4444/`, the admin API on
http://localhost:4445, and placeholder login/consent URLs on `http://localhost:3999/...`, out of the way of other dev
servers. Its database is in `data/` here (delete that folder to start over).

`node hydra.mjs --local <command>` runs Hydra's command line in that local stack, and `node db.mjs --local <database>`
opens psql there.

`docker compose --profile monitoring up` adds monitoring, with Grafana on http://localhost:3030 (admin, password
`dev-only`). Without nginx locally, the Sites dashboard stays empty, and on Docker Desktop cAdvisor sees only the
whole machine, not each container.

## On the VM

```
/srv/kcsara/
  compose.yaml, hydra/, nginx/,  from this repo (node deploy.mjs vm); nginx/ includes certbot's script
    postgres/, monitoring/, bin/
  .env                           COMPOSE_PROFILES: which profiles run (full, unless changed)
  apps/rad/                      the RAD portal's build, rad-portal.mjs (node deploy.mjs rad)
  config/                        settings and secrets: certbot.env and rad.env, and postgres.env, hydra.env, grafana.env and
                                 postgres-exporter.env (made by bin/secrets.sh)
  data/                          everything the services write
    postgres/                    the shared postgres: every app's database
    letsencrypt/                 certificates
    acme-challenge/              certbot's answers to Let's Encrypt's checks
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
5. **Configuration**, on the VM: `cp /srv/kcsara/config/certbot.env.example /srv/kcsara/config/certbot.env` and set an
   address for Let's Encrypt's expiry warnings.
6. **Test name.** Until `jwt.kingcountysar.org` points here, you can run Hydra under a test name (see
   [Testing under another name](#testing-under-another-name)).
7. **Start everything.** `node deploy.mjs vm` again, then `node deploy.mjs status`.
8. **DNS.** Point Hydra's host name (or the test name) at the VM's public IP. Within about 10 minutes certbot gets its certificate and
   nginx loads it: watch with `node deploy.mjs logs certbot` (`docker compose restart certbot` on the VM tries again
   right away). Until its DNS is ready, it just waits.
9. **Check it.** `https://<host>/.well-known/openid-configuration` shows the issuer and endpoints. To try a token,
   make a client with `node hydra.mjs create oauth2-client ...` (below), then
   `curl -u <client id>:<client secret> -d grant_type=client_credentials -d scope=<scope> https://<host>/oauth2/token`.
10. **Back up `config/`** somewhere safe (a password manager). Without `SECRETS_SYSTEM`, the database's
    client secrets and signing keys can't be read.

## Testing under another name

Test names stay out of git, as uncommitted changes in your working files (which is what `node deploy.mjs vm` sends):

1. Copy the site's file (like `nginx/sites/jwt.kingcountysar.org.conf`) to `nginx/sites/<test name>.conf` and change
   the three names in it.
   Add that file to `.git/info/exclude`, which keeps it out of git without naming it in `.gitignore`.
2. For Hydra only: change `urls.self.issuer` in `hydra/hydra.yml` to `https://<test name>/`. Don't commit that change.
3. Point the test name's DNS at the VM, then `node deploy.mjs vm`.

Hydra has one issuer at a time, and clients check it, so tokens from one name aren't accepted for another. Both sites
can be there at once, so the real name's certificate can be ready before switching.

**Switching the RAD portal to rad.kingcountysar.org**, once its DNS points here: delete the test site's file, run
`node deploy.mjs vm`, and remove the test name from the Google client's origins and from DNS.

**Switching to jwt.kingcountysar.org**, once its DNS points here:

1. Undo the change to `hydra/hydra.yml` (`git checkout hydra/hydra.yml`), delete the test site's file, and run
   `node deploy.mjs vm`. certbot deletes the test name's certificate within 10 minutes.
2. Change the apps using it to `https://jwt.kingcountysar.org/` (token URL and issuer). Their tokens from the test
   name stop being accepted, so they get new ones.
3. Remove the test name's DNS record.

## RAD portal

The `rad` service runs `apps/rad/rad-portal.mjs` on the VM, the whole app in one file from `npm run build` in the
rad-portal repo. nginx passes its sites (`nginx/rad.inc`) to it at `http://rad:3000`. Until the first build arrives,
it waits.

Setting it up:

1. **Configuration**, on the VM: `cp /srv/kcsara/config/rad.env.example /srv/kcsara/config/rad.env` and fill it in.
   `node deploy.mjs vm` stops until this file exists.
2. **Atlas**: add the VM's public IP to the cluster's IP access list.
3. **Google**: add `https://rad.kingcountysar.org` (and the test name's https address) to the OAuth client's
   Authorized JavaScript origins.
4. **The app**: `npm run build` in rad-portal, then `node deploy.mjs rad` here. It copies
   `../rad-portal/server/dist/rad-portal.mjs` (and its `.map`), or the path you give, and restarts the app.
5. Point the site's DNS at the VM, and run `node deploy.mjs vm` (see [Testing under another name](#testing-under-another-name)
   for kcsara-rad.kcesar.org).

Health checks ask for its `/health`.

## Removing a site

Delete its file from `nginx/sites/`, run `node deploy.mjs vm`, and remove its DNS record. certbot deletes its
certificate within 10 minutes (putting the file back gets a new one).

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
`http://hydra:4444` (public) and `http://hydra:4445` (admin), without going through nginx.

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
| `alloy` | Each site's requests, status codes, response times and bytes, counted from nginx's log (`monitoring/alloy/config.alloy`; nginx logs each request as JSON, `nginx/nginx.conf`) |
| `node-exporter` | The VM's CPU, memory, disk I/O and filesystems (not its network: see cadvisor) |
| `cadvisor` | Each service's CPU, memory, disk and network |
| `postgres-exporter` | Postgres's connections, database sizes and activity, as a read-only `postgres_exporter` user |
| `hydra` | Hydra's own request counts and times, per endpoint |
| `blackbox-exporter` | Health checks: each site in `nginx/sites/` over https from the VM (DNS, certificate and its expiry, an answer that isn't a server error), and Hydra's `/health/ready` |

A new site in `nginx/sites/` is checked and graphed without any other change: `bin/site-targets.sh` lists them for
Prometheus on each deploy. Each is checked at `/`, unless its file names a better address on a line of its own, like
Hydra's sites do: `# health: /health/ready`.

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
`root_url` in `monitoring/grafana/grafana.ini` to its address, and add its site to `nginx/sites/` (proxying to
`http://grafana:3000`).

### Choosing what runs

The core (postgres, hydra, nginx, certbot) always runs. Everything else is in profiles: each part in `full` and in its
own (`monitoring`, `rad`, and each app added later). Profiles only add services, so to leave one part out, list the others
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
| Change hydra.yml, nginx/, monitoring/ or compose.yaml | edit here, then `node deploy.mjs vm` (it restarts each service whose own configuration changed) |
| Deploy a new RAD portal build | `npm run build` in rad-portal, then `node deploy.mjs rad` |
| Open Grafana | `node grafana.mjs`, then http://localhost:3030 |
| See what's running | `node deploy.mjs status` |
| See a service's log | `node deploy.mjs logs hydra` (or `rad`, `postgres`, `nginx`, `certbot`, `grafana`, ...); `logs -f hydra` keeps watching |
| Upgrade Hydra | change the image tag in `compose.yaml` (read Ory's upgrade notes first), back up the database, `node deploy.mjs vm` |
| Back up a database | on the VM: `docker compose exec -T postgres pg_dump -U postgres <database> \| gzip > <database>-$(date +%F).sql.gz` (or `pg_dumpall` for all of them) |
| Open psql as the superuser | `node db.mjs <database>` (like `node db.mjs hydra`; no database for `postgres`). Add psql options after it, like `-c "<sql>"`, or `< file.sql` to run a file |
| See certificates | on the VM: `docker compose exec certbot certbot certificates` |

## Rotating Hydra's secret

In `config/hydra.env` on the VM, put the new secret first in `SECRETS_SYSTEM` with the old one after it
(`SECRETS_SYSTEM=<new>,<old>`), then `docker compose up -d hydra` there. Hydra encrypts with the first and can still
read with the others. See Ory's [secret rotation](https://www.ory.sh/docs/hydra/self-hosted/secrets-key-rotation) docs.
