#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu VM: installs Docker and creates /srv/kcsara. Run it from your machine with
# `node deploy.mjs setup`, which runs it on the VM as your own (sudo-capable) user. Your next ssh login can then run
# docker without sudo. Secrets are made later, by bin/secrets.sh (`node deploy.mjs vm` runs it).
set -euo pipefail

root=/srv/kcsara

if ! command -v docker > /dev/null; then
  # Docker's own apt repository (https://docs.docker.com/engine/install/ubuntu/)
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
sudo usermod -aG docker "$USER"
# Containers' logs otherwise grow without limit.
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "log-driver": "local", "log-opts": { "max-size": "20m", "max-file": "5" } }' | sudo tee /etc/docker/daemon.json > /dev/null
  sudo systemctl restart docker
fi

sudo mkdir -p $root/config $root/data/postgres $root/data/caddy
sudo chown -R "$USER": $root
chmod 700 $root/config

echo "Done. Continue with the README's first-time setup."
