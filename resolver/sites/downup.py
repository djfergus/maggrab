"""downup.me (dwp.la short links): Free Download -> 60s countdown -> Turnstile -> download2."""

import re
import time
import urllib.parse

from common import ResolveError, Session, form_fields, page_text, solve_turnstile

HOSTS = ("dwp.la", "downup.me", "downup.space")
LINK_HOSTS = ("downup.me", "downup.space")
# Any page on the site works for a token-only self-test with --blank-page
SELF_TEST = {"page": "https://downup.me/", "sitekey": "0x4AAAAAADKt-sQQ_BNTZwuQ"}


def parse_wait(html):
    """Seconds from downup's 'You have to wait X hours, Y minutes, Z seconds' message, else 0."""
    m = re.search(r"You have to wait ((?:\d+ \w+,? ?)+)", html)
    if not m:
        return 0
    total = 0
    for value, unit in re.findall(r"(\d+) (hour|minute|second)", m.group(1)):
        total += int(value) * {"hour": 3600, "minute": 60, "second": 1}[unit]
    return total


def resolve(url):
    session = Session()

    # 1. File page (dwp.la redirects to it)
    resp = session.request(url)
    page_url = resp.geturl()
    html = resp.read().decode(errors="ignore")
    if resp.status == 404 or "File Not Found" in html or "file was removed" in html.lower():
        raise ResolveError("not_found", "File not found on downup")
    step1 = form_fields(html, "download1")
    if not step1:
        raise ResolveError("error", f"Unexpected file page: {page_text(html)[:200]}")

    # 2. Free Download: shows the countdown and Turnstile, or the cooldown message
    step1["method_free"] = "1"
    html = session.request(page_url, step1, referer=page_url).read().decode(errors="ignore")
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
    resp = session.request(page_url, step2, referer=page_url, redirects=False)
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
    check = Session().request(direct, method="HEAD")
    if check.status != 200:
        raise ResolveError("error", f"Direct link check failed: HTTP {check.status}")
    size = check.headers.get("Content-Length")
    return {"status": "ok", "directUrl": direct, "filename": filename,
            "size": int(size) if size and size.isdigit() else None}
