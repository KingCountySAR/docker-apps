#!/bin/sh
# Backs up the VM to Azure Blob Storage with restic, in the backup service (see "Backups" in the README):
#   - every database in the shared postgres, as one pg_dumpall, tagged postgres
#   - the files that aren't in git: .env, config/, each app's config/, Caddy's certificates and Grafana's data, tagged
#     files
# then forgets backups the keep policy doesn't keep, and deletes their data. restic only uploads what's new since the
# last backup, and encrypts everything with RESTIC_PASSWORD first.
#
#   sh /scripts/backup.sh            one backup, now (node deploy.mjs backup)
#   sh /scripts/backup.sh schedule   one every day at 11:00 UTC (3 or 4 in the morning in Seattle), after the reports'
#                                    D4H load; the service's command
#
# Prometheus learns how each went from node-exporter, which reads /data/metrics (data/backup/metrics on the VM).
set -u
metrics=/data/metrics
mkdir -p "$metrics"

# Writes a metrics file whole, so node-exporter never reads half of one.
metric() {
  file=$1
  shift
  printf '%s\n' "$@" > "$metrics/$file.prom.tmp" && mv "$metrics/$file.prom.tmp" "$metrics/$file.prom"
}

step() { echo "== $*"; }

backup() {
  echo "Backup starting, $(date -u '+%F %T') UTC"
  step "Opening the repository, $RESTIC_REPOSITORY"
  # Made once, by hand (`node deploy.mjs backup -- init`): restic retries for minutes when Azure says the container
  # isn't there, so a backup can't tell that apart from a failure in time to make it.
  restic cat config > /dev/null
  case $? in
    0) ;;
    10) echo "There's no repository there yet: make it with node deploy.mjs backup -- init" >&2; return 1 ;;
    *) return 1 ;;
  esac
  step 'Backing up the databases (pg_dumpall)'
  PGPASSWORD=$POSTGRES_PASSWORD restic backup --verbose --tag postgres --stdin-filename postgres.sql \
    --stdin-from-command -- pg_dumpall -h postgres -U postgres || return 1
  # /kcsara is /srv/kcsara, read-only. Paths that aren't there (an app without config yet) are left out.
  paths=$(for p in /kcsara/.env /kcsara/config /kcsara/apps/*/config /kcsara/data/caddy /kcsara/data/grafana; do
    [ ! -e "$p" ] || echo "$p"
  done)
  step "Backing up the files: $(echo $paths)"
  # shellcheck disable=SC2086 # one path per word
  restic backup --verbose --tag files $paths || return 1
  step 'Forgetting the backups the keep policy drops, and deleting their data'
  restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune || return 1
  step 'Checking the repository'
  # The repository's own structure, not every byte (which would download it all).
  restic check || return 1
}

run() {
  if backup; then
    now=$(date +%s)
    size=$(restic stats --mode raw-data --json 2> /dev/null | sed -n 's/.*"total_size":\([0-9]*\).*/\1/p')
    metric backup-success \
      '# HELP kcsara_backup_last_success_timestamp_seconds When the last backup to Azure that succeeded ended.' \
      '# TYPE kcsara_backup_last_success_timestamp_seconds gauge' \
      "kcsara_backup_last_success_timestamp_seconds $now" \
      '# HELP kcsara_backup_repository_bytes What the backups take in Azure, all of them, compressed.' \
      '# TYPE kcsara_backup_repository_bytes gauge' \
      "kcsara_backup_repository_bytes ${size:-0}"
    ok=1
    echo "Backup done, $(date -u '+%F %T') UTC"
  else
    ok=0
    echo "Backup FAILED, $(date -u '+%F %T') UTC" >&2
  fi
  metric backup-run \
    '# HELP kcsara_backup_last_run_success Whether the last backup to Azure succeeded (1) or not (0).' \
    '# TYPE kcsara_backup_last_run_success gauge' \
    "kcsara_backup_last_run_success $ok"
  [ "$ok" = 1 ]
}

if [ "${1:-}" = schedule ]; then
  while true; do
    next=$(date -u -d "$(date -u +%Y-%m-%d) 11:00:00" +%s)
    now=$(date -u +%s)
    [ "$next" -gt "$now" ] || next=$((next + 86400))
    echo "Next backup: $(date -u -d "@$next" '+%F %T') UTC"
    sleep $((next - now))
    run
  done
else
  run
fi
