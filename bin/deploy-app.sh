#!/bin/sh
# Deploys an app that brings its own compose.yaml, from a gzipped tar on standard input: the app's deploy/ folder
# (compose.yaml, app.json, ...) and its build's files, all in one folder. `node deploy.mjs app <repo>` sends it; a
# GitHub workflow can too, through an ssh key that may only run this (see "Apps with their own compose.yaml" in the
# README).
#
#   sh /srv/kcsara/bin/deploy-app.sh <name> < app.tar.gz
#
# The app lives in apps/<name>/:
#   current/          what was sent, run as the compose project <name>, swapped in whole on each deploy
#   previous/         the deploy before: to go back, swap the two folders and run `docker compose up -d` in current
#   config/           kept between deploys, made by hand: what compose.yaml's env_file entries name (../config/...),
#                     database.env (from `node deploy.mjs database <name>`), and compose.env, if any, for compose.yaml's
#                     own ${...} variables, like its host names on a test VM
# Nothing changes when what was sent doesn't check out: a wrong name, a compose.yaml compose can't read, or a config
# file it names that doesn't exist yet.
set -eu
name=${1:-}
case $name in
  '' | kcsara | -* | *[!a-z0-9-]*) echo "Give the app's name: lower case letters, digits and -, not kcsara" >&2; exit 1 ;;
esac
root=$(cd "$(dirname "$0")/.." && pwd)
app=$root/apps/$name

# apps/rad, apps/cedar, ... hold builds that the VM's own compose.yaml runs (node deploy.mjs <name>), not apps like this:
# files of their own, or (Respond) a current folder without a compose.yaml.
if [ -n "$(ls -A "$app" 2> /dev/null | grep -vxE 'config|current|previous|\.incoming')" ] ||
  { [ -d "$app/current" ] && [ ! -f "$app/current/compose.yaml" ]; }; then
  echo "$app is an app the VM's compose.yaml runs: deploy it with node deploy.mjs $name" >&2
  exit 1
fi

mkdir -p "$app/config"
cd "$app"
rm -rf .incoming
mkdir .incoming
tar -xz -C .incoming
fail() { rm -rf .incoming; echo "Not deployed: $1" >&2; exit 1; }

[ -f .incoming/compose.yaml ] || fail "no compose.yaml in what was sent"
# So a key for one app can't deploy another's repo by mistake.
grep -Eq "\"name\" *: *\"$name\"" .incoming/app.json 2> /dev/null || fail "app.json doesn't name the app $name"

{ echo "COMPOSE_PROJECT_NAME=$name"; [ ! -f config/compose.env ] || cat config/compose.env; } > .incoming/.env
(cd .incoming && docker compose config -q) || fail "compose.yaml doesn't check out, as above (a file it names in $app/config that isn't there yet?)"

# Brings its database and user up to date (the password in database.env), if it has one.
[ ! -f config/database.env ] || sh "$root/bin/app-database.sh" "$name"

rm -rf previous
[ ! -d current ] || mv current previous
mv .incoming current
cd current
# Recreated rather than left running: a container would keep the files of the folder now called previous.
docker compose up -d --force-recreate --remove-orphans
docker compose ps
