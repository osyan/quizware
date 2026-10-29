# Shared proxy settings used by the quizware vhost(s).
# Copy this file to /etc/nginx/quizware_proxy.inc

proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Host $host;
# Enable TRUST_PROXY=1 in the app so rate limits see the real client IP.
proxy_read_timeout 75s;
proxy_send_timeout 75s;
