"""link-resolver: turns a download host's page link into a direct download link.

Each supported host is one file in sites/ (see docs/link-resolver.md). It only
ever returns the direct link; it never downloads the file.

API
  POST /resolve   {"url": "https://..."}
    200 {"status": "ok", "directUrl", "filename", "size"}
    200 {"status": "cooldown", "waitSeconds", "message"}
    200 {"status": "not_found", "message"}
    200 {"status": "error", "message"}
  GET  /sites     {"sites": [{"name", "hosts", "linkHosts"}]}
  GET  /health    {"ok", "busy", "selfTest": {"ok", "at", "message"},
                   "sites": {"<name>": {"ok", "at", "message"}}}
"""

import importlib
import json
import logging
import os
import pkgutil
import socket
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import sites as sites_package
from common import ResolveError, solve_turnstile

PORT = int(os.environ.get("PORT", "8080"))
SELF_TEST_INTERVAL = int(os.environ.get("SELF_TEST_INTERVAL_HOURS", "6")) * 3600
GUARD_PORT = int(os.environ.get("GUARD_PORT", "8081"))
REQUIRE_GUARD = os.environ.get("REQUIRE_GUARD", "1") != "0"
MAX_BODY = 64 * 1024

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("resolver")


def host_matches(host, allowed):
    return any(host == h or host.endswith("." + h) for h in allowed)


class Site:
    def __init__(self, name, module):
        self.name = name
        self.module = module
        self.lock = threading.Lock()  # one session per site: free users get one slot
        self.self_test = {"ok": None, "at": None, "message": "not run yet"}

    def run_self_test(self):
        config = self.module.SELF_TEST
        try:
            solve_turnstile(config["page"], config["sitekey"])
            self.self_test.update(ok=True, message="Turnstile solved")
        except Exception as e:  # noqa: BLE001 - report any failure in /health
            self.self_test.update(ok=False, message=str(e)[:300])
        self.self_test["at"] = int(time.time())
        log.info("Self-test %s: %s", self.name, self.self_test)

    def self_test_loop(self):
        while True:
            with self.lock:
                self.run_self_test()
            time.sleep(SELF_TEST_INTERVAL)


def load_sites():
    loaded = []
    for info in pkgutil.iter_modules(sites_package.__path__):
        if not info.name.startswith("_"):
            loaded.append(Site(info.name, importlib.import_module(f"sites.{info.name}")))
    return loaded


SITES = load_sites()


def overall_self_test():
    """The first failing site's result, else the first site's. A site that hasn't run yet is unknown."""
    tested = [s.self_test for s in SITES if s.module.SELF_TEST]
    if not tested:
        return {"ok": None, "at": None, "message": "no site has a self-test"}
    for wanted in (False, None):
        for result in tested:
            if result["ok"] is wanted:
                return result
    return tested[0]


def resolve(url):
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    site = next((s for s in SITES if host_matches(host, s.module.HOSTS)), None)
    if parts.scheme not in ("http", "https") or not site:
        return {"status": "error", "message": f"No site handles this link: {host}"}

    with site.lock:
        try:
            result = site.module.resolve(url)
        except ResolveError as e:
            return e.result
        except Exception as e:  # noqa: BLE001 - never crash the request thread
            log.exception("Resolve failed")
            return {"status": "error", "message": f"{type(e).__name__}: {e}"[:300]}

    if result.get("status") == "ok":
        direct = urllib.parse.urlsplit(result.get("directUrl", ""))
        if direct.scheme != "https" or not host_matches(direct.hostname or "", site.module.LINK_HOSTS):
            return {"status": "error",
                    "message": f"{site.name} returned a link outside its allowed hosts: {direct.hostname}"}
    return result


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True,
                             "busy": any(s.lock.locked() for s in SITES),
                             "selfTest": overall_self_test(),
                             "sites": {s.name: s.self_test for s in SITES}})
        elif self.path == "/sites":
            self.reply(200, {"sites": [{"name": s.name, "hosts": s.module.HOSTS,
                                        "linkHosts": s.module.LINK_HOSTS} for s in SITES]})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/resolve":
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.reply(413, {"error": "body too large"})
            url = json.loads(self.rfile.read(length) or b"{}").get("url", "")
        except (ValueError, AttributeError):
            return self.reply(400, {"error": "body must be JSON with a url"})
        if not isinstance(url, str) or not url:
            return self.reply(400, {"error": "url is required"})

        started = time.time()
        result = resolve(url)
        log.info("resolve %s -> %s in %.0fs", url, result["status"], time.time() - started)
        self.reply(200, result)

    def log_message(self, fmt, *args):
        pass  # request lines are logged by do_POST


def guard_is_up():
    try:
        socket.create_connection(("127.0.0.1", GUARD_PORT), timeout=3).close()
        return True
    except OSError:
        return False


def wait_for_guard():
    """Don't touch the network until the firewall container says its rules are in place."""
    while not guard_is_up():
        log.warning("Waiting for resolver-guard's firewall")
        time.sleep(2)


def guard_watchdog():
    """If the guard restarts this network is orphaned: exit so Docker rejoins the new one."""
    failures = 0
    while True:
        time.sleep(20)
        failures = 0 if guard_is_up() else failures + 1
        if failures >= 3:
            log.error("resolver-guard is gone, exiting")
            sys.stdout.flush()
            os._exit(1)


if __name__ == "__main__":
    if REQUIRE_GUARD:
        wait_for_guard()
        threading.Thread(target=guard_watchdog, daemon=True).start()
    for site in SITES:
        if site.module.SELF_TEST:
            threading.Thread(target=site.self_test_loop, daemon=True).start()
    log.info("link-resolver listening on %d, sites: %s", PORT, [s.name for s in SITES])
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
