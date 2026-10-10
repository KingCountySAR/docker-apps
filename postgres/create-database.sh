#!/bin/sh
# Makes sure an app's database and its own user exist in the shared postgres, with the password from the app's
# connection URL. Each app has a one-off <app>-db service in compose.yaml that runs this before the app starts, with
# the app's env file (for its URL) and config/postgres.env (for the postgres superuser's password).
#
#   DATABASE_URL_FROM   the name of the app's variable holding its URL, like DSN for Hydra:
#                       postgres://<user>:<password>@postgres:5432/<database>?...
#
# Safe to run every time: it creates what's missing, and sets the user's password to the one in the URL (so changing
# it in the app's env file and running `docker compose up -d` is enough). Other apps' users can't connect to the
# database. The password must not need URL encoding (bin/secrets.sh makes hex ones).
set -eu
: "${DATABASE_URL_FROM:?Set DATABASE_URL_FROM to the name of the variable with the database URL}"
url=$(printenv "$DATABASE_URL_FROM") || { echo "$DATABASE_URL_FROM isn't set" >&2; exit 1; }

rest=${url#*://}
credentials=${rest%%@*}
user=${credentials%%:*}
password=${credentials#*:}
database=${rest#*/}
database=${database%%\?*}

export PGHOST=postgres PGUSER=postgres PGPASSWORD="$POSTGRES_PASSWORD"
psql -q -v ON_ERROR_STOP=1 -v user="$user" -v password="$password" -v database="$database" << 'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'user') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'user') \gexec
ALTER ROLE :"user" WITH LOGIN PASSWORD :'password';
SELECT format('CREATE DATABASE %I OWNER %I', :'database', :'user')
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database') \gexec
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
SQL
echo "database $database ready for $user"
