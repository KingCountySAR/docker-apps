# cedar's API (the cedar service), for each of its host names in sites/.
add_header Strict-Transport-Security "max-age=31536000" always;

location / {
    set $upstream http://cedar:3040;
    proxy_pass $upstream;
}
