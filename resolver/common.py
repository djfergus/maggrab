"""Helpers shared by the site modules in sites/."""

import http.cookiejar
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

CFSOLVE = os.environ.get("CFSOLVE_BIN", "/opt/cfsolve/challenge")
PROFILE = os.environ.get("CFSOLVE_PROFILE", "/opt/cfsolve/profiles/safari-26-ios.json")

HTTP_TIMEOUT = 60
SOLVE_TIMEOUT = 120
# The profile cfsolve impersonates; requests here use the same browser identity
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1")


class ResolveError(Exception):
    """A site's normal failure: not_found, cooldown (with waitSeconds) or error."""

    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.result = {"status": status, "message": message, **extra}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Session:
    """Cookies and browser identity for one run through a site's download flow."""

    def __init__(self):
        jar = http.cookiejar.CookieJar()
        self.follow = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        self.no_follow = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)

    def request(self, target, data=None, referer=None, method=None, redirects=True):
        headers = {"User-Agent": UA}
        if referer:
            headers["Referer"] = referer
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        opener = self.follow if redirects else self.no_follow
        try:
            return opener.open(urllib.request.Request(target, body, headers, method=method),
                               timeout=HTTP_TIMEOUT)
        except urllib.error.HTTPError as e:
            return e


def form_fields(html, op):
    """Input fields of the form whose op value is `op`, or None."""
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
    """Return a Cloudflare Turnstile token for the page, or raise ResolveError."""
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
