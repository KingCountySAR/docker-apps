# The RAD portal (the rad service), for each of its host names in sites/.
add_header Strict-Transport-Security "max-age=31536000" always;

location / {
    set $upstream http://rad:3000;
    proxy_pass $upstream;
}
