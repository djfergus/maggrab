#!/bin/sh
# Firewall for the network namespace shared with link-resolver, which has no
# permission to change it. Allowed out: public internet on ALLOWED_TCP_PORTS and
# DNS to DNS_SERVERS. Allowed in: SERVICE_PORT from this Docker network.
set -eu

ALLOWED_TCP_PORTS="${ALLOWED_TCP_PORTS:-80,443}"
DNS_SERVERS="${DNS_SERVERS:-1.1.1.1,9.9.9.9}"
SERVICE_PORT="${SERVICE_PORT:-8080}"
READY_PORT="${READY_PORT:-8081}"
PRIVATE_RANGES="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4"
REJECT="REJECT --reject-with icmp-admin-prohibited"

ipt="iptables-legacy -w"
ip6t="ip6tables-legacy -w"

# Docker's embedded DNS rules are in the nat table, so only filter is changed
for table in "$ipt" "$ip6t"; do
  $table -P INPUT DROP
  $table -P OUTPUT DROP
  $table -P FORWARD DROP
  $table -F
done

# No IPv6 at all (Tailscale and other ULA addresses would be reachable through it)
$ip6t -A INPUT -i lo -j ACCEPT
$ip6t -A OUTPUT -o lo -j ACCEPT

$ipt -A INPUT -i lo -j ACCEPT
$ipt -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
subnet="$(ip -4 route show dev eth0 scope link | awk '{print $1; exit}')"
[ -n "$subnet" ]
$ipt -A INPUT -i eth0 -s "$subnet" -p tcp --dport "$SERVICE_PORT" -j ACCEPT

$ipt -A OUTPUT -o lo -j ACCEPT
$ipt -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for range in $PRIVATE_RANGES; do
  $ipt -A OUTPUT -d "$range" -j $REJECT
done
for server in $(echo "$DNS_SERVERS" | tr ',' ' '); do
  $ipt -A OUTPUT -d "$server" -p udp --dport 53 -j ACCEPT
  $ipt -A OUTPUT -d "$server" -p tcp --dport 53 -j ACCEPT
done
for port in $(echo "$ALLOWED_TCP_PORTS" | tr ',' ' '); do
  $ipt -A OUTPUT -o eth0 -p tcp --dport "$port" -j ACCEPT
done
$ipt -A OUTPUT -j $REJECT

echo "resolver-guard: firewall set, outbound TCP ports $ALLOWED_TCP_PORTS, DNS $DNS_SERVERS"

# link-resolver won't start until this port is open
exec nc -lk -s 127.0.0.1 -p "$READY_PORT" -e /bin/true
