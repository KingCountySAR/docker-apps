#!/bin/sh
# Makes the secret config files that don't exist yet, with random values. `node deploy.mjs vm` runs it on the VM before
# starting anything; files that exist are left alone. Never remake hydra.env on a running server: SECRETS_SYSTEM
# encrypts what's in Hydra's database (see "Rotating Hydra's secret" in the README).
set -eu
cd "$(dirname "$0")/../config"
umask 077
random() { openssl rand -hex "$1"; }

if [ ! -f postgres.env ]; then
  cat > postgres.env << END
# Made by bin/secrets.sh. The shared postgres's superuser (postgres) password. Each app has its own user and database
# (see postgres/create-database.sh). Postgres only sets this when it first creates data/postgres.
POSTGRES_PASSWORD=$(random 24)
END
  echo "made config/postgres.env"
fi

if [ ! -f hydra.env ]; then
  cat > hydra.env << END
# Made by bin/secrets.sh. hydra-db creates the hydra user and database from DSN, with its password.
DSN=postgres://hydra:$(random 24)@postgres:5432/hydra?sslmode=disable
SECRETS_SYSTEM=$(random 32)
END
  echo "made config/hydra.env"
fi

if [ ! -f postgres-exporter.env ]; then
  cat > postgres-exporter.env << END
# Made by bin/secrets.sh. postgres-exporter-db creates this user, with pg_monitor's read-only access, from the URL.
DATA_SOURCE_NAME=postgres://postgres_exporter:$(random 24)@postgres:5432/postgres?sslmode=disable
END
  echo "made config/postgres-exporter.env"
fi

if [ ! -f respond-db.env ]; then
  cat > respond-db.env << END
# Made by bin/secrets.sh. respond-db creates the respond user and database from DATABASE_URL, with its password.
DATABASE_URL=postgres://respond:$(random 24)@postgres:5432/respond
# Encrypts the client secrets of Respond's member and sign-in providers in its database: 32 random bytes, in base64.
# Without it they can't be read, and have to be entered again.
SECRETS_KEY=$(openssl rand -base64 32)
END
  echo "made config/respond-db.env"
fi

if [ ! -f grafana.env ]; then
  cat > grafana.env << END
# Made by bin/secrets.sh. Grafana's settings as GF_<SECTION>_<KEY>, overriding monitoring/grafana/grafana.ini.
# The admin login (user admin). Grafana sets it only when it first creates data/grafana: after that, change it in
# Grafana (or with \`docker compose exec grafana grafana cli admin reset-admin-password <new>\`).
GF_SECURITY_ADMIN_PASSWORD=$(random 16)

# Google sign-in (see "Signing in to Grafana with Google" in the README): the OAuth client's id and secret, and the
# Google Workspace domain whose accounts may sign in. Then GF_AUTH_GOOGLE_ENABLED=true and \`docker compose up -d grafana\`.
#GF_AUTH_GOOGLE_ENABLED=true
#GF_AUTH_GOOGLE_CLIENT_ID=
#GF_AUTH_GOOGLE_CLIENT_SECRET=
#GF_AUTH_GOOGLE_ALLOWED_DOMAINS=
END
  echo "made config/grafana.env"
fi
