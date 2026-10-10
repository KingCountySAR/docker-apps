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
