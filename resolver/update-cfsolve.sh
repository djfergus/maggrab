#!/bin/bash
# Daily job: installs the newest cfsolve commit if it passes its tests in lockdown.
# A version that fails is never installed, and the current one keeps running.
set -uo pipefail

RESOLVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$RESOLVER_DIR")"
STATE="$RESOLVER_DIR/.update"
MAGGRAB_API="http://localhost:45001/api"
UPSTREAM_API="https://api.github.com/repos/chris124567/cfsolve/commits/HEAD"
CANDIDATE=link-resolver-candidate
SELF_TEST_WAIT=240
MAX_COOLDOWN_WAIT=3900

mkdir -p "$STATE"
exec >>"$STATE/update.log" 2>&1
exec 9>"$STATE/lock"
flock -n 9 || { echo "$(date -u) already running"; exit 0; }
echo "=== $(date -u)"

read_env() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -1; }

notify() {
  local token chat enabled
  token="$(read_env TELEGRAM_BOT_TOKEN "$ROOT/.env")"
  chat="$(read_env TELEGRAM_CHAT_ID "$ROOT/.env")"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  enabled="$(curl -s -m 10 "$MAGGRAB_API/settings" | jq -r 'if .alerts.solverUpdate == false then "no" else "yes" end' 2>/dev/null)"
  [ "$enabled" = no ] && return 0
  # The token goes through stdin so it isn't visible in the process list
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" \
    | curl -s -m 15 -o /dev/null -K - --data-urlencode "chat_id=$chat" --data-urlencode "text=$1" || true
}

compose_candidate() {
  RESOLVER_PROJECT=$CANDIDATE RESOLVER_NAME=$CANDIDATE RESOLVER_NETWORK=resolver-net-candidate \
    RESOLVER_IMAGE=link-resolver:candidate CFSOLVE_COMMIT="$latest" \
    docker compose -f "$RESOLVER_DIR/docker-compose.yml" "$@"
}

remove_candidate() { compose_candidate down --remove-orphans >/dev/null 2>&1; }

in_container() { # container, python source, args...
  local container="$1" source="$2"
  shift 2
  docker exec "$container" python3 -c "$source" "$@"
}

wait_for_self_test() { # container: succeeds once its self-test has passed
  local deadline=$((SECONDS + SELF_TEST_WAIT)) result
  while [ $SECONDS -lt $deadline ]; do
    result="$(in_container "$1" 'import urllib.request; print(urllib.request.urlopen("http://localhost:8080/health", timeout=4).read().decode())' 2>/dev/null | jq -r '.selfTest.ok')"
    [ "$result" = true ] && return 0
    [ "$result" = false ] && return 1
    sleep 5
  done
  return 1
}

resolve_in_candidate() {
  in_container "$CANDIDATE" 'import json, sys, urllib.request
req = urllib.request.Request("http://localhost:8080/resolve", json.dumps({"url": sys.argv[1]}).encode(), {"Content-Type": "application/json"})
print(urllib.request.urlopen(req, timeout=300).read().decode())' "$1"
}

test_real_link() {
  local links link result status wait_seconds
  links="$(curl -s -m 15 "$MAGGRAB_API/extracted" | jq -r 'sort_by(-.timestamp) | map(.downupUrl // empty) | .[:3] | .[]')"
  [ -n "$links" ] || { echo "no downup link to test with"; return 1; }
  for link in $links; do
    result="$(resolve_in_candidate "$link")"
    status="$(echo "$result" | jq -r '.status')"
    if [ "$status" = cooldown ]; then
      wait_seconds="$(echo "$result" | jq -r '.waitSeconds')"
      if [ "$wait_seconds" -le "$MAX_COOLDOWN_WAIT" ] 2>/dev/null; then
        echo "downup cooldown, waiting ${wait_seconds}s"
        sleep "$((wait_seconds + 60))"
        result="$(resolve_in_candidate "$link")"
        status="$(echo "$result" | jq -r '.status')"
      fi
    fi
    echo "resolve $link -> $status"
    [ "$status" = ok ] && return 0
    [ "$status" = not_found ] || { echo "$result" | jq -r '.message' | cut -c1-300; return 1; }
  done
  return 1
}

reject() { # reason
  echo "rejected $short: $1"
  remove_candidate
  # Tests run again tomorrow, but only the first failure of each commit sends a message
  if [ "$(cat "$STATE/rejected" 2>/dev/null)" != "$latest" ]; then
    echo "$latest" >"$STATE/rejected"
    notify "⚠️ cfsolve $short failed: $1. It wasn't installed, and $current_short stays in place. Tests run again daily."
  fi
  exit 1
}

latest="$(curl -s -m 30 "$UPSTREAM_API" | jq -r '.sha // empty')"
if ! [[ "$latest" =~ ^[0-9a-f]{40}$ ]]; then
  echo "couldn't read upstream's latest commit"
  exit 1
fi
short="${latest:0:7}"

current="$(read_env CFSOLVE_COMMIT "$RESOLVER_DIR/.env")"
current_short="${current:0:7}"
if [ -z "$current" ]; then
  echo "CFSOLVE_COMMIT missing from $RESOLVER_DIR/.env"
  notify "⚠️ cfsolve update check couldn't run: CFSOLVE_COMMIT is missing from resolver/.env."
  exit 1
fi
case "$latest" in
  "$current"*) echo "up to date ($short)"; exit 0 ;;
esac
echo "testing $short (installed: $current_short)"

# Runs on every exit, so failed builds don't fill the disk
clean_up() {
  remove_candidate
  docker image prune -f --filter label=app=link-resolver >/dev/null
  docker builder prune -f --filter until=168h >/dev/null
}

trap clean_up EXIT
remove_candidate
compose_candidate build >>"$STATE/build.log" 2>&1 || reject "the build failed"
compose_candidate up -d --no-build || reject "it wouldn't start"
wait_for_self_test "$CANDIDATE" || reject "its Turnstile self-test failed"
"$RESOLVER_DIR/verify-lockdown.sh" "$CANDIDATE" || reject "the lockdown check failed"
test_real_link || reject "it couldn't resolve a real link"
remove_candidate

previous_commit="$current"
docker tag link-resolver:latest link-resolver:rollback
docker tag link-resolver:candidate link-resolver:latest
sed -i "s/^CFSOLVE_COMMIT=.*/CFSOLVE_COMMIT=$latest/" "$RESOLVER_DIR/.env"

deployed_ok() {
  docker compose -f "$RESOLVER_DIR/docker-compose.yml" up -d --no-build link-resolver \
    && wait_for_self_test link-resolver \
    && "$RESOLVER_DIR/verify-lockdown.sh" link-resolver
}

if deployed_ok; then
  rm -f "$STATE/rejected"
  echo "installed $short"
  notify "✅ cfsolve updated from $current_short to $short: https://github.com/chris124567/cfsolve/commit/$latest"
else
  echo "rolling back to $current_short"
  docker tag link-resolver:rollback link-resolver:latest
  sed -i "s/^CFSOLVE_COMMIT=.*/CFSOLVE_COMMIT=$previous_commit/" "$RESOLVER_DIR/.env"
  docker compose -f "$RESOLVER_DIR/docker-compose.yml" up -d --no-build link-resolver
  echo "$latest" >"$STATE/rejected"
  notify "⚠️ cfsolve $short passed its tests but failed once installed, so $current_short was restored."
fi
