"""downup-resolver: turns a downup.me (or dwp.la) link into a direct download link.

Runs downup's free-download flow (Free Download -> 60s countdown -> Cloudflare
Turnstile -> download2) using cfsolve for the Turnstile token. It only ever
returns the direct link; it never downloads the file.

API
  POST /resolve   {"url": "https://dwp.la/d/..."}
    200 {"status": "ok", "directUrl", "filename", "size"}
    200 {"status": "cooldown", "waitSeconds"}
    200 {"status": "not_found", "message"}
    200 {"status": "error", "message"}
  GET  /health    {"ok", "busy", "selfTest": {"ok", "at", "message"}}
"""

import http.cookiejar
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CFSOLVE = os.environ.get("CFSOLVE_BIN", "/opt/cfsolve/challenge")
PROFILE = os.environ.get("CFSOLVE_PROFILE", "/opt/cfsolve/profiles/safari-26-ios.json")
PORT = int(os.environ.get("PORT", "8080"))
SELF_TEST_INTERVAL = int(os.environ.get("SELF_TEST_INTERVAL_HOURS", "6")) * 3600
# Any page on the site works for a token-only self-test with --blank-page
SELF_TEST_PAGE = os.environ.get("SELF_TEST_PAGE", "https://downup.me/")
SELF_TEST_SITEKEY = os.environ.get("SELF_TEST_SITEKEY", "0x4AAAAAADKt-sQQ_BNTZwuQ")

HTTP_TIMEOUT = 60
SOLVE_TIMEOUT = 120
ALLOWED_HOSTS = ("dwp.la", "downup.me", "downup.space")
# The profile cfsolve impersonates; requests here use the same browser identity
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("resolver")

resolve_lock = threading.Lock()  # one downup session at a time: free users get one slot
self_test = {"ok": None, "at": None, "message": "not run yet"}


class ResolveError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.result = {"status": status, "message": message, **extra}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def parse_wait(html):
    """Seconds from downup's 'You have to wait X hours, Y minutes, Z seconds' message, else 0."""
    m = re.search(r"You have to wait ((?:\d+ \w+,? ?)+)", html)
    if not m:
        return 0
    total = 0
    for value, unit in re.findall(r"(\d+) (hour|minute|second)", m.group(1)):
        total += int(value) * {"hour": 3600, "minute": 60, "second": 1}[unit]
    return total


def form_fields(html, op):
    for form in re.findall(r"<form.*?</form>", html, re.S):
        if f'value="{op}"' in form:
            fields = {}
            for tag in re.findall(r"<input[^>]*>", form):
                name = re.search(r'name="([^"]+)"', tag)
                value = re.search(r'value="([^"]*)"', tag)
                if name:
                    fields[name.group(1)] = value.group(1) if value else ""
            return fields
    return None


def page_text(html):
    html = re.sub(r"<(script|style).*?</\1>", "", html, flags=re.S)
    return " ".join(re.sub(r"<[^>]+>", " ", html).split())


def solve_turnstile(page_url, sitekey):
    with tempfile.TemporaryDirectory() as tmp:
        workdir = os.path.join(tmp, "solve")  # cfsolve wants a new or empty directory
        proc = subprocess.run(
            [CFSOLVE, "--page", page_url, workdir, "--solve", "--fingerprint", PROFILE,
             "--sitekey", sitekey, "--blank-page"],
            capture_output=True, text=True, timeout=SOLVE_TIMEOUT)
    lines = proc.stdout.strip().splitlines()
    token = lines[-1].strip() if lines else ""
    if proc.returncode != 0 or len(token) < 100:
        tail = " ".join(proc.stderr.strip().splitlines()[-3:])[:300]
        raise ResolveError("error", f"Turnstile solve failed (exit {proc.returncode}): {tail}")
    return token


def resolve(url):
    host = urllib.parse.urlsplit(url).hostname or ""
    if not any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS):
        raise ResolveError("error", f"Not a downup link: {host}")

    jar = http.cookiejar.CookieJar()
    follow = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    no_follow = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)

    def request(opener, target, data=None, referer=None, method=None):
        headers = {"User-Agent": UA}
        if referer:
            headers["Referer"] = referer
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        try:
            return opener.open(urllib.request.Request(target, body, headers, method=method),
                               timeout=HTTP_TIMEOUT)
        except urllib.error.HTTPError as e:
            return e

    # 1. File page (dwp.la redirects to it)
    resp = request(follow, url)
    page_url = resp.geturl()
    html = resp.read().decode(errors="ignore")
    if resp.status == 404 or "File Not Found" in html or "file was removed" in html.lower():
        raise ResolveError("not_found", "File not found on downup")
    step1 = form_fields(html, "download1")
    if not step1:
        raise ResolveError("error", f"Unexpected file page: {page_text(html)[:200]}")

    # 2. Free Download: shows the countdown and Turnstile, or the cooldown message
    step1["method_free"] = "1"
    html = request(follow, page_url, step1, referer=page_url).read().decode(errors="ignore")
    wait = parse_wait(html)
    if wait:
        raise ResolveError("cooldown", f"downup cooldown: {wait}s", waitSeconds=wait)
    step2 = form_fields(html, "download2")
    sitekey = re.search(r'data-sitekey="([^"]+)"', html)
    if not step2 or not sitekey:
        raise ResolveError("error", f"Unexpected download page: {page_text(html)[:200]}")
    countdown = re.search(r'id="seconds">(\d+)<', html)
    ready_at = time.time() + (int(countdown.group(1)) if countdown else 0) + 2

    # 3. Turnstile token, then let the countdown finish
    token = solve_turnstile(page_url, sitekey.group(1))
    time.sleep(max(0, ready_at - time.time()))

    # 4. Submit; success is a redirect to the direct link
    step2["cf-turnstile-response"] = token
    resp = request(no_follow, page_url, step2, referer=page_url)
    direct = resp.headers.get("Location")
    if not direct:
        html = resp.read().decode(errors="ignore")
        wait = parse_wait(html)
        if wait:
            raise ResolveError("cooldown", f"downup cooldown: {wait}s", waitSeconds=wait)
        raise ResolveError("error", f"No direct link (HTTP {resp.status}): {page_text(html)[:200]}")

    # The link contains spaces; JDownloader and HEAD need it encoded
    parts = urllib.parse.urlsplit(direct)
    direct = urllib.parse.urlunsplit(parts._replace(path=urllib.parse.quote(parts.path)))
    filename = urllib.parse.unquote(parts.path.rsplit("/", 1)[-1])

    # HEAD does not use up the link (checked in testing)
    check = request(urllib.request.build_opener(), direct, method="HEAD")
    if check.status != 200:
        raise ResolveError("error", f"Direct link check failed: HTTP {check.status}")
    size = check.headers.get("Content-Length")
    return {"status": "ok", "directUrl": direct, "filename": filename,
            "size": int(size) if size and size.isdigit() else None}


def run_self_test():
    try:
        solve_turnstile(SELF_TEST_PAGE, SELF_TEST_SITEKEY)
        self_test.update(ok=True, message="Turnstile solved")
    except Exception as e:  # noqa: BLE001 - report any failure in /health
        self_test.update(ok=False, message=str(e)[:300])
    self_test["at"] = int(time.time())
    log.info("Self-test: %s", self_test)


def self_test_loop():
    while True:
        with resolve_lock:
            run_self_test()
        time.sleep(SELF_TEST_INTERVAL)


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
            self.reply(200, {"ok": True, "busy": resolve_lock.locked(), "selfTest": self_test})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/resolve":
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            url = json.loads(self.rfile.read(length) or b"{}").get("url", "")
        except (ValueError, AttributeError):
            return self.reply(400, {"error": "body must be JSON with a url"})
        if not url:
            return self.reply(400, {"error": "url is required"})

        started = time.time()
        with resolve_lock:
            try:
                result = resolve(url)
            except ResolveError as e:
                result = e.result
            except Exception as e:  # noqa: BLE001 - never crash the request thread
                log.exception("Resolve failed")
                result = {"status": "error", "message": f"{type(e).__name__}: {e}"[:300]}
        log.info("resolve %s -> %s in %.0fs", url, result["status"], time.time() - started)
        self.reply(200, result)

    def log_message(self, fmt, *args):
        pass  # request lines are logged by do_POST


if __name__ == "__main__":
    threading.Thread(target=self_test_loop, daemon=True).start()
    log.info("downup-resolver listening on %d", PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
