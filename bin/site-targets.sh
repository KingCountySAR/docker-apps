#!/bin/sh
# The site-targets service's command (monitoring/compose.yaml): every minute, writes what Prometheus should collect
# from, from the labels on Docker's containers (the VM's own and any app's). Prometheus notices the files changing by
# itself. Stopped containers count too, so one that's down is checked (and fails) rather than forgotten; one that's
# removed is dropped.
#   /targets/sites.json     the https address of each site, for the health checks (the sites job): each host name in a
#                           container's caddy label, at the path in its kcsara.health label
#   /targets/metrics.json   each container's own metrics (the apps job): the port and path in its kcsara.metrics label,
#                           like 3000/metrics (/metrics when only a port), at the container's name on the kcsara
#                           network, labelled with its compose project (app) and service
set -u
trap 'exit 0' TERM INT

# Standard input's lines, joined with commas
join() {
  separator=''
  while read -r item; do
    printf '%s%s' "$separator" "$item"
    separator=', '
  done
}

# Writes standard input to the file, swapping it in whole.
write() {
  cat > "$1.new" && mv "$1.new" "$1"
}

while :; do
  targets=$(
    docker ps -a --filter label=kcsara.health --format '{{.Label "caddy"}}|{{.Label "kcsara.health"}}' |
      while IFS='|' read -r hosts health; do
        for host in $(echo "$hosts" | tr ',' ' '); do
          echo "\"https://$host$health\""
        done
      done | sort -u | join
  )
  printf '[{"targets": [%s]}]\n' "$targets" | write /targets/sites.json

  # Not one-off containers (docker compose run), which have their service's labels too.
  groups=$(
    docker ps -a --filter label=kcsara.metrics \
      --format '{{.Names}}|{{.Label "kcsara.metrics"}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.oneoff"}}' |
      while IFS='|' read -r container metrics project service oneoff; do
        [ "$oneoff" != True ] || continue
        port=${metrics%%/*}
        path=${metrics#"$port"}
        printf '{"targets": ["%s:%s"], "labels": {"__metrics_path__": "%s", "app": "%s", "service": "%s"}}\n' \
          "$container" "$port" "${path:-/metrics}" "$project" "$service"
      done | sort | join
  )
  printf '[%s]\n' "$groups" | write /targets/metrics.json

  sleep 60 &
  wait $!
done
