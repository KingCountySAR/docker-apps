# Respond (the respond service), for each of its host names in sites/. The app tells its organizations' sites apart by
# host name, so each name needs its own file there and must be one of an organization's host names in the app.
add_header Strict-Transport-Security "max-age=31536000" always;

location / {
    set $upstream http://respond:4000;
    proxy_pass $upstream;
}

# The live sync connection: a WebSocket. Setting any proxy header here drops all of default.conf's for this location,
# so they're repeated, Host above all (it picks the site). Clients ping every 15 seconds, well inside nginx's
# 60-second read timeout.
location = /api/sync {
    set $upstream http://respond:4000;
    proxy_pass $upstream;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
