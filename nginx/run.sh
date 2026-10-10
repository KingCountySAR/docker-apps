#!/bin/sh
# Runs nginx with nginx.conf, default.conf and each site in sites/ (<host>.conf) that has a certificate. nginx won't
# start with a missing certificate, so a site waits until the certbot container has its certificate. Every minute this
# checks for new or renewed certificates and changed configuration, and reloads nginx when something changed.
#
#   sh run.sh         start nginx (the container's command)
#   sh run.sh check   apply changes now (`node deploy.mjs vm` runs this)
set -u

src=/etc/kcsara-nginx
conf=/etc/nginx/conf.d
certs=/etc/letsencrypt/live
state_file=/tmp/sites.state

# A fingerprint of the configuration and the certificates, to notice changes.
state() {
  {
    cat "$src"/nginx.conf "$src"/default.conf "$src"/*.inc "$src"/sites/*.conf 2> /dev/null
    stat -L -c '%n %Y' "$certs"/*/fullchain.pem 2> /dev/null
  } | md5sum
}

# Copies nginx.conf into place, and default.conf and the sites with certificates into nginx's conf.d.
enable_sites() {
  # Without default.conf the configuration folder is missing or half-copied: change nothing.
  if [ ! -f "$src/default.conf" ]; then
    echo "no $src/default.conf; leaving nginx as it is (recreate this container if its folder was replaced)"
    return 1
  fi
  cp "$src/nginx.conf" /etc/nginx/nginx.conf
  rm -f "$conf"/*.conf
  cp "$src/default.conf" "$conf/default.conf"
  enabled="" waiting=""
  for site in "$src"/sites/*.conf; do
    [ -e "$site" ] || continue
    host=$(basename "$site" .conf)
    if [ -f "$certs/$host/fullchain.pem" ]; then
      cp "$site" "$conf/$host.conf"
      enabled="$enabled $host"
    else
      waiting="$waiting $host"
    fi
  done
  echo "nginx sites:${enabled:- none}${waiting:+ (waiting for certificates:$waiting)}"
}

# Applies changes since the last check, if any.
check() {
  now=$(state)
  [ "$now" = "$(cat "$state_file" 2> /dev/null)" ] && return 0
  enable_sites || return 1
  if nginx -t -q; then
    nginx -s reload && echo "nginx reloaded"
    echo "$now" > "$state_file"
  else
    echo "nginx configuration has errors; still running the previous one"
  fi
}

if [ "${1:-}" = check ]; then
  check
  exit
fi

enable_sites
state > "$state_file"
(
  while :; do
    sleep 60
    check
  done
) &
exec nginx -g 'daemon off;'
