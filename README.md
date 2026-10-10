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
- **Postgres** (`data/postgres/`)
- **Hydra** runs `serve all` on `oryd/hydra:v2.3.0`, with its database in Postgres.
  - `hydra-migrate` updates the database before Hydra starts, on every `docker compose up`.
  - Hydra's public API is on the internet, at https://jwt.kingcountysar.org: clients anywhere get tokens from
  `/oauth2/token` and check them with `/.well-known/jwks.json`.
  - Its host name, which is also the issuer in its tokens, is `urls.self.issuer` in `hydra/hydra.yml`, with its site
  in `nginx/sites/jwt.kingcountysar.org.conf`.
  - The admin API is never public. Hydra's admin port (4445) has no authentication. It's only on the compose
  network (`http://hydra:4445`) and the VM's loopback address. `node hydra.mjs` reaches it over ssh.
  - Configuration is in `hydra/hydra.yml` (in git, no secrets). The secrets are only on the VM, in
  `/srv/kcsara/config/hydra.env`, which `setup-vm.sh` generates.
  - Machine-to-machine tokens only (`client_credentials`). There's no login and consent app, and none is planned:
  hydra.yml leaves `urls.login` and `urls.consent` at Hydra's defaults.

## On a dev machine

`docker compose up` in this folder runs Hydra and Postgres, without nginx or certificates, using
`compose.override.yaml`: fixed dev secrets, `--dev` mode, issuer `http://localhost:4444/`, the admin API on
http://localhost:4445, and placeholder login/consent URLs on `http://localhost:3999/...`, out of the way of other dev
servers. Its database is in `data/` here (delete that folder to start over).

`node hydra.mjs --local <command>` runs Hydra's command line in that local stack.

## On the VM

```
/srv/kcsara/
  compose.yaml, hydra/, nginx/   from this repo (node deploy.mjs vm); nginx/ includes certbot's script
  config/                        settings and secrets: hydra.env (made by setup-vm.sh), certbot.env
  data/                          everything the services write
    postgres/                    Hydra's database
    letsencrypt/                 certificates
    acme-challenge/              certbot's answers to Let's Encrypt's checks
```

`config/` and `data/` are all there is to back up; everything else comes from this repo.

## First-time setup

1. **Firewall.** Allow ports 22, 80 and 443 to the VM. Check nothing else on it already uses 80 or 443:
   `sudo ss -ltnp | grep -E ':(80|443) '`.
2. **Your ssh login.** Check you can `ssh` to the VM, then put it in `.env` here as `DEPLOY_HOST` (copy
   `.env.example`), or give `--host` on each command.
3. **Docker, folders and Hydra's secrets.** `node deploy.mjs setup` (it asks for your sudo password on the VM).
4. **Copy this folder's files over.** `node deploy.mjs vm`. This first time it stops after copying, and lists the
   configuration still missing.
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
10. **Back up `config/hydra.env`** somewhere safe (a password manager). Without `SECRETS_SYSTEM`, the database's
    client secrets and signing keys can't be read.

## Testing under another name

Test names stay out of git, as uncommitted changes in your working files (which is what `node deploy.mjs vm` sends):

1. Copy `nginx/sites/jwt.kingcountysar.org.conf` to `nginx/sites/<test name>.conf` and change the three names in it.
   Add that file to `.git/info/exclude`, which keeps it out of git without naming it in `.gitignore`.
2. Change `urls.self.issuer` in `hydra/hydra.yml` to `https://<test name>/`. Don't commit that change.
3. Point the test name's DNS at the VM, then `node deploy.mjs vm`.

Hydra has one issuer at a time, and clients check it, so tokens from one name aren't accepted for another. Both sites
can be there at once, so the real name's certificate can be ready before switching.

**Switching to jwt.kingcountysar.org**, once its DNS points here:

1. Undo the change to `hydra/hydra.yml` (`git checkout hydra/hydra.yml`), delete the test site's file, and run
   `node deploy.mjs vm`. certbot deletes the test name's certificate within 10 minutes.
2. Change the apps using it to `https://jwt.kingcountysar.org/` (token URL and issuer). Their tokens from the test
   name stop being accepted, so they get new ones.
3. Remove the test name's DNS record.

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

The client secret is shown only when the client is created: copy it to the app's configuration then.

Apps on the VM in another compose project can join the `kcsara` network (see `compose.yaml`) and call Hydra at
`http://hydra:4444` (public) and `http://hydra:4445` (admin), without going through nginx.

## Everyday

| To | Run |
|---|---|
| Change hydra.yml, nginx/ (sites, certbot) or compose.yaml | edit here, then `node deploy.mjs vm` (it restarts Hydra if hydra.yml changed) |
| See what's running | `node deploy.mjs status` |
| See a service's log | `node deploy.mjs logs hydra` (or `postgres`, `nginx`, `certbot`) |
| Upgrade Hydra | change the image tag in `compose.yaml` (read Ory's upgrade notes first), back up the database, `node deploy.mjs vm` |
| Back up the database | on the VM: `docker compose exec -T postgres pg_dump -U hydra hydra \| gzip > hydra-$(date +%F).sql.gz` |
| See certificates | on the VM: `docker compose exec certbot certbot certificates` |

## Rotating Hydra's secret

In `config/hydra.env` on the VM, put the new secret first in `SECRETS_SYSTEM` with the old one after it
(`SECRETS_SYSTEM=<new>,<old>`), then `docker compose up -d hydra` there. Hydra encrypts with the first and can still
read with the others. See Ory's [secret rotation](https://www.ory.sh/docs/hydra/self-hosted/secrets-key-rotation) docs.
