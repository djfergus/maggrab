# Sets the firewall for the network it shares with link-resolver
FROM alpine:3.22
RUN apk add --no-cache iptables iptables-legacy
COPY guard.sh /guard.sh
LABEL app=link-resolver
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD nc -z 127.0.0.1 8081
ENTRYPOINT ["/bin/sh", "/guard.sh"]
