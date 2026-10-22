#!/bin/sh
# The site-targets service's command (monitoring/compose.yaml): every minute, writes /targets/sites.json, the https
# address of each site for Prometheus's health checks (the sites job), from the labels on Docker's containers: each
# host name in a container's caddy label, at the path in its kcsara.health label. Stopped containers count too, so a
# site whose app is down is checked (and fails) rather than forgotten; one whose container is removed is dropped.
# Prometheus notices the file changing by itself.
set -u
trap 'exit 0' TERM INT

while :; do
  {
    printf '[{"targets": ['
    separator=''
    docker ps -a --filter label=kcsara.health --format '{{.Label "caddy"}}|{{.Label "kcsara.health"}}' |
      while IFS='|' read -r hosts health; do
        for host in $(echo "$hosts" | tr ',' ' '); do
          echo "https://$host$health"
        done
      done | sort -u | {
        while read -r target; do
          printf '%s"%s"' "$separator" "$target"
          separator=', '
        done
      }
    printf ']}]\n'
  } > /targets/sites.json.new && mv /targets/sites.json.new /targets/sites.json

  sleep 60 &
  wait $!
done
