# downup integration: progress log

Goal: send downmagaz's second link (dwp.la → downup.me) to JDownloader first, using
cfsolve to pass downup's Cloudflare Turnstile, and fall back to the novafile link.
User choice (2026-10-31): **wait for downup** rather than fall back quickly
(`DOWNUP_MAX_DEFER_MINUTES=180`), to avoid solving novafile captchas.

If this session is interrupted, resume from "Status" below.

## Rollback (current working state is preserved)

| What | Where |
|---|---|
| Last known-good code | git tag `pre-downup` (= `e657715`, main before this work) |
| Last known-good image | `maggrab-maggrab:pre-downup` on Unraid |
| Data + .env + compose backup | `/mnt/user/appdata/maggrab-data-backup-pre-downup-20261031-*` on Unraid |

Fastest rollback, in order:
1. Remove `DOWNUP_RESOLVER_URL` from `/mnt/user/appdata/maggrab/.env`, then
   `cd /mnt/user/appdata/maggrab && docker compose up -d maggrab` (new code, downup off).
2. `docker tag maggrab-maggrab:pre-downup maggrab-maggrab:latest && docker compose up -d --no-build maggrab`
3. `git checkout pre-downup && docker compose up -d --build maggrab`
Data restore if ever needed: `docker cp <backup>/. maggrab:/app/data/` then restart.

## Design

- `resolver/`: **downup-resolver** container. cfsolve built from pinned commit
  `98240dd`, plus `server.py` (stdlib HTTP).
  - `POST /resolve {url}` returns `ok {directUrl, filename, size}`, `cooldown {waitSeconds}`,
    `not_found`, or `error`.
  - `GET /health` reports the result of a Turnstile self-test, run every 6h.
  - It never downloads files; a HEAD request doesn't use up the link (verified).
- maggrab (only active when `DOWNUP_RESOLVER_URL` is set; unset = previous behaviour):
  - Extraction stores the dwp.la link as `downupUrl`. With the resolver off, downup
    links are ignored, exactly as before.
  - Submission tries downup first:
    - ok: send the direct link (package name = article title).
    - cooldown: set `nextAttemptAt` to when the cooldown ends.
    - error: wait on the normal backoff.
    - After `DOWNUP_MAX_DEFER_MINUTES` (180) from the item being found, fall back to novafile.
    - not_found: fall back immediately.
  - The resolved link is cached (`resolvedUrl`/`resolvedAt`) and reused for
    `DOWNUP_LINK_TTL_MINUTES` if sending it to JDownloader fails.
  - New optional item fields: `downupUrl`, `resolvedUrl`, `resolvedAt`, `nextAttemptAt`, `submittedVia`.
  - `GET /api/downup-status` feeds the settings card. The dashboard rows show "via" and the waiting state.

## Facts measured so far (2026-10-31)

- **Getting a link does NOT start the cooldown; downloading does.** Phase 0 got a link at
  01:56 and the cooldown was already 0 at 02:01. The earlier "wait 18m51s" came from a test
  that downloaded the whole 215 MB file.

- cfsolve solved downup's Turnstile 7/8 times, ~7s each. The one failure was
  "probe 32 matches no known collector" (cfsolve profile gap).
- Full flow: Free Download → 60s countdown → token → `download2` POST → 302 to
  `https://s3.downup.me:183/d/<token>/<file>`. That link:
  - survived 2 HEADs and a partial GET,
  - ~90 KB/s,
  - **no Range support** (an interrupted download restarts from zero).
- downup free cooldown exists, roughly 1h ("You have to wait 18 minutes, 51 seconds
  till next download"). Exact length and link lifetime come from Phase 0.
- JDownloader's own DownupSpace plugin can't solve Turnstile ("No solver available"),
  and the MyJDownloader phone solver doesn't support Turnstile either.

## Status

- [x] Snapshot: tag `pre-downup`, image tag, data backup
- [ ] **Phase 0** (running): container `cfsolve-phase0` on Unraid, log at
      `/mnt/user/appdata/cfsolve-test/phase0.log`. It ends with "PHASE0 DONE" (~4h).
      Use the results to set `DOWNUP_LINK_TTL_MINUTES` (default 60) and confirm the cooldown.
      `/mnt/user/appdata/cfsolve-test/` also holds a built cfsolve (`src/target/release/challenge`)
      and the test scripts `flow.py`, `reliab.sh`, `probe.py`. Delete when done, plus the `cfsolve-cargo` volume.
- [x] Phase 1 code: `resolver/server.py`, `resolver/Dockerfile` (branch `feat/downup-resolver`)
- [x] Phase 1 image build: `downup-resolver:test` (180 MB, ~15 min build)
- [x] Phase 1 test: self-test solved Turnstile; `POST /resolve` for dwp.la/d/ix0 returned an `ok`
      direct link (215 MB) in 72s; non-downup URLs are rejected; runs as non-root; healthy
- [x] Phase 2 code (server): schema fields, `server/scraper.ts` downup-first submission
- [x] Phase 2 code (rest): `/api/downup-status` route, client api, settings card,
      dashboard badges, docker-compose service + env, `.dockerignore` (exclude `resolver/`)
- [x] Type check and build in a `node:20-alpine` container on Unraid (both pass)
- [x] Phase 3 fake-resolver tests (`/tmp/p3/run.sh on|off` on Unraid; bad JD creds, so nothing reaches JD).
      All passed:
      - ok: link cached, then sent via downup
      - cooldown: wait until it ends
      - error: wait 10m
      - not_found: fall back to novafile now
      - item older than 180m: fall back to novafile
      - downup-only item: keeps waiting
      - legacy item: novafile path unchanged
      - cached link reused on retry (no new resolver call)
      - resolver off: novafile only, resolver never called
- [x] Phase 3: real feed. Economist Audio 10.31 was stored with downloadUrl=nfile and
      downupUrl=dwp.la/d/ix0. A resolver hang gives up after 240s and defers the item.
- [x] Phase 3: real resolver end-to-end (see Phase 1 test)
- [~] Deploy step 1 (02:2x UTC): Unraid checkout switched to branch `feat/downup-resolver`; maggrab
      rebuilt with no `DOWNUP_*` in `.env` (`/api/downup-status` reports enabled=false).
      Verifying a feed cycle.
- [ ] Deploy step 2: start downup-resolver, set `DOWNUP_RESOLVER_URL=http://downup-resolver:8080`
      in `.env`, recreate maggrab; watch the next 2–3 issues; test the fallback by stopping the resolver
- [ ] PR to main, merge, update the memory note, clean up test artifacts
