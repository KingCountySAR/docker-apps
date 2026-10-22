# KCSARA Reports (the reports service), for each of its host names in sites/.
add_header Strict-Transport-Security "max-age=31536000" always;

location / {
    set $upstream http://reports:3000;
    proxy_pass $upstream;
}
