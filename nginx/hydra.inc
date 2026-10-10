# Hydra's public API, for each of its host names in sites/. Only the public port: the admin API (4445) is never
# reachable through nginx.
add_header Strict-Transport-Security "max-age=31536000" always;

location / {
    set $upstream http://hydra:4444;
    proxy_pass $upstream;
}
