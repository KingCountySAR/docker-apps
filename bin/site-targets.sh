#!/bin/sh
# Writes monitoring/prometheus/sites.json: the https address of each site in nginx/sites/, for Prometheus's health
# checks (the sites job). `node deploy.mjs vm` runs it on the VM; Prometheus notices the change by itself.
# A site is checked at / unless its file names another path, on a line of its own: `# health: /health/ready`.
set -eu
cd "$(dirname "$0")/.."
{
  printf '[{"targets": ['
  separator=''
  for site in nginx/sites/*.conf; do
    [ -e "$site" ] || continue
    health=$(sed -n 's|^[[:space:]]*#[[:space:]]*health:[[:space:]]*\(/[^[:space:]]*\).*|\1|p' "$site" | head -n 1)
    printf '%s"https://%s%s"' "$separator" "$(basename "$site" .conf)" "${health:-/}"
    separator=', '
  done
  printf ']}]\n'
} > monitoring/prometheus/sites.json.new
mv monitoring/prometheus/sites.json.new monitoring/prometheus/sites.json
