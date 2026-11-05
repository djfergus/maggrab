# link-resolver

Turns a download host's page link into a direct link, solving Cloudflare Turnstile with
[cfsolve](https://github.com/chris124567/cfsolve). Any container can use it. It runs as its own
compose project in `resolver/`, separate from maggrab.

Start or update it from the `resolver` folder with `docker compose up -d --build`. Start it before
maggrab, because maggrab joins its network.

## Add a download host

1. Copy `resolver/sites/_example.py` to `resolver/sites/<name>.py` and fill in `HOSTS`, `LINK_HOSTS`,
   `SELF_TEST` and `resolve()`. The file is picked up automatically.
2. If the host's direct links use a port other than 80, 443 or 183, add it to
   `RESOLVER_ALLOWED_TCP_PORTS` in `resolver/.env`.
3. For maggrab to use it, add an entry to `RESOLVER_SITES` in `server/scraper.ts`. The resolver is
   tried first, and any other link on the page is the fallback. Each page can have one resolver link,
   stored in the `downupUrl` field whatever the site.
4. Rebuild from `resolver/` with `docker compose up -d --build`, and rebuild maggrab if you did step 3.

## Add a container that uses it

Join the network and call `http://link-resolver:8080`:

```yaml
services:
  myapp:
    networks: [default, resolver-net]
networks:
  resolver-net:
    external: true
```

If the app also publishes a port, set `gw_priority: 1` on `default`, as maggrab's compose file does.

- `POST /resolve {"url": "..."}` returns `ok {directUrl, filename, size}`, `cooldown {waitSeconds}`,
  `not_found` or `error`.
- `GET /sites` lists the supported hosts and the hosts their direct links may be on.
- `GET /health` reports self-tests, overall and per site.

Treat the resolver as untrusted: check that `directUrl` is `https` and on one of the site's link hosts
before using it, using a list held in your own app, as maggrab does in `isAllowedDirectLink`.

Containers on `resolver-net` can reach each other, so only add ones you trust. The resolver can't
start a connection to any of them.

## Lockdown

- **Network:** `resolver/guard/guard.sh` sets the firewall in the network namespace shared with the
  resolver, which has no permission to change it. Allowed out: public internet on
  `RESOLVER_ALLOWED_TCP_PORTS`, and DNS to 1.1.1.1 and 9.9.9.9. All private and special ranges and all
  IPv6 are blocked, which covers the LAN, Unraid, other containers and Tailscale. Allowed in: port 8080
  from `resolver-net`.
- **Failure handling:** the resolver waits for the guard's ready port before using the network, and
  exits if the guard goes away.
- **Container:** non-root, no capabilities, no privilege escalation, read-only filesystem, no mounts,
  and memory, CPU and process limits.
- **Build:** upstream's code and dependencies compile with networking off. Only the `Dockerfile` in
  this repo decides the build steps.
- **maggrab:** accepts only `https` links on the site's `linkHosts`.

Run `resolver/verify-lockdown.sh` on Unraid to check all of this. It also runs on each update.

Not covered: the internet stays open on the allowed ports, because Cloudflare and download hosts can't
be reliably allowlisted, and a kernel or Docker bug could allow an escape.

## Daily cfsolve update

`resolver/update-cfsolve.sh` runs daily at 11:00 Unraid time (User Scripts job `update_cfsolve`). If
upstream has a new commit, it builds it and runs it in lockdown as a separate `link-resolver-candidate`
project. The commit must pass the self-test, the lockdown check and a real link resolve. Then it's
installed, with an automatic rollback if the installed version fails the same checks. Telegram gets the
result, unless **Solver auto-updates** is unticked in Settings.

- Installed commit: `CFSOLVE_COMMIT` in `resolver/.env`
- Logs: `resolver/.update/update.log` and `build.log`
- Previous image: `link-resolver:rollback`

The real-link test can start downup's cooldown of about 60 minutes. Issues found in that hour wait for it.

## Roll back

- Previous cfsolve: `docker tag link-resolver:rollback link-resolver:latest`, set `CFSOLVE_COMMIT` in
  `resolver/.env` to the old commit, then run `docker compose up -d --no-build link-resolver` in `resolver/`.
- Turn off daily updates: disable `update_cfsolve` in User Scripts.
- Turn off the resolver: remove `DOWNUP_RESOLVER_URL` from `.env` and recreate maggrab. It then uses
  novafile only.
- Before this project existed: images `maggrab-maggrab:pre-link-resolver` and
  `maggrab-downup-resolver:pre-link-resolver`, and git tag `pre-link-resolver`.
