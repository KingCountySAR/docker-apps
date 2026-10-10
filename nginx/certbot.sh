#!/bin/sh
# The certbot container's command. Gets a Let's Encrypt certificate for each site in nginx/sites/ (<host>.conf) that
# doesn't have one, as soon as Let's Encrypt can reach that host here, and renews certificates before they expire.
# Let's Encrypt checks through nginx's port 80 (/.well-known/acme-challenge/ in nginx/default.conf), and nginx/run.sh
# picks up new and renewed certificates.
#
# A host whose DNS doesn't point here yet is only tried against Let's Encrypt's staging server, whose limits are
# loose, so waiting for DNS doesn't use up the real limits.
# It's tried every 10 minutes; `docker compose restart certbot` tries right away.
#
# A certificate whose site is gone from nginx/sites/ is deleted, so it isn't renewed (and failing, once its DNS is
# gone) forever. Putting the site back gets a new one on the next try.
set -u
: "${CERTBOT_EMAIL:?Set CERTBOT_EMAIL in config/certbot.env, for certificate expiry notices}"

webroot=/var/www/certbot
last_renewal=0
trap 'exit 0' TERM INT

# Gives nginx a moment to start, the first time.
sleep 5

while :; do
  hosts=$(for site in /etc/kcsara-nginx/sites/*.conf; do [ -e "$site" ] && basename "$site" .conf; done)
  for host in $hosts; do
    [ -f "/etc/letsencrypt/live/$host/fullchain.pem" ] && continue
    get="certonly --webroot -w $webroot -d $host --cert-name $host --non-interactive --agree-tos -m $CERTBOT_EMAIL"
    if certbot $get --dry-run > /tmp/dry-run.log 2>&1; then
      echo "$host: Let's Encrypt can reach it; getting its certificate"
      certbot $get || echo "$host: getting the certificate failed; trying again in 10 minutes"
      rm -f "/tmp/waiting-$host"
    elif [ ! -f "/tmp/waiting-$host" ]; then
      # Said once per host, not every 10 minutes.
      echo "$host: Let's Encrypt can't reach it here yet (does its DNS point at this server?). Trying every 10 minutes."
      grep -m 2 -E 'Detail|Error' /tmp/dry-run.log
      touch "/tmp/waiting-$host"
    fi
  done

  # Certificates for sites that are gone. Not while the folder is half copied by `node deploy.mjs vm` (default.conf is
  # missing then too), or every certificate would look unused.
  if [ -f /etc/kcsara-nginx/default.conf ]; then
    for live in /etc/letsencrypt/live/*/; do
      [ -d "$live" ] || continue
      name=$(basename "$live")
      echo "$hosts" | grep -qxF "$name" && continue
      echo "$name: no site for it in nginx/sites/ any more; deleting its certificate"
      certbot delete --cert-name "$name" --non-interactive
    done
  fi

  # Twice a day, renew whatever expires within 30 days.
  now=$(date +%s)
  if [ $((now - last_renewal)) -ge 43200 ]; then
    certbot renew --webroot -w $webroot --quiet
    last_renewal=$now
  fi

  sleep 600 &
  wait $!
done
