#!/bin/sh
# Writes monitoring/prometheus/sites.json: the https address of each site in nginx/sites/, for Prometheus's health
# checks (the sites job). `node deploy.mjs vm` runs it on the VM; Prometheus notices the change by itself.
set -eu
cd "$(dirname "$0")/.."
{
  printf '[{"targets": ['
  separator=''
  for site in nginx/sites/*.conf; do
    [ -e "$site" ] || continue
    printf '%s"https://%s/"' "$separator" "$(basename "$site" .conf)"
    separator=', '
  done
  printf ']}]\n'
} > monitoring/prometheus/sites.json.new
mv monitoring/prometheus/sites.json.new monitoring/prometheus/sites.json
