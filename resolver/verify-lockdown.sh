#!/bin/bash
# Proves a running link-resolver container is locked down. Usage: verify-lockdown.sh [container]
# Exits non-zero if anything that must be blocked is reachable, or the internet isn't.
set -uo pipefail

container="${1:-link-resolver}"

host_ip="$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
router="$(ip -4 route show default | awk '{print $3; exit}')"
tailscale="$(ip -4 -o addr show tailscale0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
own_ips="$(docker inspect "${container}-guard" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null)"

blocked=("$router:80" "$router:53" "$host_ip:22" "$host_ip:80" "$host_ip:445" "$host_ip:45001" "$host_ip:7807" "172.17.0.1:80" "169.254.169.254:80" "1.1.1.1:22" "8.8.8.8:53")
[ -n "$tailscale" ] && blocked+=("$tailscale:22")
# Every other container, on every Docker network
for ip in $(docker ps -q | xargs docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | tr ' ' '\n' | sort -u); do
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  [[ " $own_ips " == *" $ip "* ]] || blocked+=("$ip:80")
done

docker exec -i "$container" python3 - "${blocked[@]}" <<'PY'
import errno, os, re, socket, struct, sys

failures = 0

def report(ok, text):
    global failures
    failures += not ok
    print(("PASS " if ok else "FAIL ") + text)

def attempt(host, port):
    """None if connected, else the errno (or 'timeout')."""
    try:
        socket.create_connection((host, int(port)), timeout=6).close()
        return None
    except socket.timeout:
        return "timeout"
    except OSError as e:
        return e.errno

# Our firewall's rejection only: a closed port (refused) means the packet got through
FIREWALLED = (errno.EHOSTUNREACH, errno.EACCES, errno.EPERM)

with open("/proc/net/route") as f:
    gateway = next(socket.inet_ntoa(struct.pack("<L", int(p[2], 16)))
                   for p in (line.split() for line in f) if p[1] == "00000000")

for target in sys.argv[1:] + [f"{gateway}:80"]:
    host, port = target.rsplit(":", 1)
    result = attempt(host, port)
    report(result in FIREWALLED, f"blocked {target} ({errno.errorcode.get(result, result)})")

for host, port in (("1.1.1.1", 443), ("downup.me", 443), ("s3.downup.me", 183)):
    result = attempt(host, port)
    report(result is None, f"reachable {host}:{port} ({result})")

with open("/proc/self/status") as f:
    caps = re.search(r"CapEff:\s+(\w+)", f.read()).group(1)
report(int(caps, 16) == 0, f"no Linux capabilities (CapEff {caps})")
report(os.getuid() != 0, f"not root (uid {os.getuid()})")
try:
    open("/opt/resolver/server.py", "a").close()
    report(False, "filesystem is read-only")
except OSError:
    report(True, "filesystem is read-only")
try:
    with open("/proc/net/if_inet6") as f:
        addrs = [l for l in f if not l.split()[0].startswith("00000000000000000000000000000001")]
except OSError:
    addrs = []
report(not addrs, f"no IPv6 addresses ({len(addrs)})")

print(f"{failures} failed")
sys.exit(1 if failures else 0)
PY
