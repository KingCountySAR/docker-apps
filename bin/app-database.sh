#!/bin/sh
# Gives an app with its own compose.yaml (see bin/deploy-app.sh) a database and user in the shared postgres. The first
# time, makes apps/<name>/config/database.env, with a random password:
#
#   DATABASE_URL=postgres://<database>:<password>@postgres:5432/<database>
#
# for the app's compose.yaml to name in env_file (../config/database.env). The database is the app's name with _ for
# -, unless given. Then, every time (deploy-app.sh runs it on each deploy), makes sure the database and user exist with
# that password, as postgres/create-database.sh does for the VM's own apps. To change the password, edit the file and
# deploy again.
#
#   sh /srv/kcsara/bin/app-database.sh <name> [database]
set -eu
name=${1:-}
case $name in
  '' | kcsara | -* | *[!a-z0-9-]*) echo "Give the app's name: lower case letters, digits and -, not kcsara" >&2; exit 1 ;;
esac
root=$(cd "$(dirname "$0")/.." && pwd)
env=$root/apps/$name/config/database.env

if [ ! -f "$env" ]; then
  database=${2:-$(echo "$name" | tr - _)}
  case $database in
    '' | [!a-z]* | *[!a-z0-9_]* | postgres | hydra | postgres_exporter) echo "Not a database name to use: $database" >&2; exit 1 ;;
  esac
  mkdir -p "$(dirname "$env")"
  (umask 077 && cat > "$env" << END
# Made by bin/app-database.sh: $name's database and user in the shared postgres, made from this URL (with its password).
DATABASE_URL=postgres://$database:$(openssl rand -hex 24)@postgres:5432/$database
END
  )
  echo "made $env"
elif [ -n "${2:-}" ]; then
  echo "$env already exists; leaving it as it is (its database, not $2)"
fi

# Run inside the postgres container, which has psql and the superuser's password: the URL, then the script, on its
# standard input, so the password isn't on any command line.
cd "$root"
{ echo 'set -a'; cat "$env"; echo 'set +a'; cat postgres/create-database.sh; } |
  docker compose exec -T -e DATABASE_URL_FROM=DATABASE_URL postgres sh -s
